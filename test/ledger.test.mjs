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
