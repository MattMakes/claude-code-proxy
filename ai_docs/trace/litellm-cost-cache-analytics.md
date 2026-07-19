# LiteLLM — Cost Tracking, Sessions & Prompt-Cache Analytics

> LiteLLM prices every response from a 2,968-entry JSON pricing registry (per-token rates plus discounted cache-read / marked-up cache-write rates, tiered and service-tier variants), zeroes cost on its own response-cache hits, and pipes the resulting `response_cost` through `_ProxyDBLogger` into a per-request `LiteLLM_SpendLogs` row (keyed by `request_id`, grouped by `session_id`) plus per-day aggregate tables per user/team/org/end-user/agent/tag, with pre-call budget enforcement against Redis-first spend counters.

**Entry points:**
- `litellm/cost_calculator.py:296` (`cost_per_token`), `:1108` (`completion_cost`), `:1708` (`response_cost_calculator`)
- `litellm/litellm_core_utils/llm_cost_calc/utils.py:678` (`generic_cost_per_token` — the core formula)
- `litellm/proxy/hooks/proxy_track_cost_callback.py:46` (`_ProxyDBLogger`), registered at `litellm/proxy/proxy_server.py:2086-2087`
- `litellm/proxy/spend_tracking/spend_tracking_utils.py:238` (`get_logging_payload` → SpendLogs row)
- `litellm/caching/caching.py:329` (`Cache.get_cache_key`)
- `litellm/proxy/auth/auth_checks.py:488` (`common_checks` — pre-call budget gates)

**Last traced:** 2026-07-19 (repo: /Users/mascott/projects/proxy/research/litellm)

---

## Cost calculation (formulas, pricing registry schema)

### Call flow

