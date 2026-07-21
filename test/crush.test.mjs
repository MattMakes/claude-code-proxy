import test from "node:test";
import assert from "node:assert/strict";
import { crushPass } from "../lib/crush.mjs";
import { createCcrStore } from "../lib/ccr.mjs";
import { optimize, commitForward } from "../lib/optimize.mjs";

const CCR_URL = "http://x/ccr";
const PAD = "x".repeat(9000); // pushes request over the 2000-token floor
const row = (i) => ({ id: i, status: "ok", payload: `row ${i} body ${"x".repeat(80)}` });
const rows = (n) => Array.from({ length: n }, (_, i) => row(i));
const toolResult = (id, text) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
const req = (messages) => ({ model: "claude-sonnet-5", system: PAD, messages });
const freshState = () => ({ spans: new Map(), pendingSpans: null, forwardedCount: 0, forwardedPrefixHash: null, lastUsage: null });
const saved = () => ({ dedup: 0, stale_read: 0, crush: 0, crush_text: 0, mature: 0 });
const run = (text) => {
  const msgs = [toolResult("t1", text)];
  const s = saved();
  const ccr = createCcrStore();
  crushPass(msgs, 0, s, { ccr, ccrUrl: CCR_URL });
  return { s, ccr, out: msgs[0].content[0].content };
};

test("20-item array, 2 errors: errors + anchors kept, marker + CCR roundtrip, savings counted", () => {
  const arr = rows(20);
  arr[9].status = "error: connection reset";
  arr[14].status = "error: request denied";
  const text = JSON.stringify(arr);
  const { s, ccr, out } = run(text);
  assert.ok(s.crush > 0);
  const parsed = JSON.parse(out);
  const marker = parsed.at(-1);
  assert.match(marker, /^\[crushed: kept 11 of 20 items — full data: curl -s http:\/\/x\/ccr\/[0-9a-f]{24}\]$/);
  const ids = parsed.slice(0, -1).map((x) => x.id);
  assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 9, 14, 17, 18, 19]); // errors + first/last anchors, order preserved
  const key = marker.match(/\/ccr\/([0-9a-f]{24})\]$/)[1];
  assert.equal(ccr.get(key), text); // full original retrievable
});

test("guards: <5 items, non-JSON, and sub-15%-savings results untouched", () => {
  const four = JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ id: i, payload: "y".repeat(300) })));
  assert.equal(run(four).out, four);
  const prose = "not json at all\n".repeat(80);
  assert.equal(run(prose).out, prose);
  // one giant kept anchor: dropping the tiny middle items saves <15%
  const lop = JSON.stringify([{ id: 0, payload: "z".repeat(1500) }, row(1), { id: 2 }, { id: 3 }, { id: 4 }]);
  const r = run(lop);
  assert.equal(r.out, lop);
  assert.equal(r.s.crush, 0);
});

test("numeric outliers beyond 2σ kept even mid-array", () => {
  const arr = Array.from({ length: 30 }, (_, i) => ({ id: i, n: 10 + (i % 3), payload: `row ${i} ${"x".repeat(60)}` }));
  arr[17].n = 9999;
  const { out } = run(JSON.stringify(arr));
  const ids = JSON.parse(out).slice(0, -1).map((x) => x.id);
  assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, 7, 17, 26, 27, 28, 29]); // caps 8/4 + the outlier
});

