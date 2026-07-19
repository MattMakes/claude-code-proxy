/**
 * agent-proxy — see what Claude Code actually sends the model.
 *
 * A zero-dependency logging proxy for Claude Code. It sits between the CLI and
 * the Anthropic API, forwards every request (auth headers pass through
 * untouched), streams the response straight back so the CLI is unaffected, and
 * for each request writes a readable Markdown document — led by a ranked table
 * of what is eating your context.
 *
 * v2 also trims what it measures. Two cache-safe optimizations are on by
 * default — run with --no-optimize to observe only. Every request is recorded
 * in the ledger at logs/ledger.jsonl (replayed at boot, so the numbers survive
 * restarts), and a live dashboard is served at /dashboard.
 *
 * Run:   node proxy.mjs
 * Point Claude Code at it:
 *   ANTHROPIC_BASE_URL=http://localhost:8787 claude
 * Watch it:
 *   http://localhost:8787/dashboard
 *
 * Zero runtime dependencies — Node built-ins only. Requires Node 18+.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { estTokens as estTok } from "./lib/cost.mjs";
import { loadPrices } from "./lib/cost.mjs";
import { extractSessionId, sessionState } from "./lib/session.mjs";
import { createLedger } from "./lib/ledger.mjs";
import { optimize, commitForward } from "./lib/optimize.mjs";
import { createSseHub } from "./lib/sse.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = "api.anthropic.com";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");

const OPTIMIZE = !process.argv.includes("--no-optimize");
const BOOT_ID = Math.random().toString(36).slice(2, 8);
const PRICES = loadPrices();
const LEDGER = createLedger({ dir: LOG_DIR, prices: PRICES });
const replayed = LEDGER.replay();
const HUB = createSseHub();

/** Rough token estimate for display. Real input tokens come from the response
 * usage; this is only for ranking the request before the reply arrives. */
const estTokens = (bytes) => Math.round(bytes / 4);

/** count_tokens calls send content but get back only a number, never a reply.
 * A single turn fires many as housekeeping — pure noise here, so skip them. */
const isTokenCount = (reqPath) => reqPath.includes("count_tokens");

const REDACT = new Set(["authorization", "x-api-key", "api-key"]);

/** Strip hop-by-hop and encoding headers so the captured response is readable,
 * recompute content-length, and pass auth through untouched so the real request
 * still authenticates. */
function forwardHeaders(headers, body) {
  const out = { ...headers };
  delete out["host"];
  delete out["connection"];
  delete out["accept-encoding"]; // force identity so we can read the stream
  delete out["transfer-encoding"];
  delete out["content-length"];
  if (body.length > 0) out["content-length"] = String(body.length);
  return out;
}

function baseName() {
  const stamp = new Date().toISOString().replace(/:/g, "-").replace(".", "-").replace("Z", "");
  return `${stamp}_anthropic`;
}

// ---------------------------------------------------------------------------
// The audit: rank what's in the request
// ---------------------------------------------------------------------------

/** Measure every removable region of the request and rank the tools by size.
 * This is the whole point of the proxy — the numbers you cut against. */
