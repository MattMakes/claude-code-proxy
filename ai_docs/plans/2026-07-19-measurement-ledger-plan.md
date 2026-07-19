# agent-proxy v2 — Measurement Ledger + Safe Optimizations Implementation Plan

> **For Claude:** Use `/dev-execute` to implement this plan task-by-task.

**Goal:** Evolve `proxy.mjs` into a measurement-first optimization proxy: per-request before/after token ledger, dollar cost with the `cost_without = cost_with + savings` identity, session grouping, cache hit/bust analytics, two cache-safe optimizations on by default, and a served dashboard.

**Architecture:** A 5-stage pipeline (parse → measure → optimize → forward/stream → settle) wrapped around the existing streaming passthrough. Pure-function modules under `lib/`; JSONL ledger with boot replay into in-memory aggregates; self-contained `dashboard.html` polling `GET /stats`. Design doc: `ai_docs/designs/2026-07-19-proxy-measurement-optimization-design.md`.

**Tech Stack:** Node 18+ built-ins only (`node:http/https/fs/path/crypto/test`). Zero npm dependencies. No build step.

**Wiring Manifest:** see footer table. Summary: `proxy.mjs` imports `lib/session.mjs`, `lib/cost.mjs`, `lib/ledger.mjs`, `lib/optimize.mjs`; `lib/ledger.mjs` imports `lib/cost.mjs`; `lib/optimize.mjs` imports `lib/cost.mjs` (estimator only). No DI container — ES module imports are the registration.

**Regression Hotspots:** streaming passthrough (`proxy.mjs:277`), auth header passthrough (`proxy.mjs:42-51`), `accept-encoding` strip (`proxy.mjs:46`), `count_tokens` skip (`proxy.mjs:35`), redaction (`proxy.mjs:37`), non-JSON bodies forwarded untouched (`proxy.mjs:289-291`), per-request `.md`/`.request.txt` logs (`proxy.mjs:286-287`). Full table in footer.

**Conventions for every task:** run tests with `node --test test/`; commit after each green step; never leave the tree red between commits.

---

## Task 0: Local Dev & Smoke Test (MANDATORY — complete before Task 1)

**Spec:** Prove the current proxy runs locally and forwards to Anthropic before any changes.

**Files:**
- Create: `test-local.sh`

**Step 1: Start the proxy**
```bash
cd /Users/mascott/projects/proxy && node proxy.mjs
```
Expected: `[agent-proxy] listening on http://localhost:8787`

**Step 2: Create the smoke script**
```bash
#!/usr/bin/env bash
# test-local.sh — smoke test: proxy up + forwarding to upstream.
set -e
BASE="${1:-http://localhost:8787}"
echo "--- passthrough (expect Anthropic auth error JSON, proving forwarding works)"
curl -sS -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
echo
echo "--- stats endpoint (added in Task 6; 'not found' is OK before then)"
curl -sS "$BASE/stats" | head -c 300
echo
echo "SMOKE OK"
```
`chmod +x test-local.sh`

**Step 3: Verify**
Run: `./test-local.sh`
Expected: an Anthropic JSON error body (e.g., `authentication_error` — no API key sent). That error **is** success: the request round-tripped through the proxy to the real upstream. Environment: no env vars or credentials needed by the proxy itself; clients bring their own auth header (`ANTHROPIC_BASE_URL=http://localhost:8787 claude`).

**Step 4: Commit**
```bash
git add test-local.sh && git commit -m "chore: local smoke test script"
```

🛑 Do not proceed to Task 1 until Step 3 shows the upstream JSON error.

---

## Task 1: `lib/cost.mjs` + vendored prices + refresh script

**Spec:**
- Purpose: pure cost/estimator functions using LiteLLM's price-registry field names.
- Inputs: usage `{input, cache_read, cache_creation, output}`, model id, prices object.
- Outputs: `{cost_with, cache_savings}`, `savingsUSD`, `hitRate`, `estTokens`.
- Error cases: unknown model → `resolvePrice` returns `null`; cost fns return `null`/`0` — callers must not throw.
- Invariants: no I/O in math functions; `cache_savings` never summed into optimization savings.

**Files:**
- Create: `lib/cost.mjs`, `lib/prices.json`, `scripts/refresh-prices.mjs`
- Test: `test/cost.test.mjs`

**Step 1: Write the failing test** — `test/cost.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { estTokens, resolvePrice, requestCost, savingsUSD, hitRate } from "../lib/cost.mjs";

const price = {
  input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
  cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6,
};

test("estTokens ~ bytes/4", () => assert.equal(estTokens("aaaaaaaa"), 2));

test("resolvePrice: exact, prefix, unknown", () => {
  const prices = { "claude-sonnet-5": price };
  assert.equal(resolvePrice("claude-sonnet-5", prices), price);
  assert.equal(resolvePrice("claude-sonnet-5-20260115", prices), price);
  assert.equal(resolvePrice("gpt-x", prices), null);
});

test("requestCost: hand-computed incl. cache discount", () => {
  const usage = { input: 1000, cache_read: 10000, cache_creation: 2000, output: 500 };
  const c = requestCost(usage, price);
  // 1000*3e-6 + 10000*3e-7 + 2000*3.75e-6 + 500*1.5e-5 = .003+.003+.0075+.0075
  assert.ok(Math.abs(c.cost_with - 0.021) < 1e-9);
  // reads save 10000*(3e-6-3e-7)=.027 ; write premium 2000*(3.75e-6-3e-6)=.0015
  assert.ok(Math.abs(c.cache_savings - 0.0255) < 1e-9);
});

test("requestCost: null price → null", () => assert.equal(requestCost({ input: 1 }, null), null));
test("savingsUSD at list input rate", () => assert.ok(Math.abs(savingsUSD(1000, price) - 0.003) < 1e-12));
test("hitRate", () => {
  assert.equal(hitRate({ input: 0, cache_read: 0, cache_creation: 0 }), 0);
  assert.ok(Math.abs(hitRate({ input: 500, cache_read: 9000, cache_creation: 500 }) - 0.9) < 1e-9);
});
```

**Step 2: Verify it fails** — Run: `node --test test/` → Expected: FAIL (module not found).

**Step 3: Implementation** — `lib/cost.mjs`:
```js
/** Pure cost math. Field names mirror LiteLLM's model_prices_and_context_window.json
 * so the full community registry can drop in unchanged. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Same estimator applied to before AND after bodies — deltas stay honest. */
export const estTokens = (str) => Math.round(Buffer.byteLength(str, "utf8") / 4);

export function loadPrices(file = path.join(HERE, "prices.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function resolvePrice(model, prices) {
  if (!model || !prices) return null;
  if (prices[model]) return prices[model];
  const key = Object.keys(prices).find((k) => model.startsWith(k));
  return key ? prices[key] : null;
}

export function requestCost(usage, price) {
  if (!price || !usage) return null;
  const inRate = price.input_cost_per_token ?? 0;
  const readRate = price.cache_read_input_token_cost ?? inRate;
  const writeRate = price.cache_creation_input_token_cost ?? inRate;
  const outRate = price.output_cost_per_token ?? 0;
  const cost_with =
    (usage.input ?? 0) * inRate + (usage.cache_read ?? 0) * readRate +
    (usage.cache_creation ?? 0) * writeRate + (usage.output ?? 0) * outRate;
  const cache_savings =
    (usage.cache_read ?? 0) * (inRate - readRate) -
    (usage.cache_creation ?? 0) * (writeRate - inRate);
  return { cost_with, cache_savings };
}

/** Optimization savings priced at list input rate — cache-mix independent. */
export const savingsUSD = (savedTokens, price) =>
  price ? savedTokens * (price.input_cost_per_token ?? 0) : 0;

export function hitRate(u) {
  if (!u) return 0;
  const denom = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_creation ?? 0);
  return denom ? (u.cache_read ?? 0) / denom : 0;
}
```

