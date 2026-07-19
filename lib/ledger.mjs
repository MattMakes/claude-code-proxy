/** JSONL ledger + in-memory aggregates. One add() path serves both live
 * traffic and boot replay so numbers can never diverge. */
import fs from "node:fs";
import path from "node:path";
import { resolvePrice, requestCost, savingsUSD, hitRate } from "./cost.mjs";

const HOUR = (ts) => ts.slice(0, 13); // "2026-07-19T10"
const RECENT_MAX = 100;
const BUST_PREV_MIN = 0.5;  // prev request looked cached
const BUST_NOW_MAX = 0.1;   // this one clearly missed

export function createLedger({ dir, prices }) {
  const file = path.join(dir, "ledger.jsonl");
  const sessions = new Map();
  const hourly = new Map();
  const lifetime = {
    requests: 0, saved_tokens: 0, cost_with: 0, cost_without: 0,
    cache_savings: 0, by_model: {},
  };

  function add(e) {
    const price = resolvePrice(e.model, prices);
    const cost = requestCost(e.usage, price) ?? { cost_with: 0, cache_savings: 0 };
    const ok = e.status < 500;
    const saved = ok ? (e.saved_tokens ?? 0) : 0;
    const savedUsd = ok ? savingsUSD(saved, price) : 0;
    const withUsd = cost.cost_with;
    const withoutUsd = withUsd + savedUsd;

    let s = sessions.get(e.session);
    if (!s) {
      s = { id: e.session, started: e.ts, requests: 0, saved_tokens: 0,
        saved_detail: { dedup: 0, stale_read: 0 }, cost_with: 0, cost_without: 0,
        cache_savings: 0, busts: 0, bust_cost: 0,
        tokens: { input: 0, cache_read: 0, cache_creation: 0, output: 0 },
        recent: [], prevUsage: null };
      sessions.set(e.session, s);
    }
    if (s.prevUsage && hitRate(s.prevUsage) > BUST_PREV_MIN && hitRate(e.usage) < BUST_NOW_MAX) {
      s.busts += 1;
      const readRate = price?.cache_read_input_token_cost ?? 0;
      const writeRate = price?.cache_creation_input_token_cost ?? 0;
      s.bust_cost += (e.usage?.cache_creation ?? 0) * (writeRate - readRate);
    }
    s.prevUsage = e.usage ?? null;
    s.last_ts = e.ts;
    s.requests += 1;
    s.saved_tokens += saved;
    if (ok && e.saved_detail) {
      s.saved_detail.dedup += e.saved_detail.dedup ?? 0;
      s.saved_detail.stale_read += e.saved_detail.stale_read ?? 0;
    }
    s.cost_with += withUsd;
    s.cost_without += withoutUsd;
    s.cache_savings += cost.cache_savings;
    for (const k of Object.keys(s.tokens)) s.tokens[k] += e.usage?.[k] ?? 0;
    s.recent.push({ ts: e.ts, model: e.model, status: e.status, ms: e.ms,
      saved_tokens: saved, applied: !!e.applied, usage: e.usage,
      hit_rate: hitRate(e.usage), cost_with: withUsd });
    if (s.recent.length > RECENT_MAX) s.recent.shift();

    lifetime.requests += 1;
    lifetime.saved_tokens += saved;
    lifetime.cost_with += withUsd;
    lifetime.cost_without += withoutUsd;
    lifetime.cache_savings += cost.cache_savings;
    const bm = (lifetime.by_model[e.model] ??= { requests: 0, cost_with: 0, saved_tokens: 0 });
    bm.requests += 1; bm.cost_with += withUsd; bm.saved_tokens += saved;

    const h = hourly.get(HOUR(e.ts)) ??
      hourly.set(HOUR(e.ts), { hour: HOUR(e.ts), requests: 0, cost_with: 0, cost_without: 0, saved_tokens: 0 }).get(HOUR(e.ts));
    h.requests += 1; h.cost_with += withUsd; h.cost_without += withoutUsd; h.saved_tokens += saved;
  }

  function append(e) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(e) + "\n");
    } catch (err) {
      console.error(`[agent-proxy] ledger append failed: ${err.message}`);
    }
    add(e);
  }

  function replay() {
    if (!fs.existsSync(file)) return 0;
    let n = 0, skipped = 0;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { add(JSON.parse(line)); n += 1; } catch { skipped += 1; }
    }
    if (skipped) console.error(`[agent-proxy] ledger replay: skipped ${skipped} corrupt line(s)`);
    return n;
  }

  function stats() {
    const sess = [...sessions.values()]
      .sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""))
      .map(({ prevUsage, ...rest }) => rest);
    return { lifetime, sessions: sess,
      hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour)) };
  }

  return { add, append, replay, stats, file };
}
