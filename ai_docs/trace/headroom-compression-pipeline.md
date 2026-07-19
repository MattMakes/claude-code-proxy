# Headroom — Token-Saving Pipeline

> Headroom cuts LLM spend by intercepting every request (local proxy, library call, or MCP), routing each oversized content block to a type-specific compressor (statistical JSON crushing in Rust, AST code slicing, ONNX word pruning, lossless folds), caching every dropped original behind a `headroom_retrieve` hash so compression is reversible, and doing all of it without ever mutating bytes the provider's prompt cache already holds.

**Entry point:** `headroom/proxy/handlers/anthropic.py:549` (`handle_anthropic_messages`, routed from `headroom/providers/proxy_routes.py:207`) and `headroom/compress.py:171` (`compress()`) | **Type:** Proxy request path + library API | **Last traced:** 2026-07-19

Repo root: `/Users/mascott/projects/proxy/research/headroom`. All paths below are relative to it.

---

## Trigger (how requests enter)

1. **Proxy HTTP endpoints** — FastAPI app built in `headroom/proxy/server.py::create_app`; LLM routes registered by `register_provider_routes` (`headroom/proxy/server.py:4859` → `headroom/providers/proxy_routes.py:100`):
   - `POST /v1/messages` → `handle_anthropic_messages` (`proxy_routes.py:207-218`; also `/anthropic/v1/messages` for Foundry at :220-223). Note `/v1/messages` is registered twice (explicit at `proxy_routes.py:207` + declarative `route_specs.py:78`); FastAPI uses the first.
   - `POST /v1/chat/completions` → `handle_openai_chat` (`headroom/providers/route_specs.py:107`).
   - OpenAI Responses: `/v1/responses`, `/v1/codex/responses`, `/backend-api/responses`, `/backend-api/codex/responses` (POST + WebSocket + subpaths; `headroom/providers/openai_responses.py:28-49`, wired `proxy_routes.py:169-175,242`).
   - Gemini `POST /v1beta/models/{model}:generateContent|:streamGenerateContent|:countTokens` (`route_specs.py:124-143`), Vertex publisher routes (`proxy_routes.py:246-411`), Bedrock `/model/{id}/invoke[-with-response-stream]` (only if `bedrock_api_url` set, `proxy_routes.py:232-240`), Anthropic/OpenAI/Gemini batch routes, CloudCode `/v1internal:streamGenerateContent` (`route_specs.py:174-185`).
   - Utility: `POST /v1/compress` (`server.py:4855`), `/v1/retrieve*` CCR endpoints (`server.py:4386,4434,4713,4745`, loopback-only), passthrough catch-all `/{path:path}` (`proxy_routes.py:439-468`), stats/health/admin routes (`server.py:3167-4688`).
2. **`headroom wrap <agent>`** (`headroom/cli/wrap.py:1-16`) — starts the proxy and launches Claude Code / Codex / Cursor / Aider / Copilot CLI / etc. with `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` pointed at `http://127.0.0.1:8787` (defaults `headroom/cli/mcp.py:21`; `headroom/cli/init.py:178`). Wrap also hot-syncs env to a running proxy via `POST /admin/runtime-env` (`server.py:3252`).
3. **`headroom mcp serve`** (`headroom/cli/mcp.py:1-6`, default `127.0.0.1:8788/mcp` per `mcp.py:22-25`) — MCP server exposing `headroom_retrieve` / `headroom_compress` (`mcp.py:85-115`), so subscription users get CCR without a proxied API key. `headroom/ccr/mcp_server.py` reads the same compression store.
4. **Library call** — `from headroom import compress; compress(messages, model=...)` (`headroom/compress.py:171-347`). Singleton `TransformPipeline` (`compress.py:398-419`); `compress_spreadsheet()` at `compress.py:365-395`. Also a client (`headroom/client.py`), ASGI middleware and a LiteLLM callback (`headroom/integrations/`).

---

## Business Logic — Step-by-step Flow

### A. Proxy path (one Anthropic `/v1/messages` request; OpenAI/Gemini handlers mirror it)

1. Classify auth mode from headers (PAYG vs OAuth vs Subscription) → `request.state.auth_mode` (`handlers/anthropic.py:588-589`). Auth mode selects a `CompressionPolicy` later (step 9).
2. Acquire pre-upstream concurrency semaphore (fail-open on timeout) (`anthropic.py:657-695`); reject bodies > `MAX_REQUEST_BODY_SIZE` with 413 (`anthropic.py:699-711`).
3. Parse JSON, keeping the original bytes for byte-faithful forwarding (`anthropic.py:719-734`); sanitize model id (`:735-742`); strip streaming-only `index` fields (`:753`).
4. Emit `INPUT_RECEIVED` pipeline-extension event (`anthropic.py:759-774`); guard on `MAX_MESSAGE_ARRAY_LENGTH` (`:777-789`).
5. Bypass check: `x-headroom-bypass: true` or `x-headroom-mode: passthrough` (`anthropic.py:797-800`). Optional cost-aware model routing (`:809-812`), header scrubbing (`:818-851`), rate limit + budget 429s (`:873-909`), memory decision (`:950-956`).
6. Count original tokens off-thread (`anthropic.py:1049`).
7. Prefix-cache session tracking: compute session id, resolve tracker, get `frozen_message_count` — the count of leading messages already held in the provider's prompt cache, derived from prior `cache_read_input_tokens` (`anthropic.py:1122-1153`; updated post-response at `:2680-2685`).
8. `CompressionDecision.decide()` (`headroom/proxy/compression_decision.py:71-147`) — skips compression on: `bypass_header`, `compression_disabled` (`config.optimize=False`), `no_messages`, `license_denied` (:118-135). Plus inline `pre_upstream_backpressure` skip (`anthropic.py:1253-1261`).
9. If compressing, resolve `CompressionPolicy` per auth mode (`anthropic.py:1286-1288`; policies in `headroom/proxy/compression_policy.py:45-66`: PAYG/OAuth `volatile_token_threshold=128`, `max_lossy_ratio=0.45`, `toin_read_only=False`; Subscription `32` / `0.25` / `toin_read_only=True` — note only `toin_read_only` and `cache_aligner_enabled` are consumed today, `compression_policy.py:103-116`), then run **one of three branches**, all calling `TransformPipeline.apply(...)` with `proxy_pipeline_kwargs(config)` (`headroom/agent_savings.py:275-352`):
   - **token mode** (`HEADROOM_MODE=token`): compress the whole message list; frozen count clamped to provider-confirmed cache; cold-start background-compression deferral if `HEADROOM_BACKGROUND_COMPRESSION=1` and `original_tokens >= 50000` and no frozen prefix (`anthropic.py:1289-1436`; min-tokens knob `HEADROOM_BACKGROUND_COMPRESSION_MIN_TOKENS`, `server.py:1095-1099`); sync path bounded by `COMPRESSION_TIMEOUT_SECONDS=30.0` (`headroom/proxy/helpers.py:687-691`; cold-start fast pass 10.0s at `:701-705`).
   - **cache mode** (the **default**: `HEADROOM_MODE` defaults to `cache`, `server.py::_proxy_config_from_env` ~:4933; modes in `headroom/proxy/modes.py:21-38`): compress **only the append-only delta** past the frozen prefix (`_extract_cache_stable_delta`, `anthropic.py:1485-1566`), strip `cache_control` from the delta so per-block guards don't skip it (`headroom/cache/prefix_tracker.py:123-135`), splice compressed delta onto the byte-stable forwarded prefix.
   - non-cache fallback: full pipeline apply (`anthropic.py:1462-1484`).
   Any pipeline exception fails open — original messages forwarded (`anthropic.py:1570-1581`); the pipeline also has its own circuit breaker (3 consecutive failures → 60s pass-through; `HEADROOM_PIPELINE_BREAKER_THRESHOLD/_COOLDOWN_S`, `headroom/transforms/pipeline.py:123-131,202-230`).