1. Logging object computes cost per request: `Logging._response_cost_calculator` (`litellm/litellm_core_utils/litellm_logging.py:1374-1466`). If `cache_hit is True` it returns `0.0` immediately (`litellm_logging.py:1387-1388`); if the provider already put `response_cost` in `_hidden_params` that wins (`litellm_logging.py:1394-1399`); otherwise it calls `litellm.response_cost_calculator(...)` (`litellm_logging.py:1453`).
2. `response_cost_calculator` (`cost_calculator.py:1708-1793`): `cache_hit=True → response_cost = 0.0` (`cost_calculator.py:1765-1766`), else delegates to `completion_cost` (`cost_calculator.py:1775`).
3. `completion_cost` (`cost_calculator.py:1108`) extracts usage from the response: `prompt_tokens`, `completion_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and — if present — `prompt_tokens_details.cached_tokens` overrides `cache_read_input_tokens` (`cost_calculator.py:1274-1284`). It resolves the model name via `_select_model_name_for_cost_calc` (`cost_calculator.py:1212-1219`), then calls `cost_per_token`.
4. `cost_per_token` (`cost_calculator.py:296-693`) dispatches:
   - custom per-deployment pricing first (`cost_calculator.py:406-417`, helper at `:180-228`)
   - special call types: speech (`:484`), rerank (`:530`), vector-store search (`:536`), OCR (`:542`), batch (`:548`), transcription (`:560`), search (`:574`)
   - provider-specific token calculators: vertex_ai `:584`, anthropic `:605-606`, bedrock `:607-608`, openai `:609-615`, databricks `:616`, fireworks `:618`, azure `:620`, gemini `:627-628`, deepseek/tencent/perplexity/xai/lemonade/dashscope/azure_ai `:629-652`
   - generic fallback: `generic_cost_per_token` if the model has `input_cost_per_token`/`output_cost_per_token` > 0 (`cost_calculator.py:653-663`), else per-second pricing `input_cost_per_second * response_time_ms / 1000` (`cost_calculator.py:665-693`).

Model-key lookup in the registry tries, in order: `provider/region/model`, `provider/model`, `model`, `model-without-prefix` (`cost_calculator.py:453-481`).

### Pricing registry: `model_prices_and_context_window.json` (repo root; 2,968 entries; documented by the `sample_spec` entry)

Per-model cost fields (all USD per unit):

| Field | Meaning |
|---|---|
| `input_cost_per_token` / `output_cost_per_token` | base prompt/completion token rates |
| `cache_read_input_token_cost` | discounted rate for prompt-cache **read** tokens |
| `cache_creation_input_token_cost` | rate for prompt-cache **write** (5-minute TTL) tokens |
| `cache_creation_input_token_cost_above_1hr` | rate for 1-hour-TTL cache-write tokens (Anthropic) |
| `input_cost_per_token_above_{X}k_tokens` (and `_above_{X}_tokens`) | tiered price when `prompt_tokens > X*1000` — matching `output_…`, `cache_read_…`, `cache_creation_…` tiered variants exist (parsed at `llm_cost_calc/utils.py:196-198`, applied `:236-349`) |
| `input_cost_per_token_flex` / `_priority` / `_batches` | OpenAI service-tier variants; key selection in `_get_service_tier_cost_key` (`llm_cost_calc/utils.py:174-193`), fallback to base key at `:393-412` |
| `input_cost_per_second` / `output_cost_per_second` | duration pricing (audio, sagemaker etc.) |
| `input_cost_per_audio_token`, `input_cost_per_image_token`, `input_cost_per_video_token`, `input_cost_per_character`, `input_cost_per_image`, `input_cost_per_video_per_second`, `input_cost_per_audio_per_second` | modality-specific input adders (`llm_cost_calc/utils.py:581-642`) |
| `output_cost_per_reasoning_token`, `output_cost_per_audio_token`, `output_cost_per_image_token`, `output_cost_per_video_token` | modality-specific output rates (`llm_cost_calc/utils.py:799-829`) |
| `regional_processing_uplift_multiplier_{eu,us}` | flat multiplier on all token costs for regionalized OpenAI hosts (`llm_cost_calc/utils.py:647-675`, applied `:831-837`) |
| `search_context_cost_per_query` | web-search per-query pricing (low/medium/high) |
| non-cost metadata | `litellm_provider`, `mode`, `max_tokens` / `max_input_tokens` / `max_output_tokens`, `supports_prompt_caching`, `supports_reasoning`, `deprecation_date`, etc. |

Concrete example (`claude-sonnet-4-5`): input `3e-06`, output `1.5e-05`, cache read `3e-07` (10% of input), cache write 5m `3.75e-06` (1.25×), cache write 1h `6e-06` (2×), plus `_above_200k_tokens` variants doubling each rate. `gpt-5.1`: input `1.25e-06`, cache read `1.25e-07` (10%), with `_priority` variants at 2×.

### The core formula — `generic_cost_per_token` (`llm_cost_calc/utils.py:678-839`)

Token buckets come from `usage.prompt_tokens_details` via `_parse_prompt_tokens_details` (`utils.py:455-513`). Double-count guard: if `text_tokens + cached + audio + cache_creation + image + video > prompt_tokens` (or text_tokens unset), recompute `text_tokens = prompt_tokens - cache_hit - audio - cache_creation - image - video`, clamped at 0 (`utils.py:735-744`).

Rates resolve via `_get_token_base_cost` (`utils.py:201-357`), which returns `(prompt_base, completion_base, cache_creation, cache_creation_above_1hr, cache_read)` after applying service-tier keys and token-threshold tiering.

**Input cost** (`_calculate_input_cost`, `utils.py:564-644`):

```
prompt_cost = text_tokens            * input_cost_per_token          (utils.py:576)
            + cache_hit_tokens       * cache_read_input_token_cost   (utils.py:579)
            + cache_write_cost                                        (utils.py:602-612)
            + audio/image/video/character/image-count/length adders   (utils.py:581-642)
```

**Cache-write cost** (`calculate_cache_writing_cost`, `utils.py:417-438`):

```
if cache_creation_token_details present (Anthropic ephemeral buckets):
    cost = ephemeral_5m_input_tokens * cache_creation_input_token_cost
         + ephemeral_1h_input_tokens * cache_creation_input_token_cost_above_1hr
else:
    cost = cache_creation_tokens * cache_creation_input_token_cost
