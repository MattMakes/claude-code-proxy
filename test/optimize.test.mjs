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
