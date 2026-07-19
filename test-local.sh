#!/usr/bin/env bash
# test-local.sh — smoke test: proxy up + forwarding to upstream.
set -e
BASE="${1:-http://localhost:8787}"
echo "--- passthrough (expect Anthropic auth error JSON, proving forwarding works)"
curl -sS -X POST "$BASE/v1/messages" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'
echo
echo "--- stats endpoint (added in Task 6; 'not found' is OK before then)"
curl -sS "$BASE/stats" | head -c 300
echo
echo "SMOKE OK"
