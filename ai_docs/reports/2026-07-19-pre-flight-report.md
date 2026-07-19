# Pre-Flight Report: Measurement Ledger + Safe Optimizations Plan

**Plan:** `ai_docs/plans/2026-07-19-measurement-ledger-plan.md` · **Target:** `proxy.mjs` (greenfield feature work, not a rewrite — no `source_path`)

## Prerequisites
- Runtime Discovery: n/a (not a rewrite)
- Local Dev Setup (Task 0): PRESENT
- External Dependencies Matrix: PRESENT (Anthropic upstream + build-time price registry)

## Summary
- Wiring: 0 issues (after review)
- Behavioral: 1 critical, 2 important — all patched into the plan
- Contracts: 0 breaking (3 new local endpoints; stubs are valid Anthropic content blocks)
- Configuration: 1 important (bind address) — patched
- Domain: 0 violations
- Credentials: 0 issues (pure passthrough, redaction preserved)

## Wiring
- PASS `lib/cost.mjs` → imported by proxy, ledger, optimize (ES imports are the registration; no DI container)
- PASS `createLedger` instantiated at module scope; `replay()` called at boot
- PASS `optimize`/`commitForward` called in pipeline + settle
- PASS `dashboard.html` served via existing `HERE` constant (`proxy.mjs:26`)
- PASS no name collision: plan aliases `estTokens as estTok` (v1 keeps its bytes-based `estTokens` at `proxy.mjs:31`)

## Behavioral Preservation (v1 invariants vs plan)
- PASS streaming, auth passthrough, `accept-encoding` strip, redaction, `count_tokens` skip, `.md` logs (renders ORIGINAL body) — all explicitly preserved in Task 6 Step 6
- **FAIL→FIXED (critical):** settle block used `usageSplit` but plan never updated the destructure at `proxy.mjs:283` → guaranteed `ReferenceError`. Plan now updates the destructure first (Task 6 · 3e).
- **WARN→FIXED (important):** cross-turn dedup seeded `state.spans` even when the forwarded prefix was broken (client compaction) → could stub a span whose original occurrence no longer exists in context. Plan now seeds cross-turn spans only when `deltaStart > 0` (Task 4 · dedupPass).
- **WARN→FIXED (important):** projection mode (`--no-optimize`) never called `commitForward`, so prefix hash/span memory went stale and projected savings undercounted. Plan now commits whatever body was actually forwarded in both modes (Task 6 · 3e settle).

## Contract Surface
- PASS `POST /v1/*` transparent; optimized bodies remain schema-valid Anthropic requests (stubs are plain strings inside `tool_result` content)
- PASS `GET /stats`, `GET /stats?format=jsonl`, `GET /dashboard` are new, no upstream collision
- WARN (accepted): non-streaming (`stream:false`) responses carry usage in plain JSON, not SSE — `decodeResponse` yields no `usageSplit`, ledger row records zero usage. Same limitation as v1's `inputTokens`; Claude Code always streams. Documented here, not fixed (YAGNI).

## Configuration
- **WARN→FIXED (important):** v1 listened on all interfaces; v2 adds LAN-readable usage data (`/stats`, raw ledger export). Plan now binds `127.0.0.1` by default with `HOST` env override (Task 6 · 3f).

## Domain Assumptions
- PASS all thresholds match the design doc: dedup ≥ 3 lines/40 chars, stale ≥ 512 B, request floor 2,000 est. tokens, cache-miss floor 1,024 read tokens, bust detection 0.5→0.1 hit-rate cliff, RECENT_MAX 100
- WARN (cosmetic, accepted): stub text "message N" is a 1-based index that can drift after client compaction; content-recovery is unaffected (path/tool named in the stub)

## Credential Sources
- PASS Anthropic key: client headers passthrough only; `REDACT` set (`proxy.mjs:37`) untouched; nothing stored
- PASS price registry: anonymous fetch, build-time only, never at proxy runtime

## Critical Issues (Must Fix)
1. ~~`usageSplit` destructure~~ — fixed in plan (Task 6 · 3e).

## Important Issues (Should Fix)
1. ~~Dedup across broken prefix~~ — fixed (Task 4).
2. ~~Projection-mode state commit~~ — fixed (Task 6 · 3e).
3. ~~Loopback bind~~ — fixed (Task 6 · 3f).

## Verdict: CLEAR FOR TAKEOFF (4 issues found, 4 patched into the plan pre-execution)
