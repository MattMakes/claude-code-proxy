# Trace Synthesis — Headroom + LiteLLM → agent-proxy

> What we learned from deep-tracing headroomlabs-ai/headroom and BerriAI/litellm, and how it maps onto our zero-dependency Claude Code proxy (`proxy.mjs`).

**Last traced:** 2026-07-19 · headroom @ v0.32.0 · litellm @ `bd44c9e` (upstream main, verified — complexity router is upstream, not a fork extra)
**Source clones:** `research/headroom/`, `research/litellm/` (shallow)

## The trace documents

| Doc | Covers |
|---|---|
| [headroom-compression-pipeline.md](headroom-compression-pipeline.md) | Every token-saving mechanism, the libraries it delegates to, prompt-cache safety, reversibility |
| [headroom-cost-stats-dashboard.md](headroom-cost-stats-dashboard.md) | With/without-optimization accounting, cost formulas, dashboard, Prometheus metrics |
| [litellm-complexity-routing.md](litellm-complexity-routing.md) | All routing strategies, auto-router + semantic-router library internals, complexity router |
| [litellm-cost-cache-analytics.md](litellm-cost-cache-analytics.md) | Cost math incl. cache discounts, SpendLogs schema, sessions, budgets |
| [litellm-dashboard.md](litellm-dashboard.md) | Complete admin-UI map + backend analytics endpoints |

---

## 1. How Headroom saves tokens (ranked by relevance to us)

1. **Prompt-cache safety is the architecture, not a feature.** Default mode compresses only the append-only delta *past the provider-confirmed frozen prefix* (inferred from `cache_read_input_tokens` in the previous response). Previously-forwarded compressed prefixes are replayed byte-identical, and accumulated `cache_control` markers are collapsed to stay under Anthropic's 4-breakpoint limit. Any optimization that rewrites the cached prefix is a false economy: you save list-price tokens but pay 10× on the cache re-write (read = 0.1×, write = 1.25× list).
2. **SmartCrusher (Rust core):** statistical crushing of JSON arrays in tool results. Keeps errors (12-keyword set), 2σ anomalies, change points, first-30%/last-15% anchors, and query-relevant items (hybrid embed+BM25 score ≥ 0.3); adaptive keep-count via Kneedle knee-point, cap 15. Gates: ≥ 5 items and > 200 tokens. Tries a *lossless* CSV-schema fold first and ships that if it saves ≥ 15%. Claimed 60–95% on JSON tool output.
3. **History mechanisms — no summarizer, nothing deleted:** stale-Read replacement (a Read that was later re-read/edited gets stubbed; ~67% of Reads go stale), cross-turn dedup of re-served spans (≥ 3 lines / 40 chars). These are deterministic and cheap — the best first wins for a coding-agent proxy.
4. **Reversibility (CCR):** dropped content goes to a SQLite store (sha256 key, 30-min TTL, 1000 entries) behind a `[...Retrieve more: hash=...]` marker; a `headroom_retrieve` tool is injected and the proxy satisfies retrievals *in-flight* (≤ 3 rounds) so the client never notices. Lossy compression becomes safe because the model can undo it.
5. **ContentRouter:** detect content type (Rust magika → unidiff → plaintext chain), route to a type-specific compressor (logs, search, diffs, config, HTML via trafilatura, generic → Kompress). Relevance split keeps query-relevant records verbatim.
6. **Output shaping (opt-in):** cache-safe verbosity steering appended to the system tail + lowering already-present thinking effort on mechanical continuations. ~31.7% output-token reduction claimed. Notably it never caps `max_tokens`.
7. **Kompress (ONNX ModernBERT)** LLMLingua-style word pruning — last resort for prose, threshold 0.5, MUST_KEEP regex for paths/numbers/flags.

**Library delegation:** headroom uses **LiteLLM purely as a pricing/model registry** (lazily imported, ImportError-guarded), tiktoken for counting, fastembed (`bge-small-en-v1.5`) for relevance, magika for content detection, tree-sitter/ast-grep for (default-off) code compression.

## 2. Measuring savings *with and without* optimization (the part we must copy)

Both projects converge on the same principle: **you never run the request twice — you reconstruct the baseline from a per-request ledger.**

Headroom's per-request `RequestOutcome`:

