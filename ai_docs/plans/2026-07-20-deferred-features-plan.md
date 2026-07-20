# Deferred Features Build — crush, routing, /metrics, CCR

> Source designs: `ai_docs/trace/headroom-compression-pipeline.md` (SmartCrusher, CCR), `ai_docs/trace/litellm-complexity-routing.md` (ComplexityRouter), `ai_docs/trace/headroom-cost-stats-dashboard.md` (metrics). Constraints unchanged: Node 18+ built-ins only, zero npm deps, TDD (`node --test 'test/*.test.mjs'`), iron rule (never rewrite the frozen cache prefix).

## A. CCR retrieval store — `lib/ccr.mjs` + `GET /ccr/<hash>`

Headroom stores crushed originals (SQLite, sha256 key, 30-min TTL, 1000 entries) and satisfies retrievals in-flight. Our zero-dep adaptation: in-memory store; retrieval via HTTP so any agent with shell access can `curl` it back — no response interception needed.

- `createCcrStore({ ttlMs = 30*60_000, max = 1000 })` → `{ put(text) → 24-hex sha256 key, get(key) → text|null (expired ⇒ null + delete), size() }`. Insertion-order eviction when over max. `put` of identical text returns same key without duplicate entry.
- proxy.mjs: `GET /ccr/<key>` → 200 text/plain original, or 404 `expired or unknown — re-run the original tool call`.
- Tests: put/get roundtrip + stable key; TTL expiry (inject clock via optional `now` fn param); eviction at max; 404 route covered by later live check.

## B. JSON tool-result crushing — `lib/crush.mjs`, wired as third optimize pass

Deterministic subset of headroom's SmartCrusher (no embeddings, no Kneedle — fixed caps):

- Candidate: `tool_result` text in the DELTA only (cache-safe by construction; frozen prefix untouched — crushed form replays byte-identical via existing `commitForward`), est tokens > 200, parses as JSON, largest array has ≥ 5 items.
- Keep policy (headroom's anchors): ALL items whose serialized form matches error keywords `/error|fail|exception|fatal|denied|timeout|refused|warning/i`; first ceil(30%·N) (cap 8); last ceil(15%·N) (cap 4); numeric outliers — for each numeric key present in ≥ 80% of items, items outside mean ± 2σ; non-error keep cap 15 total.
- Ship only if est savings ≥ 15% of the result text. Replacement: same JSON shape with the array replaced by kept items + trailing string item `"[crushed: kept K of N items — full data: curl -s http://localhost:8787/ccr/<key>]"`; original full text `put()` into CCR first.
- `crushPass(messages, deltaStart, saved, ccr)` mirrors existing pass signatures; `saved.crush` tokens; wired in `optimize()` after staleReadPass. `saved_detail` gains `crush` everywhere (ledger sums with `?? 0` tolerance — old ledger lines must replay fine).
- Tests: 20-item array with 2 error items → errors kept, marker present, CCR key retrievable, savings counted; <5 items untouched; non-JSON untouched; <15% savings untouched; frozen-prefix candidate untouched on cache-hot path.

## C. Complexity-based routing — `lib/route.mjs`, shadow always / applied with `--route`

LiteLLM ComplexityRouter subset (deterministic; their weights and boundaries):

- `scoreComplexity(text)`: dimensions in [0,1] — code (fences, `function|class|import|def|=>|{ }` density; weight 0.30), reasoning (marker count among `why|prove|plan|design|architect|analy[sz]e|step.by.step|trade.?off|debug|root cause`; weight 0.25), technical (term density; weight 0.25), length (estTokens/4000 capped; weight 0.10); score = Σw·d / Σw. ≥ 2 reasoning markers ⇒ force REASONING.
- Tiers: `< 0.15` SIMPLE, `< 0.35` MODERATE, `< 0.60` COMPLEX, else REASONING.
- `routeModel(reqJson, tierMap, prices)` → `{tier, score, from, target, apply_ok}`. Default map: SIMPLE→`claude-haiku-4-5`, MODERATE→`claude-sonnet-5`, COMPLEX/REASONING→requested. **Downgrade-only** (`apply_ok` only when target's input rate < requested's). Input text = last user message text blocks.
- proxy.mjs: score EVERY pipeline request (shadow — recorded, never applied) and rewrite `reqJson.model` only when started with `--route` **and** `apply_ok`, with **session pinning**: first applied decision fixes that session's target (LiteLLM pins 3600s; ours pins for session lifetime — a mid-session model swap busts the prompt cache, so flapping is worse than a stale pin). Ledger entry: `route: {tier, score, from, target, applied}`; when applied, `model` = target and `route.from` keeps the original.
- Ledger aggregates: `routing = { tiers: {SIMPLE:0,...}, applied: 0, potential_saved_usd: 0 }` where potential ≈ `in_tokens·(from_in_rate − target_in_rate) + output·(from_out_rate − target_out_rate)` summed over shadow decisions with `apply_ok` (labeled ≈ in UI; ignores cache-mix — documented).
- Rationale for shadow-default (differs from optimizers-on-default): model substitution changes answer quality invisibly, so the gauge comes first — the Insights view shows exactly what `--route` would have saved before anyone flips it.
- Tests: scoring tiers (plain question → SIMPLE; code+bug fix → higher; ≥2 reasoning markers → REASONING); downgrade-only (haiku request never "upgraded"); routing aggregate math; pinning (two requests, one session → same target even if second scores differently).

## D. Prometheus `/metrics` — `lib/metrics.mjs`

Text exposition v0.0.4 rendered from `LEDGER.stats()` on scrape (aggregates are monotonic ⇒ valid counters). ~15 families, `agentproxy_` prefix:
requests_total, tokens_total{class}, saved_tokens_total{pass=dedup|stale_read|crush}, cost_usd_total, cost_without_usd_total, cache_savings_usd_total, cache_busts_total, bust_cost_usd_total, sessions, requests_by_model_total{model}, cost_by_model_usd_total{model}, route_tier_total{tier}, route_applied_total, route_potential_saved_usd, ccr_entries.
- `renderMetrics(stats, extra)` pure function; proxy route `GET /metrics` → text/plain; charset + `# HELP`/`# TYPE` lines; label values escaped.
- Tests: renders HELP/TYPE + correct values from a fixture stats blob; model label present; no NaN.

## E. Dashboard + README

- Session cards: "dedup / stale / crush" three-way split.
- Insights: routing card/table — tier counts, applied count, `≈$ potential if routed` (from `routing`), plus CCR entries count.
- README: remove built items from Deferred (leaves it empty — delete section), document `/ccr/<key>`, `/metrics`, `--route` + shadow routing, crush behavior + retrieval marker.

## Order & verification

A → B (needs CCR) → C+D (independent of each other, same agent to avoid proxy.mjs conflicts) → E. TDD each; commit per feature; suite green at every commit (31 baseline). Final: live smoke (proxy restart — user traffic may be flowing; restart fast), `/metrics` scrape, `/ccr` 404, crush + route shadow visible in `/stats`, browser pass on dashboard.