function auditRequest(reqJson, realInputTokens) {
  const tools = Array.isArray(reqJson?.tools) ? reqJson.tools : [];
  const toolRows = tools
    .map((t) => {
      const bytes = Buffer.byteLength(JSON.stringify(t));
      return { name: t?.name ?? "(unnamed)", bytes, tokens: estTokens(bytes) };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const toolsBytes = toolRows.reduce((n, r) => n + r.bytes, 0);
  const systemBytes = reqJson?.system ? Buffer.byteLength(JSON.stringify(reqJson.system)) : 0;
  const totalBytes = Buffer.byteLength(JSON.stringify(reqJson ?? {}));

  return {
    toolRows,
    toolCount: toolRows.length,
    toolsBytes,
    systemBytes,
    totalBytes,
    realInputTokens,
  };
}

/** The ranked table, as Markdown. The hero of the whole document. */
function renderAudit(a) {
  const pct = (b) => (a.totalBytes ? ((b / a.totalBytes) * 100).toFixed(1) : "0.0");
  const rows = a.toolRows
    .map((r) => `| ${r.name} | ${r.bytes.toLocaleString()} | ~${r.tokens.toLocaleString()} | ${pct(r.bytes)}% |`)
    .join("\n");

  return [
    "<audit>",
    "",
    a.realInputTokens != null
      ? `**${a.realInputTokens.toLocaleString()} input tokens** billed for this request (from the response usage).`
      : "",
    "",
    `- **tools**: ${a.toolCount} definitions, ${a.toolsBytes.toLocaleString()} bytes (~${estTokens(a.toolsBytes).toLocaleString()} tokens)`,
    `- **system prompt**: ${a.systemBytes.toLocaleString()} bytes (~${estTokens(a.systemBytes).toLocaleString()} tokens)`,
    `- **total request**: ${a.totalBytes.toLocaleString()} bytes`,
    "",
    "**Tools, ranked by size — this is your cut list:**",
    "",
    "| tool | bytes | ~tokens | % of request |",
    "| --- | --: | --: | --: |",
    rows,
    "",
    "</audit>",
  ].join("\n");
}

/** The same ranking, compact, for the terminal — so you see the bloat live. */
function printAudit(a, base) {
  const top = a.toolRows.slice(0, 12);
  const w = Math.max(4, ...top.map((r) => r.name.length));
  console.log(`\n[agent-proxy] ${a.toolCount} tools · ${a.toolsBytes.toLocaleString()} tool bytes` +
    (a.realInputTokens != null ? ` · ${a.realInputTokens.toLocaleString()} real input tokens` : ""));
  for (const r of top) {
    console.log(`  ${r.name.padEnd(w)}  ${String(r.bytes).padStart(7)} B  ~${r.tokens} tok`);
  }
  if (a.toolRows.length > top.length) console.log(`  … ${a.toolRows.length - top.length} more`);
  console.log(`  logs/${base}.md\n`);
}

// ---------------------------------------------------------------------------
// Readable Markdown render (Anthropic /messages only)
// ---------------------------------------------------------------------------

const fenceJson = (v) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
const fence = (t, lang = "") => "```" + lang + "\n" + t + "\n```";

function blockText(b) {
  if (typeof b === "string") return b;
  if (b?.type === "text" && typeof b.text === "string") return b.text;
  return "";
}

function renderSystem(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => blockText(b) + (b?.cache_control ? "\n\n<!-- cache_control breakpoint -->" : ""))
      .join("\n\n");
  }
  return fenceJson(system);
}

function renderTools(tools) {
  const rendered = tools.map((t) => {
    const lines = [`### ${t.name ?? "(unnamed tool)"}`, ""];
    if (t.description) lines.push(t.description, "");
    if (t.input_schema) lines.push(fenceJson(t.input_schema));
    return lines.join("\n");
  });
  return ["<tools>", "", rendered.join("\n\n"), "", "</tools>"].join("\n");
}

function imagePlaceholder(b) {
  const src = b.source ?? {};
  const bytes = typeof src.data === "string" ? src.data.length : 0;
  return `\`[image: ${src.media_type ?? "unknown"}, ${bytes} base64 chars — full data in .request.txt]\``;
}

function renderContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fenceJson(content);
  return content
    .map((b) => {
      switch (b?.type) {
        case "text":
          return b.text ?? "";
        case "tool_use":
          return [`<tool-use name="${b.name}" id="${b.id ?? ""}">`, "", fenceJson(b.input ?? {}), "", "</tool-use>"].join("\n");
        case "tool_result": {
          const inner =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((x) => (x?.type === "image" ? imagePlaceholder(x) : blockText(x) || fenceJson(x))).join("\n\n")
                : fenceJson(b.content);
          return [`<tool-result tool-use-id="${b.tool_use_id ?? ""}" is-error="${!!b.is_error}">`, "", inner, "", "</tool-result>"].join("\n");
        }
        case "image":
          return imagePlaceholder(b);
        case "thinking":
          return ["<thinking>", "", b.thinking ?? "", "", "</thinking>"].join("\n");
        default:
          return fenceJson(b);
      }
    })
    .join("\n\n");
}

function renderMessages(messages) {
  if (!Array.isArray(messages)) return "<messages></messages>";
  const rendered = messages.map((m, i) =>
    [`<message index="${i + 1}" role="${m.role ?? "unknown"}">`, "", renderContent(m.content), "", "</message>"].join("\n")
  );
  return ["<messages>", "", rendered.join("\n\n"), "", "</messages>"].join("\n");
}

/** Reassemble the streamed SSE response so we can read the reply — and pull the
 * real input-token count out of the usage events. */
