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

`ANTHROPIC_BASE_URL` is the only variable the proxy strictly needs — but set
this one too:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 \
_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
claude
```

`_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` matters because Claude Code
checks whether `ANTHROPIC_BASE_URL`'s host is `api.anthropic.com` and, when it
isn't, silently switches into gateway mode: different model-id forms (the
1M-context `[1m]` suffix handling changes), server-suggested model fallbacks
disabled, no trace-context propagation, non-first-party pricing paths. A
measuring proxy must not change the traffic it measures — this flag tells the
CLI the endpoint really is Anthropic behind a transparent relay, which for
this proxy is true. Caveats: it is an underscore-prefixed internal flag
(undocumented, may change without notice; found in CLI v2.1.215), and it is
only honest to set it for a transparent pass-through like this one — never
for a real third-party gateway.

Optional, for measurement fidelity: `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`.
On stream stalls the CLI can retry a request in non-streaming mode; those
responses carry usage in plain JSON instead of SSE, which this proxy's decoder
doesn't parse, so the ledger records them with zero usage. Disabling the
fallback keeps every request measurable — at the cost of a hard failure
instead of a fallback if a stream genuinely breaks. Leave the
`DISABLE_PROMPT_CACHING*` family unset: caching opt-outs would wreck both your
costs and the cache analytics this proxy exists to show.

`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` stops the auto-updater, fast-mode
availability check, and gateway model discovery — background calls that go
straight to api.anthropic.com and bypass the proxy anyway. Statsig telemetry
and Sentry error reports also never pass through the proxy (third-party
endpoints), so they can't pollute the ledger; add `DISABLE_TELEMETRY=1` and
`DISABLE_ERROR_REPORTING=1` only if you don't want them sent at all. The
`count_tokens` housekeeping calls DO pass through, but the proxy already
excludes them from both the logs and the ledger.

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
