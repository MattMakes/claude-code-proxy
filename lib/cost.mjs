/** Pure cost math. Field names mirror LiteLLM's model_prices_and_context_window.json
 * so the full community registry can drop in unchanged. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Same estimator applied to before AND after bodies — deltas stay honest. */
export const estTokens = (str) => Math.round(Buffer.byteLength(str, "utf8") / 4);

export function loadPrices(file = path.join(HERE, "prices.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function resolvePrice(model, prices) {
  if (!model || !prices) return null;
  if (prices[model]) return prices[model];
  const key = Object.keys(prices).find((k) => model.startsWith(k));
  return key ? prices[key] : null;
}

export function requestCost(usage, price) {
  if (!price || !usage) return null;
  const inRate = price.input_cost_per_token ?? 0;
  const readRate = price.cache_read_input_token_cost ?? inRate;
  const writeRate = price.cache_creation_input_token_cost ?? inRate;
  const outRate = price.output_cost_per_token ?? 0;
  const cost_with =
    (usage.input ?? 0) * inRate + (usage.cache_read ?? 0) * readRate +
    (usage.cache_creation ?? 0) * writeRate + (usage.output ?? 0) * outRate;
  const cache_savings =
    (usage.cache_read ?? 0) * (inRate - readRate) -
    (usage.cache_creation ?? 0) * (writeRate - inRate);
  return { cost_with, cache_savings };
}

/** Optimization savings priced at list input rate — cache-mix independent. */
export const savingsUSD = (savedTokens, price) =>
  price ? savedTokens * (price.input_cost_per_token ?? 0) : 0;

export function hitRate(u) {
  if (!u) return 0;
  const denom = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_creation ?? 0);
  return denom ? (u.cache_read ?? 0) / denom : 0;
}