function decodeResponse(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m || m[1] === "[DONE]" || m[1].trim() === "") continue;
    try { events.push(JSON.parse(m[1])); } catch { /* skip */ }
  }
  const blocks = {};
  let stopReason, usage;
  for (const ev of events) {
    if (ev.type === "content_block_start") blocks[ev.index] = { type: ev.content_block?.type ?? "text", text: "", name: ev.content_block?.name, id: ev.content_block?.id };
    else if (ev.type === "content_block_delta" && blocks[ev.index]) {
      const d = ev.delta ?? {};
      blocks[ev.index].text += d.text ?? d.partial_json ?? d.thinking ?? "";
    } else if (ev.type === "message_start" && ev.message?.usage) usage = { ...ev.message.usage, ...(usage ?? {}) };
    else if (ev.type === "message_delta") {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage) usage = { ...(usage ?? {}), ...ev.usage };
    }
  }
  const parts = [];
  if (stopReason) parts.push(`- **stop reason**: ${stopReason}`);
  if (usage) parts.push(`- **usage**: ${JSON.stringify(usage)}`, "");
  for (const i of Object.keys(blocks).map(Number).sort((a, b) => a - b)) {
    const b = blocks[i];
    if (b.type === "text") parts.push(["<assistant-text>", "", b.text, "", "</assistant-text>"].join("\n"));
    else if (b.type === "thinking") parts.push(["<thinking>", "", b.text, "", "</thinking>"].join("\n"));
    else if (b.type === "tool_use") parts.push([`<tool-use name="${b.name}" id="${b.id ?? ""}">`, "", fence(b.text || "{}", "json"), "", "</tool-use>"].join("\n"));
  }
  const usageSplit = usage ? {
    input: usage.input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    cache_creation: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  } : null;
  const inputTokens = usageSplit
    ? usageSplit.input + usageSplit.cache_read + usageSplit.cache_creation
    : null;
  return { markdown: parts.length ? parts.join("\n\n") : fence(raw), inputTokens, usageSplit };
}