10. **Inside `TransformPipeline.apply`** (`headroom/transforms/pipeline.py:232-545`): optional stage-0 **ToolResultInterceptorTransform** (ast-grep Read outlining, opt-in `HEADROOM_INTERCEPT_ENABLED=1` / `intercept_tool_results`, `pipeline.py:139-152`) → **CacheAligner** (detector-only, never rewrites; `pipeline.py:154-156`) → **ContentRouter** (all real compression; `pipeline.py:158-167`). Token counts before/after via the per-model tokenizer (`pipeline.py:283,444`).
11. Cache-safety overlay for **all** modes: `overlay_cached_prefix` replays the previously-forwarded compressed prefix byte-identical (`anthropic.py:1597-1606`; impl `prefix_tracker.py:267-359`), then `normalize_message_cache_control` collapses accumulated breakpoints to a single ephemeral one (`anthropic.py:1608-1616`; impl `prefix_tracker.py:362-420` — Anthropic hard-errors above 4 `cache_control` blocks).
12. **Inflation guard**: if `optimized_tokens > original_tokens` (non-cache-mode, no overlay), revert to originals (`anthropic.py:1627-1638`). The library `compress()` has the same guard (`compress.py:278-291`).
13. CCR tool injection (sticky per session), read-maturation, memory injection, hooks (`anthropic.py:1660-2236`); `body["messages"] = optimized_messages` (`:2236-2245`).
14. Request-shape shrinkers: tool-schema compaction Layer 1 always-on (`anthropic.py:2254-2259`, `headroom/proxy/tool_schema_compaction.py:242-278`), tool-description truncation Layer 2 opt-in (`:2278-2299`), system-prompt compaction Layer 3 opt-in `HEADROOM_SYSTEM_COMPACT=1` (`:2310-2334`; `headroom/proxy/system_compaction.py:24-36`, min block 500 chars), tool-search deferral opt-in (`:2386-2413`).
15. **Output shaping** (opt-in `HEADROOM_OUTPUT_SHAPER=1`, skipped on bypass) (`anthropic.py:2446-2497`) — see "Output token reduction" below.
16. Forward upstream (Anthropic/Vertex/Bedrock). Streaming requests carrying a `headroom_retrieve` tool are coerced to buffered `stream:false` so the CCR loop can run (`anthropic.py:2757-2774`). Streaming impl in `headroom/proxy/handlers/streaming.py:63,977,1053`.
17. Response path: `RESPONSE_RECEIVED` events; **CCR auto-retrieval loop** `ccr_response_handler.handle_response(...)` transparently satisfies `headroom_retrieve` calls and re-calls upstream, max 3 rounds (`anthropic.py:3096-3163`; gate `server.py:1784`); prefix tracker updated from `cache_read/creation_input_tokens` (`anthropic.py:2680-2685`); outcome + savings recorded (`:2687-2724`), costs priced through LiteLLM (`headroom/proxy/cost.py:687-732`).

### B. Library path (`compress()`)

1. Empty messages or `optimize=False` → passthrough (`compress.py:211-212`).
2. Build effective `CompressConfig` (defaults: `compress_user_messages=False`, `compress_system_messages=True`, `protect_recent=4`, `protect_analysis_context=True`, `frozen_message_count=0`, `target_ratio=None`, `min_tokens_to_compress=250`, `kompress_model=None`; `compress.py:77-147`); apply named savings profile if set (`compress.py:224-225` → `agent_savings.py:254-272`).
3. Extract latest user query for relevance scoring (`compress.py:252` → `headroom/utils.py:46-64`).
4. `pipeline.apply(...)` with all config knobs (`compress.py:254-269`); pipeline = CacheAligner → ContentRouter (`compress.py:409-419`).
5. Inflation guard reverts if tokens grew (`compress.py:278-291`); hooks + pipeline-extension events fire (`:293-338`); any exception returns originals (`:349-362`).
6. Savings profiles (`agent_savings.py:110-204`): `agent-90` (target 90%, `target_ratio=0.10`, `min_tokens=120`, `protect_recent=2`, `force_kompress=True`, `max_items_after_crush=8`), `balanced` (70%, ratio 0.30, min 250, protect 4), `coding` (**proxy default**, `HEADROOM_SAVINGS_PROFILE` fallback set in `server.py::_proxy_config_from_env`; cache mode, `min_tokens=10`, `protect_recent=0`, `compress_user=True`, `protect_reads=True`, `cross_turn_dedup=True`, `lossless_then_lossy=True`, `min_chars_for_block=25`), `general` (60%, min 25). Env mapping `HEADROOM_MODE/_MIN_TOKENS/_PROTECT_RECENT/_TARGET_RATIO/...` at `agent_savings.py:66-100`.

---

## Each compressor

### SmartCrusher (statistical JSON-array crusher — Rust core)

