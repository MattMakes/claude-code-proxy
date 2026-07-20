/** JSONL ledger + in-memory aggregates. One add() path serves both live
 * traffic and boot replay so numbers can never diverge. */
import fs from "node:fs";
import path from "node:path";
import { resolvePrice, requestCost, savingsUSD, hitRate } from "./cost.mjs";

const HOUR = (ts) => ts.slice(0, 13); // "2026-07-19T10"
const RECENT_MAX = 100;
const ALL_RECENT_MAX = 200;
const TOP_MAX = 20;
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
  const tools = new Map();     // tool name → cumulative definition cost
  const topRequests = [];      // up to TOP_MAX entries, sorted desc by cost_with
  const waste = { bust_cost_total: 0, system_sum: 0, system_count: 0 };
  // Session-shaped rollup of everything, so the dashboard can render "All
  // sessions" through the exact same panels as a single session.
  const all = { id: "all", started: null, requests: 0, saved_tokens: 0,
    saved_detail: { dedup: 0, stale_read: 0 }, cost_with: 0, cost_without: 0,
    cache_savings: 0, busts: 0, bust_cost: 0,
    tokens: { input: 0, cache_read: 0, cache_creation: 0, output: 0 },
    recent: [] };

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
    let bust = false;
    if (s.prevUsage && hitRate(s.prevUsage) > BUST_PREV_MIN && hitRate(e.usage) < BUST_NOW_MAX) {
      bust = true;
      s.busts += 1;
      const readRate = price?.cache_read_input_token_cost ?? 0;
      const writeRate = price?.cache_creation_input_token_cost ?? 0;
      const bustUsd = (e.usage?.cache_creation ?? 0) * (writeRate - readRate);
      s.bust_cost += bustUsd;
      all.busts += 1;
      all.bust_cost += bustUsd;
      waste.bust_cost_total += bustUsd;
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
    const recentItem = { ts: e.ts, model: e.model, status: e.status, ms: e.ms,
      saved_tokens: saved, applied: !!e.applied, usage: e.usage,
      hit_rate: hitRate(e.usage), cost_with: withUsd, ...(bust && { bust: true }) };
    s.recent.push(recentItem);
    if (s.recent.length > RECENT_MAX) s.recent.shift();

    all.started ??= e.ts;
    all.last_ts = e.ts;
    all.requests += 1;
    all.saved_tokens += saved;
    if (ok && e.saved_detail) {
      all.saved_detail.dedup += e.saved_detail.dedup ?? 0;
      all.saved_detail.stale_read += e.saved_detail.stale_read ?? 0;
    }
    all.cost_with += withUsd;
    all.cost_without += withoutUsd;
    all.cache_savings += cost.cache_savings;
    for (const k of Object.keys(all.tokens)) all.tokens[k] += e.usage?.[k] ?? 0;
    all.recent.push(recentItem);
    if (all.recent.length > ALL_RECENT_MAX) all.recent.shift();

    lifetime.requests += 1;
    lifetime.saved_tokens += saved;
    lifetime.cost_with += withUsd;
    lifetime.cost_without += withoutUsd;
    lifetime.cache_savings += cost.cache_savings;
    const bm = (lifetime.by_model[e.model] ??= { requests: 0, cost_with: 0, cost_without: 0, saved_tokens: 0,
      tokens: { input: 0, cache_read: 0, cache_creation: 0, output: 0 } });
    bm.requests += 1; bm.cost_with += withUsd; bm.cost_without += withoutUsd; bm.saved_tokens += saved;
    for (const k of Object.keys(bm.tokens)) bm.tokens[k] += e.usage?.[k] ?? 0;

    // Request composition (optional field — entries without it aggregate fine).
    if (e.breakdown) {
      for (const td of e.breakdown.tool_defs ?? []) {
        const t = tools.get(td.name) ??
          tools.set(td.name, { requests: 0, tokens_per_request: 0, tokens_total: 0 }).get(td.name);
        t.requests += 1; t.tokens_per_request = td.tokens ?? 0; t.tokens_total += td.tokens ?? 0;
      }
      waste.system_sum += e.breakdown.system ?? 0;
      waste.system_count += 1;
    }

    topRequests.push({ ts: e.ts, session: e.session, model: e.model, cost_with: withUsd,
      in_tokens: (e.usage?.input ?? 0) + (e.usage?.cache_read ?? 0) + (e.usage?.cache_creation ?? 0),
      hit_rate: hitRate(e.usage), saved_tokens: saved });
    topRequests.sort((a, b) => b.cost_with - a.cost_with);
    if (topRequests.length > TOP_MAX) topRequests.length = TOP_MAX;

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
    // Tool $ approximated at the most-used model's list input rate ("≈" in UI).
    const topModel = Object.entries(lifetime.by_model)
      .sort((a, b) => b[1].requests - a[1].requests)[0]?.[0];
    const inRate = resolvePrice(topModel, prices)?.input_cost_per_token ?? 0;
    return { lifetime, all, sessions: sess,
      hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
      tools: [...tools.entries()]
        .map(([name, t]) => ({ name, ...t, usd_total: t.tokens_total * inRate }))
        .sort((a, b) => b.tokens_total - a.tokens_total),
      top_requests: topRequests,
      by_model: Object.entries(lifetime.by_model).map(([model, v]) =>
        ({ model, requests: v.requests, saved_tokens: v.saved_tokens, cost_with: v.cost_with,
          cost_without: v.cost_without, tokens: v.tokens, hit_rate: hitRate(v.tokens) })),
      waste: { bust_cost_total: waste.bust_cost_total,
        system_tokens_avg: waste.system_count ? Math.round(waste.system_sum / waste.system_count) : 0 } };
  }

  return { add, append, replay, stats, file };
}