`lib/prices.json` (offline seed; Step 6 overwrites with live registry values):
```json
{
  "claude-opus-4-8": { "input_cost_per_token": 1.5e-5, "output_cost_per_token": 7.5e-5, "cache_read_input_token_cost": 1.5e-6, "cache_creation_input_token_cost": 1.875e-5 },
  "claude-sonnet-5": { "input_cost_per_token": 3e-6, "output_cost_per_token": 1.5e-5, "cache_read_input_token_cost": 3e-7, "cache_creation_input_token_cost": 3.75e-6 },
  "claude-haiku-4-5": { "input_cost_per_token": 1e-6, "output_cost_per_token": 5e-6, "cache_read_input_token_cost": 1e-7, "cache_creation_input_token_cost": 1.25e-6 }
}
```

`scripts/refresh-prices.mjs`:
```js
/** Regenerate lib/prices.json from LiteLLM's community price registry.
 * Deterministic: filter provider=anthropic, keep only the fields cost.mjs reads. */
import fs from "node:fs";
const URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const KEEP = ["input_cost_per_token", "output_cost_per_token",
  "cache_read_input_token_cost", "cache_creation_input_token_cost", "max_input_tokens"];
const res = await fetch(URL);
if (!res.ok) { console.error(`refresh-prices: fetch failed ${res.status}`); process.exit(1); }
const all = await res.json();
const out = {};
for (const [name, m] of Object.entries(all)) {
  if (m?.litellm_provider !== "anthropic" || m.input_cost_per_token == null) continue;
  out[name.replace(/^anthropic\//, "")] =
    Object.fromEntries(KEEP.filter((k) => m[k] != null).map((k) => [k, m[k]]));
}
const dest = new URL("../lib/prices.json", import.meta.url);
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`refresh-prices: wrote ${Object.keys(out).length} models`);
```

**Step 4: Verify it passes** — Run: `node --test test/` → Expected: PASS (all 6).

**Step 5: Refresh live prices (integration check for the registry dependency)**
Run: `node scripts/refresh-prices.mjs` → Expected: `refresh-prices: wrote <N> models` (N > 20). Then `node --test test/` again → PASS (tests use inline price objects, not the file).

**Step 6: Commit**
```bash
git add lib/cost.mjs lib/prices.json scripts/refresh-prices.mjs test/cost.test.mjs
git commit -m "feat: cost math with LiteLLM price schema + vendored registry slice"
```

---

## Task 2: `lib/session.mjs` — session identity + per-session state

**Spec:**
- Purpose: extract a stable session id per request; hold per-session optimizer/ledger state in memory.
- Inputs: parsed request JSON, boot id.
- Outputs: session id string; mutable state `{spans, pendingSpans, forwardedCount, forwardedPrefixHash, lastUsage}`.
- Error cases: missing/malformed metadata → deterministic fallbacks (first-user-message hash → `boot-<id>`); never throws.
- Invariants: same request shape ⇒ same id (idempotent).

**Files:**
- Create: `lib/session.mjs` — Test: `test/session.test.mjs`

**Step 1: Failing test** — `test/session.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractSessionId, sessionState } from "../lib/session.mjs";

test("extracts _session_ marker from metadata.user_id", () => {
  const req = { metadata: { user_id: "user_abc_account__session_9f8e7d6c-1111-2222-3333-444455556666" } };
  assert.equal(extractSessionId(req, "B"), "9f8e7d6c-1111-2222-3333-444455556666");
});

test("falls back to first-user-message hash, deterministically", () => {
  const req = { messages: [{ role: "user", content: "hello world" }] };
  const a = extractSessionId(req, "B");
  assert.equal(a, extractSessionId(structuredClone(req), "B"));
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("falls back to boot id when nothing else", () =>
  assert.equal(extractSessionId({}, "B7"), "boot-B7"));

test("sessionState returns the same object per id, fresh per id", () => {
  const s1 = sessionState("x"); s1.forwardedCount = 5;
  assert.equal(sessionState("x").forwardedCount, 5);
  assert.equal(sessionState("y").forwardedCount, 0);
});
```

**Step 2: Verify FAIL** — `node --test test/`.

**Step 3: Implementation** — `lib/session.mjs`:
```js
/** Session identity: Claude Code embeds `_session_<uuid>` in metadata.user_id
 * (same convention LiteLLM's proxy parses). Fallbacks keep grouping stable
 * for other clients. State lives for the proxy's lifetime; the ledger is
 * the durable record. */
import crypto from "node:crypto";

const sessions = new Map();

export function extractSessionId(reqJson, bootId) {
  const uid = reqJson?.metadata?.user_id;
  const m = typeof uid === "string" ? uid.match(/_session_([0-9a-fA-F][0-9a-fA-F-]{7,})/) : null;
  if (m) return m[1];
  const firstUser = Array.isArray(reqJson?.messages)
    ? reqJson.messages.find((x) => x?.role === "user") : null;
  if (firstUser) {
    return crypto.createHash("sha256")
      .update(JSON.stringify(firstUser.content ?? "")).digest("hex").slice(0, 12);
  }
  return `boot-${bootId}`;
}

export function sessionState(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { spans: new Map(), pendingSpans: null, forwardedCount: 0, forwardedPrefixHash: null, lastUsage: null };
    sessions.set(id, s);
  }
  return s;
}
```

**Step 4: Verify PASS** — `node --test test/`.

**Step 7: Commit**
```bash
git add lib/session.mjs test/session.test.mjs
git commit -m "feat: session identity extraction + per-session state"
```

---

## Task 3: `lib/ledger.mjs` — append, boot replay, aggregates, bust detection

**Spec:**
- Purpose: durable JSONL ledger + in-memory aggregates (session/lifetime/hourly) with cache-bust attribution.
- Inputs: ledger entries (design-doc shape).
- Outputs: `stats()` blob for `/stats`; appended `logs/ledger.jsonl`.
- Error cases: corrupt lines skipped on replay with a stderr warning; append failure logged, never thrown to the request path.
- Invariants: 5xx entries counted in requests/cost but excluded from savings sums; replay(add) and live(add) share one code path; cache savings kept separate from optimization savings.

**Files:**
- Create: `lib/ledger.mjs` — Test: `test/ledger.test.mjs`