```
original_tokens   = what the client sent (counted pre-compression)
optimized_tokens  = what was actually forwarded
tokens_saved      = original − optimized
+ provider usage:   input, cache_read, cache_creation (5m/1h split), output
```

- `cost_with = Σ cache_read×0.1×price + cache_write×1.25×price + uncached×price`
- `savings_usd = Σ tokens_saved × list_input_price` (priced at list rate — conservative, cache-mix-independent)
- **`cost_without = cost_with + savings_usd`** ← the whole with/without comparison is this identity
- Prefix-cache savings tracked separately: `cache_read × price × (1 − 0.1)` minus write premium `cache_write × price × (1.25 − 1)` — so compression savings and cache savings never double-count, and the *net* of "compression vs cache interference" is an explicit dashboard panel.
- Three headline percentages: `active = saved/attempted`, `whole-wire = saved/(input+saved)`, `new-input = saved/(uncached+cache_write+saved)`. 5xx responses excluded so failures can't inflate the save rate.

LiteLLM's cost core (`generic_cost_per_token`):

```
input_cost  = text_tokens×input_rate + cached×cache_read_rate (~0.1×)
            + 5m_writes×1.25×rate + 1h_writes×2×rate
text_tokens = prompt − cached − cache_creation − audio/image/video   # double-count guard
prompt_caching_savings = cache_read_tokens × (input_rate − cache_read_rate)
```

Prices come from `model_prices_and_context_window.json` (~3,000 models, per-token rates incl. `cache_read_input_token_cost`, `cache_creation_input_token_cost`, tiered/above-128k variants). **Worth vendoring this one file** — it's the community-maintained price table both projects rely on.

## 3. Prompt-cache hit/miss understanding

- **Per-request hit rate is derivable from usage alone:** `cache_read / (input + cache_read + cache_creation)`. Our proxy already decodes all three fields (`proxy.mjs:236-238`) — we log the sum but throw the split away.
- LiteLLM keeps **two separate metric families**: proxy-level response-cache hits (`litellm_cache_hits/misses`, exact-match SHA-256 of normalized params; a hit costs $0 and still writes a SpendLogs row with `cache_hit=True` + `cache_key`) vs provider-level prompt-cache reads (`litellm_provider_cache_read/creation_input_tokens`). Never conflate the two.
- Headroom goes further: TTL mix (5m vs 1h writes), **cache-bust attribution** (which request broke the prefix and why), and miss attribution — the most actionable cache analytics either project has.
- Headroom's "semantic cache" is *not* semantic — exact SHA-256 LRU (1000 entries, 1h TTL). LiteLLM's actual semantic cache uses Redis + redisvl embeddings.

## 4. Sessions and cost-of-session

- LiteLLM stamps every SpendLogs row with an indexed `session_id`: user-passed `litellm_session_id` → `litellm_trace_id` → any `x-*-session-id` header → **`_session_` marker parsed out of Anthropic `metadata.user_id`** → uuid4. That last one matters to us: Claude Code sends `metadata.user_id` containing a `_session_<uuid>` marker, so our proxy can group requests into sessions with zero client changes.
- Per-session cost = sum of rows (`GET /spend/logs/session/ui`); there's even a `max_budget_per_session` pre-call hook.
- Daily aggregate tables (per user/team/org/tag/agent) all carry `cache_read`/`cache_creation` token columns + `prompt_caching_savings_spend` and `compression_savings_spend` columns — savings are first-class schema, not derived at query time.

## 5. Complexity-based model routing (LiteLLM)

