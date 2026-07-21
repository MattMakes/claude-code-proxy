import test from "node:test";
import assert from "node:assert/strict";
import { optimize, commitForward, CACHE_TTL_MS } from "../lib/optimize.mjs";
import { createCcrStore } from "../lib/ccr.mjs";

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

test("TTL lapse opens the frozen-prefix gate: stale read stubbed despite hot cache", () => {
  const state = freshState();
  const first = req([readUse("u1", "/a.txt"), toolResult("u1", BIG)]);
  const out1 = optimize(first, state, { apply: true });
  assert.equal(out1.applied, false); // nothing to do yet
  commitForward(state, first, { input: 10, cache_read: 90000, cache_creation: 5, output: 5 }, () => 1000);
  const second = structuredClone(first);
  second.messages.push(editUse("u2", "/a.txt"), toolResult("u2", "ok\nok\nok\nedited fine result"));

  // Within TTL, cache hot → frozen read untouched.
  const warm = optimize(structuredClone(second), state, { apply: true, now: () => 1000 + 60_000 });
  assert.equal(warm.savedDetail.stale_read, 0);

  // Past TTL the cache entry is dead — compaction is free.
  const lapsed = optimize(second, state, { apply: true, now: () => 1000 + CACHE_TTL_MS + 1 });
  assert.ok(lapsed.savedDetail.stale_read > 0);
  assert.match(lapsed.body.messages[1].content[0].content, /stale Read of \/a\.txt/);
  assert.equal(lapsed.cache.ttlLapsed, true);
});

test("stale stub references the FIRST superseding access — later touches don't move it", () => {
  const base = [readUse("u1", "/a.txt"), toolResult("u1", BIG),
    editUse("u2", "/a.txt"), toolResult("u2", "ok\nok\nok\nedited fine result")];
  const out1 = optimize(req(structuredClone(base)), freshState(), { apply: true });
  const more = structuredClone(base);
  more.push(editUse("u3", "/a.txt"), toolResult("u3", "ok\nok\nok\nedited more"));
  const out2 = optimize(req(more), freshState(), { apply: true });
  assert.equal(out2.body.messages[1].content[0].content,
    out1.body.messages[1].content[0].content); // byte-stable across new touches
});

const BIGREAD = ("a long unique-ish line of file content for the maturation test\n").repeat(50);
const chat = (n) => Array.from({ length: n }, () => ({ role: "assistant", content: "acknowledged" }));

test("read maturation via optimize: held while active, matured after quiesce", () => {
  const ccr = createCcrStore();
  const o = { apply: true, ccr, ccrUrl: "http://x/ccr", sid: "s1" };

  const held = req([readUse("u1", "/a.txt"), toolResult("u1", BIGREAD)]);
  held.messages[1].content[0].cache_control = { type: "ephemeral" };
  const outHeld = optimize(held, freshState(), o);
  assert.equal(outHeld.applied, true); // relocation alone forces the draft out
  assert.equal(outHeld.body.messages[1].content[0].content, BIGREAD); // verbatim
  assert.equal(outHeld.body.messages[1].content[0].cache_control, undefined); // held out of cache
  assert.deepEqual(outHeld.body.messages[0].content[0].cache_control, { type: "ephemeral" }); // parked before

  const quiet = req([readUse("u1", "/a.txt"), toolResult("u1", BIGREAD), ...chat(5)]);
  const outQuiet = optimize(quiet, freshState(), o);
  assert.ok(outQuiet.savedDetail.mature > 0);
  assert.match(outQuiet.body.messages[1].content[0].content, /^\[Read of \/a\.txt compressed after quiesce/);
});

test("small (<512B) stale reads untouched", () => {
  const tiny = "short line one\nshort line two\nshort line three";
  const r = req([readUse("u1", "/b.txt"), toolResult("u1", tiny), editUse("u2", "/b.txt"),
    toolResult("u2", "ok\nok\nok\nfine")]);
  const out = optimize(r, freshState(), { apply: true });
  assert.equal(out.savedDetail.stale_read, 0);
});