function renderMarkdown(c, audit, responseMd) {
  const headers = Object.entries(c.headers).map(([k, v]) =>
    `${k}: ${REDACT.has(k.toLowerCase()) ? "[REDACTED]" : Array.isArray(v) ? v.join(", ") : v ?? ""}`
  );
  const req = c.reqJson;
  const parts = [
    ["<meta>", "", `- **timestamp**: ${c.timestamp}`, `- **model**: ${req?.model ?? "unknown"}`, `- **endpoint**: ${c.method} ${c.path}`, `- **upstream status**: ${c.statusCode}`, "", "</meta>"].join("\n"),
    renderAudit(audit),
    ["<headers>", "", "```", ...headers, "```", "", "</headers>"].join("\n"),
  ];
  if (req?.system != null) parts.push(["<system-prompt>", "", renderSystem(req.system), "", "</system-prompt>"].join("\n"));
  if (Array.isArray(req?.tools) && req.tools.length) parts.push(renderTools(req.tools));
  parts.push(renderMessages(req?.messages));
  parts.push("<response>\n\n" + responseMd + "\n\n</response>");
  return parts.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function handle(req, res) {
  const reqPath = req.url ?? "/";
  // Must precede the /stats check — "/stats/stream".startsWith("/stats") is true.
  if (req.method === "GET" && reqPath.startsWith("/stats/stream")) {
    HUB.handle(res);
    return;
  }
  if (req.method === "GET" && reqPath.startsWith("/stats")) {
    if (reqPath.includes("format=jsonl")) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      fs.existsSync(LEDGER.file) ? fs.createReadStream(LEDGER.file).pipe(res) : res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ optimize: OPTIMIZE, ...LEDGER.stats() }));
    }
    return;
  }
  if (req.method === "GET" && reqPath.startsWith("/dashboard")) {
    try {
      const html = fs.readFileSync(path.join(HERE, "dashboard.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("dashboard.html not built yet");
    }
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const timestamp = new Date().toISOString();
    const base = baseName();

    const t0 = Date.now();
    let pipeline = null; // { reqJson, sid, state, opt, forwardBody }
    if (!isTokenCount(reqPath) && (req.method ?? "POST") === "POST") {
      try {
        const reqJson = JSON.parse(body.toString("utf8"));
        const sid = extractSessionId(reqJson, BOOT_ID);
        const state = sessionState(sid);
        let opt;
        try {
          opt = optimize(reqJson, state, { apply: OPTIMIZE });
        } catch (err) {
          console.error(`[agent-proxy] optimizer error (forwarding original): ${err.message}`);
          opt = { body: reqJson, originalTokens: estTok(body.toString("utf8")),
            optimizedTokens: estTok(body.toString("utf8")),
            savedDetail: { dedup: 0, stale_read: 0 }, applied: false };
        }
        const forwardBody = opt.applied ? Buffer.from(JSON.stringify(opt.body)) : body;
        pipeline = { reqJson, sid, state, opt, forwardBody };
      } catch { /* non-JSON body: forward untouched, no pipeline (v1 invariant) */ }
    }
    const wireBody = pipeline ? pipeline.forwardBody : body;

    const upstream = https.request(
      { hostname: UPSTREAM, port: 443, path: reqPath, method: req.method, headers: forwardHeaders(req.headers, wireBody) },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        const respChunks = [];
        up.on("data", (c) => { respChunks.push(c); res.write(c); });
        up.on("end", () => {
          res.end();
          if (isTokenCount(reqPath)) return;
          try {
            const reqJson = JSON.parse(body.toString("utf8"));
            const { markdown, inputTokens, usageSplit } = decodeResponse(Buffer.concat(respChunks).toString("utf8"));
            const audit = auditRequest(reqJson, inputTokens);
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.writeFileSync(path.join(LOG_DIR, `${base}.request.txt`), body.toString("utf8"));
            fs.writeFileSync(path.join(LOG_DIR, `${base}.md`), renderMarkdown({ reqJson, timestamp, method: req.method ?? "POST", path: reqPath, statusCode: up.statusCode ?? 0, headers: req.headers }, audit, markdown));
            printAudit(audit, base);
            if (pipeline) {
              const { sid, state, opt } = pipeline;
              // Commit whatever was ACTUALLY forwarded — the optimized body when
              // applied, the original in projection mode — so cross-turn state
              // (prefix hash, span memory) stays truthful in both modes.
              if ((up.statusCode ?? 0) < 500) commitForward(state, opt.applied ? opt.body : pipeline.reqJson, usageSplit);
              else if (usageSplit) state.lastUsage = usageSplit;
              LEDGER.append({ ts: timestamp, session: sid, model: pipeline.reqJson?.model ?? "unknown",
                original_tokens: opt.originalTokens, optimized_tokens: opt.optimizedTokens,
                saved_tokens: opt.originalTokens - opt.optimizedTokens,
                saved_detail: opt.savedDetail, applied: opt.applied,
                usage: usageSplit ?? { input: 0, cache_read: 0, cache_creation: 0, output: 0 },
                status: up.statusCode ?? 0, ms: Date.now() - t0,
                // Request composition, from the audit above — feeds the
                // dashboard's cumulative tool cut-list and waste cards.
                breakdown: { system: estTok(JSON.stringify(reqJson.system ?? "")),
                  tools: estTokens(audit.toolsBytes),
                  messages: estTok(JSON.stringify(reqJson.messages ?? [])),
                  tool_defs: audit.toolRows.slice(0, 15).map((r) => ({ name: r.name, tokens: r.tokens })) } });
              HUB.broadcast({ optimize: OPTIMIZE, ...LEDGER.stats() });
            }
          } catch (err) {
            console.error(`[agent-proxy] could not render (non-JSON body?): ${err.message}`);
          }
        });
      }
    );
    upstream.on("error", (err) => {
      console.error(`[agent-proxy] upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `agent-proxy upstream error: ${err.message}` }));
    });
    if (wireBody.length > 0) upstream.write(wireBody);
    upstream.end();
  });
}

const HOST = process.env.HOST ?? "127.0.0.1";
http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`[agent-proxy] listening on http://localhost:${PORT}`);
  console.log(`[agent-proxy] point Claude Code at it:  ANTHROPIC_BASE_URL=http://localhost:${PORT} claude`);
  console.log(`[agent-proxy] optimize: ${OPTIMIZE ? "ON (use --no-optimize to observe only)" : "OFF (projection only)"}`);
  console.log(`[agent-proxy] ledger: ${replayed} request(s) replayed · dashboard: http://localhost:${PORT}/dashboard`);
});