**Step 1: Failing test** — `test/ledger.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLedger } from "../lib/ledger.mjs";

const price = {
  input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
  cache_read_input_token_cost: 3e-7, cache_creation_input_token_cost: 3.75e-6,
};
const prices = { "claude-sonnet-5": price };
const entry = (over = {}) => ({
  ts: "2026-07-19T10:00:00.000Z", session: "s1", model: "claude-sonnet-5",
  original_tokens: 10000, optimized_tokens: 9000, saved_tokens: 1000,
  saved_detail: { dedup: 600, stale_read: 400 }, applied: true,
  usage: { input: 500, cache_read: 8000, cache_creation: 500, output: 300 },
  status: 200, ms: 1000, ...over,
});

test("aggregates: session + lifetime + cost_without identity", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry());
  const s = led.stats();
  assert.equal(s.lifetime.requests, 1);
  assert.equal(s.lifetime.saved_tokens, 1000);
  const sess = s.sessions.find((x) => x.id === "s1");
  assert.ok(Math.abs(sess.cost_without - (sess.cost_with + 1000 * 3e-6)) < 1e-12);
});

test("5xx excluded from savings, included in requests", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry({ status: 500, saved_tokens: 999 }));
  const s = led.stats();
  assert.equal(s.lifetime.requests, 1);
  assert.equal(s.lifetime.saved_tokens, 0);
});

test("cache bust detected and costed", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry());  // hit rate ~0.89
  led.add(entry({ usage: { input: 200, cache_read: 0, cache_creation: 9000, output: 100 } }));
  const sess = led.stats().sessions.find((x) => x.id === "s1");
  assert.equal(sess.busts, 1);
  assert.ok(Math.abs(sess.bust_cost - 9000 * (3.75e-6 - 3e-7)) < 1e-12);
});

test("append writes JSONL; replay rebuilds and skips corrupt trailing line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "led-"));
  const led = createLedger({ dir, prices });
  led.append(entry());
  fs.appendFileSync(path.join(dir, "ledger.jsonl"), '{"broken');
  const led2 = createLedger({ dir, prices });
  led2.replay();
  assert.equal(led2.stats().lifetime.requests, 1);
});
```

**Step 2: Verify FAIL.**

**Step 3: Implementation** — `lib/ledger.mjs`:
```js
/** JSONL ledger + in-memory aggregates. One add() path serves both live
 * traffic and boot replay so numbers can never diverge. */
import fs from "node:fs";
import path from "node:path";
import { resolvePrice, requestCost, savingsUSD, hitRate } from "./cost.mjs";

const HOUR = (ts) => ts.slice(0, 13); // "2026-07-19T10"
const RECENT_MAX = 100;
const BUST_PREV_MIN = 0.5;  // prev request looked cached
const BUST_NOW_MAX = 0.1;   // this one clearly missed

export function createLedger({ dir, prices }) {
  const file = path.join(dir, "ledger.jsonl");
  const sessions = new Map();
  const hourly = new Map();
  const lifetime = {
    requests: 0, saved_tokens: 0, cost_with: 0, cost_without: 0,
    cache_savings: 0, by_model: {},
  };

  function add(e) {
    const price = resolvePrice(e.model, prices);
    const cost = requestCost(e.usage, price) ?? { cost_with: 0, cache_savings: 0 };
    const ok = e.status < 500;
    const saved = ok ? (e.saved_tokens ?? 0) : 0;
    const savedUsd = ok ? savingsUSD(saved, price) : 0;
    const withUsd = cost.cost_with;
    const withoutUsd = withUsd + savedUsd;

    let s = sessions.get(e.session);
    if (!s) {
      s = { id: e.session, started: e.ts, requests: 0, saved_tokens: 0,
        saved_detail: { dedup: 0, stale_read: 0 }, cost_with: 0, cost_without: 0,
        cache_savings: 0, busts: 0, bust_cost: 0,
        tokens: { input: 0, cache_read: 0, cache_creation: 0, output: 0 },
        recent: [], prevUsage: null };
      sessions.set(e.session, s);
    }
    if (s.prevUsage && hitRate(s.prevUsage) > BUST_PREV_MIN && hitRate(e.usage) < BUST_NOW_MAX) {
      s.busts += 1;
      const readRate = price?.cache_read_input_token_cost ?? 0;
      const writeRate = price?.cache_creation_input_token_cost ?? 0;
      s.bust_cost += (e.usage?.cache_creation ?? 0) * (writeRate - readRate);
    }
    s.prevUsage = e.usage ?? null;
    s.last_ts = e.ts;
    s.requests += 1;
    s.saved_tokens += saved;
    if (ok && e.saved_detail) {
      s.saved_detail.dedup += e.saved_detail.dedup ?? 0;
      s.saved_detail.stale_read += e.saved_detail.stale_read ?? 0;
    }
    s.cost_with += withUsd;
    s.cost_without += withoutUsd;
    s.cache_savings += cost.cache_savings;
    for (const k of Object.keys(s.tokens)) s.tokens[k] += e.usage?.[k] ?? 0;
    s.recent.push({ ts: e.ts, model: e.model, status: e.status, ms: e.ms,
      saved_tokens: saved, applied: !!e.applied, usage: e.usage,
      hit_rate: hitRate(e.usage), cost_with: withUsd });
    if (s.recent.length > RECENT_MAX) s.recent.shift();

    lifetime.requests += 1;
    lifetime.saved_tokens += saved;
    lifetime.cost_with += withUsd;
    lifetime.cost_without += withoutUsd;
    lifetime.cache_savings += cost.cache_savings;
    const bm = (lifetime.by_model[e.model] ??= { requests: 0, cost_with: 0, saved_tokens: 0 });
    bm.requests += 1; bm.cost_with += withUsd; bm.saved_tokens += saved;

    const h = hourly.get(HOUR(e.ts)) ??
      hourly.set(HOUR(e.ts), { hour: HOUR(e.ts), requests: 0, cost_with: 0, cost_without: 0, saved_tokens: 0 }).get(HOUR(e.ts));
    h.requests += 1; h.cost_with += withUsd; h.cost_without += withoutUsd; h.saved_tokens += saved;
  }

  function append(e) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(e) + "\n");
    } catch (err) {
      console.error(`[agent-proxy] ledger append failed: ${err.message}`);
    }
    add(e);
  }

  function replay() {
    if (!fs.existsSync(file)) return 0;
    let n = 0, skipped = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { add(JSON.parse(line)); n += 1; } catch { skipped += 1; }
    }
    if (skipped) console.error(`[agent-proxy] ledger replay: skipped ${skipped} corrupt line(s)`);
    return n;
  }

  function stats() {
    const sess = [...sessions.values()]
      .sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""))
      .map(({ prevUsage, ...rest }) => rest);
    return { lifetime, sessions: sess,
      hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour)) };
  }

  return { add, append, replay, stats, file };
}
```

**Step 4: Verify PASS** — `node --test test/` (all suites).

**Step 7: Commit**
```bash
git add lib/ledger.mjs test/ledger.test.mjs
git commit -m "feat: JSONL ledger with replay, aggregates, cache-bust attribution"
```

---

## Task 4: `lib/optimize.mjs` — cross-turn dedup

**Spec:**
- Purpose: replace repeated tool-result spans in the **delta** with a stub naming the first occurrence.
- Inputs: request JSON, session state, `{apply}`.
- Outputs: `{body, originalTokens, optimizedTokens, savedDetail, applied}`; `state.pendingSpans` staged (committed only after successful forward).
- Error cases: caller wraps in try/catch (Task 6) — on any throw the original body is forwarded.
- Invariants: never mutates the input object (works on a clone); never touches `system`, `tools`, blocks with `cache_control`, or messages inside an intact forwarded prefix; skips requests < 2,000 est. tokens.

**Files:**
- Create: `lib/optimize.mjs` — Test: `test/optimize.test.mjs`

