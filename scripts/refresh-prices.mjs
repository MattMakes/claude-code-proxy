/** Regenerate lib/prices.json from LiteLLM's community price registry.
 * Deterministic: filter provider=anthropic, keep only the fields cost.mjs reads. */
import fs from "node:fs";
const REGISTRY_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const KEEP = ["input_cost_per_token", "output_cost_per_token",
  "cache_read_input_token_cost", "cache_creation_input_token_cost", "max_input_tokens"];
const res = await fetch(REGISTRY_URL);
if (!res.ok) { console.error(`refresh-prices: fetch failed ${res.status}`); process.exit(1); }
const all = await res.json();
const out = {};
for (const [name, m] of Object.entries(all)) {
  if (m?.litellm_provider !== "anthropic" || m.input_cost_per_token == null) continue;
  out[name.replace(/^anthropic\//, "")] =
    Object.fromEntries(KEEP.filter((k) => m[k] != null).map((k) => [k, m[k]]));
}
const dest = new URL("../lib/prices.json", import.meta.url);
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`refresh-prices: wrote ${Object.keys(out).length} models`);
