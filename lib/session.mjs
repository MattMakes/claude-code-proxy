/** Session identity: Claude Code embeds `_session_<uuid>` in metadata.user_id
 * (same convention LiteLLM's proxy parses). Fallbacks keep grouping stable
 * for other clients. State lives for the proxy's lifetime; the ledger is
 * the durable record. */
import crypto from "node:crypto";

const sessions = new Map();

export function extractSessionId(reqJson, bootId) {
  const uid = reqJson?.metadata?.user_id;
  const m = typeof uid === "string" ? uid.match(/_session_([0-9a-fA-F][0-9a-fA-F-]{7,})/) : null;
  if (m) return m[1];
  const firstUser = Array.isArray(reqJson?.messages)
    ? reqJson.messages.find((x) => x?.role === "user") : null;
  if (firstUser) {
    return crypto.createHash("sha256")
      .update(JSON.stringify(firstUser.content ?? "")).digest("hex").slice(0, 12);
  }
  return `boot-${bootId}`;
}

export function sessionState(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { spans: new Map(), pendingSpans: null, forwardedCount: 0, forwardedPrefixHash: null, lastUsage: null, routePin: null };
    sessions.set(id, s);
  }
  return s;
}