- **Where the logic lives:** Rust. Python `headroom/transforms/smart_crusher.py` retired its native implementation (docstring :1-19); everything delegates to `headroom._core.SmartCrusher` — PyO3 module built from `crates/headroom-py/src/lib.rs` (pymodule `_core` at lib.rs:1803-1804; `module-name = "headroom._core"` in pyproject.toml:395). **Hard import, no Python fallback** (`smart_crusher.py:16-19,266-275`); proxy hard-fails at startup without it (`server.py:501,537-575`). Real algorithms in `crates/headroom-core/src/transforms/smart_crusher/` (~12k lines: crusher.rs, analyzer.rs, planning.rs, crushers.rs, outliers.rs, orchestration.rs, field_detect.rs, adaptive_sizer.rs, compaction/).
- **What it targets:** JSON arrays in tool results — OpenAI `role:"tool"` string content (`smart_crusher.py:1277-1300`) and Anthropic `tool_result` blocks (`:1304-1333`); recurses into nested arrays to depth 50 (`crusher.rs:460,486-488`). Space-concatenated JSON objects (web-search style) are normalized first (`smart_crusher.py:487-493`). Results from `headroom_retrieve` itself are never re-crushed (`:1283-1284,1313-1314`).
- **Gates:** message > `min_tokens_to_crush=200` tokens (`smart_crusher.py:1288,1319`; default `:173` / `config.rs:137`); array ≥ `min_items_to_analyze=5` (`crusher.rs:494-495`).
- **Algorithm (dict arrays, `crush_array` crusher.rs:761-930):**
  1. Adaptive K via `compute_optimal_k` — Kneedle knee-point on cumulative unique-bigram coverage (`adaptive_sizer.py:27-106` and Rust port): n≤8 → keep all; ≤3 unique SimHashes → keep uniques; no knee → `keep_fraction = 0.3 + 0.7*diversity`; per-tool bias multiplier (Grep conservative 1.5, Bash moderate 1.0, WebFetch aggressive 0.7 — `headroom/config.py:390-407`), clamped to `max_items_after_crush=15`; zlib sanity check bumps K 20% if compression-ratio diff > 0.15 (`adaptive_sizer.py:276-329`).
  2. If `len <= K` → passthrough.
  3. **Lossless-first**: run structural compaction (csv-schema table / buckets render); if byte savings ≥ `lossless_min_savings_ratio=0.15` (`config.rs:151`, `smart_crusher.py:193`; some Rust docstrings stale at 0.30 — `crusher.rs:186-188`), ship lossless with **zero rows dropped**. `lossless_only=True` never falls through to lossy (`crusher.rs:829-838`).
  4. Lossy: `SmartAnalyzer` computes per-field stats, detects pattern (`time_series` — ISO/Unix temporal field regexes `analyzer.rs:370-413`; `logs` — message field unique_ratio>0.5 & avg_len>20 + level field with 2-10 uniques `analyzer.rs:340-353`; `search_results` — score-like field conf ≥0.5 `field_detect.rs:116-203`; else generic) and crushability (6-case decision tree on uniqueness/ID/signal, `analyzer.rs:421-645`; not-crushable → `skip` passthrough).
  5. Strategy planners (`planning.rs`): SmartSample / TopN (keep top `max_items-3` by score) / ClusterSample (≤2 reps per md5-of-first-50-chars cluster) / TimeSeries (change-point window ±2).
  6. **Always kept:** error items (12-keyword set `error, exception, failed, failure, critical, fatal, crash, panic, abort, timeout, denied, rejected` — `error_keywords.rs:17-30`), structural outliers (fields present <20% of rows; rare status values outside the Pareto-80% top-K, `outliers.rs:61-235`), numeric anomalies > `variance_threshold=2.0`·σ, change points (window 5, threshold 2σ, `analyzer.rs:282-317`), first/last anchors (`first_fraction=0.3`, `last_fraction=0.15`, `config.rs:44-47`; anchor budget = clamp(25% of max_items, 3, 12), pattern-weighted front/back — `anchor_selector.py:364-439`), and query-relevant items (HybridScorer ≥ `relevance_threshold=0.3` Rust-side, `planning.rs:474-518`).
  7. Over-budget pruning keeps ALL critical items even if that exceeds K (`orchestration.rs:152-230`).
  8. Dropped rows → SHA-256[0:12-hex] hash stored, sentinel `{"_ccr_dropped": "<<ccr:HASH N_rows_offloaded>>"}` appended (`crusher.rs:563-571,904-920`).
- String/number/mixed arrays get simpler crushers (n≤8 passthrough; keep errors, length/σ outliers, k_first/k_last, stride fill — `crushers.rs:76-366`).
- **Python shim keeps:** message walking + markers (`smart_crusher.py:1230-1349`), TOIN recording (`:885-982`, skipped when `policy.toin_read_only`), Rust→Python CCR store mirroring so `/v1/retrieve` resolves markers (`:984-1172`), audit-safe protected-pattern splice-back (`:545-734`).
- **Config discrepancy to know:** `toin_confidence_threshold` defaults 0.3 in `headroom/config.py:458` but 0.5 in the live `transforms/smart_crusher.py:182` dataclass.

### ContentRouter (content-type detection + dispatch)

- Sole compression transform in the default pipeline (`transforms/pipeline.py:158-167`); `headroom/transforms/content_router.py` (6053 lines).
- **Detection:** backend = Rust `headroom._core.detect_content_type` on macOS/Linux, pure-Python on Windows (`content_router.py:761-766`); tool-output envelopes stripped before detection (`:840-854`). The Rust chain is **magika → unidiff → PlainText** (`content_router.py:860-861`; Rust `crates/headroom-core/src/transforms/magika_detector.rs`, `unidiff_detector.rs`, `detection.rs`; `magika = "1"` optional dep behind the `ml` feature, `crates/headroom-core/Cargo.toml:80-86,169`). Guard rails: HTML→log/search re-check (`:947-950`); SOURCE_CODE→config override iff config confidence ≥0.7 (`:956-959`); PLAIN_TEXT rescue via regex detector (`:961-964`); magika SOURCE_CODE ≥0.8 confidence overrides MIXED heuristics (`:2254`). Windows/native failure degrades to the regex cascade in `headroom/transforms/content_detector.py:156-223` (JSON parse → diff ≥0.7 → HTML ≥0.7 → search ≥0.6 (30% of lines `file:line:`) → log ≥0.5 (10% lines) → tabular ≥0.6 → config ≥0.6 → code ≥0.5 → plain text), with a 5s watchdog + circuit breaker (`HEADROOM_DETECT_TIMEOUT_SECS`, `:770,789-820,889-931`).
- **Routing table** (`_strategy_from_detection`, `content_router.py:2262-2304`; dispatch `:2912-3140`): SOURCE_CODE→CodeCompressor (but default-disabled → PASSTHROUGH), JSON_ARRAY→SmartCrusher, SEARCH_RESULTS→SearchCompressor, BUILD_OUTPUT→LogCompressor, GIT_DIFF→DiffCompressor, HTML→HTMLExtractor(trafilatura), TABULAR→tabular→SmartCrusher, STRUCTURED_CONFIG→ConfigCompressor, PLAIN_TEXT→Kompress, MIXED→per-section split (`mixed_content.py:30-159`, ≥2 of 5 signals), fallback strategy = KOMPRESS (`:1495`).
- **Stage-0 lossless fold runs for every strategy** (`_lossless_first` `:2422-2475`, unconditional at `:2824`): reversible, marker-free folds in `headroom/transforms/lossless_compaction.py:368-415` (ANSI strip, identical-run collapse, ripgrep heading form, diff `index` line strip, blank-run folds; every transform self-verified for exact inversion).
- **Relevance split** (default on, `relevance_split=True` `:1571-1582`): for LOG/SEARCH content, segments the output, scores each record against user-query+tool-args with the HybridScorer, keeps records above an Otsu-adaptive cut floored at `relevance_threshold=0.25` verbatim, Kompresses the rest (`headroom/transforms/relevance_split.py:32-174`, `content_router.py:3662-3715`).
- **Key knobs** (`ContentRouterConfig` `:1439-1555`): `enable_code_aware=False`, all other compressors enabled; `min_chars_for_block_compression=500` (`HEADROOM_MIN_CHARS_FOR_BLOCK` lowers it; coding profile pins 25); `protect_error_outputs=True` (≤8000 chars); `protect_recent_code=4`; `skip_user_messages=True`; Kompress size gate `HEADROOM_KOMPRESS_MAX_TOKENS=50000` (`:1771-1775,3378`); `enable_cross_turn_dedup=False` (`HEADROOM_DEDUPE=1` / coding profile enables).
- **Tool exclusions:** `Read, Glob, Grep, Write, Edit, WebSearch, WebFetch` outputs are never lossily compressed (`headroom/config.py:216-234`); WebSearch/WebFetch stay byte-verbatim even for lossless folds (`:238-245`). Bash is deliberately NOT excluded. `HEADROOM_PROTECT_TOOL_RESULTS` extends the set; glob patterns like `mcp__*` supported (`config.py:269-300`).

