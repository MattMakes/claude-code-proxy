import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { optimize, commitForward } from "../lib/optimize.mjs";
import { extractSessionId, sessionState } from "../lib/session.mjs";
import { createLedger } from "../lib/ledger.mjs";
import { loadPrices } from "../lib/cost.mjs";

test("golden: request → optimize → ledger → stats", () => {
  const BIG = ("repeated tool output line for the golden fixture\n").repeat(40);
  const reqJson = {
    model: "claude-sonnet-5",
    metadata: { user_id: "user_x__session_aaaabbbb-cccc-dddd-eeee-ffff00001111" },
    system: "s".repeat(9000),
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: BIG }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: BIG }] },
    ],
  };
  const sid = extractSessionId(reqJson, "boot");
  assert.equal(sid, "aaaabbbb-cccc-dddd-eeee-ffff00001111");
  const state = sessionState(sid);
  const opt = optimize(reqJson, state, { apply: true });
  assert.ok(opt.applied && opt.savedDetail.dedup > 0);

  const usage = { input: 900, cache_read: 4000, cache_creation: 1200, output: 250 };
  commitForward(state, opt.body, usage);
  const led = createLedger({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "gold-")), prices: loadPrices() });
  led.append({ ts: new Date().toISOString(), session: sid, model: reqJson.model,
    original_tokens: opt.originalTokens, optimized_tokens: opt.optimizedTokens,
    saved_tokens: opt.originalTokens - opt.optimizedTokens, saved_detail: opt.savedDetail,
    applied: opt.applied, usage, status: 200, ms: 42 });

  const s = led.stats();
  const sess = s.sessions.find((x) => x.id === sid);
  assert.equal(sess.requests, 1);
  assert.ok(sess.cost_without > sess.cost_with);
  assert.ok(fs.existsSync(led.file));
});
