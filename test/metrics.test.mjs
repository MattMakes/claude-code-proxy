import test from "node:test";
import assert from "node:assert/strict";
import { renderMetrics } from "../lib/metrics.mjs";

const stats = {
  lifetime: { requests: 42, saved_tokens: 1234, cost_with: 1.5, cost_without: 2.25,
    cache_savings: 0.75 },
  all: { tokens: { input: 100, cache_read: 2000, cache_creation: 300, output: 50 },
    saved_detail: { dedup: 600, stale_read: 400, crush: 234 }, busts: 3, bust_cost: 0.12 },
  sessions: [{ id: "s1" }, { id: "s2" }],
  by_model: [
    { model: 'claude-"weird"-5', requests: 40, cost_with: 1.4 },
    { model: "claude-haiku-4-5", requests: 2, cost_with: 0.1 },
  ],
  routing: { tiers: { SIMPLE: 5, MODERATE: 2, COMPLEX: 1, REASONING: 0 },
    applied: 1, potential_saved_usd: 0.33 },
};

test("renders HELP/TYPE per family and exact sample values", () => {
  const out = renderMetrics(stats, { ccrEntries: 7 });
  assert.match(out, /^# HELP agentproxy_requests_total .+$/m);
  assert.match(out, /^# TYPE agentproxy_requests_total counter$/m);
  assert.match(out, /^agentproxy_requests_total 42$/m);
  assert.match(out, /^agentproxy_tokens_total\{class="cache_read"\} 2000$/m);
  assert.match(out, /^agentproxy_tokens_total\{class="output"\} 50$/m);
  assert.match(out, /^agentproxy_saved_tokens_total\{pass="dedup"\} 600$/m);
  assert.match(out, /^agentproxy_saved_tokens_total\{pass="crush"\} 234$/m);
  assert.match(out, /^agentproxy_cost_usd_total 1\.5$/m);
  assert.match(out, /^agentproxy_cost_without_usd_total 2\.25$/m);
  assert.match(out, /^agentproxy_cache_savings_usd_total 0\.75$/m);
  assert.match(out, /^agentproxy_cache_busts_total 3$/m);
  assert.match(out, /^agentproxy_bust_cost_usd_total 0\.12$/m);
  assert.match(out, /^# TYPE agentproxy_sessions gauge$/m);
  assert.match(out, /^agentproxy_sessions 2$/m);
  assert.match(out, /^agentproxy_requests_by_model_total\{model="claude-haiku-4-5"\} 2$/m);
  assert.match(out, /^agentproxy_cost_by_model_usd_total\{model="claude-haiku-4-5"\} 0\.1$/m);
  assert.match(out, /^agentproxy_route_tier_total\{tier="SIMPLE"\} 5$/m);
  assert.match(out, /^agentproxy_route_tier_total\{tier="REASONING"\} 0$/m);
  assert.match(out, /^agentproxy_route_applied_total 1$/m);
  assert.match(out, /^agentproxy_route_potential_saved_usd 0\.33$/m);
  assert.match(out, /^agentproxy_ccr_entries 7$/m);
});

test("label values with quotes are escaped", () => {
  const out = renderMetrics(stats, { ccrEntries: 0 });
  assert.ok(out.includes('agentproxy_requests_by_model_total{model="claude-\\"weird\\"-5"} 40'));
  const tricky = renderMetrics({ ...stats,
    by_model: [{ model: 'a\\b\n"c"', requests: 1, cost_with: 0 }] });
  assert.ok(tricky.includes('agentproxy_requests_by_model_total{model="a\\\\b\\n\\"c\\""} 1'));
});

test("missing routing/ccr/all fields render zeros — never NaN", () => {
  const out = renderMetrics({ lifetime: {}, all: {}, sessions: [], by_model: [] });
  assert.match(out, /^agentproxy_requests_total 0$/m);
  assert.match(out, /^agentproxy_tokens_total\{class="input"\} 0$/m);
  assert.match(out, /^agentproxy_saved_tokens_total\{pass="stale_read"\} 0$/m);
  assert.match(out, /^agentproxy_route_tier_total\{tier="SIMPLE"\} 0$/m);
  assert.match(out, /^agentproxy_route_applied_total 0$/m);
  assert.match(out, /^agentproxy_route_potential_saved_usd 0$/m);
  assert.match(out, /^agentproxy_ccr_entries 0$/m);
  assert.ok(!out.includes("NaN"));
});
