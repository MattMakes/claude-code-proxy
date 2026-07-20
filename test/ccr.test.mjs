import test from "node:test";
import assert from "node:assert/strict";
import { createCcrStore } from "../lib/ccr.mjs";

test("put/get roundtrip; identical text → same key, no duplicate entry", () => {
  const ccr = createCcrStore();
  const key = ccr.put("the original tool output");
  assert.match(key, /^[0-9a-f]{24}$/);
  assert.equal(ccr.get(key), "the original tool output");
  assert.equal(ccr.put("the original tool output"), key);
  assert.equal(ccr.size(), 1);
});

test("TTL expiry: expired entry reads null and is deleted", () => {
  let clock = 1000;
  const ccr = createCcrStore({ ttlMs: 60_000, now: () => clock });
  const key = ccr.put("short-lived");
  clock += 59_999;
  assert.equal(ccr.get(key), "short-lived");
  clock += 2;
  assert.equal(ccr.get(key), null);
  assert.equal(ccr.size(), 0);
});

test("insertion-order eviction when over max", () => {
  const ccr = createCcrStore({ max: 2 });
  const k1 = ccr.put("first");
  const k2 = ccr.put("second");
  const k3 = ccr.put("third");
  assert.equal(ccr.size(), 2);
  assert.equal(ccr.get(k1), null); // oldest evicted
  assert.equal(ccr.get(k2), "second");
  assert.equal(ccr.get(k3), "third");
});

test("unknown key reads null", () => {
  const ccr = createCcrStore();
  assert.equal(ccr.get("0".repeat(24)), null);
});