```

**Output cost** (`utils.py:764-829`):

```
completion_cost = text_tokens * output_cost_per_token
                + reasoning_tokens * (output_cost_per_reasoning_token or output rate)
                + audio/image/video tokens at their own rates (fallback = output rate)
```
`text_tokens` defaults to `completion_tokens` when no breakdown exists; with a breakdown it's the remainder `completion_tokens - reasoning - audio - image - video` (`utils.py:779-795`).

Finally both sides are multiplied by the regional uplift when `data_residency` matches a configured multiplier (`utils.py:831-837`).

**Custom (per-deployment) pricing** (`_cost_per_token_custom_pricing_helper`, `cost_calculator.py:180-228`): `regular = max(prompt_tokens - cached - cache_creation, 0)`; `input_cost = regular*input_rate + cached*cache_read_rate + cache_creation*cache_creation_rate` (cache rates default to `input_cost_per_token` when unset — `cost_calculator.py:203-210`); `output_cost = completion_tokens * output_rate`; or `custom_cost_per_second * response_time_ms / 1000` (`:224-226`).

**Anthropic wrapper** (`litellm/llms/anthropic/cost_calculation.py:59-101`): delegates to `generic_cost_per_token`, then applies geo/speed multipliers from `provider_specific_entry` to non-cache costs only: `prompt_cost = (prompt_cost - cache_cost)*multiplier + cache_cost` (`:94-97`, cache-only cost at `:23-56`). OpenAI's calculator is a thin passthrough to `generic_cost_per_token` (`litellm/llms/openai/cost_calculation.py:21-47`).

---

## Prompt-cache token accounting

### Provider field normalization

Two shapes exist and `cost_per_token` normalizes them (`cost_calculator.py:363-404`):

- **OpenAI-compatible**: `usage.prompt_tokens_details.cached_tokens`; `prompt_tokens` **already includes** cached tokens. Cache-write variants: `prompt_tokens_details.cache_write_tokens` (kimi-k2) or `.cache_creation_tokens` (`cost_calculator.py:377-382`).
- **Anthropic**: top-level `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`; `prompt_tokens` (= `input_tokens`) **excludes** cache tokens, so LiteLLM adds them: `_normalized_prompt_tokens += cache_read + cache_creation` (`cost_calculator.py:400-404`).

The `Usage` constructor mirrors Anthropic fields onto the OpenAI shape: `cache_read_input_tokens` → `prompt_tokens_details.cached_tokens` (`litellm/types/utils.py:1622-1626`) and onto private attrs `_cache_read_input_tokens` / `_cache_creation_input_tokens` (`types/utils.py:1543,1661-1666`), so `generic_cost_per_token` only ever reads `prompt_tokens_details`.

### Exact discount math

- Cache read: `cache_hit_tokens * cache_read_input_token_cost` instead of the full input rate (`llm_cost_calc/utils.py:579`). For Anthropic/OpenAI flagship models this is a 90% discount (see registry examples above).
- Cache write: `cache_creation_tokens * cache_creation_input_token_cost` (5m) / `..._above_1hr` (1h) — a **premium** over the input rate (`llm_cost_calc/utils.py:417-438`).
- Both cache rates participate in `_above_{X}k_tokens` tiering and `_flex`/`_priority` service tiers (`llm_cost_calc/utils.py:216-217,296-343`).

A provider-agnostic per-request breakdown (`reasoning_cost`, `cache_read_cost`, `cache_creation_cost`) is computed by `get_token_type_cost_breakdown` (`llm_cost_calc/utils.py:853-940`) and lands in SpendLogs metadata as `cost_breakdown` (`spend_tracking_utils.py:361-363`).

**Dollar savings from prompt caching** are computed per request for the Cost Optimization dashboard: `prompt_caching_savings = max(cache_read_tokens,0) * max(input_cost_per_token - cache_read_input_token_cost, 0)` (`litellm/proxy/spend_tracking/savings.py:47-63`), summed into the `prompt_caching_savings_spend` column of every daily spend table (`db_spend_update_writer.py:1857-1884`).

### Where cache hit rate can be derived

- **Per request**: SpendLogs `metadata.additional_usage_values.cache_read_input_tokens` (backfilled from `prompt_tokens_details.cached_tokens` at `spend_tracking_utils.py:377-383`) vs `prompt_tokens` column.
- **Per day / entity**: daily tables store `cache_read_input_tokens` and `cache_creation_input_tokens` alongside `prompt_tokens` (`schema.prisma:737-738` et al.); extraction handles both provider shapes (`db_spend_update_writer.py:75-98`). Hit rate = `cache_read_input_tokens / prompt_tokens`.
- **Prometheus**: `litellm_provider_cache_read_input_tokens_metric / litellm_input_tokens_metric`.

### Prometheus metrics (`litellm/integrations/prometheus.py`)

| Metric | Meaning | Defined |
|---|---|---|
| `litellm_cache_hits_metric` | LiteLLM response-cache hits (count) | `prometheus.py:509-513` |
| `litellm_cache_misses_metric` | LiteLLM response-cache misses | `prometheus.py:515-519` |
| `litellm_cached_tokens_metric` | total tokens served from LiteLLM cache | `prometheus.py:521-525` |
| `litellm_provider_cache_read_input_tokens_metric` | provider prompt-cache read tokens | `prometheus.py:528-532` |
| `litellm_provider_cache_creation_input_tokens_metric` | provider prompt-cache write tokens | `prometheus.py:534-537` |
| `litellm_input_cached_tokens_metric` / `litellm_input_cache_creation_tokens_metric` | token-type detail counters from `usage_object` | `prometheus.py:212-221` |

Increment logic `_increment_cache_metrics` (`prometheus.py:1549-1640`): `cache_hit=True` → hits + cached_tokens(total_tokens); `False` → misses; `None` → neither (only requests that went through the LiteLLM cache count). Provider prompt-cache counters are incremented independently from `metadata.usage_object` (`cache_read_input_tokens`, falling back to `prompt_tokens_details.cached_tokens` only when the explicit field is absent — `prometheus.py:1600-1620`).

---

## Response cache (LiteLLM's own caching, `litellm/caching/`)

### Key computation (`Cache.get_cache_key`, `caching.py:329-379`)

1. If `litellm_params.preset_cache_key` was already computed, return it (`caching.py:432-444`).
2. Otherwise concatenate `"{param}: {value}"` for every kwarg that is a known LLM API param (`ModelParamHelper._get_all_llm_api_params()`); non-litellm provider-specific params are included only behind `litellm.enable_caching_on_provider_specific_optional_params` (`caching.py:347-363`). The `model` value is replaced by caching-group or router `model_group` when present, so caching works across deployments (`caching.py:395-416`); `file` uses checksum/name (`caching.py:418-430`).
3. SHA-256 hex of the concatenation (`Cache._get_hashed_cache_key`, `caching.py:458-475`), then optional namespace prefix `"{namespace}:{hash}"` from dynamic cache-control, `metadata.redis_namespace`, or the configured namespace (`caching.py:477-494`). The result is memoized into `litellm_params.preset_cache_key` (`caching.py:446-456`).
4. **Semantic caches** exclude `messages`/`prompt`/`input` from the scope key (matching is by vector similarity) and instead append a tenant scope built from `user_api_key`, `user_api_key_team_id`, `user_api_key_org_id` (`caching.py:294-327,349-366`).

### Backends (`caching.py:170-265`)

`redis` (`RedisCache`), `redis` cluster (`RedisClusterCache`), `redis-semantic` (**redisvl** `SemanticCache` + `CustomTextVectorizer`, `redis_semantic_cache.py:129-130`), `valkey-semantic`, `qdrant-semantic`, `local` in-memory, `s3`, `gcs`, `azure-blob`, `disk`. Semantic hit criterion: `distance_threshold = 1 - similarity_threshold` (`redis_semantic_cache.py:86`); a returned entry's `similarity = 1 - vector_distance` must satisfy the threshold (`redis_semantic_cache.py:449-463,593-607`).

### What counts as a hit & `cache_hit` propagation

`LLMCachingHandler._async_get_cache` / sync path (`caching/caching_handler.py:188-370`): on a non-None cached value it sets `cache_hit = True` (`caching_handler.py:211,336`), stamps `cached_result._hidden_params["cache_hit"] = True` and `["cache_key"]` (`caching_handler.py:255-256,893-898`), sets `logging_obj.caching_details = CachingDetails(cache_hit=True, ...)` (`caching_handler.py:1175-1177`), and fires success callbacks with `cache_hit=True` (`_async_log_cache_hit_on_callbacks`, `caching_handler.py:642-676`) — that's what lands in `kwargs["cache_hit"]` / `model_call_details["cache_hit"]` (`litellm_logging.py:1826`) and eventually `standard_logging_payload["cache_hit"]`.

### Cost of a hit — $0, enforced three times

1. `Logging._response_cost_calculator`: `cache_hit is True → return 0.0` (`litellm_logging.py:1387-1388`).
2. `response_cost_calculator`: same guard (`cost_calculator.py:1765-1766`).
3. Proxy spend callback re-zeroes defensively: `if kwargs.get("cache_hit") is True: response_cost = 0.0` (`proxy_track_cost_callback.py:224-226`).

A cache-hit request still writes a SpendLogs row (spend=0) with `cache_hit="True"`, the computed `cache_key`, and a de-duplicated id `f"{id}_cache_hit{time.time()}"` (`spend_tracking_utils.py:385-392`; same pattern in `litellm_logging.py:5283-5284`).

---

## Spend tracking pipeline (request → SpendLogs row)

1. **Registration**: `_ProxyDBLogger()` added as a LiteLLM callback + async success callback at proxy startup (`proxy_server.py:2086-2087`).
2. **Success path**: `async_log_success_event → _PROXY_track_cost_callback` (`proxy_track_cost_callback.py:47-48,179-323`). It reads `response_cost` from `kwargs["standard_logging_object"]["response_cost"]` (fallback `kwargs["response_cost"]`) (`:213-216`), zeroes it on cache hit (`:224-226`), resolves tags (`_get_request_tags_for_cost_tracking`, `:460-473`), and — unless spend updates are disabled or there is no key/user/team/end-user to attribute (pass-through routes exempt; `_should_track_cost_callback`, `:421-443`) — runs:
   - `db_spend_update_writer.update_database(...)` (`:493-504`)
   - `increment_spend_counters(...)` for Redis budget counters (`:520-529`)
   - fire-and-forget `update_cache(...)` (cached-object spend fields, soft-budget alerts) (`:259-269`) and `customer_spend_alert` (`:271-277`).
   Missing cost for a model raises the "Cost tracking failed … add custom pricing" alert (`:294-307`).
3. **`update_database`** (`litellm/proxy/db/db_spend_update_writer.py:124-224`): builds the row via `get_logging_payload`, overwrites `payload["spend"] = response_cost or 0.0` (`:168`), appends it to `prisma_client.spend_log_transactions` (batched writer; `_insert_spend_log_to_db`, `:715-731`) unless `disable_spend_logs`, then a single `_batch_database_updates` task increments key/user/team/org/end-user `spend` columns and enqueues the six daily-table transactions.
4. **Failure path**: `async_post_call_failure_hook` (`proxy_track_cost_callback.py:50-177`) writes a `status="failure"` row with sanitized `error_information` in metadata, and attributes recovered partial cost of a broken stream when `combined_usage_object` is present (`:157-168`).

### `LiteLLM_SpendLogs` schema (`litellm/proxy/schema.prisma:598-635`)

| Column | Type | Populated from (`spend_tracking_utils.py:238-448`) |
|---|---|---|
| `request_id` | String @id | response id (or call id); `_cache_hit{ts}` suffix on cache hits (`:280,389-392`) |
| `call_type` | String | `kwargs["call_type"]` (`:250,408`) |
| `api_key` | String | hashed virtual key (`:285-295,409`) |
| `spend` | Float | `kwargs["response_cost"]` (`:420`), overwritten by `update_database` (`db_spend_update_writer.py:168`) |
| `total_tokens` / `prompt_tokens` / `completion_tokens` | Int | usage object, fallback standard_logging_payload (`:421-423`) |
| `startTime` / `endTime` / `completionStartTime` | DateTime | UTC-normalized (`:411-413`) |
| `request_duration_ms` | Int? | `end - start` ms (`:444,489-494`) |
| `model` / `model_id` / `model_group` / `custom_llm_provider` / `api_base` | String | reconstructed model name, router model info (`:310-311,401-403,414,426-428,432`) |
| `user` / `team_id` / `organization_id` / `end_user` | String? | key metadata + `get_end_user_id_for_cost_tracking` (`:283,415-417,425`) |
| `metadata` | Json | cleaned metadata incl. `usage_object`, `additional_usage_values` (with `cache_read_input_tokens`), `cost_breakdown`, guardrails, `error_information` (`:320-383,418`) |
| `cache_hit` | String? | `str(kwargs["cache_hit"])` (`:251,410`) |
| `cache_key` | String? | `litellm.cache.get_cache_key(**kwargs)` or `"Cache OFF"` (`:385-388,419`) |
| `request_tags` | Json | `standard_logging_payload["request_tags"]` or metadata tags (`:304-308,424`) |
| `requester_ip_address` | String? | metadata (`:431`) |
| `messages` / `response` / `proxy_server_request` | Json? | opt-in prompt/response storage (`:433-439`) |
| `session_id` | String? (indexed, `schema.prisma:634`) | `_get_session_id_for_spend_log` (`:440-443,466-486`) |
| `status` | String? | success/failure (`:445-447`) |
| `mcp_namespaced_tool_name` / `agent_id` | String? | MCP/A2A attribution (`:394-400,429-430`) |

---

## Sessions (session_id grouping, per-session cost)

- **Column source**: `_get_session_id_for_spend_log` (`spend_tracking_utils.py:466-486`) — priority: `standard_logging_payload["trace_id"]` → `kwargs["litellm_trace_id"]` → random `uuid4()` (every row always has a session id).
- **`trace_id`** is set by `StandardLoggingPayloadSetup._get_standard_logging_payload_trace_id` (`litellm_logging.py:5029-5055`): `litellm_params.litellm_session_id` (recommended) → `litellm_params.litellm_trace_id` → `metadata.session_id` / `metadata.trace_id` → `logging_obj.litellm_trace_id` (auto-uuid per request, `litellm_logging.py:349`). So passing `litellm_session_id` on N requests groups their N SpendLogs rows under one `session_id`.
- **Header ingestion** (`litellm/proxy/litellm_pre_call_utils.py`): `get_chain_id_from_headers` (`:403-427`) accepts `x-litellm-trace-id` > `x-litellm-session-id` > any `x-<vendor>-session-id` (e.g. `x-claude-code-session-id`); the value is written to both `data["litellm_session_id"]` and `data["litellm_trace_id"]` (`:955-961`). Fallback: Anthropic body `metadata.user_id` with a `_session_<id>` marker (`:429-451,963-968`).
- **Per-session cost**: no SQL SUM endpoint; the UI sums rows. `GET /spend/logs/session/ui?session_id=...` returns paginated SpendLogs rows `WHERE session_id = $1` (`spend_management_endpoints.py:3243-3313`), and `/spend/logs/ui` + `/spend/logs/v2` support a partial-match `session_id` filter and per-request session counts (`spend_management_endpoints.py:1625-1627,1913-1916,2032`).
- **Per-session budget**: `_PROXY_MaxBudgetPerSessionHandler` (`litellm/proxy/hooks/max_budget_per_session_limiter.py:57+`) accumulates response cost per `session_id` in Redis (`{session_budget:<session_id>}:spend`, atomic Lua INCRBYFLOAT with TTL, `:39-54`) and 429s once `max_budget_per_session` (agent litellm_params) is exceeded.

---

## Aggregation & budgets

### Daily aggregate tables (`schema.prisma`)

Six structurally identical tables, one row per `(entity, date, api_key, model, custom_llm_provider, mcp_namespaced_tool_name, endpoint)`:
`LiteLLM_DailyUserSpend` (`:725`), `LiteLLM_DailyOrganizationSpend` (`:759`), `LiteLLM_DailyEndUserSpend` (`:793`), `LiteLLM_DailyAgentSpend` (`:826`), `LiteLLM_DailyTeamSpend` (`:859`), `LiteLLM_DailyTagSpend` (`:893`). Shared columns: `prompt_tokens`, `completion_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `compression_saved_tokens`, `compression_savings_spend`, `prompt_caching_savings_spend`, `spend`, `api_requests`, `successful_requests`, `failed_requests` (e.g. `schema.prisma:735-745`).

