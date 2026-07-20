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

test("session state starts with routePin null and holds a pin once set", () => {
  const s = sessionState("route-pin");
  assert.equal(s.routePin, null);
  s.routePin = "claude-haiku-4-5";
  assert.equal(sessionState("route-pin").routePin, "claude-haiku-4-5");
});
