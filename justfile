# agent-proxy recipes. `just` lists them; PORT/HOST pass through to the proxy.

port := env_var_or_default("PORT", "8787")

# List available recipes
default:
    @just --list

# Run the proxy (optimizations on, routing in shadow mode)
run:
    node proxy.mjs

# Run in observe-only mode (measure without changing any traffic)
observe:
    node proxy.mjs --no-optimize

# Run with routing applied (model routing decisions take effect)
route:
    node proxy.mjs --route

# Run with routing applied but optimizations off
route-only:
    node proxy.mjs --route --no-optimize

# Launch Claude Code through the proxy (auto-starts it if needed)
claude *args:
    ./bin/cpx {{args}}

# Open the dashboard in the browser
dashboard:
    open "http://127.0.0.1:{{port}}/dashboard"

# Run the unit tests
test:
    node --test "test/*.test.mjs"

# Smoke-test a running proxy (forwarding + stats endpoint)
smoke:
    ./test-local.sh "http://127.0.0.1:{{port}}"

# Refresh the model price table
prices:
    node scripts/refresh-prices.mjs