Rows are built from each SpendLogs payload by `_common_add_spend_log_transaction_to_daily_transaction` (`db_spend_update_writer.py:1795-1888`) — cache tokens extracted from `metadata.usage_object` by `_extract_cache_read_tokens` / `_extract_cache_creation_tokens` (`db_spend_update_writer.py:75-98`), savings computed via `compute_savings_spend` — and queued per entity (`:1890-2031`). **Tags fan out**: one transaction per tag in `request_tags` (`db_spend_update_writer.py:2033-2065`). Upserts increment counters in Prisma (`db_spend_update_writer.py:1553-1606`).

### Aggregation endpoints (`litellm/proxy/spend_tracking/spend_management_endpoints.py`)

Per-key `/spend/keys` (`:52`), per-user `/spend/users` (`:114`), per-tag `/spend/tags` (`:189`) and `/global/spend/tags` (`:1299`) + `/global/spend/all_tag_names` (`:1247`), activity rollups `/global/activity` (`:289`) / `/global/activity/model` (`:428`) / exceptions (`:579,724`), per-provider `/global/spend/provider` (`:830`), grouped report `/global/spend/report?group_by=team|customer|api_key` (`:958`), cost preview `/spend/calculate` (`:1439`), raw logs `/spend/logs` (`:2207`), `/spend/logs/v2` (`:1595`), `/spend/logs/ui` (`:1603`), single row `/spend/logs/ui/{request_id}` (`:2124`), totals `/global/spend` (`:2676`), top keys/teams/end-users/models `/global/spend/keys|teams|end_users|models` (`:2768,2814,2935,3017`), reset/refresh (`:2435,2470`), `/global/spend/logs` (`:2587`), session view `/spend/logs/session/ui` (`:3243`). Daily-table-backed dashboards: `/user/daily/activity` (`internal_user_endpoints.py:2452`) and `/user/daily/activity/aggregated` (`:2561`), plus `/team/daily/activity` and `/tag/daily/activity` routes (`litellm/proxy/_types.py:263,714,749`).

