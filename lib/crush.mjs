/** Statistical tool-result crushing. JSON arrays: deterministic subset of
 * headroom's SmartCrusher (no embeddings): error keywords, fixed first/last
 * anchors, 2σ numeric outliers. Line-based text (Bash/Grep/etc. output):
 * Kneedle adaptive keep-count from adaptive.mjs - redundant logs crush hard,
 * dense unique content is left alone. The full original goes into the CCR
 * store first, so the marker's curl command always recovers it. Delta-only by
 * construction - callers pass the same deltaStart the other passes use. */
import { estTokens } from "./cost.mjs";
import { computeOptimalK } from "./adaptive.mjs";

const MIN_RESULT_TOKENS = 200;
const MIN_ITEMS = 5;
const MIN_SAVINGS_RATIO = 0.15;
const FIRST_FRACTION = 0.3, FIRST_CAP = 8;
const LAST_FRACTION = 0.15, LAST_CAP = 4;
const NUMERIC_KEY_COVERAGE = 0.8;
const SIGMA = 2;
const NON_ERROR_KEEP_CAP = 15;
const ERROR_RE = /error|fail|exception|fatal|denied|timeout|refused|warning/i;
const TEXT_MIN_LINES = 30;
const TEXT_MIN_KEEP = 10;
const TEXT_TAIL_KEEP = 3;
// File-content results belong to read maturation, never line crushing.
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Mirror optimize.mjs's tool_result accessors (kept local to avoid a cycle).
function resultText(block) {
  const c = block?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === "text").map((x) => x.text ?? "").join("\n");
  return "";
}
function setResultText(block, text) {
  if (typeof block.content === "string") block.content = text;
  else block.content = [{ type: "text", text }];
}

/** Items outside mean ± 2σ for any numeric key present in ≥ 80% of items. */
function numericOutliers(arr) {
  const out = new Set();
  const counts = new Map();
  for (const item of arr) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const [k, v] of Object.entries(item)) {
      if (typeof v === "number" && Number.isFinite(v)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  for (const [k, count] of counts) {
    if (count < arr.length * NUMERIC_KEY_COVERAGE) continue;
    const val = (it) => (it && typeof it === "object" && typeof it[k] === "number" ? it[k] : null);
    const vals = arr.map(val).filter((v) => v !== null);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
    arr.forEach((it, i) => { if (val(it) !== null && Math.abs(val(it) - mean) > SIGMA * sd) out.add(i); });
  }
  return out;
}

/** Keep policy (headroom's anchors): ALL error items; first ceil(30%) cap 8;
 * last ceil(15%) cap 4; numeric outliers; non-error keeps capped at 15. */
function pickKeep(arr) {
  const n = arr.length;
  const errors = new Set();
  arr.forEach((item, i) => { if (ERROR_RE.test(JSON.stringify(item))) errors.add(i); });
  const anchors = new Set();
  for (let i = 0; i < Math.min(FIRST_CAP, Math.ceil(FIRST_FRACTION * n)); i++) anchors.add(i);
  for (let i = n - Math.min(LAST_CAP, Math.ceil(LAST_FRACTION * n)); i < n; i++) anchors.add(i);
  for (const i of numericOutliers(arr)) anchors.add(i);
  const keep = new Set(errors);
  let nonError = 0;
  for (const i of [...anchors].sort((a, b) => a - b)) {
    if (errors.has(i) || nonError >= NON_ERROR_KEEP_CAP) continue;
    keep.add(i); nonError += 1;
  }
  return keep;
}

/** Crush one result text, or return null when it doesn't qualify. Replacement
 * keeps the top-level JSON shape: kept items + trailing retrieval marker. */
function crushJson(text, ccr, ccrUrl, sid) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  // The candidate array: the value itself, or the largest array in a top-level
  // object (all other keys ride along unchanged).
  let arr = null, objKey = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === "object") {
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v) && v.length > (arr?.length ?? 0)) { arr = v; objKey = k; }
    }
  }
  if (!arr || arr.length < MIN_ITEMS) return null;
  const keep = pickKeep(arr);
  if (keep.size >= arr.length) return null;
  const key = ccr.put(text, sid);
  const marker = `[crushed: kept ${keep.size} of ${arr.length} items — full data: curl -s ${ccrUrl}/${key}]`;
  const kept = [...arr.filter((_, i) => keep.has(i)), marker];
  const replacement = objKey === null ? JSON.stringify(kept) : JSON.stringify({ ...parsed, [objKey]: kept });
  if (estTokens(text) - estTokens(replacement) < MIN_SAVINGS_RATIO * estTokens(text)) return null;
  return replacement;
}

/** Crush repetitive line-based text via the Kneedle keep-count: first-K lines
 * in original order, plus every error-keyword line, plus a small tail anchor
 * (errors cluster at the end of build output). All-unique content comes back
 * with K ≈ n and is left alone. Returns null when it doesn't qualify. */
function crushText(text, ccr, ccrUrl, sid) {
  const lines = text.split("\n");
  if (lines.length < TEXT_MIN_LINES) return null;
  const k = computeOptimalK(lines, { minK: TEXT_MIN_KEEP });
  if (k >= lines.length) return null;
  const keep = new Set();
  for (let i = 0; i < k; i++) keep.add(i);
  lines.forEach((l, i) => { if (ERROR_RE.test(l)) keep.add(i); });
  for (let i = Math.max(0, lines.length - TEXT_TAIL_KEEP); i < lines.length; i++) keep.add(i);
  if (keep.size >= lines.length) return null;
  const key = ccr.put(text, sid);
  const marker = `[crushed: kept ${keep.size} of ${lines.length} lines — full output: curl -s ${ccrUrl}/${key}]`;
  const replacement = [...lines.filter((_, i) => keep.has(i)), marker].join("\n");
  if (estTokens(text) - estTokens(replacement) < MIN_SAVINGS_RATIO * estTokens(text)) return null;
  return replacement;
}

/** tool_use_id → tool name, so text crushing can exclude file-content tools
 * and skip results it cannot attribute. */
function toolNamesById(messages) {
  const names = new Map();
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === "tool_use" && b.id) names.set(b.id, b.name);
    }
  }
  return names;
}

export function crushPass(messages, deltaStart, saved, { ccr, ccrUrl, sid = "" }) {
  const names = toolNamesById(messages);
  messages.forEach((m, i) => {
    if (i < deltaStart || m?.role !== "user" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.cache_control || b.is_error) continue;
      const text = resultText(b);
      if (estTokens(text) <= MIN_RESULT_TOKENS) continue;
      // Never restub stubs, never re-crush a marker-carrying result.
      if (text.includes("[crushed:") || text.startsWith("[duplicate of") ||
          text.startsWith("[stale Read") || text.startsWith("[Read of ")) continue;
      const crushed = crushJson(text, ccr, ccrUrl, sid);
      if (crushed !== null) {
        saved.crush += Math.max(0, estTokens(text) - estTokens(crushed));
        setResultText(b, crushed);
        continue;
      }
      // Text path: only for results attributable to a non-file tool.
      const tool = names.get(b.tool_use_id);
      if (!tool || FILE_TOOLS.has(tool)) continue;
      const crushedText = crushText(text, ccr, ccrUrl, sid);
      if (crushedText === null) continue;
      saved.crush_text += Math.max(0, estTokens(text) - estTokens(crushedText));
      setResultText(b, crushedText);
    }
  });
}