### CCR — Compress-Cache-Retrieve (reversibility layer)

- **Store:** `headroom/cache/compression_store.py`. Key = explicit marker hash or `sha256(original)[:24]` (`:306-325`). Backend via `HEADROOM_CCR_BACKEND` (`:952-999`): default **SQLite** at `workspace_dir()/ccr_store.db` (`HEADROOM_CCR_SQLITE_PATH`; WAL, chmod 0600, 60s purge cadence — `headroom/cache/backends/sqlite.py:36-166`), `memory`, or entry-point backends (Redis via `HEADROOM_REDIS_URL`). TTL default **1800s (30 min)** (`DEFAULT_CCR_TTL_SECONDS`, `compression_store.py:51-52`; env `HEADROOM_CCR_TTL_SECONDS`; several docstrings stale at "5 minutes"). `max_entries=1000`, min-heap eviction (`:675-742`). MCP-channel entries get 3600s (`ccr/mcp_server.py:195-197`); batch context 86400s (`ccr/batch_store.py:25-26`).
- **Markers:** bracket form `[{N} items compressed to {M}. Retrieve more: hash={24-hex}. Expires in {ttl}m.]` (template `headroom/config.py:573-578`; emitted by kompress/log/search/diff/config/read_lifecycle compressors) and Rust form `<<ccr:HASH ...>>` (12-24 hex). All recognized by injector regexes at `headroom/ccr/tool_injection.py:182-210`.
- **Tool injection:** tool name `headroom_retrieve` (`tool_injection.py:22`), one required string param `hash`; per-provider definitions at `:25-110`. Injected only when the request contains markers or the session has done CCR, skipped if MCP already provides the tool (`:296-348`). **Session-sticky**: once injected, kept for every later request with pinned "golden" tool bytes so the tool list never flips and busts the prompt cache (`headroom/proxy/helpers.py:2290-2369`, `ccr_session_tracker.py:9-88`, `ccr_golden_policy.py:12-52`). Defaults: `ccr_inject_tool=True`, `ccr_inject_system_instructions=False`, `ccr_max_retrieval_rounds=3`, `ccr_handle_responses=True`, proactive expansion max 2 (`headroom/proxy/models.py:172-187`).
- **Interception:** see Reversibility section below.

### TOIN — Tool Output Intelligence Network (observation-only learning)

- `headroom/telemetry/toin.py:1` — records compression/retrieval telemetry per `(auth_mode, model_family, tool structure_hash)` (`:110-128`; structure hash = SHA256[:24] of sorted field names+types, `telemetry/models.py:93,354`). **Never changes request-time decisions** (PR-B5; the old `get_recommendation()` is deprecated and returns None, `toin.py:955-986`).
- Collects: compression counts/ratios, per-strategy success rates (+0.02 per un-retrieved compression; retrieval penalizes −0.15 full / −0.05 search, `toin.py:612-632,844-851`), anonymized field statistics from a 5-item sample (`smart_crusher.py:975`), hashed field names (SHA256[:8]), anonymized query patterns — no raw values, no user identifiers (`toin.py:30-34,1040-1063`).
- Storage: `~/.headroom/toin.json` (`HEADROOM_TOIN_PATH`; auto-save every 600s; `toin.py:152-172,383-411`).
- Deployment path: `python -m headroom.cli.toin_publish` aggregates slices with ≥50 observations into `recommendations.toml` (`toin_publish.py`; `DEFAULT_MIN_OBSERVATIONS_TO_PUBLISH=50`, `toin.py:98`), which the Rust core loads at startup (`crates/headroom-core/src/transforms/recommendations.rs`). Sharing is manual export/import JSON (`toin.py:1178-1285`); the old external telemetry beacon was removed (`headroom/telemetry/beacon.py:1-12`).
- Subscription-auth traffic is read-only for TOIN (`smart_crusher.py:905-926`).

### CodeCompressor (AST-aware slicing — tree-sitter)

- `headroom/transforms/code_compressor.py` (2484 lines). Uses **tree-sitter** (`tree_sitter.Parser` + `tree_sitter_language_pack`, `:154-160`; optional `[code]` extra, thread-local parsers `:109-174`). **Not ast-grep** (ast-grep is the separate Read-outline interceptor, below).
- Languages: Python, JS, TS, Go, Rust, Java, C, C++, C# (`:213-226,323-464`); Perl quarantined (`:106,136-137,1161-1173`). Language detection = regex prefilter then parse-error-count comparison (`:614-777`).
- Keeps imports, signatures, type annotations, decorators, class/type definitions; docstrings reduced to first line; comments dropped; function bodies truncated to whole AST statements up to `max_body_lines=5` with an "omitted" marker (`CodeCompressorConfig` `:485-529`; body walk `:1590-1857`).
- Thresholds: `min_tokens_for_compression=100` (`:518`), `target_compression_rate=0.2` (`:513`); output syntax re-verified, invalid → return original (`:1199-1232`); ratio <0.05 → return original (`:1237-1251`); CCR marker when ratio <0.8, `ccr_ttl=300`s (`:1253-1273,528-529`); fallback to Kompress (`:522,1147-1189`).
- **Disabled by default in the router** (`enable_code_aware=False`, `content_router.py:1440`) — code detected as SOURCE_CODE passes through rather than being Kompressed (`:2286-2302`).

