/** Deterministic, cache-safe optimizers. Iron rule: never rewrite content
 * inside the provider-frozen cache prefix — mutations touch the append-only
 * delta, fire when the cache is already missed (stale reads: prefix change or
 * TTL lapse), or replace bytes that were deliberately held out of the cache
 * (read maturation, see mature.mjs). */
import crypto from "node:crypto";
import { estTokens } from "./cost.mjs";
import { crushPass } from "./crush.mjs";
import { maturePass, relocateBreakpoint } from "./mature.mjs";

const MIN_REQ_TOKENS = 2000;
const DEDUP_MIN_CHARS = 40;
const DEDUP_MIN_LINES = 3;
export const STALE_MIN_BYTES = 512;
const CACHE_MISS_READ_FLOOR = 1024;
// Anthropic's default ephemeral prompt cache lives ~5 minutes. Past that, the
// frozen prefix has no cache entry left to protect - compaction becomes free.
export const CACHE_TTL_MS = 5 * 60_000;

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

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function staleReadPass(messages, deltaStart, cacheMissLikely, saved) {
  const useById = new Map();
  const accessesByPath = new Map(); // path → message indices, in order
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return;
    for (const b of m.content) {
      if (b?.type === "tool_use" && FILE_TOOLS.has(b.name) && b.input?.file_path) {
        useById.set(b.id, { tool: b.name, path: b.input.file_path, msg: i });
        (accessesByPath.get(b.input.file_path) ??
          accessesByPath.set(b.input.file_path, []).get(b.input.file_path)).push(i);
      }
    }
  });
  messages.forEach((m, i) => {
    if (m?.role !== "user" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.cache_control || b.is_error) continue;
      const use = useById.get(b.tool_use_id);
      if (!use || use.tool !== "Read") continue;
      // FIRST superseding access, not the last: later touches must not move
      // the stub text, or the already-forwarded bytes drift and bust the cache.
      const newer = (accessesByPath.get(use.path) ?? []).find((idx) => idx > use.msg);
      if (newer === undefined) continue;
      const text = resultText(b);
      if (Buffer.byteLength(text, "utf8") < STALE_MIN_BYTES || text.startsWith("[stale Read")) continue;
      if (i < deltaStart && !cacheMissLikely) continue;
      const stub = `[stale Read of ${use.path} — superseded by later read/edit in message ${newer + 1}]`;
      saved.stale_read += Math.max(0, estTokens(text) - estTokens(stub));
      setResultText(b, stub);
    }
  });
}

export function optimize(reqJson, state, { apply = true, ccr = null, ccrUrl = "", sid = "", now = Date.now } = {}) {
  const originalTokens = estTokens(JSON.stringify(reqJson));
  const out = { body: reqJson, originalTokens, optimizedTokens: originalTokens,
    savedDetail: { dedup: 0, stale_read: 0, crush: 0, crush_text: 0, mature: 0 },
    applied: false, cache: null };
  if (!Array.isArray(reqJson?.messages) || originalTokens < MIN_REQ_TOKENS) return out;

  const draft = structuredClone(reqJson);
  const prefixIntact = state.forwardedCount > 0 &&
    state.forwardedCount <= draft.messages.length &&
    prefixHash(draft.messages, state.forwardedCount) === state.forwardedPrefixHash;
  const deltaStart = prefixIntact ? state.forwardedCount : 0;
  const idleMs = state.lastForwardTs ? Math.max(0, now() - state.lastForwardTs) : 0;
  const ttlLapsed = !!state.lastForwardTs && idleMs > CACHE_TTL_MS;
  const cacheMissLikely = !prefixIntact || ttlLapsed || !state.lastUsage ||
    (state.lastUsage.cache_read ?? 0) < CACHE_MISS_READ_FLOOR;

  dedupPass(draft.messages, state, deltaStart, out.savedDetail);
  staleReadPass(draft.messages, deltaStart, cacheMissLikely, out.savedDetail);
  let holding = [];
  if (ccr) {
    holding = maturePass(draft.messages, state, out.savedDetail, { ccr, ccrUrl, sid });
    crushPass(draft.messages, deltaStart, out.savedDetail, { ccr, ccrUrl, sid });
  }
  // Holding Reads must stay out of the provider cache: park the trailing
  // breakpoint before them. Only meaningful when the draft reaches the wire.
  const relocated = apply && holding.length > 0 && relocateBreakpoint(draft.messages, holding);

  const optimizedTokens = estTokens(JSON.stringify(draft));
  if (optimizedTokens < originalTokens || relocated) {
    out.optimizedTokens = Math.min(optimizedTokens, originalTokens);
    if (apply) { out.body = draft; out.applied = true; }
  }

  // Cache attribution inputs for the ledger, judged on what actually goes to
  // the wire: forwardedStable means the bytes the provider hashed last turn
  // still lead this turn's forwarded list.
  const wireMsgs = out.applied ? draft.messages : reqJson.messages;
  const forwardedStable = state.forwardedCount > 0 &&
    state.forwardedCount <= wireMsgs.length &&
    prefixHash(wireMsgs, state.forwardedCount) === state.forwardedPrefixHash;
  out.cache = { idleMs, ttlLapsed, forwardedStable,
    expectedCached: (state.lastUsage?.cache_read ?? 0) + (state.lastUsage?.cache_creation ?? 0),
    holding: holding.length };
  return out;
}

/** Call ONLY after a successful upstream response: locks in what was actually
 * forwarded so the next request's frozen-prefix boundary is exact. */
export function commitForward(state, forwardedJson, usage, now = Date.now) {
  const msgs = Array.isArray(forwardedJson?.messages) ? forwardedJson.messages : [];
  state.forwardedCount = msgs.length;
  state.forwardedPrefixHash = prefixHash(msgs, msgs.length);
  if (state.pendingSpans) { state.spans = state.pendingSpans; state.pendingSpans = null; }
  if (usage) state.lastUsage = usage;
  state.lastForwardTs = now();
}