### Budget enforcement (pre-call)

All checks run inside `common_checks` during auth (`litellm/proxy/auth/auth_checks.py:488+`), reading spend from Redis-first cross-pod counters via `get_current_spend` (`proxy_server.py:2118-2170`; counter keys `spend:key:{hash}`, `spend:user:{id}`, `spend:team:{id}`, per-window `...:window:{duration}`), which are incremented post-call by `increment_spend_counters` (`proxy_server.py:2326+`, awaited by the cost callback so the next auth sees it — `proxy_track_cost_callback.py:520`):

- **Virtual key**: `_virtual_key_max_budget_check` — raises `BudgetExceededError` when `spend >= max_budget` (NaN-safe) (`auth_checks.py:3494-3566`); multi-window budgets `_virtual_key_multi_budget_check` (`:3569-3600`).
- **User**: `_user_max_budget_check` (`:633-658`); also enforced by the `_PROXY_MaxBudgetLimiter` pre-call hook for personal (non-team) budgets (`litellm/proxy/hooks/max_budget_limiter.py:13-60`).
- **Team / org / tag / team-member / soft budgets**: concurrent checks (`auth_checks.py:665-700`).
- **End user (customer)**: budget from `litellm_budget_table.max_budget` (`auth_checks.py:1078-1102`).
- **Project**: `_project_max_budget_check` / soft check (`auth_checks.py:307-318`).
- **Global proxy**: `litellm.max_budget` vs `global_proxy_spend` (`auth_checks.py:354-370`).
- **Reservations**: budget headroom can be reserved pre-call and released/invalidated on failure (`litellm/proxy/spend_tracking/budget_reservation.py`; release paths at `proxy_track_cost_callback.py:58-68,278-281,506-540`).