### Kompress (ONNX ML word-level pruning)

- `headroom/transforms/kompress_compressor.py`. LLMLingua-style **extractive word pruning** — keeps original words in order, no paraphrase (`:1413-1414`). Model `chopratejas/kompress-v2-base`: dual-head ModernBERT (`answerdotai/ModernBERT-base`, 768-d; keep/discard head + span-importance CNN, `:499-550`), pinned to a specific HF SHA (`headroom/onnx_runtime.py:54-61`; `HEADROOM_HF_PIN=off` bypasses). ONNX artifacts tried in order int8-wo (261MB, f1≈0.913) → fp32 → int8 (`:89-93`).
- Algorithm: whitespace split; <10 words → passthrough (`:1229`); 350-word chunks tokenized to max 512 (`:999,1312-1319`); default (no `target_ratio` — the proxy never sets one, `:1212`) keeps words passing threshold 0.5 with a 0.3-0.5 borderline span boost (`:519-542,1366-1393`); with `target_ratio` keeps top-scored fraction (`:1373-1387`). MUST_KEEP regex override preserves hex addresses, numbers, ALLCAPS, dotted paths, unix paths, flags, CamelCase (`:48-57,1395-1398`; `HEADROOM_KOMPRESS_MUST_KEEP=0` disables).
- Triggers on PLAIN_TEXT / fallback strategy; requires the `[ml]` extra else passthrough (`:482-491`); proxy passes `allow_download=False` (background model fetch, `:922-948,1213-1217`); wall-clock deadline `HEADROOM_COMPRESSION_DEADLINE_MS=20000` keeps unprocessed tail verbatim (`:1240-1306`). CCR marker only when ratio <0.8 (`:1428-1437`); adopted only when ratio <0.9 (`:1880`). Remote variant POSTs to `HEADROOM_KOMPRESS_ENDPOINT/compress`, fails open, keeps CCR local (`kompress_remote.py:29-137`).

### Output token reduction (what the model writes back)

- Master switch **off by default**: `HEADROOM_OUTPUT_SHAPER=1` (`headroom/proxy/output_shaper.py:106-117`). **No `max_tokens` capping anywhere** — two mechanisms only:
  1. **Verbosity steering** — appends a sentinel-wrapped `<headroom_output_shaping>` block to the **tail** of the system prompt (cache-prefix-safe) telling the model to skip preamble/postamble and never restate code/diffs/tool output (`headroom/proxy/output_steering.py:16-46`; level texts `output_verbosity_policy.py:13-36`). Default level 2 of 0-4 (`HEADROOM_VERBOSITY_LEVEL`, `output_shaper.py:107,119-122`); optional AIMD autotune (`HEADROOM_VERBOSITY_AUTOTUNE`; floor 1, ceil 4, 3 consecutive too-verbose signals to step, 5-turn cooldown — `verbosity_controller.py:62-65`) and learned level from `headroom learn --verbosity`.
  2. **Effort routing** — only on `MECHANICAL_CONTINUATION` turns (trailing tool_result, e.g. resuming after a file read): lowers an **already-present** `output_config.effort` to `mechanical_effort="low"` (never injects; `output_shaper.py:128-135,201-239`) and clamps `thinking.budget_tokens` to floor 1024 (`output_effort_policy.py:12,26-39`). OpenAI equivalents: `reasoning.effort` lowering, `text.verbosity="low"` (gpt-5* only) (`output_shaper.py:263-285,394,498-525`). Effort router itself defaults ON once shaper is on (`HEADROOM_EFFORT_ROUTER`, `:123-127`).
- Deterministic per-conversation A/B holdout for honest measurement (`HEADROOM_OUTPUT_HOLDOUT`, default 0; `output_savings_policy.py:157-165`, `anthropic.py:2468-2490`); savings reported as estimate-with-CI or measured (`output_savings.py:195-307`).

### Conversation-history compression (no summarizer; four mechanisms)

The old rolling-window/"drop messages" stage was retired (PR-B1, `transforms/pipeline.py:86-99`) — nothing ever deletes messages. Instead:

1. **Read lifecycle** (`transforms/read_lifecycle.py`, on by default): Reads whose file was later Edited/Written (STALE) are replaced with `[Read content stale: {path}... Retrieve original: hash=...]` + CCR hash (`:328,502-514`). SUPERSEDED (re-read) compression exists but is **off** because it busts the Anthropic prefix cache (`config.py:326-329`); `min_size_bytes=512`. Frozen-prefix Reads are never touched (`:143-160`). Measured traffic: ~67% of Reads go stale, ~12% superseded (`:12-19`).
2. **Read maturation** (`transforms/read_maturation.py`, **off by default**, pilot): holds a fresh large Read (≥2048 bytes) out of the provider cache by relocating the trailing cache breakpoint before it, then converts it to a CCR marker after the file is quiet for `quiesce_turns=5` (hard cap `max_hold_turns=25`) (`config.py:332-371`; breakpoint relocation `read_maturation.py:322-378`). Motivation: median Read lives ~118 turns ≈ 13x its size in cache-read fees (`config.py:336-356`).
3. **Cross-turn dedup** (`transforms/cross_turn_dedup.py`, off unless `HEADROOM_DEDUPE=1` / coding profile): replaces a re-served verbatim span (≥3 lines and ≥40 chars) with `[↑{N}L same as msg {ref}: 'anchor']`; prefix-monotonic (cache-safe) and keep-earliest; tolerant of uniform line-renumbering (`:40-44,111-133,281-296`).
4. **System-prompt compaction** (`proxy/system_compaction.py`, opt-in `HEADROOM_SYSTEM_COMPACT=1`): routes system blocks ≥500 chars through the ContentRouter, adopts only if smaller, preserves `cache_control` (`:21-37,84-89,134`).

Aging knobs: `protect_recent` (4 default / 0 coding), `protect_recent_code=4` messages, `protect_recent_reads_fraction=0.0` (`content_router.py:1499,1530-1536`).

### Auxiliary compressors (one-liners)

