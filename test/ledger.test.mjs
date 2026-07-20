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

test("breakdown: tools aggregate requests + tokens_total across entries", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  const breakdown = { system: 2000, tools: 5000, messages: 3000,
    tool_defs: [{ name: "Bash", tokens: 400 }, { name: "Read", tokens: 250 }] };
  led.add(entry({ breakdown }));
  led.add(entry({ breakdown }));
  const s = led.stats();
  const bash = s.tools.find((t) => t.name === "Bash");
  assert.equal(bash.requests, 2);
  assert.equal(bash.tokens_per_request, 400);
  assert.equal(bash.tokens_total, 800);
  assert.ok(bash.usd_total > 0); // priced at the most-used model's input rate
  assert.equal(s.tools[0].name, "Bash"); // sorted by tokens_total desc
});

test("top_requests sorted desc by cost_with", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry({ ts: "2026-07-19T10:00:01.000Z", usage: { input: 100, cache_read: 0, cache_creation: 0, output: 0 } }));
  led.add(entry({ ts: "2026-07-19T10:00:02.000Z", usage: { input: 9000, cache_read: 0, cache_creation: 0, output: 0 } }));
  led.add(entry({ ts: "2026-07-19T10:00:03.000Z", usage: { input: 3000, cache_read: 0, cache_creation: 0, output: 0 } }));
  const top = led.stats().top_requests;
  assert.equal(top.length, 3);
  assert.deepEqual(top.map((r) => r.in_tokens), [9000, 3000, 100]);
  assert.ok(top[0].cost_with >= top[1].cost_with && top[1].cost_with >= top[2].cost_with);
});

test("by_model hit_rate computed from accumulated token sums", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry({ usage: { input: 1000, cache_read: 3000, cache_creation: 0, output: 100 } }));
  led.add(entry({ usage: { input: 1000, cache_read: 1000, cache_creation: 0, output: 100 } }));
  const bm = led.stats().by_model.find((m) => m.model === "claude-sonnet-5");
  assert.equal(bm.requests, 2);
  assert.ok(Math.abs(bm.hit_rate - 4000 / 6000) < 1e-12); // cache_read / (input+read+creation)
});

test("entry without breakdown still aggregates; tools stay empty", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry());
  const s = led.stats();
  assert.deepEqual(s.tools, []);
  assert.equal(s.waste.system_tokens_avg, 0);
  assert.equal(s.lifetime.requests, 1);
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

test("all-sessions rollup: session-shaped cumulative view", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry());
  led.add(entry({ session: "s2" }));
  const a = led.stats().all;
  assert.equal(a.id, "all");
  assert.equal(a.requests, 2);
  assert.equal(a.recent.length, 2);
  assert.equal(a.tokens.cache_read, 16000);
  assert.equal(a.saved_tokens, 2000);
  assert.ok(Math.abs(a.cost_without - (a.cost_with + 2000 * 3e-6)) < 1e-12);
});

test("saved_detail.crush sums; old lines without crush replay fine", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  led.add(entry()); // pre-crush ledger line: no crush key
  led.add(entry({ saved_detail: { dedup: 100, stale_read: 0, crush: 250 } }));
  const s = led.stats();
  const sess = s.sessions.find((x) => x.id === "s1");
  assert.equal(sess.saved_detail.crush, 250);
  assert.equal(sess.saved_detail.dedup, 700);
  assert.equal(s.all.saved_detail.crush, 250);
});

test("recent entries carry session-scoped bust flags across interleaved sessions", () => {
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "led-")), prices });
  const cold = { input: 200, cache_read: 0, cache_creation: 9000, output: 100 };
  led.add(entry());                                  // s1, cache-hot
  led.add(entry({ session: "s2", usage: cold }));    // s2 FIRST request: cold, but not a bust
  led.add(entry({ usage: cold }));                   // s1 again: genuine bust
  const a = led.stats().all;
  assert.deepEqual(a.recent.map((r) => !!r.bust), [false, false, true]);
  assert.equal(a.busts, 1);
});
