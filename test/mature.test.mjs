import test from "node:test";
import assert from "node:assert/strict";
import { maturePass, relocateBreakpoint } from "../lib/mature.mjs";
import { createCcrStore } from "../lib/ccr.mjs";

const CCR_URL = "http://x/ccr";
const BIG = ("a fairly long line of file content for maturation tests\n").repeat(50); // ~2.8KB
const readUse = (id, file) => ({ role: "assistant",
  content: [{ type: "tool_use", id, name: "Read", input: { file_path: file } }] });
const editUse = (id, file) => ({ role: "assistant",
  content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] });
const toolResult = (id, text) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] });
const chat = (n) => Array.from({ length: n }, () => ({ role: "assistant", content: "ok" }));
const freshState = () => ({ matured: new Map() });
const saved = () => ({ dedup: 0, stale_read: 0, crush: 0, crush_text: 0, mature: 0 });
const opts = (ccr) => ({ ccr, ccrUrl: CCR_URL, sid: "s1" });

test("fresh Read is held: verbatim content, holding index reported", () => {
  const msgs = [readUse("u1", "/a.txt"), toolResult("u1", BIG)];
  const s = saved();
  const holding = maturePass(msgs, freshState(), s, opts(createCcrStore()));
  assert.deepEqual(holding, [1]);
  assert.equal(msgs[1].content[0].content, BIG);
  assert.equal(s.mature, 0);
});

test("quiet file matures into a CCR-backed marker after 5 quiet turns", () => {
  const msgs = [readUse("u1", "/a.txt"), toolResult("u1", BIG), ...chat(5)];
  const ccr = createCcrStore();
  const s = saved();
  const state = freshState();
  const holding = maturePass(msgs, state, s, opts(ccr));
  assert.deepEqual(holding, []);
  const marker = msgs[1].content[0].content;
  assert.match(marker, /^\[Read of \/a\.txt compressed after quiesce — re-read the file if needed\. Full original: curl -s http:\/\/x\/ccr\/[0-9a-f]{24}\]$/);
  assert.equal(ccr.get(marker.match(/\/ccr\/([0-9a-f]{24})\]$/)[1]), BIG);
  assert.ok(s.mature > 0);
  assert.equal(state.matured.get("u1"), marker);
});

test("a touch resets the quiet clock", () => {
  const msgs = [readUse("u1", "/a.txt"), toolResult("u1", BIG), ...chat(4),
    editUse("u2", "/a.txt"), toolResult("u2", "done"), ...chat(3)];
  const holding = maturePass(msgs, freshState(), saved(), opts(createCcrStore()));
  assert.deepEqual(holding, [1]); // quiet only 3 turns since the edit
});

test("max hold cap matures an ever-busy file anyway", () => {
  const msgs = [readUse("u1", "/a.txt"), toolResult("u1", BIG)];
  for (let i = 0; i < 20; i++) msgs.push(editUse(`e${i}`, "/a.txt"), toolResult(`e${i}`, "ok"));
  const holding = maturePass(msgs, freshState(), saved(), opts(createCcrStore()));
  assert.deepEqual(holding, []);
  assert.match(msgs[1].content[0].content, /compressed after quiesce/);
});

test("matured marker replays deterministically over the resent original", () => {
  const build = () => [readUse("u1", "/a.txt"), toolResult("u1", BIG), ...chat(5)];
  const ccr = createCcrStore();
  const state = freshState();
  const first = build();
  maturePass(first, state, saved(), opts(ccr));
  const marker = first[1].content[0].content;
  const second = build(); // client resends the original text
  const s2 = saved();
  maturePass(second, state, s2, opts(ccr));
  assert.equal(second[1].content[0].content, marker); // byte-identical replay
  assert.ok(s2.mature > 0);
  assert.equal(ccr.size(), 1); // same content+scope → same key, no duplicate
});

test("small reads, stubs from other passes, and error results are ignored", () => {
  const small = [readUse("u1", "/a.txt"), toolResult("u1", "tiny"), ...chat(9)];
  assert.deepEqual(maturePass(small, freshState(), saved(), opts(createCcrStore())), []);
  assert.equal(small[1].content[0].content, "tiny");
  const stubbed = [readUse("u1", "/a.txt"),
    toolResult("u1", "[stale Read of /a.txt" + " x".repeat(1200) + "]"), ...chat(9)];
  maturePass(stubbed, freshState(), saved(), opts(createCcrStore()));
  assert.match(stubbed[1].content[0].content, /^\[stale Read/);
  const err = [readUse("u1", "/a.txt"), toolResult("u1", BIG), ...chat(9)];
  err[1].content[0].is_error = true;
  maturePass(err, freshState(), saved(), opts(createCcrStore()));
  assert.equal(err[1].content[0].content, BIG);
});

test("relocateBreakpoint: strips held-region breakpoints, re-anchors before them", () => {
  const msgs = [readUse("u0", "/z.txt"), toolResult("u0", "old"),
    readUse("u1", "/a.txt"), toolResult("u1", BIG)];
  msgs[3].content[0].cache_control = { type: "ephemeral" };
  assert.equal(relocateBreakpoint(msgs, [3]), true);
  assert.equal(msgs[3].content[0].cache_control, undefined);
  assert.deepEqual(msgs[2].content[0].cache_control, { type: "ephemeral" });
});

test("relocateBreakpoint: no-op without holds or without breakpoints in the held region", () => {
  const msgs = [readUse("u1", "/a.txt"), toolResult("u1", BIG)];
  assert.equal(relocateBreakpoint(msgs, []), false);
  assert.equal(relocateBreakpoint(msgs, [1]), false); // nothing to strip
  assert.equal(msgs[0].content[0].cache_control, undefined); // and nothing anchored
});
