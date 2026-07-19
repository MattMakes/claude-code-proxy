# agent-proxy v2 — Measurement Ledger + Safe Optimizations

> Evolve `proxy.mjs` from a pure logging proxy into a measurement-first optimization proxy: every request gets a before/after token ledger, deterministic cache-safe optimizations apply by default, and a served dashboard shows session/lifetime cost in tokens and dollars — with and without optimization.

**Date:** 2026-07-19
**Status:** Validated with user (sections 1–4 reviewed interactively; section 5 standard practice)
**Informed by:** `ai_docs/trace/` — deep traces of headroomlabs-ai/headroom and BerriAI/litellm

---

## Scope (SLC)

**v1.0 ships, complete:**
- Per-request ledger: 4-way usage split, before/after tokens, dollars
- Session grouping (Claude Code `_session_` marker)
- Deterministic cost math from a vendored price table (LiteLLM schema)
- Cache analytics: hit rate, bust attribution, cache savings in dollars
- Two optimizations, **on by default**: cross-turn dedup + stale-Read stubbing
- `--no-optimize` flag (detectors still run, projection-only)
- Dashboard: `GET /dashboard` (self-contained HTML) + `GET /stats` JSON, three views (Session / Lifetime / History)

**Explicitly deferred (not phases — separate future products):** statistical JSON tool-result crushing, complexity-based model routing, Prometheus `/metrics`, CCR-style retrieval store.

**Constraints preserved:** zero npm dependencies (Node built-ins only, Node 18+), single command `node proxy.mjs`, streaming passthrough untouched, auth passthrough untouched.

---

## Architecture

### File layout

```
proxy.mjs                 entry + HTTP server + pipeline orchestration
lib/ledger.mjs            ledger append, boot replay, in-memory aggregates
lib/cost.mjs              pure cost functions (LiteLLM field names)
lib/optimize.mjs          dedup + stale-Read detectors/rewriters, session span memory
lib/session.mjs           session-id extraction, per-session state
lib/prices.json           vendored Anthropic slice of LiteLLM's model_prices_and_context_window.json
scripts/refresh-prices.mjs deterministic regeneration of lib/prices.json from LiteLLM's registry
dashboard.html            self-contained dashboard (vanilla JS, inline CSS, no CDN)
logs/                     per-request .md / .request.txt (existing) + ledger.jsonl (new)
```

### Request pipeline (5 stages)

1. **Parse** — JSON body; extract session id from `_session_<id>` marker in `metadata.user_id` (LiteLLM-verified Claude Code convention); fallback: hash of first user message; final fallback: proxy boot id. `count_tokens` calls skipped as today.
2. **Measure before** — `original_tokens` estimated on the body as received.
3. **Optimize** (default on) — run detectors against per-session span memory; rewrite body; `optimized_tokens` on the result. `--no-optimize`: detectors run, record projected savings, body forwarded untouched. Either way the before/after gauge has data.
4. **Forward & stream** — unchanged from v1; SSE decode keeps the 4-way usage split (`input`, `cache_read`, `cache_creation`, `output`) instead of summing.
5. **Settle** — append ledger line, update session/lifetime/hourly aggregates, terminal audit, `.md` log.

### The iron rule (from the headroom trace)

**Never rewrite anything inside the provider-confirmed frozen cache prefix.** Mutations touch only the append-only delta, or fire on requests that already miss the cache. Rewriting cached history is a false economy: cache reads cost 0.1× list, re-writes cost 1.25×.

---

## Ledger & cost math

### `logs/ledger.jsonl` — one line per request

```json
{ "ts": "2026-07-19T00:00:00.000Z", "session": "abc123", "model": "claude-opus-4-8",
  "original_tokens": 48210, "optimized_tokens": 44950, "saved_tokens": 3260,
  "saved_detail": { "dedup": 2100, "stale_read": 1160 }, "applied": true,
  "usage": { "input": 1450, "cache_read": 41200, "cache_creation": 2300, "output": 890 },
  "status": 200, "ms": 4200 }
```