- **Auto-router (semantic):** deployment `model: auto_router/<name>` + JSON routes `{name, utterances, score_threshold}` where **route name = target model**. Flow: last user message → embedding → cosine vs every stored utterance → top-5 → mean-aggregate per route → first route ≥ threshold (default 0.3) → that model; no match → default model. (Library: aurelio-labs/semantic-router.)
- **ComplexityRouter (upstream, verified at `litellm/router_strategy/complexity_router/`):** deterministic scoring of 7 weighted dimensions — code 0.30, reasoning 0.25, technical 0.25, token count 0.10 (+3 minor); 2+ reasoning markers force the REASONING tier. Score vs boundaries 0.15/0.35/0.60 → SIMPLE/MODERATE/COMPLEX/REASONING tier → model map. Extras: optional LLM classifier, "LITELLM ESCALATE" marker, **session pinning (TTL 3600s)** so a conversation doesn't ping-pong models, Thompson-sampling adaptive mode.
- **Size-based routing** (the simplest complexity signal): pre-call checks drop deployments whose `max_input_tokens` < prompt tokens; `context_window_fallbacks` re-route oversized prompts to bigger-context model groups.
- Classic strategies for completeness: simple-shuffle (weighted random), least-busy (min in-flight), usage-based (lowest current-minute TPM, Redis 60s windows), latency-based (lowest sec/token over last 10 samples, 1000s timeout penalty), **lowest-cost** (cheapest $/token after rate-limit filtering). Reliability: 2 retries, 5s cooldown (on 429 or >50% failure over ≥5 requests), fallback depth 5.

## 6. Dashboards — what's worth having

**Headroom** (single-page Alpine.js served by the proxy, fits our zero-dep ethos): Session view (5s poll of `/stats`) with token savings + active %, output-shaping savings with 95% CI, **waste signals**, prefix-cache impact (TTL mix, busts, miss attribution), compression-vs-cache net; Lifetime view; History view (hourly→monthly rollups, CSV/JSON export); live transformation feed; ~45 Prometheus series; `headroom_stats` MCP tool ("Without/With Headroom: you saved $X").

**LiteLLM** — top 5 analytics for a token-optimization workflow:
1. `GET /user/daily/activity/aggregated` — one call: spend + prompt/completion/cache_read/cache_creation tokens + success/fail, by day × model × provider × key × endpoint. The single best "what's burning tokens" source.
2. **Cost Optimization page** — `prompt_caching_savings_spend`, `compression_savings_spend`, `compression_saved_tokens` trended per day; the only place savings appear in dollars.
3. `/spend/logs/ui` + session drill-down — per-request cost/tokens/TTFT sortable by spend; session-total spend.
4. `/global/activity/cache_hits` — cache-hit ratio, cached vs generated tokens per call type.
5. Per-model Prompt Caching Metrics — find models/keys with low cache-read ratios = where to aim optimization next.

Gaps found (avoid repeating them): the logs *table* has no cache-hit column (only the drawer), the caching dashboard shows hit ratio but no dollars saved, and model latency analytics got orphaned from the UI.

---

## 7. What this means for agent-proxy (SLC recommendation)

`proxy.mjs` today is a complete, lovable v1.0 of an *observer*. The traces say the next complete product is **the measurement layer** — because both projects prove you cannot claim savings without the per-request ledger, and we already decode every field the ledger needs.

**Narrowest scope that fully solves one problem — "know exactly what Claude Code costs, per request and per session, and what caching is doing":**

1. **Keep the usage split.** Stop summing `input + cache_read + cache_creation` into one number; record all four usage fields per request (`proxy.mjs:236-238` already has them in hand).
2. **Session grouping for free:** parse the `_session_` marker from `metadata.user_id` in the request body → per-session rollups (requests, tokens by class, dollars).
3. **Deterministic cost math** (no AI, no deps): vendor litellm's `model_prices_and_context_window.json` (or a hand-cut Anthropic-only slice); apply `uncached×rate + cache_read×read_rate + cache_write×write_rate + output×out_rate`.
4. **Cache analytics:** per-request hit rate `cache_read/(input+cr+cc)`; flag cache-bust requests (previous request had high cache_read, this one re-wrote); report cache savings as `cache_read × (rate − read_rate)` minus write premium.
5. **The with/without ledger, from day one:** even before we optimize anything, record `original_tokens`/`optimized_tokens` (identical for now) so the day we add an optimization, `cost_without = cost_with + savings` works with zero rework — and savings are priced at list input rate, headroom-style, never double-counted with cache savings.
6. **One HTML dashboard file** polled from a `/stats` endpoint (headroom's exact pattern) — session + lifetime + JSONL export. Vanilla JS, still zero npm deps.

**When we do start optimizing (later, separate product decision), the proven order of operations is:** (a) never touch the frozen cached prefix; (b) cross-turn dedup + stale-Read stubbing (deterministic, reversible-by-construction); (c) statistical JSON crushing of tool results with a lossless fold attempted first; (d) complexity routing only after the ledger can prove what it changes.
