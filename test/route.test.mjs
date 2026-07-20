import test from "node:test";
import assert from "node:assert/strict";
import { scoreComplexity, routeModel, DEFAULT_TIER_MAP } from "../lib/route.mjs";
import { loadPrices } from "../lib/cost.mjs";

const prices = loadPrices();
const req = (text, model = "claude-opus-4-6") =>
  ({ model, messages: [{ role: "user", content: text }] });

test("plain question scores SIMPLE and downgrades to haiku", () => {
  const d = routeModel(req("what is 2+2"), DEFAULT_TIER_MAP, prices);
  assert.ok(d.score < 0.15);
  assert.equal(d.tier, "SIMPLE");
  assert.equal(d.from, "claude-opus-4-6");
  assert.equal(d.target, "claude-haiku-4-5");
  assert.equal(d.apply_ok, true); // haiku input rate < opus input rate
});

test("code fence + debug request scores above SIMPLE", () => {
  const text = "debug this function:\n```js\nfunction f(x) { return x * 2; }\n```";
  const s = scoreComplexity(text);
  assert.ok(s.dims.code > 0);
  assert.ok(s.score >= 0.15);
  const d = routeModel(req(text), DEFAULT_TIER_MAP, prices);
  assert.notEqual(d.tier, "SIMPLE");
});

test("two-plus reasoning markers force REASONING regardless of score", () => {
  const text = "analyze the tradeoffs and design an approach";
  const s = scoreComplexity(text);
  assert.ok(s.reasoningMarkers >= 2);
  assert.ok(s.score < 0.60); // weighted score alone would NOT reach REASONING
  const d = routeModel(req(text), DEFAULT_TIER_MAP, prices);
  assert.equal(d.tier, "REASONING");
  assert.equal(d.target, "claude-opus-4-6"); // REASONING keeps the requested model
  assert.equal(d.apply_ok, false);
});

test("downgrade-only: haiku request never rewritten, even for SIMPLE", () => {
  const d = routeModel(req("what is 2+2", "claude-haiku-4-5"), DEFAULT_TIER_MAP, prices);
  assert.equal(d.tier, "SIMPLE");
  assert.equal(d.target, "claude-haiku-4-5"); // same rate — not strictly cheaper
  assert.equal(d.apply_ok, false);
});

test("missing price on either side → apply_ok false", () => {
  const d = routeModel(req("what is 2+2", "gpt-x-unpriced"), DEFAULT_TIER_MAP, prices);
  assert.equal(d.tier, "SIMPLE");
  assert.equal(d.apply_ok, false);
});

test("scores the LAST user message; tool_result blocks excluded", () => {
  const reqJson = { model: "claude-opus-4-6", messages: [
    { role: "user", content: "analyze the tradeoffs and design the architecture" },
    { role: "assistant", content: "ok" },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1",
        content: "analyze design architect why prove plan debug root cause" },
      { type: "text", text: "thanks, what is 2+2" },
    ] },
  ] };
  const d = routeModel(reqJson, DEFAULT_TIER_MAP, prices);
  assert.equal(d.tier, "SIMPLE");
});

test("routeModel is pure: no mutation, identical decision on repeat", () => {
  const reqJson = req("what is 2+2");
  const snapshot = JSON.stringify(reqJson);
  const d1 = routeModel(reqJson, DEFAULT_TIER_MAP, prices);
  const d2 = routeModel(reqJson, DEFAULT_TIER_MAP, prices);
  assert.equal(JSON.stringify(reqJson), snapshot);
  assert.deepEqual(d1, d2);
});
