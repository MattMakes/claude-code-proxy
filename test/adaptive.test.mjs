import test from "node:test";
import assert from "node:assert/strict";
import { computeOptimalK, findKnee, uniqueBigramCurve, countUniqueSimhash } from "../lib/adaptive.mjs";

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"];
const uniqueLines = (n) => Array.from({ length: n }, (_, i) =>
  `${WORDS[i % 16]} ${WORDS[(i * 3 + 1) % 16]} ${WORDS[(i * 7 + 2) % 16]} item ${i} value ${i * i}`);

test("trivial fast path: n <= 8 keeps everything", () => {
  assert.equal(computeOptimalK(["a b", "c d", "e f"]), 3);
  assert.equal(computeOptimalK(uniqueLines(8)), 8);
});

test("near-total redundancy collapses to minK", () => {
  const items = Array.from({ length: 40 }, () => "same repeated log line every single time");
  assert.equal(countUniqueSimhash(items), 1);
  assert.equal(computeOptimalK(items), 3);
});

test("all-unique content is never truncated", () => {
  const items = uniqueLines(20);
  const k = computeOptimalK(items);
  assert.equal(k, 20);
});

test("saturating curve finds an early knee", () => {
  // 5 information-rich lines, then 45 repeats: keep count lands near the knee.
  const items = [...uniqueLines(5), ...Array.from({ length: 45 }, () => "repeat repeat repeat repeat")];
  const k = computeOptimalK(items);
  assert.ok(k >= 3 && k <= 12, `expected small k, got ${k}`);
});

test("findKnee: concave curve knees early, flat and linear curves behave", () => {
  assert.equal(findKnee([100, 180, 220, 230, 234, 236, 237, 238, 239, 240]), 3);
  assert.equal(findKnee([5, 5, 5, 5]), 1); // flat - everything identical
  assert.equal(findKnee([1, 2, 3, 4, 5, 6]), null); // on the diagonal - no knee
  assert.equal(findKnee([1, 2]), null); // too short
});

test("bigram curve counts cumulative unique word pairs", () => {
  const curve = uniqueBigramCurve(["a b c", "a b", "x y"]);
  assert.deepEqual(curve, [2, 2, 3]);
});

test("deterministic: same items, same K", () => {
  const items = [...uniqueLines(10), ...Array.from({ length: 30 }, (_, i) => `dup line ${i % 2}`)];
  assert.equal(computeOptimalK(items), computeOptimalK(items));
});