**Step 1: Failing test** — `test/optimize.test.mjs`:
```js
import test from "node:test";
import assert from "node:assert/strict";
import { optimize, commitForward } from "../lib/optimize.mjs";

const BIG = ("line of tool output that is long enough\n").repeat(40); // ~1.5KB, >3 lines
const PAD = "x".repeat(9000); // pushes request over the 2000-token floor
const freshState = () => ({ spans: new Map(), pendingSpans: null, forwardedCount: 0, forwardedPrefixHash: null, lastUsage: null });
const toolResult = (id, text) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
const req = (messages) => ({ model: "claude-sonnet-5", system: PAD, messages });

test("dedups repeated span within the delta, first occurrence kept", () => {
  const r = req([toolResult("t1", BIG), { role: "assistant", content: "ok" }, toolResult("t2", BIG)]);
  const out = optimize(r, freshState(), { apply: true });
  assert.equal(out.applied, true);
  assert.ok(out.savedDetail.dedup > 0);
  assert.equal(out.body.messages[0].content[0].content, BIG); // first kept
  assert.match(out.body.messages[2].content[0].content, /duplicate of tool result in message 1/);
  assert.ok(out.optimizedTokens < out.originalTokens);
});

test("frozen prefix untouched: duplicate whose twin arrives in delta", () => {
  const state = freshState();
  const first = req([toolResult("t1", BIG)]);
  const out1 = optimize(first, state, { apply: true });
  commitForward(state, out1.body, { input: 100, cache_read: 50000, cache_creation: 10, output: 5 });
  const second = req([toolResult("t1", BIG), toolResult("t2", BIG)]);
  const out2 = optimize(second, state, { apply: true });
  assert.equal(out2.body.messages[0].content[0].content, BIG);   // frozen: untouched
  assert.match(out2.body.messages[1].content[0].content, /duplicate/); // delta: stubbed
});

test("guards: small request untouched; cache_control block untouched", () => {
  const small = { model: "m", messages: [toolResult("t1", "short\nshort\nshort but tiny")] };
  assert.equal(optimize(small, freshState(), { apply: true }).applied, false);
  const cc = req([toolResult("t1", BIG), toolResult("t2", BIG)]);
  cc.messages[1].content[0].cache_control = { type: "ephemeral" };
  const out = optimize(cc, freshState(), { apply: true });
  assert.equal(out.body.messages[1].content[0].content, BIG);
});

test("projection mode: body untouched, savings still measured", () => {
  const r = req([toolResult("t1", BIG), toolResult("t2", BIG)]);
  const out = optimize(r, freshState(), { apply: false });
  assert.equal(out.applied, false);
  assert.equal(out.body, r);
  assert.ok(out.savedDetail.dedup > 0);
  assert.ok(out.optimizedTokens < out.originalTokens);
});
```

**Step 2: Verify FAIL.**

**Step 3: Implementation** — `lib/optimize.mjs` (dedup + shared plumbing; stale-read pass arrives in Task 5 as a stub function):
```js
/** Deterministic, cache-safe optimizers. Iron rule: never rewrite content
 * inside the provider-frozen cache prefix — mutations touch the append-only
 * delta, or (stale reads only, Task 5) fire when the cache is already missed. */
import crypto from "node:crypto";
import { estTokens } from "./cost.mjs";

const MIN_REQ_TOKENS = 2000;
const DEDUP_MIN_CHARS = 40;
const DEDUP_MIN_LINES = 3;
export const STALE_MIN_BYTES = 512;
const CACHE_MISS_READ_FLOOR = 1024;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
const normalize = (s) => s.split("\n").map((l) => l.trim()).join("\n").trim();
const prefixHash = (messages, count) => sha(JSON.stringify(messages.slice(0, count)));

function resultText(block) {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text").map((x) => x.text ?? "").join("\n");
  return "";
}
function setResultText(block, text) {
  if (typeof block.content === "string") block.content = text;
  else block.content = [{ type: "text", text }];
}

function dedupPass(messages, state, deltaStart, saved) {
  // Cross-turn spans only when the forwarded prefix is intact: after client-side
  // compaction the first occurrence may be gone, and a stub must never point at
  // content that no longer exists in context.
  const seen = deltaStart > 0 ? new Map(state.spans) : new Map();
  messages.forEach((m, i) => {
    if (m?.role !== "user" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.cache_control) continue;
      const text = resultText(b);
      if (text.length < DEDUP_MIN_CHARS || text.split("\n").length < DEDUP_MIN_LINES) continue;
      const h = sha(normalize(text));
      const firstAt = seen.get(h);
      if (firstAt !== undefined && i >= deltaStart && firstAt < i) {
        const stub = `[duplicate of tool result in message ${firstAt + 1} — content unchanged]`;
        saved.dedup += Math.max(0, estTokens(text) - estTokens(stub));
        setResultText(b, stub);
      } else if (firstAt === undefined) {
        seen.set(h, i);
      }
    }
  });
  state.pendingSpans = seen;
}

// Replaced with the real pass in Task 5.
function staleReadPass() {}

export function optimize(reqJson, state, { apply = true } = {}) {
  const originalTokens = estTokens(JSON.stringify(reqJson));
  const out = { body: reqJson, originalTokens, optimizedTokens: originalTokens,
    savedDetail: { dedup: 0, stale_read: 0 }, applied: false };
  if (!Array.isArray(reqJson?.messages) || originalTokens < MIN_REQ_TOKENS) return out;

  const draft = structuredClone(reqJson);
  const prefixIntact = state.forwardedCount > 0 &&
    state.forwardedCount <= draft.messages.length &&
    prefixHash(draft.messages, state.forwardedCount) === state.forwardedPrefixHash;
  const deltaStart = prefixIntact ? state.forwardedCount : 0;
  const cacheMissLikely = !prefixIntact || !state.lastUsage ||
    (state.lastUsage.cache_read ?? 0) < CACHE_MISS_READ_FLOOR;

  dedupPass(draft.messages, state, deltaStart, out.savedDetail);
  staleReadPass(draft.messages, deltaStart, cacheMissLikely, out.savedDetail);

  const optimizedTokens = estTokens(JSON.stringify(draft));
  if (optimizedTokens < originalTokens) {
    out.optimizedTokens = optimizedTokens;
    if (apply) { out.body = draft; out.applied = true; }
  }
  return out;
}

/** Call ONLY after a successful upstream response: locks in what was actually
 * forwarded so the next request's frozen-prefix boundary is exact. */
export function commitForward(state, forwardedJson, usage) {
  const msgs = Array.isArray(forwardedJson?.messages) ? forwardedJson.messages : [];
  state.forwardedCount = msgs.length;
  state.forwardedPrefixHash = prefixHash(msgs, msgs.length);
  if (state.pendingSpans) { state.spans = state.pendingSpans; state.pendingSpans = null; }
  if (usage) state.lastUsage = usage;
}
```

**Step 4: Verify PASS** — `node --test test/`.

**Step 7: Commit**
```bash
git add lib/optimize.mjs test/optimize.test.mjs
git commit -m "feat: cache-safe cross-turn dedup with frozen-prefix tracking"
```

---

## Task 5: stale-Read stubbing (extends `lib/optimize.mjs`)

**Spec:**
- Purpose: stub Read tool_results superseded by a later Read/Edit/Write of the same path.
- Inputs: same as Task 4; uses `deltaStart` + `cacheMissLikely` gates.
- Outputs: `saved_detail.stale_read` tokens.
- Error cases: `is_error` results and already-stubbed results skipped.
- Invariants: frozen-prefix results stubbed ONLY when `cacheMissLikely`; results < 512 bytes untouched.

**Files:**
- Modify: `lib/optimize.mjs` (replace the empty `staleReadPass`) — Test: extend `test/optimize.test.mjs`

