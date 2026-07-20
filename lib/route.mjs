/** Complexity-based routing — deterministic subset of LiteLLM's
 * ComplexityRouter (their weights and tier boundaries; no embeddings, no LLM
 * classifier). Scoring is pure; the proxy decides whether to apply, and by
 * default only shadows: decisions are recorded, never applied. */
import { estTokens, resolvePrice } from "./cost.mjs";

const WEIGHTS = { code: 0.30, reasoning: 0.25, technical: 0.25, length: 0.10 };
const WEIGHT_SUM = WEIGHTS.code + WEIGHTS.reasoning + WEIGHTS.technical + WEIGHTS.length;
const BOUNDARIES = [[0.15, "SIMPLE"], [0.35, "MODERATE"], [0.60, "COMPLEX"]]; // else REASONING
const LENGTH_CAP_TOKENS = 4000;

/** ≥ 2 distinct marker hits force REASONING outright (LiteLLM's rule). */
const REASONING_MARKERS = [
  /\bwhy\b/i, /\bprove\b/i, /\bplan\b/i, /\bdesign\b/i, /\barchitect/i,
  /\banaly[sz]e\b/i, /step.by.step/i, /trade.?off/i, /\bdebug\b/i, /root.?cause/i,
];
const CODE_SIGNALS = [
  /```/, /\bfunction\b/, /\bclass\b/, /\bimport\b/, /\bdef\b/, /=>/, /[{}]/,
];
const TECHNICAL_TERMS = [
  /\bapi\b/i, /\bdatabase\b/i, /\bsql\b/i, /\balgorithm\b/i, /\basync\b/i,
  /\bthread\b/i, /\bserver\b/i, /\bendpoint\b/i, /\bschema\b/i, /\bregex\b/i,
  /\bcompiler\b/i, /\bkernel\b/i, /\bcache\b/i, /\blatency\b/i, /\bprotocol\b/i,
  /\bencryption\b/i, /\bmiddleware\b/i, /\bruntime\b/i, /\bdependenc/i,
  /\brefactor/i, /\bconcurren/i, /\bdistributed\b/i,
];

/** COMPLEX/REASONING intentionally absent — those keep the requested model. */
export const DEFAULT_TIER_MAP = { SIMPLE: "claude-haiku-4-5", MODERATE: "claude-sonnet-5" };

const countHits = (patterns, text) => patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

export function scoreComplexity(text) {
  const t = typeof text === "string" ? text : "";
  const reasoningMarkers = countHits(REASONING_MARKERS, t);
  const codeSignals = countHits(CODE_SIGNALS, t);
  const technicalTerms = countHits(TECHNICAL_TERMS, t);
  const dims = {
    code: codeSignals >= 2 ? 1 : codeSignals === 1 ? 0.5 : 0,
    reasoning: reasoningMarkers >= 2 ? 1 : reasoningMarkers === 1 ? 0.7 : 0,
    technical: technicalTerms >= 4 ? 1 : technicalTerms >= 2 ? 0.5 : 0,
    length: Math.min(1, estTokens(t) / LENGTH_CAP_TOKENS),
  };
  const score = (WEIGHTS.code * dims.code + WEIGHTS.reasoning * dims.reasoning +
    WEIGHTS.technical * dims.technical + WEIGHTS.length * dims.length) / WEIGHT_SUM;
  return { score, dims, reasoningMarkers };
}

function tierOf(score, reasoningMarkers) {
  if (reasoningMarkers >= 2) return "REASONING";
  for (const [max, tier] of BOUNDARIES) if (score < max) return tier;
  return "REASONING";
}

/** Text to score: concatenated text blocks of the LAST user message.
 * tool_result blocks are machine output, not intent — excluded. */
function lastUserText(reqJson) {
  const msgs = Array.isArray(reqJson?.messages) ? reqJson.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== "user") continue;
    const c = msgs[i].content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
    }
    return "";
  }
  return "";
}

/** Pure decision. Downgrade-only: apply_ok requires the target's list input
 * rate strictly below the requested model's (either price missing → false). */
export function routeModel(reqJson, tierMap = DEFAULT_TIER_MAP, prices) {
  const { score, reasoningMarkers } = scoreComplexity(lastUserText(reqJson));
  const tier = tierOf(score, reasoningMarkers);
  const from = reqJson?.model ?? "unknown";
  const target = tierMap?.[tier] ?? from;
  const fromRate = resolvePrice(from, prices)?.input_cost_per_token;
  const targetRate = resolvePrice(target, prices)?.input_cost_per_token;
  const apply_ok = fromRate != null && targetRate != null && targetRate < fromRate;
  return { tier, score, from, target, apply_ok };
}
