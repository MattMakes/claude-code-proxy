# Headroom — Cost Tracking, Savings Measurement & Dashboard

> Headroom measures savings by recording, for every proxied request, the pre-compression token count vs. the tokens actually forwarded (plus the provider's own usage breakdown of cached/uncached tokens), then prices saved tokens at each model's LiteLLM list price to reconstruct a "cost without Headroom" baseline (`cost_without = cost_with + savings`), with prompt-cache discounts and cache-write premiums accounted separately.

**Entry points:**
- `headroom/proxy/outcome.py:314` — `emit_request_outcome` (the single per-request bookkeeping funnel)
- `headroom/proxy/cost.py:637` — `CostTracker` (litellm pricing, budget, `$` savings)
- `headroom/proxy/cost.py:113` — `build_prefix_cache_stats` (cache discount math)
- `headroom/proxy/prometheus_metrics.py:69` — `PrometheusMetrics` (live counters + `/metrics` export at `:964`)
- `headroom/proxy/savings_tracker.py:543` — `SavingsTracker` (durable `proxy_savings.json`)
- `headroom/savings_ledger.py:119` — durable append-only savings ledger (`headroom savings`)
- `headroom/proxy/server.py:3530` — `_build_stats_payload` (`/stats`); routes `:4142` `/stats`, `:4183` `/stats-lifetime`, `:4210` `/stats-history`, `:4261` `/transformations/feed`, `:4338` `/metrics`, `:3295` `/dashboard`
- `headroom/dashboard/templates/dashboard.html` — the local dashboard SPA (Alpine.js)
- `headroom/ccr/mcp_server.py:835` — `headroom_stats` MCP tool

**Last traced:** 2026-07-19

---

## How savings are measured (before/after token accounting — exact flow and formulas)

### Per-request capture

Every handler builds an immutable `RequestOutcome` at end of request (`headroom/proxy/outcome.py:36`). The load-bearing fields (`outcome.py:64-81`):

- `original_tokens` — pre-compression request size (Headroom's own count)
- `optimized_tokens` — post-compression tokens actually forwarded upstream
- `tokens_saved` — `original - optimized` (0 if compression bypassed)
- `attempted_input_tokens` — compressible-only denominator (extracted units + tool schemas; excludes user/system messages, frozen prefix). Derived as `optimized_tokens + tokens_saved` in `RequestOutcome.from_stream` (`outcome.py:289`)
- `cache_read_tokens` / `cache_write_tokens` / `cache_write_5m_tokens` / `cache_write_1h_tokens` / `uncached_input_tokens` — **from the provider's response `usage`** (Anthropic reports all five; OpenAI read + inferred write with `cache_inferred=True`; Gemini read only; Bedrock mirrors Anthropic — `outcome.py:70-82`)
- `status_code >= 500` short-circuits the funnel: a failed upstream request is recorded via `record_failed` only and never feeds savings/cost stats (`outcome.py:366-368`)

### The funnel (`emit_request_outcome`, `outcome.py:314`)

Four effects, canonical order:

1. `metrics.record_request(...)` — Prometheus counters + SavingsTracker (`outcome.py:392-413`). Note `input_tokens = outcome.optimized_tokens` — the *forwarded* count.
2. `cost_tracker.record_tokens(...)` — cost/budget accounting (`outcome.py:416-428`; skipped with `--no-cost`)
3. `logger.log(RequestLog(...))` — per-request log feed (`outcome.py:435-463`)
4. Structured `PERF` log line: `tok_before= tok_after= tok_saved= cache_read= cache_write= ...` (`outcome.py:470-483`), consumed by `headroom perf`.

### In-memory session accumulation (`PrometheusMetrics.record_request`, `prometheus_metrics.py:664`)

- Negative `tokens_saved` is clamped to 0 with a debug log — handlers revert any inflation before sending, so savings are ≥0 by construction (`prometheus_metrics.py:694-700`; same clamp in `cost.py:782-788`).
- Accumulates `tokens_input_total` (post-compression), `tokens_output_total`, `tokens_saved_total`, `attempted_input_tokens_total` (`:709-714`).
- Per-provider prefix-cache dict `cache_by_provider` (read/write/5m/1h/uncached tokens, requests, hit_requests, bust_count/bust_write_tokens) (`:717-741`).
- **Bust heuristic**: for Anthropic, after a model's first request (cold start exempt), a request where `cache_write_tokens > (read+write) * 0.5` counts as a bust (`:735-741`).
- `savings_history`: `(iso_timestamp, cumulative tokens_saved_total)` appended per request, last 500 points kept (`:774-778`).
- Feeds `SavingsTracker.record_lifetime_request` + `record_request` (`:780-811`), then appends to the durable **savings ledger** when `tokens_saved > 0`: `record_savings_event(tokens_before=input+saved, tokens_after=input, ...)` — before is reconstructed as forwarded+saved so `saved/before` is the true reduction percent (`:819-835`).

### Percent formulas in `/stats` (`server.py:3894-3931`)

- `active_savings_percent = tokens_saved_total / attempted_input_tokens_total * 100` — the dashboard headline ("how well do we compress what we tried to compress")
- `proxy_savings_percent = saved / (tokens_input_total + saved) * 100` — whole-wire ratio (diluted by frozen prefix)
- `new_input_savings_percent = saved / (new_input_tokens + saved) * 100` where `new_input_tokens = uncached_input + cache_write` from provider usage (`server.py:3667-3670`) — avoids recounting the full cached transcript every turn; reports 0 (not 100%) when no cache usage data exists
- `savings_percent` (all layers) `= (proxy_saved + cli_tokens_avoided) / (tokens_input_total + proxy_saved + cli_avoided) * 100` (`server.py:3640-3643, 3915-3920`)

### "Would-have-cost" baseline (`build_session_summary`, `cost.py:548-554`)

```
cost_with    = cost_tracker.stats()["cost_with_headroom_usd"]   # actual billed input, cache-priced
savings      = cost_tracker.stats()["savings_usd"]              # saved tokens × list price
cost_without = cost_with + savings
savings_pct  = savings / cost_without * 100
```

Layer separation is deliberate (`merge_cost_stats`, `cost.py:366-403`): `savings_usd` (dollars) is **compression-only at list price** (monotonic; avoids the moving-average repricing bug #83); `cache_savings_usd` is the provider discount, kept separate; CLI-filtering tokens are counted in token savings but never dollar-priced (those tokens never reached the proxy so there's no model to price against).

### Display session (`savings_tracker.py:664-841`)

Every request updates a persisted `display_session` (requests, tokens_saved, `compression_savings_usd`, `cache_read_tokens`, `cache_savings_usd`, input tokens/cost, `savings_percent = saved / (saved + input) * 100`). The session rolls over after **60 minutes of inactivity** (`DEFAULT_DISPLAY_SESSION_INACTIVITY_MINUTES = 60`, `savings_tracker.py:40`). Lifetime counters accumulate forever; history checkpoints are appended whenever compression, cache reads, or output shaping saved anything (`:819-838`).

---

## Cost model (pricing source, $ math, cache-read discount math)

### Pricing source: LiteLLM community DB

- Lazy-imported (`cost.py:23-42`); its `.env`-loading side effect is neutralized at import in `headroom/pricing/litellm_pricing.py:26-39`.
- Model-name resolution: try as-is via `litellm.cost_per_token(model, 1, 0)`, else prefix (`claude-`→`anthropic/`, `gpt-/o1-/o3-/o4-`→`openai/`, `gemini-`→`google/`) — `savings_tracker.py:167-200`; cached per model in `litellm_pricing.py:44-53`. MiniMax-M3 and DeepSeek-V4 prices are pre-registered/injected (`litellm_pricing.py:71-92, 205-247`).
- `LITELLM_AVAILABLE` flag surfaced in `/stats` so the dashboard can explain a $0.00 tile on Python ≥3.14 (`server.py:4030-4036`).

### Per-request cost (budget path)

`CostTracker.estimate_cost` calls `litellm.cost_per_token(model, prompt_tokens=input, completion_tokens=output, cache_read_input_tokens=cr, cache_creation_input_tokens=cw)` — litellm natively prices cache reads (~10%) and writes (~125%) (`cost.py:687-732`). Cost tuples `(timestamp, cost)` go into a deque (max 100,000 entries; 744 h = 31-day retention, pruned every 5 min — `cost.py:648-652, 734-751`). Budget: `get_period_cost` sums since hour-start/day-start/month-start, `check_budget` returns `(remaining > 0, max(0, remaining))` (`cost.py:828-848`). Config: `budget_limit_usd=None`, `budget_period="daily"` (`proxy/models.py:310-311`).

### Session cost + savings (`CostTracker.stats`, `cost.py:888-963`)

Prices per model from `_get_cache_prices` (`cost.py:865-886`): `(cache_read_input_token_cost, cache_creation_input_token_cost, input_cost_per_token)`, both cache prices defaulting to the uncached price when litellm lacks them.

```
# actual billed input cost (uses API-reported cache breakdown when present)
cost_with_headroom = Σ_model  cr*cr_price + cw*cw_price + uncached*uncached_price
                     (fallback when no cache data: tokens_sent * uncached_price)   # cost.py:912-935

# compression savings — simple, monotonic, list-price valuation
savings_usd = Σ_model  tokens_saved_by_model * uncached_price                      # cost.py:940-948

# per-model reduction
reduction_pct = saved / (saved + sent) * 100                                       # cost.py:903
```

`_get_list_price` = `input_cost_per_token * 1_000_000` ($/1M) (`cost.py:850-863`).

### Durable-tracker pricing (`savings_tracker.py`)

- Compression $: `tokens_saved * input_cost_per_token`; fallback blended rate **$3/1M input** when litellm is missing/can't price (`DEFAULT_FALLBACK_INPUT_COST_PER_TOKEN = 3.0/1e6`, `:41, 203-223`). A *present* `0.0` price is honored as free (no phantom savings) — only a *missing* key falls back (`:216-221`).
- Output-shaping $: priced at the model's **output** rate, fallback **$15/1M** (`:43, 226-250`).
- Cache-read $: `cache_read_tokens * (input_cost_per_token − cache_read_input_token_cost)`, 0 if no discount (`_estimate_cache_savings_usd`, `:253-286`). Deliberately diverges from `cost.py`'s session multipliers — lifetime figures use per-model litellm pricing.
- Input spend: prefers the segmented breakdown `cr*cr_cost + cw*cw_cost + uncached*input_cost` (never adds `input_tokens` on top), else `input_tokens * input_cost`, else fallback rate (`_estimate_input_cost_usd`, `:289-349`).

### Ledger pricing (`savings_ledger.py:90-116`)

Cost is computed **at write time** so history doesn't drift with price changes. Known models → `_estimate_compression_savings_usd`; `model="unknown"` (MCP-tool compressions don't know the upstream model) → blended $3/1M directly.

---

## Prompt cache hit/miss accounting

### Session-scoped discount math (`build_prefix_cache_stats`, `cost.py:113-363`)

Provider multipliers (`_CACHE_ECONOMICS`, `cost.py:49-70`):

| provider | read multiplier | write multiplier | label |
|---|---|---|---|
| anthropic | 0.1 | 1.25 | Explicit breakpoints, 5-min TTL |
| openai | 0.5 | 1.0 | Automatic, no TTL control |
| gemini | 0.1 | 1.0 | Explicit cachedContent, configurable TTL |
| bedrock | 0.1 | 1.25 | Same as Anthropic (Bedrock) |

Base price = list input price of the **provider-matching model with the highest token volume** (fixes ~3.75× skew when Haiku happened to be seen before Sonnet — `cost.py:150-166`). Then:

```
savings_usd        = cache_read_tokens  * price_per_token * (1.0 - read_mult)      # cost.py:183
write_premium_usd  = cache_write_tokens * price_per_token * (write_mult - 1.0)     # cost.py:186 (only if write_mult > 1)
net_savings_usd    = savings_usd - write_premium_usd                                # cost.py:215, 256
hit_rate           = cache_read / (cache_read + cache_write + uncached) * 100       # token-level, cost.py:192
request_hit_rate   = hit_requests / requests * 100                                  # cost.py:193-195
```

Also emitted: observed TTL bucket mix (5m vs 1h write tokens/requests + percentages, `cost.py:228-238, 269-295`), `prefix_freeze` net benefit (`tokens_preserved − compression_foregone`, `:341-348`), and `compression_vs_cache` (`tokens_saved_total − cache_bust_tokens_lost`, `:349-354`). An explicit `attribution` string states caching is provider-performed and Headroom only observes it (`:355-362`).

### Miss attribution (#1313)

`record_cache_miss_attribution(provider, reason)` with reasons `ttl_expiry | prefix_change | unknown` from `PrefixCacheTracker.classify_cache_miss`; cold starts/hits never recorded (`prometheus_metrics.py:898-909`). Aggregated with `ttl_expiry_pct` / `prefix_change_pct` computed over *attributed* misses only, so `unknown` doesn't dilute the split (`cost.py:326-332`).

### Cache busts

`record_cache_bust(tokens_lost)` increments `cache_bust_tokens_lost` / `cache_bust_count` (`prometheus_metrics.py:890-896`) — tokens that lost their cache discount because compression changed the prefix. Mirrored into the durable lifetime aggregate.

### Actual billing

The real cache-aware dollars use litellm's per-model `cache_read_input_token_cost` / `cache_creation_input_token_cost`, in `CostTracker.stats` (`cost.py:912-935`), `estimate_cost` (`:719-725`) and `_estimate_input_cost_usd`/`_estimate_cache_savings_usd` (`savings_tracker.py:280-284, 332-345`).

---

## Semantic cache (algorithm, threshold, stats)

**Not embedding similarity** — despite the name, `SemanticCache` (`headroom/proxy/semantic_cache.py:25`) is an **exact-match content-hash response cache**:

- Key = first 32 hex chars of SHA-256 over `json.dumps({"model", "messages", **key_fields}, sort_keys=True)`, with `cache_control` annotations recursively stripped so a moved cache breakpoint doesn't fragment the key (`semantic_cache_key_policy.py:10-33`). `key_fields` carries every generation-shaping field (system, tools, sampling params) from the handler's snapshot (`semantic_cache.py:38-53`).
- LRU via `OrderedDict` with O(1) `move_to_end`/`popitem`; defaults `max_entries=1000`, `ttl_seconds=3600` (`semantic_cache.py:31`; `ProxyConfig.cache_enabled=True`, `cache_ttl_seconds=3600`, `cache_max_entries=1000` at `proxy/models.py:289-291`). Expiry checked on `get`; hit bumps `hit_count` (`:64-73`).
- Used only for **non-streaming** requests (`handlers/anthropic.py:991-992`, `handlers/openai.py:2798`). A hit means the provider is never contacted: the funnel gets `RequestOutcome(..., original/optimized/output/saved=0, from_response_cache=True)` (`anthropic.py:1012-1030`) which drives `requests_cached` and the `cached` boolean (`outcome.py:88, 148-161`).
- What a hit saves: the entire upstream call (100% of that request's cost/latency). `CacheEntry.tokens_saved_per_hit` is stored at `set()` time (`semantic_cache.py:96-102`, `proxy/models.py:108`) but is not currently rolled into any savings metric.
- Stats (`semantic_cache.py:104-113`, surfaced as `/stats["cache"]`, `server.py:4084`): `{entries, max_entries, total_hits, ttl_seconds}`. Misses/evictions are explicitly not tracked (`:152-153`). `POST /cache/clear` empties it (`server.py:4370`).

(Separately, token-mode has a per-session `CompressionCache` with hits/misses/hit_rate/total_tokens_saved surfaced as `/stats["compression_cache"]` — `server.py:3684-3712`.)

---

## Dashboard (every view/panel, data source endpoints)

Served at `GET /dashboard` (`server.py:3295`) from `headroom/dashboard/templates/dashboard.html` (bundled into the wheel by maturin's package-directory include — `pyproject.toml:381-384`). Single-page Alpine.js app; dark/light theme; settings page at `GET /dashboard/settings` (`server.py:3435`, `templates/settings.html` — schema-driven config editor backed by `/settings/schema`, `GET/POST /settings`, `/settings/apply`, loopback-only).

**Refresh model** (`dashboard.html:1834-1881`): master `setInterval` every **5 s** (`statsPollMs=5000`) calling `fetch('/stats?cached=1')` + `fetch('/health')`; the server keeps a **5 s** TTL snapshot for this fast path (`DASHBOARD_STATS_CACHE_TTL_SECONDS = 5.0`, `server.py:3454`). Lifetime view refetches `/stats-lifetime` every **30 s**, History `/stats-history` every **30 s**, live Feed `/transformations/feed?limit=50` every **5 s** when open. Polling pauses when the tab is hidden; `r` key forces refresh. Sparkline history = last 30 poll samples client-side.

Three view modes (`Session | Lifetime | History`, `dashboard.html:117-128`) plus a slide-out Feed:

### Session view (`dashboard.html:192-1272`) — fed by `/stats?cached=1`
| Panel | Metrics | JSON source |
|---|---|---|
| Request Health | completed / failed / rate-limited / cached | `requests.*` |
| Live Activity | active requests, active WebSockets, relay tasks, compression queued | `proxy_inbound.active`, `runtime.websocket_sessions.*`, `runtime.compression_executor.queued` |
| Token Savings | tokens saved, headline active % (falls back to whole-request % when attempted denominator missing, #455), Proxy vs CLI-filter split, "of total wire %", sparkline | `tokens.saved`, `tokens.active_savings_percent`, `tokens.proxy_compression_saved`, `tokens.savings_percent` |
| Output Tokens Saved | counterfactual output savings, %, `measured` (A/B holdout) vs `estimated` label, 95% CI, shaped-response count | `tokens.output_reduction.*` (from `output_savings.get_recorder().estimate()`, `server.py:3745-3762`) |
| Tool-Schema Deferral | tokens + calls with schemas deferred (only when >0) | `savings.by_layer.tool_search` |
| Overhead | avg optimization overhead ms, TTFB avg | `overhead.average_ms`, `ttfb.average_ms` |
| Throughput | input wall/active p50, compression p50/p95, forward p50/p95, generation p50/p95 tok/s; current 5-min window | `throughput.rolling/current` |
| Performance | overhead range, TTFB range, failed count, per-transform pipeline timing avg/max | `overhead`, `ttfb`, `pipeline_timing` |
| Token Usage | before compression, CLI-filtered, proxy removed, after (sent), output | `tokens.total_before_compression`, `tokens.proxy_compression_saved`, `tokens.input`, `tokens.output` |
| What Headroom Removed | waste-signal bars (json_noise, base64, whitespace, …) | `waste_signals` |
| Savings Over Time | cumulative savings trend | `savings_history` (last 100 points) |
| Prefix Cache Impact | net savings $, cache writes + write-premium $, token hit-rate % (color-coded >80/>50), busts + tokens re-written, provider count, cache-efficiency stacked bar, per-provider table | `prefix_cache.totals/by_provider` |
| TTL Bucket Mix | 1h vs 5m observed cache-write tokens/requests/percentages | `prefix_cache.totals.observed_ttl_buckets/observed_ttl_mix` |
| Compression vs Cache | tokens saved by compression vs lost to busts, net (+/−), prefix-freeze net | `prefix_cache.compression_vs_cache`, `prefix_cache.prefix_freeze` |
| Cache-Miss Attribution | ttl_expiry / prefix_change / unknown counts + headline split | `prefix_cache.miss_attribution` |
| (further session panels) | agent usage, per-model/strategy breakdowns, recent requests table with per-request before/after/saved/transforms, display-session card | `agent_usage`, `compressions_by_strategy`, `tokens_saved_by_strategy`, `recent_requests`, `display_session` |

### Lifetime view (`dashboard.html:1274-1310`) — fed by `/stats-lifetime` (durable `PersistentMetricsState.snapshot`, `persistent_metrics.py:439-470`)
Panels: **Tokens** (input/output/attempted/saved/`token_savings_percent = saved/attempted_input`); **Cost** (input $, compression saved $, prefix-cache saved $); **Prefix Cache** (hits/requests, hit rate, read/write tokens, TTL 1h/5m %, busts); **Cache Miss Attribution**; **Waste Signals**; **Providers**; **Stacks**; **Top Models + Other** (bounded at 100 exposed / 200 tracked models, `persistent_metrics.py:14-15`).

### History view (`dashboard.html:1387-1798`) — fed by `/stats-history`
Cards: Lifetime Compression Savings $ ("proxy compression only"), Lifetime Tokens Saved (+ checkpoint count), Active Days, Average Saved/Day, Average Saved/Week, CLI-filter Lifetime Saved. Chart with granularity **hourly/daily/weekly/monthly/checkpoints** and mode **tokens/$**, per-model series overlay, per-provider/per-model bucket attribution; monthly rollup list; **Export JSON / Export CSV** buttons hitting `/stats-history?format=csv&series=...` (`server.py:4210-4235`, CSV via `SavingsTracker.export_csv`, `savings_tracker.py:1094-1125`).

### Live Feed (drawer, `dashboard.html:1800+`)
Virtualized list from `/transformations/feed?limit=50` (loopback-only, `server.py:4261-4306`): per-request original vs optimized tokens, savings %, transforms applied, and (only when `log_full_messages` is on) full request/compressed/response bodies.

---

## Prometheus metrics (full table: name, type, labels, meaning)

Exported by `PrometheusMetrics.export()` (`prometheus_metrics.py:964-1564`) at `GET /metrics` (`server.py:4338`), hand-rendered text format.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `headroom_requests_total` | counter | — | Total requests (`:978`) |
| `headroom_requests_cached_total` | counter | — | Responses served from Headroom's response cache (`:985`) |
| `headroom_requests_rate_limited_total` | counter | — | Rate-limited requests (`:992`) |
| `headroom_requests_failed_total` | counter | — | Failed requests (`:999`) |
| `headroom_inbound_requests_total` | counter | — | All inbound HTTP requests accepted (`:1006`) |
| `headroom_inbound_requests_completed_total` | counter | — | Inbound requests completed/aborted (`:1013`) |
| `headroom_inbound_requests_active` | gauge | — | Inbound requests currently active (`:1020`) |
| `headroom_tokens_input_total` | counter | — | Total (post-compression) input tokens (`:1027`) |
| `headroom_tokens_output_total` | counter | — | Total output tokens (`:1034`) |
| `headroom_tokens_saved_total` | counter | — | Tokens saved by optimization (`:1041`) |
| `headroom_persistent_savings_requests_total` | counter | — | Durable lifetime requests (savings tracker) (`:1048`) |
| `headroom_persistent_savings_tokens_saved_total` | counter | — | Durable lifetime input tokens saved (`:1055`) |
| `headroom_persistent_savings_input_tokens_total` | counter | — | Durable lifetime input tokens (`:1062`) |
| `headroom_persistent_savings_input_cost_usd_total` | counter | — | Durable lifetime input spend USD (`:1069`) |
| `headroom_persistent_savings_compression_savings_usd_total` | counter | — | Durable lifetime compression savings USD (`:1076`) |
| `headroom_latency_ms_sum` / `_count` | counter | — | Request latency sum/count (`:1093-1105`) |
| `headroom_latency_ms_min` / `_max` | gauge | — | Latency min/max (`:1107-1119`) |
| `headroom_overhead_ms_sum` / `_count` | counter | — | Headroom optimization overhead (`:1121-1133`) |
| `headroom_overhead_ms_min` / `_max` | gauge | — | Overhead min/max (`:1135-1147`) |
| `headroom_ttfb_ms_sum` / `_count` | counter | — | Time-to-first-byte sum/count (`:1149-1161`) |
| `headroom_ttfb_ms_min` / `_max` | gauge | — | TTFB min/max (`:1163-1175`) |
| `headroom_cache_bust_total` | counter | — | Requests that lost cache efficiency to compression (`:1177`) |
| `headroom_cache_bust_tokens_lost_total` | counter | — | Tokens that lost the cache discount (`:1184`) |
| `headroom_cache_miss_attribution_total` | counter | `provider`, `reason` (ttl_expiry\|prefix_change\|unknown) | Misses on an expected-cached prefix by reason (`:1192-1206`) |
| `headroom_compression_failed_total` | counter | `reason` (timeout\|error) | Fail-open compression failures (`:1215-1226`) |
| `headroom_kompress_size_gate_total` | counter | `outcome` (within\|exceeded) | Kompress size-gate decisions (`:1228-1239`) |
| `headroom_compression_quarantine_total` | counter | `event` (activated\|skipped) | Timeout-debt quarantine events (`:1241-1252`) |
| `headroom_requests_by_provider` | counter | `provider` | Requests per provider (`:1254-1262`) |
| `headroom_requests_by_model` | counter | `model` | Requests per model (`:1264-1272`) |
| `headroom_transform_timing_ms_sum` / `_count` | counter | `transform` | Per-transform timing (`:1274-1295`) |
| `headroom_transform_timing_ms_max` | gauge | `transform` | Per-transform max ms (`:1296-1307`) |
| `headroom_stage_timing_ms_sum` / `_count` | counter | `path`, `stage` | Per-stage handler timing (`:1309-1330`) |
| `headroom_stage_timing_ms_max` | gauge | `path`, `stage` | Per-stage max ms (`:1331-1342`) |
| `headroom_active_ws_sessions` | gauge | — | Active Codex WS sessions (`:1345-1349`) |
| `headroom_active_relay_tasks` | gauge | — | Active Codex WS relay tasks (`:1351-1353`) |
| `headroom_ws_session_duration_ms_sum` / `_count` | counter | `cause` | Completed WS session durations by termination cause (`:1357-1378`) |
| `headroom_ws_session_duration_ms_max` | gauge | `cause` | Max WS session duration (`:1379-1390`) |
| `headroom_waste_signal_tokens_total` | counter | `signal` | Tokens attributed to detected waste signals (`:1392-1403`) |
| `headroom_cache_read_tokens_total` | counter | `provider` | Provider cache-read tokens (`:1405-1415`) |
| `headroom_cache_write_tokens_total` | counter | `provider` | Provider cache-write tokens (`:1416-1426`) |
| `headroom_cache_write_ttl_tokens_total` | counter | `provider`, `ttl` (5m\|1h) | Cache-write tokens by observed TTL bucket (`:1427-1440`) |
| `headroom_cache_write_ttl_requests_total` | counter | `provider`, `ttl` | Cache-write requests by TTL bucket (`:1441-1454`) |
| `headroom_uncached_input_tokens_total` | counter | `provider` | Input tokens not served from provider cache (`:1455-1465`) |
| `headroom_provider_cache_requests_total` | counter | `provider` | Requests with provider cache observations (`:1466-1476`) |
| `headroom_provider_cache_hit_requests_total` | counter | `provider` | Requests with cache reads (`:1477-1487`) |
| `headroom_provider_cache_bust_total` | counter | `provider` | Provider-specific bust count (`:1488-1498`) |
| `headroom_provider_cache_bust_write_tokens_total` | counter | `provider` | Write tokens attributed to busts (`:1499-1510`) |
| `proxy_image_generation_call_log_redacted_total` | counter | — | Base64 image payloads redacted from request logs (`:1525-1534`; counter lives in `request_logger.py:54-66`) |
| `wrap_rtk_invocations_total` | counter | `tool` (`__init__` zero-row sentinel on fresh boot) | RTK invocations via the wrap CLI tail (`:1544-1562`) |

Note: per-strategy compression counters (`compressions_by_strategy`, `tokens_saved_by_strategy`) are **deliberately not exported** as Prometheus series; they're observable via `/stats` only (`:1086-1092`).

---

## Stats/reporting surfaces (MCP tool, CLI, reports)

### `headroom_stats` MCP tool (`headroom/ccr/mcp_server.py:74, 835-898`)
- Local `SessionStats` (`:281-350`): compressions, retrievals, input/output tokens, `total_tokens_saved = Σ max(0, in−out)`, `savings_percent = saved/input*100`, `estimated_cost_saved_usd = saved * $3/1M` (blended, `:337-338`), last-10 events.
- Cross-process aggregation: reads the file-locked shared log (`session_stats.jsonl`, 2-hour window — `:202-204`), splits `sub_agents` (other PIDs) and `combined` totals (`:847-871`).
- If the proxy is reachable it fetches `GET /stats` and renders `_format_session_summary` (`:98-192`): mode, API requests, compression avg/best, tokens removed, uncompressed reasons, **Cost Impact** ("Without Headroom / With Headroom / You saved $X (Y%)" with cache/compression breakdown), MCP-tool totals, and Lifetime Savings.
- Companion tools: `headroom_compress` and `headroom_retrieve` record `compress`/`retrieve` events; the proxy's `/stats` folds them in via `_aggregate_mcp_events` (`cost.py:406-454`) — `retrievals` is the over-compression signal.

### `headroom savings` CLI (`headroom/cli/savings.py:48-105`)
Reads the durable ledger via `aggregate_savings` (`savings_ledger.py:288-353`): bar rows for **Today** (local calendar day) / **Last 7 days** (rolling 168 h) / **Last 30 days** (= bounded lifetime), each with `savings_percent = tokens_saved/tokens_before*100`, tokens, `$` cost avoided; then **cost avoided per model** and **savings by client** (claude-code, codex, proxy, …). `--json`, `--days 1..30`, `--reset`.

### `headroom perf` CLI (`headroom/cli/perf.py:12-40`)
Parses the structured `PERF` lines from `~/.headroom/logs/proxy.log` (default last 168 h): token savings, cache hit rates/prefix stability, transform/routing breakdown, TOIN status, recommendations; `--format text|json|csv`, `--raw`, client filtering.

### HTTP surfaces
`/stats` (full aggregate; `?cached=1` 5 s snapshot; per-request tail + config loopback-only — `server.py:4142-4181`), `/stats-lifetime` (`:4183`), `/stats-history` (JSON or CSV export of `history|hourly|daily|weekly|monthly` — `:4210`), `POST /stats/reset` (`:4198`), `/transformations/feed` (`:4261`), `/metrics` (`:4338`), `/subscription-window`, `/quota`.

### `headroom/reporting/generator.py` (SDK-side HTML report)
`generate_report(store_url, output_path, start, end)` (`generator.py:309-383`) reads SDK storage (`sqlite://` or `jsonl://`) and renders a self-contained Jinja2 HTML report (template embedded at `:29-306`): stat cards (Total Requests, Tokens Saved, Avg Saved/Request, **Est. Cost Savings** — computed as `estimate_cost(before, 0, "gpt-4o") − estimate_cost(after, 0, "gpt-4o")` at `:339-342`, Cache Alignment %, **TPM Headroom multiplier** `= total_before / max(total_after, 1)` at `:334-336`); waste histogram (json_bloat, html_noise, base64, whitespace, dynamic_date, reread, reread_compressed, and derived `history_bloat = max(0, saved − known_waste)` excluding reread — `:386-453`); top-10 high-waste requests (`:456-487`); rule-based recommendations (cache alignment <50, tool JSON bloat >10k, history bloat >50k, audit>2×optimize — `:490-560`).

---

## Persistence (schemas)

### `~/.headroom/proxy_savings.json` — `SavingsTracker`, schema v5 (`savings_tracker.py:35, 1148-1164, 1414-1480`)
```
{ schema_version: 5,
  lifetime: { requests, tokens_saved, compression_savings_usd, cache_read_tokens,
              cache_savings_usd, total_input_tokens, total_input_cost_usd,
              output_tokens_saved, output_savings_usd },
  display_session: { requests, tokens_saved, compression_savings_usd, cache_read_tokens,
                     cache_savings_usd, total_input_tokens, total_input_cost_usd,
                     savings_percent, started_at, last_activity_at },   # 60-min inactivity rollover
  history: [ { timestamp, provider, model, total_tokens_saved, compression_savings_usd,
               cache_read_tokens, cache_savings_usd, total_input_tokens,
               total_input_cost_usd, output_tokens_saved, output_savings_usd } ],
  projects: { <name>: { requests, tokens_saved, compression_savings_usd,
                        total_input_tokens, total_input_cost_usd, last_activity_at } },  # max 50
  by_model: { <model>: { requests, tokens_saved, compression_savings_usd,
                         total_input_tokens, total_input_cost_usd } },
  lifetime_metrics: <PersistentMetricsState v5> }
```
Retention: 5,000 history points / 365 days (`:36-38`); responses compact to 500 points (dense recent tail + even sampling of older, `:1360-1393`). Writes are throttled (every 25 requests from the proxy, `PROXY_SAVINGS_FLUSH_EVERY=25`, `prometheus_metrics.py:66`; flushed on shutdown) and atomic (tmp file + fsync + rename + parent-dir fsync, `:1436-1468`). Corrupt files are preserved as `.corrupt-<ts>` (`:1189-1197`). `HEADROOM_SAVINGS_PATH` overrides the path (`:32, 67-75`). Stateless mode keeps counters in memory only (`:557-559, 1415-1419`).

`lifetime_metrics` (`persistent_metrics.py:81-112`): `requests{total,cached,failed,rate_limited,by_provider(≤32),by_stack(≤64)}`, `tokens{input,output,attempted_input,saved}`, `prefix_cache{requests,hit_requests,cache_read/write/5m/1h,uncached,bust_count,bust_tokens,misses_by_reason,by_provider}`, `cost{input_usd,compression_savings_usd,cache_savings_usd}`, `waste_signals` (enum-bounded), `models{tracked(≤200, expose ≤100),other}`, `persistence.last_saved_at`. Derived percentages (`token_savings_percent`, `cache_hit_rate`, `ttl_1h/5m_percent`) computed only at read time (`:439-462`).

### `~/.headroom/savings_events.jsonl` — savings ledger, schema v1 (`savings_ledger.py:156-167`)
One JSON line per compression event (proxy + MCP): `{v:1, ts, before, after, saved, cost_usd, model, client, source ("proxy"|"mcp"), pid}`. fcntl-flocked appends; 30-day retention enforced on read; compaction rewrite once file >1 MB (`:53-62, 356-394`).

### `~/.headroom/session_stats.jsonl` — MCP shared session events (`ccr/mcp_server.py:202-261`)
`{type:"compress", input_tokens, output_tokens, savings_percent, strategy, timestamp, pid}` and `{type:"retrieve", hash, timestamp, pid}`; 2-hour rolling window, pruned on read.

### SDK sqlite storage (`headroom/storage/sqlite.py:40-70`) — feeds `reporting/generator.py`
```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY, timestamp TEXT, model TEXT, stream INTEGER, mode TEXT,
  tokens_input_before INTEGER, tokens_input_after INTEGER, tokens_output INTEGER,
  block_breakdown TEXT, waste_signals TEXT,
  stable_prefix_hash TEXT, cache_alignment_score REAL, cached_tokens INTEGER,
  transforms_applied TEXT, tool_units_dropped INTEGER, turns_dropped INTEGER,
  messages_hash TEXT, error TEXT);
-- indexes: idx_timestamp, idx_model, idx_mode
```

### `sql/` (repo root) — legacy Supabase telemetry schema
For the **removed** anonymous telemetry beacon (`/stats` now reports `"anon_telemetry_shipping": False`, `server.py:4048-4050`; `telemetry/beacon.py:6` confirms removal — collection is local-only now):
- `proxy_telemetry_v2` (`sql/create_proxy_telemetry_v2.sql`): per-session beacon rows — identity (session_id, instance_id, version, os, sdk, backend, headroom_stack, install_mode, requests_by_stack), effectiveness (`tokens_saved`, `requests`, `compression_percent`, `cache_hit_rate`, `cost_saved_usd`, `cache_saved_usd`, `models_used`), overhead (`overhead_avg_ms/max_ms`, `ttfb_avg_ms`), `pipeline_timing`, `avg_tokens_before/after`, `compression_cache`, `ccr`, `waste_signals`, `cache_bust_tokens` (added by `upgrade_telemetry_cache_bust.sql` — compare with `tokens_saved` to judge net-positive compression).
- `dashboard_summary` (`sql/create_dashboard_summary.sql`): single-row public-dashboard aggregate refreshed hourly by pg_cron `refresh_dashboard_summary()` — daily/hourly stats computed as **MAX per instance per day/hour (beacon values are cumulative) then SUM across instances**, plus totals, unique instances, top instances, os/version breakdowns.

### Request logs
`RequestLogger` (`request_logger.py:85-144`): in-memory deque of 10,000 `RequestLog` entries + optional JSONL file; message bodies dropped from the file unless `log_full_messages`; base64 images redacted (path-scoped, size-labelled placeholder). `RequestLog` fields (`proxy/models.py:47-97`): request_id, timestamp, provider, model, `input_tokens_original`, `input_tokens_optimized`, `output_tokens`, `tokens_saved`, `savings_percent`, `optimization_latency_ms`, `total_latency_ms`, tags (incl. `client`, `project`), `cache_hit`, `transforms_applied`, `waste_signals`, optional request/compressed/response bodies, `turn_id`.

---

## Code References

- `headroom/proxy/outcome.py:36-188` — `RequestOutcome` (fields, `cache_hit`, `savings_pct`); `:314-483` — `emit_request_outcome` funnel; `:366` 5xx guard; `:392-428` metrics + cost recording
- `headroom/proxy/cost.py:49-70` — `_CACHE_ECONOMICS` multipliers; `:113-363` — `build_prefix_cache_stats` (discount/premium/hit-rate/miss-attribution math); `:366-403` — `merge_cost_stats` layer separation; `:406-454` — MCP event aggregation; `:457-634` — `build_session_summary` (`cost_without = cost_with + savings`, `:554`); `:637-963` — `CostTracker` (litellm pricing `:687-732`, budget `:828-848`, list/cache prices `:850-886`, `stats()` `:888-963`)
- `headroom/proxy/prometheus_metrics.py:66` — save throttle 25; `:244-260` — per-provider cache accumulator; `:464-492` — per-strategy observer; `:664-852` — `record_request` (clamp `:694`, bust heuristic `:729-741`, savings history `:774-778`, ledger append `:819-835`); `:890-909` — bust + miss-attribution; `:964-1564` — Prometheus export
- `headroom/proxy/savings_tracker.py:35-43` — schema v5, fallback rates ($3/M in, $15/M out); `:167-200` — model resolution; `:203-349` — $ estimators (compression/output/cache/input); `:595-841` — checkpoint + per-request recording, display session; `:1094-1125` — CSV export; `:1148-1164` — default state; `:1360-1393` — history compaction; `:1414-1480` — atomic persist; `:1523-1656` — hourly/daily/weekly/monthly rollups with per-provider/model deltas
- `headroom/proxy/persistent_metrics.py:11-30` — bounds + known enums; `:303-381` — `record_request`; `:439-470` — read-time snapshot with derived percentages
- `headroom/savings_ledger.py:48-62` — schema v1, 30-day retention, 1 MB compaction; `:90-116` — write-time pricing; `:119-185` — `record_savings_event`; `:288-353` — `aggregate_savings`
- `headroom/proxy/semantic_cache.py:25-153` — `SemanticCache` (LRU, TTL, stats); `headroom/proxy/semantic_cache_key_policy.py:10-33` — SHA-256 key; `headroom/proxy/handlers/anthropic.py:991-1030` — hit path (`from_response_cache=True`); `headroom/proxy/models.py:102-108` — `CacheEntry`; `:289-291` — cache config defaults
- `headroom/proxy/request_logger.py:85-169` — logger, redaction counter `:54-66`; `headroom/proxy/models.py:47-97` — `RequestLog`
- `headroom/proxy/server.py:3454` — 5 s stats snapshot TTL; `:3530-4090` — `_build_stats_payload` (percent formulas `:3894-3931`, savings-by-layer `:3766-3843`); `:4142-4306` — `/stats`, `/stats-lifetime`, `/stats/reset`, `/stats-history`, `/transformations/feed`; `:3295` — `/dashboard`; `:4338` — `/metrics`
- `headroom/dashboard/templates/dashboard.html:117-128` — view switcher; `:192-1272` — Session view; `:1274-1310` — Lifetime view; `:1387-1798` — History view; `:1800+` — feed; `:1834-1881` — polling model; `:1906-1975` — fetchers
- `headroom/ccr/mcp_server.py:74` — tool name; `:98-192` — formatted summary; `:202-261` — shared events file; `:281-350` — `SessionStats`; `:835-898` — `_handle_stats`
- `headroom/cli/savings.py:48-105` — `headroom savings`; `headroom/cli/perf.py:12-40` — `headroom perf`
- `headroom/reporting/generator.py:309-383` — report generation (gpt-4o savings estimate `:339-342`, TPM multiplier `:334-336`); `:386-560` — histogram/top-requests/recommendations
- `headroom/pricing/litellm_pricing.py:26-92` — litellm import hygiene, resolver, MiniMax injection; `:205-247` — DeepSeek V4 injection
- `headroom/storage/sqlite.py:40-70` — SDK sqlite schema
- `sql/create_proxy_telemetry_v2.sql`, `sql/create_dashboard_summary.sql`, `sql/upgrade_*.sql` — legacy Supabase beacon/dashboard schema (beacon removed: `headroom/telemetry/beacon.py:6`, `server.py:4048-4050`)
- `headroom/paths.py:49-72` — file locations (`proxy_savings.json`, `savings_events.jsonl`, `session_stats.jsonl`)
- `pyproject.toml:381-384` — maturin bundles `headroom/dashboard/templates/*.html` into the wheel