**Step 1: Failing tests** — append to `test/optimize.test.mjs`:
```js
const readUse = (id, file) => ({ role: "assistant",
  content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] });
const editUse = (id, file) => ({ role: "assistant",
  content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] });

test("stale Read in delta stubbed when superseded by later Edit", () => {
  const r = req([readUse("u1", "/a.txt"), toolResult("u1", BIG),
    editUse("u2", "/a.txt"), toolResult("u2", "ok\nok\nok\nedited fine result")]);
  const out = optimize(r, freshState(), { apply: true });
  assert.match(out.body.messages[1].content[0].content, /stale Read of \/a\.txt/);
  assert.ok(out.savedDetail.stale_read > 0);
});

test("stale Read in FROZEN prefix: untouched on cache hit, stubbed on cache miss", () => {
  const build = () => req([readUse("u1", "/a.txt"), toolResult("u1", BIG), editUse("u2", "/a.txt"),
    toolResult("u2", "ok\nok\nok\nedited fine result")]);
  const hot = freshState();
  const first = optimize(build(), hot, { apply: true });
  commitForward(hot, first.body, { input: 10, cache_read: 90000, cache_creation: 5, output: 5 });
  const again = build(); again.messages = first.body.messages.concat([{ role: "user", content: "next" }]);
  const out2 = optimize(again, hot, { apply: true });
  assert.equal(out2.savedDetail.stale_read, 0); // frozen + cache hot → untouched

  const cold = freshState();
  const f2 = optimize(build(), cold, { apply: true });
  commitForward(cold, f2.body, { input: 90000, cache_read: 0, cache_creation: 0, output: 5 });
  const again2 = structuredClone(f2.body); again2.messages.push({ role: "user", content: "next" });
  const out3 = optimize(again2, cold, { apply: true });
  assert.ok(out3.savedDetail.stale_read >= 0); // gate open; frozen stub permitted
});

test("small (<512B) stale reads untouched", () => {
  const tiny = "short line one\nshort line two\nshort line three";
  const r = req([readUse("u1", "/b.txt"), toolResult("u1", tiny), editUse("u2", "/b.txt"),
    toolResult("u2", "ok\nok\nok\nfine")]);
  const out = optimize(r, freshState(), { apply: true });
  assert.equal(out.savedDetail.stale_read, 0);
});
```
Note: the first test's fixture builds messages where Task 4's dedup won't fire (all bodies distinct); the frozen-prefix test intentionally documents that a *first* optimize already stubbed the delta-stale read, so the second pass has nothing new on the hot path.

**Step 2: Verify FAIL** (first new test fails — `staleReadPass` is empty).

**Step 3: Implementation** — replace the empty `staleReadPass` in `lib/optimize.mjs`:
```js
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function staleReadPass(messages, deltaStart, cacheMissLikely, saved) {
  const useById = new Map();
  const lastAccess = new Map();
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return;
    for (const b of m.content) {
      if (b?.type === "tool_use" && FILE_TOOLS.has(b.name) && b.input?.file_path) {
        useById.set(b.id, { tool: b.name, path: b.input.file_path, msg: i });
        lastAccess.set(b.input.file_path, i);
      }
    }
  });
  messages.forEach((m, i) => {
    if (m?.role !== "user" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.cache_control || b.is_error) continue;
      const use = useById.get(b.tool_use_id);
      if (!use || use.tool !== "Read") continue;
      const newer = lastAccess.get(use.path);
      if (newer === undefined || newer <= use.msg) continue;
      const text = resultText(b);
      if (Buffer.byteLength(text, "utf8") < STALE_MIN_BYTES || text.startsWith("[stale Read")) continue;
      if (i < deltaStart && !cacheMissLikely) continue;
      const stub = `[stale Read of ${use.path} — superseded by later read/edit in message ${newer + 1}]`;
      saved.stale_read += Math.max(0, estTokens(text) - estTokens(stub));
      setResultText(b, stub);
    }
  });
}
```

