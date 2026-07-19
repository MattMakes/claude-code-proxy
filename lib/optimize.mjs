/** Deterministic, cache-safe optimizers. Iron rule: never rewrite content
 * inside the provider-frozen cache prefix — mutations touch the append-only
 * delta, or (stale reads only, Task 5) fire when the cache is already missed. */
import crypto from "node:crypto";
import { estTokens } from "./cost.mjs";

const MIN_REQ_TOKENS = 2000;
const DEDUP_MIN_CHARS = 40;
const DEDUP_MIN_LINES = 3;
export const STALE_MIN_BYTES = 512;
const CACHE_MISS_READ_FLOOR = 1024;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 24);
const normalize = (s) => s.split("\n").map((l) => l.trim()).join("\n").trim();
const prefixHash = (messages, count) => sha(JSON.stringify(messages.slice(0, count)));

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

function dedupPass(messages, state, deltaStart, saved) {
  // Cross-turn spans only when the forwarded prefix is intact: after client-side
  // compaction the first occurrence may be gone, and a stub must never point at
  // content that no longer exists in context.
  const seen = deltaStart > 0 ? new Map(state.spans) : new Map();
  messages.forEach((m, i) => {
    if (m?.role !== "user" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.cache_control) continue;
      const text = resultText(b);
      if (text.length < DEDUP_MIN_CHARS || text.split("\n").length < DEDUP_MIN_LINES) continue;
      const h = sha(normalize(text));
      const firstAt = seen.get(h);
      if (firstAt !== undefined && i >= deltaStart && firstAt < i) {
        const stub = `[duplicate of tool result in message ${firstAt + 1} — content unchanged]`;
        saved.dedup += Math.max(0, estTokens(text) - estTokens(stub));
        setResultText(b, stub);
      } else if (firstAt === undefined) {
        seen.set(h, i);
      }
    }
  });
  state.pendingSpans = seen;
}

// Replaced with the real pass in Task 5.
function staleReadPass() {}

export function optimize(reqJson, state, { apply = true } = {}) {
  const originalTokens = estTokens(JSON.stringify(reqJson));
  const out = { body: reqJson, originalTokens, optimizedTokens: originalTokens,
    savedDetail: { dedup: 0, stale_read: 0 }, applied: false };
  if (!Array.isArray(reqJson?.messages) || originalTokens < MIN_REQ_TOKENS) return out;

  const draft = structuredClone(reqJson);
  const prefixIntact = state.forwardedCount > 0 &&
    state.forwardedCount <= draft.messages.length &&
    prefixHash(draft.messages, state.forwardedCount) === state.forwardedPrefixHash;
  const deltaStart = prefixIntact ? state.forwardedCount : 0;
  const cacheMissLikely = !prefixIntact || !state.lastUsage ||
    (state.lastUsage.cache_read ?? 0) < CACHE_MISS_READ_FLOOR;

  dedupPass(draft.messages, state, deltaStart, out.savedDetail);
  staleReadPass(draft.messages, deltaStart, cacheMissLikely, out.savedDetail);

  const optimizedTokens = estTokens(JSON.stringify(draft));
  if (optimizedTokens < originalTokens) {
    out.optimizedTokens = optimizedTokens;
    if (apply) { out.body = draft; out.applied = true; }
  }
  return out;
}

/** Call ONLY after a successful upstream response: locks in what was actually
 * forwarded so the next request's frozen-prefix boundary is exact. */
export function commitForward(state, forwardedJson, usage) {
  const msgs = Array.isArray(forwardedJson?.messages) ? forwardedJson.messages : [];
  state.forwardedCount = msgs.length;
  state.forwardedPrefixHash = prefixHash(msgs, msgs.length);
  if (state.pendingSpans) { state.spans = state.pendingSpans; state.pendingSpans = null; }
  if (usage) state.lastUsage = usage;
}
