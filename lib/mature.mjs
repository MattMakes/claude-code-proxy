/** Read maturation - port of headroom's hold-back-then-compress state machine.
 *
 * Mutating an already-cached Read busts the prefix cache, but bytes that never
 * entered the cache have no entry to bust. So a fresh large Read is held OUT of
 * the provider cache (relocateBreakpoint parks the trailing cache_control just
 * before it) while its file is active; the model sees verbatim content the
 * whole time. Once the file has been quiet for QUIESCE_TURNS assistant turns
 * (or MAX_HOLD_TURNS caps the hold cost), the content matures into a small
 * CCR-backed marker - and only that final form is ever cache-written.
 *
 * Determinism: the marker is a pure function of (path, content, session), and
 * once matured the marker is replayed from state.matured on every later
 * request, so the forwarded prefix stays byte-stable. On state loss the
 * decision re-derives from the conversation itself; the one degraded case is
 * attaching the proxy mid-session, which can cost a single bust before the
 * marker form stabilizes. Recovery contract: the file is still on disk (the
 * model re-reads it) and the full original is one curl away. */
import { estTokens } from "./cost.mjs";

const QUIESCE_TURNS = 5;
const MAX_HOLD_TURNS = 20;
const MIN_SIZE_BYTES = 2048;
const READ_TOOLS = new Set(["Read"]);
const TOUCH_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

/** One pass over assistant messages: Read calls, per-file touch history, and
 * the assistant-turn count ("now"). All in assistant-turn units. */
function scanActivity(messages) {
  const readCalls = new Map(); // tool_use_id → { path, turn }
  const lastTouch = new Map(); // file_path → most recent touch turn
  let turns = 0;
  for (const m of messages) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) {
      if (m?.role === "assistant") turns += 1;
      continue;
    }
    turns += 1;
    for (const b of m.content) {
      if (b?.type !== "tool_use" || !TOUCH_TOOLS.has(b.name)) continue;
      const path = b.input?.file_path ?? b.input?.path ?? "";
      if (path) lastTouch.set(path, turns);
      if (READ_TOOLS.has(b.name) && path) readCalls.set(b.id, { path, turn: turns });
    }
  }
  return { readCalls, lastTouch, turns };
}

/** Hold active Reads, mature quiet ones, replay matured markers. Mutates
 * messages in place (callers pass a draft clone). Returns the indices of
 * messages that contain still-holding Reads - these must stay out of the
 * provider cache this request (feed to relocateBreakpoint). */
export function maturePass(messages, state, saved, { ccr, ccrUrl, sid = "" }) {
  state.matured ??= new Map(); // tool_use_id → marker
  const act = scanActivity(messages);
  const holding = [];
  messages.forEach((m, i) => {
    if (m?.role !== "user" || !Array.isArray(m.content)) return;
    let msgHolding = false;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || b.is_error) continue;
      const use = act.readCalls.get(b.tool_use_id);
      if (!use) continue;
      const text = resultText(b);

      // Matured earlier: replay the recorded marker deterministically. This
      // overrides any stub another pass applied this turn - the marker is
      // what the provider cached.
      const marker = state.matured.get(b.tool_use_id);
      if (marker !== undefined) {
        if (text !== marker) {
          saved.mature += Math.max(0, estTokens(text) - estTokens(marker));
          setResultText(b, marker);
        }
        continue;
      }

      // Stubs from earlier passes are already compact - respect them.
      if (text.startsWith("[stale Read") || text.startsWith("[duplicate of") ||
          text.includes("[crushed:") || text.startsWith("[Read of ")) continue;
      if (Buffer.byteLength(text, "utf8") < MIN_SIZE_BYTES) continue;

      const lastTouch = act.lastTouch.get(use.path) ?? use.turn;
      const quiet = act.turns - lastTouch;
      const held = act.turns - use.turn;
      if (quiet < QUIESCE_TURNS && held < MAX_HOLD_TURNS) {
        msgHolding = true; // file still active - keep verbatim, uncached
        continue;
      }

      const key = ccr.put(text, sid);
      const stub = `[Read of ${use.path} compressed after quiesce — re-read the file if needed. Full original: curl -s ${ccrUrl}/${key}]`;
      state.matured.set(b.tool_use_id, stub);
      saved.mature += Math.max(0, estTokens(text) - estTokens(stub));
      setResultText(b, stub);
    }
    if (msgHolding) holding.push(i);
  });
  return holding;
}

/** Park the trailing message-level cache breakpoint before held Reads: strip
 * cache_control from every block at or after the earliest holding message and
 * re-anchor one ephemeral breakpoint on the last block of the latest
 * block-style message before it. System/tools breakpoints are untouched.
 * Total breakpoints never increase. Mutates in place; returns true when a
 * breakpoint was actually moved (the caller must then forward the draft). */
export function relocateBreakpoint(messages, holdingIndices) {
  if (!holdingIndices.length) return false;
  const earliest = Math.min(...holdingIndices);
  let stripped = false;
  for (let i = earliest; i < messages.length; i++) {
    const c = messages[i]?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b && typeof b === "object" && b.cache_control) { delete b.cache_control; stripped = true; }
    }
  }
  // No client breakpoint in the held region - nothing was going to cache the
  // held Reads this request; leave placement alone.
  if (!stripped) return false;
  for (let i = earliest - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (Array.isArray(c) && c.length && c[c.length - 1] && typeof c[c.length - 1] === "object") {
      c[c.length - 1].cache_control = { type: "ephemeral" };
      break;
    }
  }
  return true;
}
