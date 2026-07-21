/** Prometheus text exposition v0.0.4, rendered from LEDGER.stats() on scrape.
 * The ledger aggregates are monotonic, so they are valid counters. Pure. */

const escLabel = (v) =>
  String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const num = (n) => String(Number.isFinite(n) ? n : 0);

const TOKEN_CLASSES = ["input", "cache_read", "cache_creation", "output"];
const PASSES = ["dedup", "stale_read", "crush", "crush_text", "mature"];
const MISS_REASONS = ["ttl_expiry", "prefix_change", "unknown"];
const TIERS = ["SIMPLE", "MODERATE", "COMPLEX", "REASONING"];

export function renderMetrics(stats = {}, extra = {}) {
  const lt = stats.lifetime ?? {};
  const all = stats.all ?? {};
  const routing = stats.routing ?? {};
  const tiers = routing.tiers ?? {};
  const byModel = Array.isArray(stats.by_model) ? stats.by_model : [];
  const lines = [];
  const family = (name, type, help, samples) => {
    lines.push(`# HELP agentproxy_${name} ${help}`);
    lines.push(`# TYPE agentproxy_${name} ${type}`);
    for (const [labels, value] of samples) {
      lines.push(`agentproxy_${name}${labels ? `{${labels}}` : ""} ${num(value ?? 0)}`);
    }
  };

  family("requests_total", "counter", "Requests forwarded through the proxy",
    [[null, lt.requests]]);
  family("tokens_total", "counter", "Tokens consumed, by billing class",
    TOKEN_CLASSES.map((c) => [`class="${c}"`, all.tokens?.[c]]));
  family("saved_tokens_total", "counter", "Estimated tokens saved, by optimizer pass",
    PASSES.map((p) => [`pass="${p}"`, all.saved_detail?.[p]]));
  family("cost_usd_total", "counter", "Actual spend in USD",
    [[null, lt.cost_with]]);
  family("cost_without_usd_total", "counter", "Spend without optimizations in USD",
    [[null, lt.cost_without]]);
  family("cache_savings_usd_total", "counter", "Prompt-cache savings in USD",
    [[null, lt.cache_savings]]);
  family("cache_busts_total", "counter", "Detected prompt-cache busts",
    [[null, all.busts]]);
  family("cache_miss_total", "counter", "Expected-hit prompt-cache misses, by attributed reason",
    MISS_REASONS.map((r) => [`reason="${r}"`, stats.cache_misses?.[r]]));
  family("bust_cost_usd_total", "counter", "Cost of detected cache busts in USD",
    [[null, all.bust_cost]]);
  family("sessions", "gauge", "Sessions seen since the ledger began",
    [[null, stats.sessions?.length]]);
  family("requests_by_model_total", "counter", "Requests per model",
    byModel.map((m) => [`model="${escLabel(m.model)}"`, m.requests]));
  family("cost_by_model_usd_total", "counter", "Spend per model in USD",
    byModel.map((m) => [`model="${escLabel(m.model)}"`, m.cost_with]));
  family("route_tier_total", "counter", "Routing decisions per complexity tier",
    TIERS.map((t) => [`tier="${t}"`, tiers[t]]));
  family("route_applied_total", "counter", "Routing decisions applied (--route)",
    [[null, routing.applied]]);
  family("route_potential_saved_usd", "gauge",
    "Approximate spend saved if shadow routing were applied, in USD",
    [[null, routing.potential_saved_usd]]);
  family("ccr_entries", "gauge", "Entries in the crushed-content retrieval store",
    [[null, extra.ccrEntries ?? 0]]);
  return lines.join("\n") + "\n";
}