test("object shape: largest array replaced in place, other keys untouched", () => {
  const text = JSON.stringify({ query: "find things", total: 25, results: rows(25) });
  const { s, out } = run(text);
  const parsed = JSON.parse(out);
  assert.equal(parsed.query, "find things");
  assert.equal(parsed.total, 25);
  assert.match(parsed.results.at(-1), /^\[crushed: kept 12 of 25 items/);
  assert.ok(s.crush > 0);
});

test("delta-only; already-crushed, is_error, cache_control blocks untouched", () => {
  const text = JSON.stringify(rows(20));
  const msgs = [toolResult("t1", text), toolResult("t2", text)];
  const ccr = createCcrStore();
  crushPass(msgs, 1, saved(), { ccr, ccrUrl: CCR_URL });
  assert.equal(msgs[0].content[0].content, text);    // before deltaStart: untouched
  assert.notEqual(msgs[1].content[0].content, text); // delta: crushed
  const once = msgs[1].content[0].content;
  crushPass(msgs, 0, saved(), { ccr, ccrUrl: CCR_URL });
  assert.equal(msgs[1].content[0].content, once);    // marker text never re-crushed
  const err = toolResult("t3", text); err.content[0].is_error = true;
  const cc = toolResult("t4", text); cc.content[0].cache_control = { type: "ephemeral" };
  const s2 = saved();
  crushPass([err, cc], 0, s2, { ccr, ccrUrl: CCR_URL });
  assert.equal(err.content[0].content, text);
  assert.equal(cc.content[0].content, text);
  assert.equal(s2.crush, 0);
});

test("optimize wiring: crush applied in delta; skipped entirely without ccr", () => {
  const text = JSON.stringify(rows(20));
  const ccr = createCcrStore();
  const out = optimize(req([toolResult("t1", text)]), freshState(), { apply: true, ccr, ccrUrl: CCR_URL });
  assert.ok(out.applied && out.savedDetail.crush > 0);
  assert.match(out.body.messages[0].content[0].content, /\[crushed: /);
  const bare = optimize(req([toolResult("t1", text)]), freshState(), { apply: true });
  assert.equal(bare.savedDetail.crush, 0);
  assert.equal(bare.body.messages[0].content[0].content, text);
});

const bashUse = (id) => ({ role: "assistant",
  content: [{ type: "tool_use", id, name: "Bash", input: { command: "make build" } }] });
const readUse = (id) => ({ role: "assistant",
  content: [{ type: "tool_use", id, name: "Read", input: { file_path: "/a.txt" } }] });

test("repetitive Bash output crushed by adaptive line count; CCR roundtrip", () => {
  const text = Array.from({ length: 60 }, (_, i) =>
    `compiling module number ${i % 3} with the same repeated flags and output`).join("\n");
  const msgs = [bashUse("b1"), toolResult("b1", text)];
  const s = saved();
  const ccr = createCcrStore();
  crushPass(msgs, 0, s, { ccr, ccrUrl: CCR_URL });
  const out = msgs[1].content[0].content;
  assert.ok(s.crush_text > 0);
  const marker = out.split("\n").at(-1);
  assert.match(marker, /^\[crushed: kept \d+ of 60 lines — full output: curl -s http:\/\/x\/ccr\/[0-9a-f]{24}\]$/);
  assert.equal(ccr.get(marker.match(/\/ccr\/([0-9a-f]{24})\]$/)[1]), text);
});

test("error lines and the tail survive text crushing", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `same build noise repeated over and over ${i % 2}`);
  lines[30] = "error: linker exploded spectacularly";
  const msgs = [bashUse("b1"), toolResult("b1", lines.join("\n"))];
  crushPass(msgs, 0, saved(), { ccr: createCcrStore(), ccrUrl: CCR_URL });
  const kept = msgs[1].content[0].content.split("\n");
  assert.ok(kept.includes("error: linker exploded spectacularly"));
  assert.ok(kept.includes(lines[49])); // tail anchor
});

test("text crush skips: unique content, file-tool results, unattributed results", () => {
  const w = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const unique = Array.from({ length: 40 }, (_, i) =>
    `${w[i % 8]} ${w[(i * 3 + 1) % 8]} distinct entry ${i} value ${i * i} token ${i * 7}`).join("\n");
  const u = [bashUse("b1"), toolResult("b1", unique)];
  const su = saved();
  crushPass(u, 0, su, { ccr: createCcrStore(), ccrUrl: CCR_URL });
  assert.equal(u[1].content[0].content, unique); // dense content untouched
  assert.equal(su.crush_text, 0);

  const noise = Array.from({ length: 60 }, () => "identical repeated log line every time").join("\n");
  const r = [readUse("r1"), toolResult("r1", noise)];
  crushPass(r, 0, saved(), { ccr: createCcrStore(), ccrUrl: CCR_URL });
  assert.equal(r[1].content[0].content, noise); // Read belongs to maturation

  const orphan = [toolResult("x1", noise)];
  crushPass(orphan, 0, saved(), { ccr: createCcrStore(), ccrUrl: CCR_URL });
  assert.equal(orphan[0].content[0].content, noise); // can't attribute → skip
});

test("frozen-prefix candidate untouched on cache-hot path", () => {
  const text = JSON.stringify(rows(20));
  const state = freshState();
  const first = req([toolResult("t1", text)]);
  const out1 = optimize(first, state, { apply: true }); // turn 1 sans ccr → forwarded verbatim
  commitForward(state, out1.body, { input: 100, cache_read: 50000, cache_creation: 10, output: 5 });
  const second = req([toolResult("t1", text), { role: "user", content: "next" }]);
  const out2 = optimize(second, state, { apply: true, ccr: createCcrStore(), ccrUrl: CCR_URL });
  assert.equal(out2.savedDetail.crush, 0);
  assert.equal(out2.body.messages[0].content[0].content, text);
});