### Tag-based spend tracking

Request tags (from request metadata, key metadata, or auto user-agent tags — `litellm_logging.py:5057+`) land in `standard_logging_payload["request_tags"]` and the SpendLogs `request_tags` column (`spend_tracking_utils.py:304-308`), fan out into `LiteLLM_DailyTagSpend` per tag (`db_spend_update_writer.py:2058-2065`), feed Redis tag spend counters (`proxy_track_cost_callback.py:217-220,528`), tag budgets (`_tag_max_budget_check`, `auth_checks.py:687-692`), and the `/spend/tags` + `/global/spend/tags` endpoints.

---

## Code References

- `litellm/cost_calculator.py:180-228` — custom-pricing cost formula (cache-aware)
- `litellm/cost_calculator.py:296-693` — `cost_per_token` dispatch + Anthropic/OpenAI cache-token normalization (`:363-404`)
- `litellm/cost_calculator.py:1108-1706` — `completion_cost` (usage extraction `:1274-1284`)
- `litellm/cost_calculator.py:1708-1793` — `response_cost_calculator`; cache hit → $0 (`:1765-1766`)
- `litellm/litellm_core_utils/llm_cost_calc/utils.py:174-357` — service-tier keys + tiered `_above_Xk` pricing
- `litellm/litellm_core_utils/llm_cost_calc/utils.py:417-438` — cache-write (5m/1h) cost
- `litellm/litellm_core_utils/llm_cost_calc/utils.py:564-644` — input-cost formula (cache read at `:579`)
- `litellm/litellm_core_utils/llm_cost_calc/utils.py:678-839` — `generic_cost_per_token`
- `litellm/litellm_core_utils/llm_cost_calc/utils.py:853-940` — per-token-type cost breakdown
- `litellm/llms/anthropic/cost_calculation.py:23-101` — Anthropic wrapper, cache-exempt multipliers
- `litellm/llms/openai/cost_calculation.py:21-47` — OpenAI passthrough
- `model_prices_and_context_window.json` (repo root) — pricing registry (schema in `sample_spec`)
- `litellm/types/utils.py:1543,1622-1666` — Usage mirrors cache tokens onto `prompt_tokens_details.cached_tokens`
- `litellm/integrations/prometheus.py:212-221,509-537,1549-1640` — cache metrics & increment logic
- `litellm/caching/caching.py:294-494` — cache-key computation, backends (`:170-265`)
- `litellm/caching/redis_semantic_cache.py:86,129,449-463` — redisvl semantic cache, similarity threshold
- `litellm/caching/caching_handler.py:188-370,642-676,893-898,1119-1177` — hit detection & `cache_hit` propagation
- `litellm/litellm_core_utils/litellm_logging.py:1374-1466,1826,5029-5055,5283-5284` — response-cost calc, cache_hit, trace_id
- `litellm/proxy/hooks/proxy_track_cost_callback.py` — `_ProxyDBLogger` (success `:179-323`, failure `:50-177`)
- `litellm/proxy/db/db_spend_update_writer.py:75-98,124-224,715-731,1795-2065` — SpendLogs insert + daily transactions
- `litellm/proxy/spend_tracking/spend_tracking_utils.py:238-486` — `get_logging_payload`, `_get_session_id_for_spend_log`
- `litellm/proxy/spend_tracking/savings.py:22-63` — prompt-caching dollar savings
- `litellm/proxy/spend_tracking/spend_management_endpoints.py` — all `/spend/*` + `/global/spend/*` endpoints (session view `:3243-3313`)
- `litellm/proxy/schema.prisma:598-635` (SpendLogs), `:725-925` (daily tables)
- `litellm/proxy/auth/auth_checks.py:307-370,633-700,1078-1102,3494-3600` — budget enforcement
- `litellm/proxy/proxy_server.py:2086-2087,2118-2170,2326+` — logger registration, spend counters
- `litellm/proxy/hooks/max_budget_limiter.py:13-60`, `max_budget_per_session_limiter.py:39-80` — pre-call budget hooks
- `litellm/proxy/litellm_pre_call_utils.py:403-451,955-968` — session-id header/body extraction