- **LogCompressor** (`transforms/log_compressor.py`, Rust-backed): keeps ≤10 errors ±3 context lines, ≤3 stack traces (≤20 lines, runtime frames collapsed), ≤5 deduped warnings, summary lines, `max_total_lines=100`; CCR at ≥50 lines (`:96-119`).
- **SearchCompressor** (Rust-backed): parses `path:line:content`, relevance-scores per query (incl. CJK bigrams), keeps top matches folded by file (`search_compressor.py:1-42,53-80`).
- **DiffCompressor** (Rust-backed, hard import): `max_context_lines=2`, `max_hunks_per_file=10`, `max_files=20`, all +/- lines always kept; never chained with Kompress (would break `git apply`) (`diff_compressor.py:30-41`).
- **ConfigCompressor** (pure Python): lossless compaction → CCR-recoverable comment elision → TOML array-of-tables SmartCrusher fold (`config_compressor.py:1-93`).
- **HTMLExtractor**: trafilatura main-content extraction to markdown, ~70-90% reduction (`html_extractor.py:9-73`).
- **Tabular/Spreadsheet ingest**: CSV/TSV/markdown/fixed-width → JSON records → SmartCrusher csv-schema fold (`tabular_ingest.py:31-39`); `.xlsx/.xls` → per-sheet CSV (`spreadsheet_ingest.py:73-96`).
- **TagProtector** (Rust-backed): swaps workflow XML tags for placeholders before Kompress so ML can't mangle them (`tag_protector.py:59-123`, wired `content_router.py:3353-3359`).
- **ast-grep Read-outline interceptor** (`proxy/interceptors/astgrep.py`, opt-in `HEADROOM_INTERCEPT_ENABLED=1`): replaces `Read`/`read_file`/`view`/`cat` outputs ≥500 chars (`HEADROOM_INTERCEPT_READ_MIN_CHARS`, `:37-41`) with ast-grep-derived signature outlines + "body elided" markers (`:89`); skips ranged reads (`:51,108`), needs ≥3 definitions, 13 file extensions (`:55-70`).
- **Image compression**: separate decision/isolation path (`proxy/image_compression_decision.py`, `image_isolation.py`), disabled in cache mode (`anthropic.py:1216`).

---

## Prompt-cache interaction

Headroom's core cache invariant: **never mutate a byte the provider has already cached**; savings must come from the uncached delta or from content compressed before it first enters the cache.

- **CacheAligner is detector-only** (`transforms/cache_aligner.py:1-24,243-251`): structurally detects UUIDs/ISO-8601/JWT-shapes/hex-hashes in the system prompt and warns that the cache prefix is unstable (`:223-240,295-371`) — it never rewrites. Disabled per-request for Subscription auth (`:283-293`). Config default even `enabled=False` (`headroom/config.py:59`).
- **Default proxy mode is `cache`** — only the append-only delta beyond the frozen (provider-cached) prefix is compressed; `cache_control` is stripped from the delta copy so router guards don't skip it; the compressed delta is spliced onto the byte-stable prefix (`anthropic.py:1485-1566`; `prefix_tracker.py:123-135`).
- **`frozen_message_count`** comes from actual provider `cache_read_input_tokens` responses (`anthropic.py:2680-2685`; `PrefixFreezeConfig` `config.py:582-598`: `min_cached_tokens=1024`, `force_compress_threshold=0.5` to justify a deliberate bust). All transforms honor it (`transforms/pipeline.py:336-343`; read_lifecycle `:143-160`; CacheAligner `:314-317`). Library callers pass it via `CompressConfig.frozen_message_count` (`compress.py:118-125`).
- **`overlay_cached_prefix`** (all modes) re-forwards the exact previously-sent compressed prefix bytes so the provider's positional prefix cache still matches (`anthropic.py:1597-1606`, `prefix_tracker.py:267-359`; canonical comparison ignores `cache_control` movement, `prefix_tracker.py:158`).
- **`normalize_message_cache_control`** strips accumulated message-level `cache_control` markers and re-places a single ephemeral breakpoint on the last block (preserving explicit `ttl` like `"1h"`), keeping total breakpoints ≤ Anthropic's hard limit of 4 (`anthropic.py:1608-1616`, `prefix_tracker.py:362-420`).
- Verbosity steering appends only after any breakpoint (tail of system prompt) (`output_shaper.py:6-10`); system compaction copies `cache_control` onto rewritten blocks (`system_compaction.py:84-89`); CCR tool injection is session-sticky with pinned golden bytes to avoid tool-list churn (`helpers.py:2290-2369`); read-maturation only relocates a breakpoint, never adds one (`read_maturation.py:322-378`); superseded-Read compression stays disabled specifically because it busts the prefix (`config.py:328`); cross-turn dedup is prefix-monotonic by construction (`cross_turn_dedup.py:10-18`).

---

## Libraries it delegates to

- **litellm** (`headroom/providers/litellm.py`, `headroom/pricing/litellm_pricing.py`, `headroom/proxy/cost.py`):
  - Pricing: `litellm.cost_per_token(model, prompt_tokens, completion_tokens, cache_read_input_tokens, cache_creation_input_tokens)` → (input_cost, output_cost) is the proxy's dollar engine (`cost.py:719-728`); raw table reads from `litellm.model_cost[key]["input_cost_per_token"|"cache_read_input_token_cost"|"cache_creation_input_token_cost"]` (`cost.py:850-886`, `litellm_pricing.py:124-159`). Model-name resolution tries bare name → provider-prefixed (`anthropic/`, `openai/`, `google/`, `deepseek/`, `minimax/`...) → retirement aliases, validated by a 1-token `cost_per_token` probe, cached per name (`litellm_pricing.py:44-68`, `litellm_model_resolution.py:24-91`). Headroom patches the DB at import (MiniMax-M3, DeepSeek-V4 entries — `litellm_pricing.py:71-92,205-247`) and un-leaks litellm's `dotenv` side effect (`:26-34`).
  - Token counting / model info (optional `LiteLLMProvider`): `litellm.token_counter(model, messages)` (`providers/litellm.py:97-129`), `litellm.get_model_info(model)["max_input_tokens"/"max_output_tokens"]` (`:195-223`), `litellm.completion_cost(...)` (`:244-251`). Not installable on Python 3.14+ → dollar figures show $0 there (README).
