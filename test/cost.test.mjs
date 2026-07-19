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
