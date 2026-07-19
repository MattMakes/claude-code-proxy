# agent-proxy

See what Claude Code actually sends the model — and pay less for it.

A measuring proxy that sits between Claude Code and the Anthropic API. It
forwards every request (auth headers pass through untouched), streams the
response straight back so the CLI is unaffected, and records a before/after
token ledger for every call. Two cache-safe optimizations are on by default;
run with `--no-optimize` to observe only.

Zero npm dependencies — Node built-ins only. Requires Node 18+. No build step.

## Quickstart

```bash
node proxy.mjs
```

Point Claude Code at it:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

Open the dashboard:

```
http://localhost:8787/dashboard
```

Session, Lifetime, and History views, polling `GET /stats` every 5 seconds.
`GET /stats?format=jsonl` streams the raw ledger; the History tab exports CSV.

To measure without changing a single byte of traffic:

```bash
node proxy.mjs --no-optimize
```

Savings are still computed and shown as projections (`applied: false`).

## The ledger

Every request appends one line to `logs/ledger.jsonl`. The proxy replays the
file at boot, so aggregates survive restarts. A line looks like:

```json
{
  "ts": "2026-07-19T10:00:00.000Z",
  "session": "9f8e7d6c-1111-2222-3333-444455556666",
  "model": "claude-sonnet-5",
  "original_tokens": 10000,
  "optimized_tokens": 9000,
  "saved_tokens": 1000,
  "saved_detail": { "dedup": 600, "stale_read": 400 },
  "applied": true,
  "usage": { "input": 500, "cache_read": 8000, "cache_creation": 500, "output": 300 },
  "status": 200,
  "ms": 1042
}
```

`original_tokens`/`optimized_tokens` are the same byte-based estimator applied
to the request body before and after optimization — the delta stays honest.
`usage` is the real token split from the response. `saved_detail` breaks the
savings down by pass (`dedup` = repeated tool results, `stale_read` =
superseded Read results). 5xx entries count toward requests and cost but are
excluded from savings.

## The math

Three formulas, one identity:

```
cost_with    = input·input_rate + cache_read·read_rate
             + cache_creation·write_rate + output·output_rate
savings_usd  = saved_tokens · input_rate          (list rate — cache-mix independent)
cost_without = cost_with + savings_usd
```

`cost_with` is what you actually paid, from real usage and real per-model
rates. `cost_without` is never estimated separately — it is the identity, so
the "without" bar can't drift from reality. Cache savings (the discount you
get from prompt caching itself) are tracked as a separate line and never
summed into optimization savings.

## The iron rule

Never rewrite content inside the provider-frozen cache prefix. Anthropic's
prompt cache keys on an exact prefix of the request; editing one byte of it
busts the cache and costs more than any stub saves. So mutations touch only
the append-only delta past the last forwarded prefix — except stale-Read
stubbing, which may reach into the prefix only when the cache is already
missed and there is nothing left to protect. Blocks carrying `cache_control`
are never touched at all.

## Prices

Per-model rates live in `lib/prices.json`, using LiteLLM's field names so the
community registry drops in unchanged. To refresh from the live registry:

```bash
node scripts/refresh-prices.mjs
```

Build-time only — the proxy never fetches anything at runtime.

## Deferred (deliberately not built yet)

- JSON tool-result crushing
- Complexity-based model routing
- Prometheus `/metrics`
- CCR retrieval store