- **tiktoken** (`headroom/tokenizers/tiktoken_counter.py`): `tiktoken.get_encoding(name)` loaded on a worker thread with a 10s timeout (`HEADROOM_TIKTOKEN_LOAD_TIMEOUT_SECONDS`, GH #956; `:106-146`); `encoding.encode(text)` (falling back to `disallowed_special=()` for special-token-looking content, `:233-252`). Model→encoding map with ordered prefixes (gpt-4o/gpt-4.1/o1/o3/o4 → o200k_base; gpt-4/gpt-3.5 → cl100k_base; default cl100k_base) (`:158-195`). Selected by regex registry (`tokenizers/registry.py:25-72`) — OpenAI-family only; Claude/Gemini/Cohere/Kimi use `EstimatingTokenCounter` with fixed chars-per-token calibrations (Anthropic 3.5, base 4.0, code 3.5, JSON 3.2, CJK 1.5 — `tokenizers/estimator.py:42-52,103-115`); Llama/Qwen/DeepSeek → HuggingFace tokenizers; Mistral → official tokenizer.
- **fastembed** (`headroom/relevance/embedding.py`): `TextEmbedding` with **`BAAI/bge-small-en-v1.5`** (384-d, int8 ONNX ~30MB), pinned to HF revision `52398278...` (`:61-81`); `model.embed(items + [context])` in one batch → cosine similarity clamped [0,1] (`:84-103,221-260`). Consumed by `HybridScorer` (`relevance/hybrid.py`): `alpha*BM25 + (1-alpha)*embedding`, base alpha 0.5, adaptive alpha 0.3-0.9 (UUID queries → 0.85 BM25-weighted) (`:64-65,141-151,191`). If fastembed is missing: boosted BM25-only (`:89-93,168-182`), with a daemon-thread prewarm that hot-swaps the embedding model in (`content_router.py:3611-3660`). The Rust SmartCrusher uses the same model via the Rust fastembed crate for byte-equal scores (`crates/headroom-core/src/relevance/embedding.rs:1-37`; Cargo `ml` feature).
- **magika** (two integrations): (1) Rust `magika` crate v1 inside `headroom._core.detect_content_type` — Tier-1 detector of the router's hot path (`crates/headroom-core/Cargo.toml:80-86,169`; `crates/headroom-core/src/transforms/magika_detector.rs`); (2) Python `Magika().identify_bytes(bytes)` → `result.output.label` / `result.score`, `min_confidence=0.5` else UNKNOWN, label maps (35 code labels → CODE; json/yaml/toml/... → JSON; log/syslog → LOG; diff → DIFF) in `headroom/compression/detector.py:52-322` — used by the `compression/universal.py` path and pre-warmed at router startup (`content_router.py:3808-3820`).
- **tree-sitter** (`tree_sitter` + `tree_sitter_language_pack`): CodeCompressor parses/verifies and body-slices 9 languages; also drives language auto-detection by parse-error counting (`code_compressor.py:154-174,682-777`).
- **ast-grep** (bundled binary, `headroom/binaries.py`): powers the opt-in Read-outline interceptor (`proxy/interceptors/astgrep.py`) and agent-facing CLI tools — not the router.
- **trafilatura**: HTML main-content extraction (`html_extractor.py:9,23-24`).
- **onnxruntime** (`headroom/_ort.py`, `onnx_runtime.py`): runs Kompress and (via Rust `ort`/fastembed/magika) the ML detection/embedding stack.

---

## Reversibility (CCR retrieval path)

1. **Compress**: any lossy compressor stores the original — Rust SmartCrusher writes to its process-local store then Python mirrors it into `CompressionStore` under the exact marker hash (`smart_crusher.py:984-1163`); Python compressors call `store.store(original, compressed, explicit_hash=key)` directly (diff `:146`, log `:528`, search `:403`, read_lifecycle `:488`, kompress, config, code).
2. **Marker**: compressed output carries `[N items compressed to M. Retrieve more: hash=HASH. Expires in 30m.]` or `<<ccr:HASH N_rows_offloaded>>` (formats above).
3. **Inject**: `headroom_retrieve` tool added to `body["tools"]` when markers are present / session has done CCR — sticky per session (`ccr/tool_injection.py:296-348`, `proxy/helpers.py:2290-2369`; Anthropic wiring `anthropic.py:1827-1897`, OpenAI `openai.py:3149-3174`).
4. **Model calls the tool** → the proxy intercepts in-flight: `ccr_response_handler.handle_response` parses CCR tool calls (hash validated as 12 or 24 hex, `tool_injection.py:452-532`), fetches `store.retrieve(hash)` (TTL-checked, access-recorded, secrets-redacted logging — `compression_store.py:387-448`), builds a provider-shaped tool_result with `{hash, original_content, original_item_count}`, and re-calls upstream — **transparent to the client**, ≤3 rounds (`ccr/response_handler.py:170-532`; mixed CCR+client-tool responses pass through untouched, `:468-475`). Streaming responses are buffered, resolved, and re-streamed (`:545-926`); streamed requests carrying the tool are pre-coerced to non-streaming (`anthropic.py:2757-2774`).
5. Alternate channels: loopback-only HTTP `POST /v1/retrieve`, `GET /v1/retrieve/{hash}`, `POST /v1/retrieve/tool_call` (`server.py:4386-4838`); MCP `headroom_retrieve` for subscription users (`ccr/mcp_server.py`); batch-API continuation via `BatchContextStore` (24h TTL) + `batch_processor.py`.
6. **Feedback**: every retrieval feeds `CompressionFeedback`, telemetry, and `TOIN.record_retrieval` (negative signal → less aggressive future recommendations) (`compression_store.py:818-922`). Proactive context tracker can re-expand relevant compressed content before the model asks, workspace-scoped to prevent cross-project leaks (`ccr/context_tracker.py:66-123,262-281`).
7. **Expiry is the weak link**: after the 30-min TTL, "lossless with retrieval" silently becomes lossy — the reason the TTL was raised from 5 min (`config.py:556-562`). Strict `lossless_only` mode produces no markers and drops nothing (`config.py:483-489`).

---

## Code References

**Entry / proxy**
- `headroom/providers/proxy_routes.py:100,207-218,439-468` — route registration, `/v1/messages`, catch-all
- `headroom/providers/route_specs.py:28-185` — declarative provider/passthrough routes
- `headroom/proxy/server.py:4859` (route hookup), `:501,537-575` (hard Rust-core requirement), `:1091-1099` (background compression env), `:1152-1187` (CCR injectors/handler/tracker), `:3167-4688` (admin/stats/CCR endpoints), `:~4933` (`HEADROOM_MODE` default cache, savings profile default coding)
- `headroom/proxy/handlers/anthropic.py:549` (handler), `:588-589,1286-1288` (auth policy), `:1049` (token count), `:1122-1153` (frozen prefix), `:1246-1265` (compression decision), `:1289-1566` (token/cache-mode compression branches), `:1597-1638` (overlay + cache_control normalize + inflation guard), `:2236-2334` (tools/system compaction), `:2446-2497` (output shaping), `:2757-2774` (CCR stream coercion), `:3096-3163` (CCR loop), `:2680-2724` (prefix tracker update, outcome)
- `headroom/proxy/compression_decision.py:71-147`; `headroom/proxy/modes.py:21-38`; `headroom/proxy/helpers.py:308-321,687-705,2290-2369`
- `headroom/proxy/handlers/openai.py:3149-3174,3609,4958`; `handlers/streaming.py:63,977,1053`
- `headroom/cache/prefix_tracker.py:123-135,158,267-359,362-420`

**Library / pipeline**
- `headroom/compress.py:77-147` (CompressConfig defaults), `:171-347` (compress), `:398-419` (pipeline singleton)
- `headroom/transforms/pipeline.py:86-99` (rolling window retired), `:123-131,202-230` (circuit breaker), `:133-167` (transform order), `:232-545` (apply)
- `headroom/agent_savings.py:110-204` (profiles), `:275-352` (proxy kwargs)
- `headroom/utils.py:46-64` (query extraction)
- `headroom/config.py:104-144` (relevance), `:148-201` (anchors), `:216-245` (excluded tools), `:310-371` (read lifecycle/maturation), `:374-407` (per-tool bias profiles), `:411-499` (SmartCrusherConfig), `:527-578` (CCRConfig + marker template), `:582-598` (PrefixFreezeConfig), `:602-635` (HeadroomConfig)

**SmartCrusher**
- `headroom/transforms/smart_crusher.py:1-19,79-100,133-141,147-236,242-275,380-443,487-519,545-734,857-982,984-1172,1230-1349`
- `crates/headroom-core/src/transforms/smart_crusher/`: `crusher.rs:442-650,761-930,945-1058,1154-1163`; `analyzer.rs:132-730`; `planning.rs:169-518`; `crushers.rs:76-532`; `outliers.rs:61-283`; `orchestration.rs:49-230`; `field_detect.rs:36-203`; `error_keywords.rs:17-42`; `config.rs:44-159`
- `headroom/transforms/adaptive_sizer.py:27-154,276-329`; `anchor_selector.py:364-439`
- `crates/headroom-py/src/lib.rs:327-329,711-904,1803-1804`; `crates/headroom-py/Cargo.toml:20-22`; `pyproject.toml:395-398`
- `headroom/proxy/compression_policy.py:45-66,103-116,247-266`; `crates/headroom-core/src/compression_policy.rs:119-176`

**ContentRouter / detection / aux**
- `headroom/transforms/content_router.py:140-204,442-452,761-969,978-1009,1307-1321,1439-1582,1771-1789,2232-2304,2306-2379,2422-2475,2642-2688,2815-3140,3353-3384,3611-3715,3808-3820,3951-3972,5047-5063,5255-5388`
- `headroom/transforms/content_detector.py:49-223,278-771`
- `headroom/compression/detector.py:52-322,410-421`
- `crates/headroom-core/src/transforms/{magika_detector.rs,unidiff_detector.rs,detection.rs}`; `crates/headroom-core/Cargo.toml:80-86,160-169`
- `headroom/transforms/code_compressor.py:64-174,213-269,323-529,614-777,1117-1294,1590-1857`
- `headroom/transforms/{log_compressor.py:96-119, search_compressor.py:1-80, diff_compressor.py:30-41,129-152, config_compressor.py:1-93, html_extractor.py:9-73, tabular_ingest.py:31-71, spreadsheet_ingest.py:73-96, mixed_content.py:30-159, tag_protector.py:59-123, lossless_compaction.py:48-51,368-415}`
- `headroom/proxy/interceptors/astgrep.py:37-110` (+ `transforms/pipeline.py:139-152`)

**Kompress / relevance / history**
- `headroom/transforms/kompress_compressor.py:41-114,482-582,922-1000,1192-1462,1864-1888`; `kompress_remote.py:29-137`; `headroom/onnx_runtime.py:54-69`; `headroom/_ort.py`
- `headroom/relevance/{bm25.py:52-268, embedding.py:61-260, hybrid.py:64-250, __init__.py:72-124}`; `headroom/transforms/relevance_split.py:32-174`; `crates/headroom-core/src/relevance/embedding.rs:1-37`
- `headroom/transforms/read_lifecycle.py:12-19,41-46,143-160,292-346,488-514`; `read_maturation.py:1-38,164-205,285-378`; `cross_turn_dedup.py:10-44,54-296`; `headroom/proxy/system_compaction.py:21-146`

**CCR / TOIN**
- `headroom/ccr/tool_injection.py:22,25-144,182-210,227-348,452-532`; `response_handler.py:64-926`; `context_tracker.py:66-281`; `mcp_server.py:72,195-197,398-429`; `batch_store.py:25-144`; `tool_calls.py:19-121`
- `headroom/cache/compression_store.py:51-88,136-176,253-448,488-519,675-783,818-922,926-1035`; `headroom/cache/backends/sqlite.py:36-166`
- `headroom/proxy/{models.py:172-187, ccr_session_tracker.py:9-88, ccr_golden_policy.py:12-52, ccr_marker_policy.py:8-45}`
- `headroom/telemetry/toin.py:1-59,90-172,180-411,466-503,521-1063,1166-1606`; `telemetry/models.py:93,354`; `telemetry/beacon.py:1-12`; `headroom/cli/toin_publish.py:53-218`; `crates/headroom-core/src/transforms/recommendations.rs`

**Output shaping**
- `headroom/proxy/output_shaper.py:106-135,139-186,201-285,394,498-525`; `output_steering.py:16-131`; `output_verbosity_policy.py:7-36`; `output_effort_policy.py:10-55`; `verbosity_controller.py:62-65`; `output_savings_policy.py:157-165`; `output_savings.py:195-307`

**Libraries / pricing / tokenizers**
- `headroom/providers/litellm.py:34-57,90-135,191-255`; `headroom/pricing/litellm_pricing.py:26-92,124-247`; `litellm_model_resolution.py:24-91`; `headroom/proxy/cost.py:637-886`
- `headroom/tokenizers/{registry.py:25-125, tiktoken_counter.py:80-260, estimator.py:42-119}`; `headroom/tokenizer.py:14-48`

**Entry modes**
- `headroom/cli/wrap.py:1-16`; `headroom/cli/mcp.py:1-115`; `headroom/cli/init.py:178`

**Known doc/code discrepancies found during trace**
- CCR TTL docstrings say 5 min; enforced default is 1800s (`compression_store.py:51` vs `:204`).
- Rust lossless-threshold prose says 0.30; code and parity test pin 0.15 (`crusher.rs:186-188` vs `config.rs:151,189`).
- `toin_confidence_threshold`: 0.3 in `headroom/config.py:458` vs 0.5 in `transforms/smart_crusher.py:182`.
- Output shaping README implies broad coverage; there is no `max_tokens` capping anywhere in the shaper.