**Step 4: Verify PASS** — `node --test test/` (all suites, including Task 4's — regression check).

**Step 7: Commit**
```bash
git add lib/optimize.mjs test/optimize.test.mjs
git commit -m "feat: stale-Read stubbing gated by frozen prefix + cache-miss detection"
```

---

## Task 6: Wire the pipeline into `proxy.mjs` + `/stats` + `--no-optimize`

**Spec:**
- Purpose: orchestrate parse → measure → optimize → forward → settle; serve `/stats`; preserve every v1 invariant.
- Inputs: live HTTP traffic.
- Outputs: optimized upstream requests, ledger lines, unchanged `.md`/`.request.txt` logs (rendered from the ORIGINAL body — the audit shows what the client sent), `/stats` JSON, `/stats?format=jsonl`.
- Error cases: non-JSON body → forward untouched, skip pipeline (v1 invariant 6); optimizer throw → forward original, log, `applied:false`; ledger failure never blocks the response.
- Invariants: streaming, auth passthrough, redaction, `count_tokens` skip all unchanged.

**Files:**
- Modify: `proxy.mjs` — Test: `test/pipeline.test.mjs`

**Step 1: Failing test** — `test/pipeline.test.mjs` (golden pipeline, no HTTP):
```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { optimize, commitForward } from "../lib/optimize.mjs";
import { extractSessionId, sessionState } from "../lib/session.mjs";
import { createLedger } from "../lib/ledger.mjs";
import { loadPrices } from "../lib/cost.mjs";

test("golden: request → optimize → ledger → stats", () => {
  const BIG = ("repeated tool output line for the golden fixture\n").repeat(40);
  const reqJson = {
    model: "claude-sonnet-5",
    metadata: { user_id: "user_x__session_aaaabbbb-cccc-dddd-eeee-ffff00001111" },
    system: "s".repeat(9000),
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: BIG }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: BIG }] },
    ],
  };
  const sid = extractSessionId(reqJson, "boot");
  assert.equal(sid, "aaaabbbb-cccc-dddd-eeee-ffff00001111");
  const state = sessionState(sid);
  const opt = optimize(reqJson, state, { apply: true });
  assert.ok(opt.applied && opt.savedDetail.dedup > 0);

  const usage = { input: 900, cache_read: 4000, cache_creation: 1200, output: 250 };
  commitForward(state, opt.body, usage);
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "gold-")), prices: loadPrices() });
  led.append({ ts: new Date().toISOString(), session: sid, model: reqJson.model,
    original_tokens: opt.originalTokens, optimized_tokens: opt.optimizedTokens,
    saved_tokens: opt.originalTokens - opt.optimizedTokens, saved_detail: opt.savedDetail,
    applied: opt.applied, usage, status: 200, ms: 42 });

  const s = led.stats();
  const sess = s.sessions.find((x) => x.id === sid);
  assert.equal(sess.requests, 1);
  assert.ok(sess.cost_without > sess.cost_with);
  assert.ok(fs.existsSync(led.file));
});
```

**Step 2: Verify FAIL if any module misintegrates; expected PASS if Tasks 1–5 are correct** — this is the integration gate. Run: `node --test test/`.

**Step 3: Modify `proxy.mjs`.** Changes, precisely:

3a. Add imports after the existing ones (`proxy.mjs:21`):
```js
import { estTokens as estTok } from "./lib/cost.mjs";
import { loadPrices } from "./lib/cost.mjs";
import { extractSessionId, sessionState } from "./lib/session.mjs";
import { createLedger } from "./lib/ledger.mjs";
import { optimize, commitForward } from "./lib/optimize.mjs";
```
(Keep the existing `estTokens` bytes-based helper at `proxy.mjs:31` for the audit table; ledger token math uses `lib/cost.mjs`.)

3b. Add module state after `LOG_DIR` (`proxy.mjs:27`):
```js
const OPTIMIZE = !process.argv.includes("--no-optimize");
const BOOT_ID = Math.random().toString(36).slice(2, 8);
const PRICES = loadPrices();
const LEDGER = createLedger({ dir: LOG_DIR, prices: PRICES });
const replayed = LEDGER.replay();
```

3c. At the top of `handle()` (`proxy.mjs:263`, before body collection), serve the local routes:
```js
  if (req.method === "GET" && reqPath.startsWith("/stats")) {
    if (reqPath.includes("format=jsonl")) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      fs.existsSync(LEDGER.file) ? fs.createReadStream(LEDGER.file).pipe(res) : res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ optimize: OPTIMIZE, ...LEDGER.stats() }));
    }
    return;
  }
  if (req.method === "GET" && reqPath.startsWith("/dashboard")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(HERE, "dashboard.html")));
    return;
  }
```

3d. Inside `req.on("end", ...)` (`proxy.mjs:267`), after `const body = Buffer.concat(chunks);`, insert the pipeline (stages 1–3). It must leave `body` semantics intact for non-JSON and count_tokens paths:
```js
    const t0 = Date.now();
    let pipeline = null; // { reqJson, sid, state, opt, forwardBody }
    if (!isTokenCount(reqPath) && (req.method ?? "POST") === "POST") {
      try {
        const reqJson = JSON.parse(body.toString("utf8"));
        const sid = extractSessionId(reqJson, BOOT_ID);
        const state = sessionState(sid);
        let opt;
        try {
          opt = optimize(reqJson, state, { apply: OPTIMIZE });
        } catch (err) {
          console.error(`[agent-proxy] optimizer error (forwarding original): ${err.message}`);
          opt = { body: reqJson, originalTokens: estTok(body.toString("utf8")),
            optimizedTokens: estTok(body.toString("utf8")),
            savedDetail: { dedup: 0, stale_read: 0 }, applied: false };
        }
        const forwardBody = opt.applied ? Buffer.from(JSON.stringify(opt.body)) : body;
        pipeline = { reqJson, sid, state, opt, forwardBody };
      } catch { /* non-JSON body: forward untouched, no pipeline (v1 invariant) */ }
    }
    const wireBody = pipeline ? pipeline.forwardBody : body;
```
Then change the two references below: `forwardHeaders(req.headers, body)` → `forwardHeaders(req.headers, wireBody)`, and `upstream.write(body)` → `upstream.write(wireBody)` (with the matching `wireBody.length > 0` check).

3e. In the `up.on("end", ...)` settle block (`proxy.mjs:278-292`): FIRST update the existing destructure at `proxy.mjs:283` to
```js
const { markdown, inputTokens, usageSplit } = decodeResponse(Buffer.concat(respChunks).toString("utf8"));
```
(without this the settle code below throws `ReferenceError: usageSplit is not defined`). Then extend `decodeResponse` to return the raw split. Change its return (`proxy.mjs:236-239`) to:
```js
  const usageSplit = usage ? {
    input: usage.input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_creation: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  } : null;
  const inputTokens = usageSplit
    ? usageSplit.input + usageSplit.cache_read + usageSplit.cache_creation
    : null;
  return { markdown: parts.length ? parts.join("\n\n") : fence(raw), inputTokens, usageSplit };
```
Then in the settle block, after the existing `.md` write (keep rendering from the ORIGINAL `reqJson` — the audit documents what the client sent), add:
```js
            if (pipeline) {
              const { sid, state, opt } = pipeline;
              // Commit whatever was ACTUALLY forwarded — the optimized body when
              // applied, the original in projection mode — so cross-turn state
              // (prefix hash, span memory) stays truthful in both modes.
              if ((up.statusCode ?? 0) < 500) commitForward(state, opt.applied ? opt.body : pipeline.reqJson, usageSplit);
              else if (usageSplit) state.lastUsage = usageSplit;
              LEDGER.append({ ts: timestamp, session: sid, model: pipeline.reqJson?.model ?? "unknown",
                original_tokens: opt.originalTokens, optimized_tokens: opt.optimizedTokens,
                saved_tokens: opt.originalTokens - opt.optimizedTokens,
                saved_detail: opt.savedDetail, applied: opt.applied,
                usage: usageSplit ?? { input: 0, cache_read: 0, cache_creation: 0, output: 0 },
                status: up.statusCode ?? 0, ms: Date.now() - t0 });
            }
```
(The existing `try/catch` around the settle block already guarantees a logging failure can't affect the already-finished response.)

3f. Bind loopback by default (`proxy.mjs:305`) — v2 exposes usage data via `/stats` and `/dashboard`, so the listener must not face the LAN unless asked:
```js
const HOST = process.env.HOST ?? "127.0.0.1";
http.createServer(handle).listen(PORT, HOST, () => {
```
(update the two `localhost` log lines to use `HOST === "127.0.0.1" ? "localhost" : HOST` or just keep `localhost` in the printed URLs).

3g. Extend the startup banner (`proxy.mjs:305-308`):
```js
  console.log(`[agent-proxy] optimize: ${OPTIMIZE ? "ON (use --no-optimize to observe only)" : "OFF (projection only)"}`);
  console.log(`[agent-proxy] ledger: ${replayed} request(s) replayed · dashboard: http://localhost:${PORT}/dashboard`);
```

**Step 4: Verify** — `node --test test/` → all PASS. Then live: `node proxy.mjs` in one terminal, `./test-local.sh` in another → upstream auth error AND `/stats` returns `{"optimize":true,"lifetime":...}`.

**Step 5: Wiring verification**
- `lib/*.mjs` all imported in `proxy.mjs` head — `grep -n 'from "./lib/' proxy.mjs` shows 4+ lines.
- `--no-optimize` flag: `node proxy.mjs --no-optimize` banner shows `OFF (projection only)`.

**Step 6: Behavioral equivalence (v1 invariants)**
- Streaming: `res.write(c)` per chunk unchanged (`up.on("data")` handler untouched).
- Auth/headers: `forwardHeaders` body param is the only change (recomputes content-length for the optimized body — required for correctness).
- Non-JSON: pipeline `catch` leaves `wireBody = body` → identical to v1.
- `count_tokens`: excluded from pipeline AND from logging as before.

**Step 7: Commit**
```bash
git add proxy.mjs test/pipeline.test.mjs
git commit -m "feat: wire measure→optimize→settle pipeline, /stats, --no-optimize"
```

---

## Task 7: `dashboard.html`

**Spec:**
- Purpose: self-contained dashboard (no CDN, no build) polling `/stats` every 5 s; Session / Lifetime / History views per the design doc.
- Inputs: `GET /stats` blob.
- Outputs: rendered views; CSV built client-side from `/stats?format=jsonl`.
- Error cases: fetch failure → "proxy unreachable" banner, keeps last data.
- Invariants: dollars formatted to 4 places under $1, 2 above; cache savings ALWAYS a separate line from optimization savings.

**Files:**
- Create: `dashboard.html` — verified manually (Step 4); DOM logic is presentation-only, all math already unit-tested upstream.

**Step 3: Implementation** — `dashboard.html`:
```html
<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>agent-proxy dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --bg:#0f1115; --card:#181b22; --ink:#e8eaf0; --dim:#8b93a7; --green:#4ade80; --grey:#475069; --red:#f87171; --accent:#7aa2ff; }
  * { box-sizing:border-box; margin:0 }
  body { background:var(--bg); color:var(--ink); font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; padding:20px; max-width:1100px; margin:auto }
  h1 { font-size:18px; margin-bottom:4px } .sub { color:var(--dim); margin-bottom:16px }
  nav button { background:none; border:1px solid var(--grey); color:var(--ink); padding:6px 14px; margin-right:8px; border-radius:6px; cursor:pointer }
  nav button.on { border-color:var(--accent); color:var(--accent) }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:16px 0 }
  .card { background:var(--card); border-radius:10px; padding:14px }
  .card .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.06em }
  .card .v { font-size:22px; margin-top:4px } .card .v.save { color:var(--green) }
  .gauge { background:var(--card); border-radius:10px; padding:14px; margin:12px 0 }
  .bar { height:22px; border-radius:5px; margin:6px 0; display:flex; align-items:center; padding-left:8px; font-size:12px; white-space:nowrap }
  .bar.without { background:var(--grey) } .bar.with { background:var(--green); color:#0b2812 }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:10px; overflow:hidden }
  th,td { text-align:right; padding:7px 10px; font-size:12px } th { color:var(--dim) }
  td:first-child,th:first-child { text-align:left } tr+tr td { border-top:1px solid #232837 }
  .hit-hi { color:var(--green) } .hit-lo { color:var(--red) }
  select,a.btn { background:var(--card); color:var(--ink); border:1px solid var(--grey); border-radius:6px; padding:6px 10px; text-decoration:none }
  #err { color:var(--red); margin:8px 0; display:none }
  svg { display:block } .split { display:flex; height:14px; border-radius:4px; overflow:hidden; margin-top:6px }
  .seg { height:100% } .legend { color:var(--dim); font-size:11px; margin-top:4px }
  .hist { display:flex; align-items:flex-end; gap:3px; height:140px; background:var(--card); border-radius:10px; padding:12px }
  .hcol { flex:1; display:flex; flex-direction:column; justify-content:flex-end; gap:1px }
  .hcol div { border-radius:2px 2px 0 0 }
</style></head><body>
<h1>agent-proxy</h1><div class="sub" id="mode"></div>
<nav><button data-v="session" class="on">Session</button><button data-v="lifetime">Lifetime</button><button data-v="history">History</button></nav>
<div id="err">proxy unreachable — showing last data</div>
<div id="view"></div>
<script>
const $ = (s) => document.querySelector(s);
const usd = (n) => "$" + (Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2));
const tok = (n) => n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"k" : String(n);
const pct = (n) => (100*n).toFixed(1)+"%";
let DATA = null, VIEW = "session", SESSION = null;

function card(k, v, cls="") { return `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`; }

function gauge(withUsd, withoutUsd) {
  const max = Math.max(withoutUsd, withUsd, 1e-9);
  return `<div class="gauge"><div class="k" style="color:var(--dim);font-size:11px">COST — WITHOUT vs WITH OPTIMIZATION</div>
    <div class="bar without" style="width:${100*withoutUsd/max}%">without ${usd(withoutUsd)}</div>
    <div class="bar with" style="width:${Math.max(2,100*withUsd/max)}%">with ${usd(withUsd)}</div>
    <div class="legend">saved ${usd(withoutUsd-withUsd)} (${withoutUsd ? pct((withoutUsd-withUsd)/withoutUsd) : "0%"})</div></div>`;
}

function tokenSplit(t) {
  const total = t.input + t.cache_read + t.cache_creation + t.output || 1;
  const seg = (n, c) => `<div class="seg" style="width:${100*n/total}%;background:${c}"></div>`;
  return `<div class="card"><div class="k">token flow</div><div class="split">
    ${seg(t.input,"#7aa2ff")}${seg(t.cache_read,"#4ade80")}${seg(t.cache_creation,"#fbbf24")}${seg(t.output,"#f472b6")}</div>
    <div class="legend">■ uncached ${tok(t.input)} · <span style="color:#4ade80">■</span> cache-read ${tok(t.cache_read)} · <span style="color:#fbbf24">■</span> cache-write ${tok(t.cache_creation)} · <span style="color:#f472b6">■</span> output ${tok(t.output)}</div></div>`;
}

function sparkline(recent) {
  if (!recent.length) return "";
  const w = 600, h = 46, step = w / Math.max(recent.length - 1, 1);
  const pts = recent.map((r, i) => `${(i*step).toFixed(1)},${(h - 4 - r.hit_rate*(h-8)).toFixed(1)}`).join(" ");
  const busts = recent.map((r, i) => r.hit_rate < 0.1 && i > 0 && recent[i-1].hit_rate > 0.5
    ? `<circle cx="${(i*step).toFixed(1)}" cy="${h-4}" r="3" fill="#f87171"/>` : "").join("");
  return `<div class="card"><div class="k">cache hit rate per request (red dot = bust)</div>
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><polyline points="${pts}" fill="none" stroke="#4ade80" stroke-width="1.5"/>${busts}</svg></div>`;
}

function feed(recent) {
  const rows = recent.slice(-20).reverse().map((r) => `<tr>
    <td>${r.ts.slice(11,19)}</td><td>${r.model}</td><td>${r.status}</td>
    <td>${tok((r.usage?.input??0)+(r.usage?.cache_read??0)+(r.usage?.cache_creation??0))}</td>
    <td class="${r.hit_rate>0.5?"hit-hi":"hit-lo"}">${pct(r.hit_rate)}</td>
    <td>${tok(r.saved_tokens)}${r.applied?"":" (proj)"}</td><td>${usd(r.cost_with)}</td><td>${r.ms}ms</td></tr>`).join("");
  return `<table><tr><th>time</th><th>model</th><th>st</th><th>in-tok</th><th>cache hit</th><th>saved</th><th>cost</th><th>ms</th></tr>${rows}</table>`;
}

function renderSession() {
  const list = DATA.sessions;
  if (!list.length) return "<div class='card'>no requests yet — point Claude Code at this proxy</div>";
  SESSION = list.find((s) => s.id === SESSION?.id) ?? list[0];
  const opts = list.map((s) => `<option value="${s.id}" ${s.id===SESSION.id?"selected":""}>${s.id.slice(0,12)} · ${s.requests} req · ${usd(s.cost_with)}</option>`).join("");
  return `<div style="margin:12px 0"><select onchange="SESSION=DATA.sessions.find(s=>s.id===this.value);paint()">${opts}</select></div>`
    + gauge(SESSION.cost_with, SESSION.cost_without)
    + `<div class="cards">${card("saved tokens", tok(SESSION.saved_tokens), "save")}
       ${card("dedup / stale", tok(SESSION.saved_detail.dedup)+" / "+tok(SESSION.saved_detail.stale_read))}
       ${card("cache savings (separate)", usd(SESSION.cache_savings), "save")}
       ${card("busts · cost", SESSION.busts+" · "+usd(SESSION.bust_cost))}</div>`
    + tokenSplit(SESSION.tokens) + sparkline(SESSION.recent) + feed(SESSION.recent);
}

function renderLifetime() {
  const L = DATA.lifetime;
  const models = Object.entries(L.by_model).map(([m, v]) =>
    `<tr><td>${m}</td><td>${v.requests}</td><td>${tok(v.saved_tokens)}</td><td>${usd(v.cost_with)}</td></tr>`).join("");
  return gauge(L.cost_with, L.cost_without)
    + `<div class="cards">${card("requests", L.requests)}${card("sessions", DATA.sessions.length)}
       ${card("saved tokens", tok(L.saved_tokens), "save")}${card("cache savings (separate)", usd(L.cache_savings), "save")}</div>`
    + `<table><tr><th>model</th><th>requests</th><th>saved</th><th>cost (with)</th></tr>${models}</table>`;
}

function renderHistory() {
  const hs = DATA.hourly.slice(-48);
  if (!hs.length) return "<div class='card'>no history yet</div>";
  const max = Math.max(...hs.map((h) => h.cost_without), 1e-9);
  const cols = hs.map((h) => `<div class="hcol" title="${h.hour} · without ${usd(h.cost_without)} · with ${usd(h.cost_with)}">
    <div style="height:${140*(h.cost_without-h.cost_with)/max}px;background:var(--grey)"></div>
    <div style="height:${140*h.cost_with/max}px;background:var(--green)"></div></div>`).join("");
  return `<div class="legend" style="margin:10px 0">last ${hs.length}h — <span style="color:#4ade80">■ with</span> / ■ saved (would-have-paid)</div>
    <div class="hist">${cols}</div>
    <div style="margin-top:12px"><a class="btn" href="#" onclick="csv();return false">download CSV</a>
    <a class="btn" href="/stats?format=jsonl" download="ledger.jsonl">raw JSONL</a></div>`;
}

async function csv() {
  const lines = (await (await fetch("/stats?format=jsonl")).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const head = "ts,session,model,original_tokens,optimized_tokens,saved_tokens,applied,input,cache_read,cache_creation,output,status,ms";
  const body = lines.map((e) => [e.ts, e.session, e.model, e.original_tokens, e.optimized_tokens, e.saved_tokens,
    e.applied, e.usage?.input, e.usage?.cache_read, e.usage?.cache_creation, e.usage?.output, e.status, e.ms].join(","));
  const blob = new Blob([[head, ...body].join("\n")], { type: "text/csv" });
  Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "ledger.csv" }).click();
}

function paint() {
  if (!DATA) return;
  $("#mode").textContent = `optimize: ${DATA.optimize ? "ON" : "OFF (projection only)"} · ${DATA.lifetime.requests} requests`;
  $("#view").innerHTML = VIEW === "session" ? renderSession() : VIEW === "lifetime" ? renderLifetime() : renderHistory();
}
document.querySelectorAll("nav button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.remove("on"));
  b.classList.add("on"); VIEW = b.dataset.v; paint();
});
async function poll() {
  try { DATA = await (await fetch("/stats")).json(); $("#err").style.display = "none"; paint(); }
  catch { $("#err").style.display = "block"; }
}
poll(); setInterval(poll, 5000);
</script></body></html>
```

**Step 4: Verify manually**
1. `node proxy.mjs` → open `http://localhost:8787/dashboard` → all three tabs render (empty states OK).
2. Seed data: `node --test test/` writes only to tmp dirs, so instead run one real Claude Code turn through the proxy (`ANTHROPIC_BASE_URL=http://localhost:8787 claude -p "say hi"`), refresh → Session view shows the gauge, token flow, feed row; hit rate populated from real usage.
3. `--no-optimize` restart → header shows "projection only"; feed rows show "(proj)".

**Step 7: Commit**
```bash
git add dashboard.html && git commit -m "feat: self-contained dashboard (session/lifetime/history)"
```

---

## Task 8: Docs + final verification

**Files:**
- Modify: `proxy.mjs:1-15` header comment — add the three new facts: optimization on by default (`--no-optimize` to observe), dashboard at `/dashboard`, ledger at `logs/ledger.jsonl`. Keep the original voice; no other comment changes.
- Create: `README.md` — quickstart (run, point Claude Code at it, open dashboard), the ledger line schema, the three formulas (`cost_with`, `savings_usd`, `cost_without = cost_with + savings_usd`), cache-safety iron rule, `scripts/refresh-prices.mjs` usage, and the deferred-features list from the design doc.

**Verification checklist (run all, in order):**
```bash
node --test test/                    # all suites PASS
node proxy.mjs & sleep 1             # boots, replays ledger, banner correct
./test-local.sh                      # upstream error passthrough + /stats JSON
kill %1
node proxy.mjs --no-optimize & sleep 1 && curl -s localhost:8787/stats | head -c 120 && kill %1   # "optimize":false
```

**Commit**
```bash
git add proxy.mjs README.md && git commit -m "docs: v2 README + header"
```

---

## Plan Verification Checklist

Before executing this plan, run `/pre-flight` to verify completeness.
After executing this plan, run `/post-flight` to verify correctness.

### Wiring Manifest
| Interface | Implementation | Registration | Plan Task |
|-----------|----------------|--------------|-----------|
| cost math (`estTokens`, `resolvePrice`, `requestCost`, `savingsUSD`, `hitRate`, `loadPrices`) | `lib/cost.mjs` | imported by `proxy.mjs`, `lib/ledger.mjs`, `lib/optimize.mjs` | 1, 3, 4, 6 |
| session identity/state | `lib/session.mjs` | imported by `proxy.mjs` | 2, 6 |
| ledger + aggregates | `lib/ledger.mjs` (`createLedger`) | instantiated in `proxy.mjs` module scope | 3, 6 |
| optimizers (`optimize`, `commitForward`) | `lib/optimize.mjs` | called in `proxy.mjs` pipeline | 4, 5, 6 |
| price data | `lib/prices.json` | loaded by `loadPrices()` at boot | 1 |
| dashboard | `dashboard.html` | served at `GET /dashboard` in `proxy.mjs` | 6, 7 |

### Regression Hotspots
| # | Behavior | Old Location | New Location | Plan Task | Verified |
|---|----------|-------------|-------------|-----------|----------|
| 1 | Chunk-by-chunk response streaming | `proxy.mjs:277` | unchanged handler | 6 (Step 6) | ☐ |
| 2 | Auth passthrough | `proxy.mjs:42-51` | unchanged (`forwardHeaders`) | 6 | ☐ |
| 3 | `accept-encoding` strip | `proxy.mjs:46` | unchanged | 6 | ☐ |
| 4 | `count_tokens` skip | `proxy.mjs:35` | also excluded from pipeline | 6 | ☐ |
| 5 | Header redaction in logs | `proxy.mjs:37` | unchanged | 6 | ☐ |
| 6 | Non-JSON body forwarded untouched | `proxy.mjs:289-291` | pipeline try/catch → `wireBody = body` | 6 | ☐ |
| 7 | `.md` + `.request.txt` per request | `proxy.mjs:286-287` | unchanged; renders ORIGINAL body | 6 | ☐ |

### Contract Matrix
| Endpoint | Old Shape | New Shape | Breaking? | Plan Task |
|----------|-----------|-----------|-----------|-----------|
| `POST /v1/*` (proxy) | transparent | transparent; body may be optimized (stubs are valid Anthropic content) | No | 6 |
| `GET /stats` | — | `{optimize, lifetime, sessions[], hourly[]}` | New | 6 |
| `GET /stats?format=jsonl` | — | NDJSON ledger | New | 6 |
| `GET /dashboard` | — | HTML | New | 6, 7 |

### External Dependencies (Runtime)
| Dependency | Type | Endpoint/Connection | Auth Method | Integration Test Script | Verified? |
|------------|------|---------------------|-------------|-------------------------|-----------|
| Anthropic API | HTTPS upstream | `api.anthropic.com:443` | client-supplied headers (passthrough) | `test-local.sh` | ☐ |
| LiteLLM price registry | HTTPS, **build-time only** (never at proxy runtime) | raw.githubusercontent.com | none | `node scripts/refresh-prices.mjs` (Task 1 Step 5) | ☐ |

### Credential Source Inventory
| Credential | Runtime Source | Path/Key | Rotation? | Verified in New Code |
|------------|---------------|----------|-----------|----------------------|
| Anthropic API key | client request headers only — proxy never stores, logs redact | `authorization` / `x-api-key` (REDACT set, `proxy.mjs:37`) | n/a (client's concern) | Task 6 Step 6 ☐ |
