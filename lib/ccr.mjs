/** In-memory CCR (Compress-Cache-Retrieve) store: crushed originals keyed by
 * sha256 prefix, retrievable over HTTP so any agent with shell access can curl
 * the full data back. Zero-dep adaptation of headroom's SQLite-backed store. */
import crypto from "node:crypto";

export function createCcrStore({ ttlMs = 30 * 60_000, max = 1000, now = Date.now } = {}) {
  const entries = new Map(); // key → { text, expires } — Map order drives eviction

  function put(text) {
    const key = crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
    if (!entries.has(key)) {
      entries.set(key, { text, expires: now() + ttlMs });
      if (entries.size > max) entries.delete(entries.keys().next().value);
    }
    return key;
  }

  function get(key) {
    const e = entries.get(key);
    if (!e) return null;
    if (now() > e.expires) { entries.delete(key); return null; }
    return e.text;
  }

  return { put, get, size: () => entries.size };
}