### Formulas (`lib/cost.mjs`, pure functions)

- `cost_with = input×rate + cache_read×cache_read_rate + cache_creation×cache_write_rate + output×output_rate`
- `savings_usd = saved_tokens × rate` — priced at list input rate (headroom's conservative, cache-mix-independent choice)
- **`cost_without = cost_with + savings_usd`** — the before/after identity; never re-run requests to get a baseline
- Cache savings, tracked separately and never summed with optimization savings:
  `cache_savings = cache_read×(rate − cache_read_rate) − cache_creation×(cache_write_rate − rate)`
- Cache hit rate per request: `cache_read / (input + cache_read + cache_creation)`
- **Cache-bust flag:** previous request in session had high `cache_read`, this one ≈ 0 → attribute the bust and its re-write dollar cost
- 5xx requests: ledger line written, **excluded** from savings percentages (headroom's anti-flattery rule)
- Headline percentages: `active = saved/attempted`, `whole-wire = saved/(input+saved)`

Price data uses LiteLLM's exact field names (`input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`) so the full registry can drop in later.

### Tokenizer honesty

`original_tokens`/`optimized_tokens` use the same estimator on both sides (bytes/4 in v1). The delta is what matters; identical measurement keeps it honest. Estimator is one function, upgradeable without touching callers.

### Boot replay

On start, replay `ledger.jsonl` into in-memory aggregates: per-session rollups, lifetime totals, hourly buckets. Milliseconds at dev-tool volume; corrupt/partial trailing lines skipped with a warning.

---

## The two optimizers (`lib/optimize.mjs`)

Both deterministic — no ML, no embeddings, no network — and reversible through the agent's own tools (model can re-run Read/Grep), so no CCR store needed.

### Cross-turn dedup

- Per-session memory of forwarded spans: normalized hashes of tool-result content, threshold **≥ 3 lines / 40 chars** (headroom's).
- A new tool result in the delta repeating a known span → replaced with `[duplicate of <tool> result in message N — content unchanged]`.
- **Cache-safe by construction:** the second occurrence is always in the append-only delta.

### Stale-Read stubbing

- A file Re-Read or Edited later makes the older Read result stale (~67% of Reads, per headroom's data).
- The old result lives in the frozen prefix → stubbing it normally busts cache (1.25× re-write to save 0.1× reads = loss).
- **Rule: apply only on requests that already miss the cache** (`cache_read ≈ 0` on the previous response for this session — session start, compaction, 5-min TTL expiry). Stub: `[stale Read of <path> — superseded by later read/edit in message N]`. Minimum size 512 bytes.

### Guards

- Never touch `system`, `tools`, or any block carrying `cache_control`.
- Skip requests under 2,000 estimated tokens.
- Any optimizer exception → forward the **original** body untouched, log the error, ledger records `applied: false`.
- `--no-optimize` → projection-only mode for both.

---

## Dashboard

Routes on the existing server: `GET /dashboard` (serves `dashboard.html`), `GET /stats` (JSON aggregate blob, polled every 5 s), `GET /stats?format=jsonl` (raw ledger export). All non-API paths; API paths proxy as before.

- **Session view (default):** session picker; hero = before/after gauge (`cost_without` vs `cost_with` paired bars, saved $ and active-%); token flow by class (uncached / cache-read / cache-write / output); cache hit-rate sparkline; cache-bust markers with attributed cost; savings split by optimizer; live request feed (the terminal audit, scrolling).
- **Lifetime view:** cumulative tokens/dollars with & without, total saved, cache savings (separate line), session count, per-model breakdown.
- **History view:** hourly→daily spend and savings trends; CSV derived client-side from JSONL export.

Deliberate fixes of LiteLLM's own dashboard gaps: cache-hit is a **column in the main table**, and cache savings shown in **dollars**, not just hit ratio.

---

## Error handling & testing

**Containment hierarchy (worst thing the proxy can do is break a coding session):**
1. Upstream/proxy errors: unchanged from v1 (502 passthrough).
2. Optimizer failure: catch-all → original body forwarded; never fail the request over savings.
3. Ledger/aggregate failure: log to stderr, response unaffected (settle stage is post-stream, as today).
4. Dashboard/stats failure: 500 on that route only; proxying unaffected.

**Testing (`node:test`, built-in runner, zero deps):**
- Unit: cost formulas against hand-computed fixtures (incl. cache discount edges); session-id extraction (marker present / absent / malformed); dedup span hashing + threshold edges; stale-Read detection (Read→Edit, Read→Read, below-512B skip); cache-miss gating.
- Pipeline: golden-file test — recorded real request/response pair (scrubbed) through the full pipeline with an injected fake upstream; assert forwarded body, ledger line, aggregates. No network in tests.
- Boot replay: ledger with a corrupt trailing line replays cleanly.

---

## Preservation Analysis

### Behavioral Invariants (of existing proxy.mjs)

| # | Behavior | Location | Business Reason | Risk if Lost |
|---|----------|----------|-----------------|--------------|
| 1 | Response streamed to client chunk-by-chunk as received | `proxy.mjs:277` | CLI latency/UX unaffected by proxy | Claude Code feels broken |
| 2 | Auth headers passed through untouched | `proxy.mjs:42-51` | Requests must still authenticate | Total outage |
| 3 | `accept-encoding` stripped (identity) | `proxy.mjs:46` | Response must be readable for decode | Garbled logs/usage |
| 4 | `count_tokens` calls skipped from logging | `proxy.mjs:35` | Housekeeping noise | Log spam |
| 5 | Secrets redacted in rendered logs | `proxy.mjs:37` | Keys never land in Markdown | Credential leak |
| 6 | Non-JSON bodies: forward fine, log error only | `proxy.mjs:289-291` | Proxy never blocks on render failures | Dropped requests |
| 7 | Per-request `.md` + `.request.txt` written | `proxy.mjs:286-287` | Existing audit workflow | Loss of current tool's value |

### Contract Surface

| Endpoint | Method | Auth | Behavior |
|----------|--------|------|----------|
| `/*` (Anthropic API paths) | any | passthrough | Transparent proxy (unchanged) |
| `/dashboard` | GET | none (localhost tool) | Serves dashboard.html (new) |
| `/stats` | GET | none | JSON aggregates; `?format=jsonl` raw ledger (new) |

Note: `/dashboard` and `/stats` shadow those upstream paths — acceptable; Anthropic API has no such routes.

### Domain Assumptions

| Value | Why This Value | Impact if Changed |
|-------|----------------|-------------------|
| dedup span ≥ 3 lines / 40 chars | Headroom's proven floor; below it stub ≈ content | Noise stubs / missed savings |
| stale-Read ≥ 512 B | Headroom default; smaller reads not worth a stub | Churn for pennies |
| skip requests < 2,000 est. tokens | Nothing meaningful to win | Wasted work per request |
| cache read 0.1× / write 1.25× | Anthropic pricing (LiteLLM registry) | Wrong savings math |
| bytes/4 token estimate | v1 estimator, same on both sides | Absolute values shift; deltas stay comparable |
| 5s dashboard poll | Headroom's session view cadence | Cosmetic |

### Failure Mode Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Optimizer stubs content the model still needs | Medium | Confused agent turn | Stubs name the source (message N / path); model can re-Read; thresholds conservative; `--no-optimize` |
| Rewrite busts prompt cache | Medium (if rule broken) | Pays 1.25× premium, negative savings | Iron rule + cache-miss gating; bust attribution makes any regression visible on the dashboard |
| Ledger corruption (crash mid-append) | Low | Lost trailing line | Replay skips partial lines |
| Savings numbers flatter (baseline inflated) | Medium | Wrong decisions | List-rate pricing only, 5xx excluded, cache vs optimization savings never summed |
| Session misattribution (marker format change) | Low | Rollups merge/split | Fallback chain; session id logged in `.md` for spot checks |
