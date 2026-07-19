# LiteLLM — Model Routing (incl. content/complexity-based)

> LiteLLM's Router picks a deployment in two phases — a **pre-routing hook** that can rewrite the requested model based on prompt *content* (semantic auto-router, heuristic/LLM complexity router, bandit adaptive router, quality router), then a **load-balancing strategy** (shuffle / least-busy / lowest-cost / lowest-latency / lowest-TPM) over the healthy deployments of that model group, wrapped in retries, cooldowns, and fallback chains (including context-window fallbacks that re-route oversized prompts to bigger models).

**Entry point:** `litellm/router.py:10643` (`Router.async_get_available_deployment`; sync twin at `router.py:11043`; `Router` class at `router.py:278`) | **Last traced:** 2026-07-19

Repo snapshot: `bd44c9e` (2026-07-18). Note: this checkout is a fork/branch of BerriAI/litellm with extra strategies not in upstream OSS (complexity/adaptive/quality routers, routing groups, routing plugins, lar1, weighted failover). Library traced: `aurelio-labs/semantic-router` @ `059dba2` (2026-07-15).

---

## Router request flow (step-by-step, plain English)

Every routed call (e.g. `Router.acompletion` → `_acompletion`, `router.py:2755`) asks `async_get_available_deployment(model, request_kwargs, messages, ...)` for one deployment dict:

1. **Async-strategy gate** (`router.py:10656-10669`). Only `usage-based-routing-v2`, `simple-shuffle`, `cost-based-routing`, `latency-based-routing`, `least-busy` have async-native selection; anything else delegates to the sync `get_available_deployment` (`router.py:11043`).
2. **Pre-routing hook** (`router.py:10677-10686` → `async_pre_routing_hook`, `router.py:10992-11041`). This is where *content-based* routing happens, BEFORE load balancing:
   - Runs the **routing-plugin pipeline** if `Router(plugins=[...])` is set (`_run_routing_plugins`, `router.py:10893-10931`): each plugin receives a `RoutingContext` (raw + structured messages, candidate models, metadata) and may narrow `candidate_models` and attach signals. The narrowed pool is enforced later by `_filter_by_routing_plugin_candidates` (`router.py:10933-10961`), which **fails closed** (raises) if plugins narrowed to zero.
   - `_select_pre_routing_strategy` (`router.py:10963-10990`) looks up the requested model name in four registries — `self.auto_routers`, `self.complexity_routers`, `self.adaptive_routers`, `self.quality_routers` (`router.py:501-504`) — disambiguating multiple entries per name by request tags, then `"default"`-tagged, then first. If one matches, its `async_pre_routing_hook` runs and may **replace `model` entirely** (e.g. `"auto-router1"` → `"claude-sonnet-4"`). The alias deployment's own `litellm_params` are merged into the request as defaults (`router.py:11033-11039`).
3. **Resolve routing strategy + selector** (`_get_routing_context`, `router.py:1058-1095`), keyed off the (possibly rewritten) model: per-request `routing_strategy` override (forwarded from key/team `router_settings`; only overridable strategies, `router.py:1012-1035`) > the model's `routing_groups` entry (`_init_routing_groups`, `router.py:940-1008`, per-group selector state) > router-level `routing_strategy` (default `"simple-shuffle"`, `router.py:335-344`).
4. **Build the healthy-deployment pool** (`async_get_healthy_deployments`, `router.py:10507-10641`):
   - `_common_checks_available_deployment` (`router.py:10330-10451`): specific-deployment / model-id passthrough (`10355-10364`), **model_group_alias** resolution (`_get_model_from_alias`, `10238-10255`), team-scoped model names, wildcard **pattern router** (`10307-10319`), default deployment, then all deployments for the model name plus **model-access-group filtering** (`10453-10505`) and `litellm.model_alias_map` (`10446-10449`). Falls back to the first `default_fallbacks` model if the name resolves to nothing (`10415-10434`).
   - Filters, in order: team-based models (`10535`), web-search-capable (`10543`), health-check-unhealthy (`10561`), **cooldown** deployments (`10566-10583`), blocked deployments (`10585`), **callback filters** (`async_callback_filter_deployments`, `router.py:7330` — runs every registered `CustomLogger.async_filter_deployments`, i.e. the `router_utils/pre_call_checks/` classes and the budget limiter), **`_pre_call_checks`** (context-window/RPM/region/param filtering, `router.py:10064`, gated by `enable_pre_call_checks`), **tag-based routing** (`get_deployments_for_tag`, `10604`), **routing-plugin narrowing** (`10613`), `order` filtering (lowest order level wins, `10618-10622`), and weighted-failover exclusions (`10624-10631`). Empty pool → `RouterRateLimitError`/no-deployment exception (`10633-10639`).
5. **Pick one deployment**: `simple-shuffle` is handled inline (`router.py:10710-10715`); every other strategy goes through `_select_deployment_async` (`router.py:1097-1148`) which calls the selector's `async_get_available_deployments(...)` (sync twin `_select_deployment_sync`, `1150-1193`; cost-based is async-only).
6. **Post-selection concurrency-safe RPM check**: callers then run `async_routing_strategy_pre_call_checks` (`router.py:7269`) inside the client semaphore; for usage-based-routing-v2 this atomically increments the deployment's RPM counter and raises `RateLimitError` if over limit (`lowest_tpm_rpm_v2.py:141-225`), putting the deployment in cooldown (`router.py:7305`).

The whole call is wrapped in `async_function_with_fallbacks` → `async_function_with_retries` (see Reliability layer).

---

## Routing strategies

### simple-shuffle (default)
- **Algorithm** (`litellm/router_strategy/simple_shuffle.py:21-69`): if the first deployment defines `weight`, else `rpm`, else `tpm` in `litellm_params`, do a weighted random pick proportional to that value across deployments (`:43-65`); otherwise uniform `random.choice` (`:68`).
- **State**: none.
- **Defaults**: router default strategy (`router.py:344`).

### least-busy
- **Algorithm** (`litellm/router_strategy/least_busy.py`): maintain an in-flight request counter per deployment; pick the deployment with the minimum counter (`_get_available_deployments`, `:160-188`; unseen deployments count as 0; falls back to random).
- **State**: dict `{deployment_id: in_flight}` under cache key `f"{model_group}_request_count"` in the router `DualCache` (in-memory + Redis if configured). Incremented in `log_pre_api_call` (`:24-48`, wired via `litellm.input_callback`, `router.py:862-867`), decremented on success/failure (`:50-158`).

### usage-based-routing (v1, legacy)
- **Algorithm** (`litellm/router_strategy/lowest_tpm_rpm.py`): per-model-group map `{model_group}:tpm:{precise_minute}` of `{deployment_id: tokens}`; picks lowest-TPM deployment under its tpm/rpm limits. Sync-only (`router.py:1121-1131` calls it inline even from async).
- **State**: DualCache dicts keyed by minute.

### usage-based-routing-v2 (lowest TPM/RPM, cross-instance)
- **Algorithm** (`litellm/router_strategy/lowest_tpm_rpm_v2.py:32`): for the current UTC minute, batch-read (`redis.mget`) per-deployment counters `"{id}:{model}:tpm:{HH-MM}"` and `"{id}:{model}:rpm:{HH-MM}"` (`:431-487`); token-count the incoming prompt (`token_counter`, `:397`); drop deployments where `current_tpm + input_tokens > tpm_limit` or `rpm + 1 >= rpm_limit`; among the rest pick the set with **lowest current TPM** and choose randomly among ties (`_return_potential_deployments`, `:315-368`; `random.choice`, `:427`). If none qualify, raises 429 with a per-deployment usage dump (`:493-545`).
- **State**: Redis/in-memory counters with TTL 60s (`RoutingArgs.ttl`, `:28-29`). Increments are buffered in-memory and flushed to Redis on a periodic sync task, default every 0.1s (`BaseRoutingStrategy`, `litellm/router_strategy/base_routing_strategy.py:19-95`; wired at `lowest_tpm_rpm_v2.py:53-58`). TPM incremented on success (`:268-313`); RPM incremented pre-call inside `async_pre_call_check` (`:141-225`) to be concurrency-safe.

### latency-based-routing
- **Algorithm** (`litellm/router_strategy/lowest_latency.py`): keeps up to 10 recent per-request latencies per deployment (`max_latency_list_size`, `RoutingArgs`, `:23-26`), measured as **seconds per completion token** (or per-token time-to-first-token for streaming requests, `:75-109`). Selection (`_get_available_deployments`, `:358-495`): average the list (TTFT list if the request streams), drop deployments over their tpm/rpm limits for the current minute, sort ascending, then pick randomly among all deployments within `lowest + lowest_latency_buffer * lowest` (buffer default 0 → strict lowest).
- **State**: DualCache key `f"{model_group}_map"` → `{id: {"latency": [...], "time_to_first_token": [...], "<Y-m-d-H-M>": {"tpm": n, "rpm": n}}}`, TTL 1h (`RoutingArgs.ttl = 3600`, `:24`).
- **Failure penalty**: a `litellm.Timeout` appends a 1000.0s latency sample (`async_log_failure_event`, `:166-224`), steering traffic away without a formal cooldown.

### cost-based-routing (lowest cost / budget-aware)
- **Algorithm** (`litellm/router_strategy/lowest_cost.py:181-305`): for each healthy deployment compute `item_cost = input_cost_per_token + output_cost_per_token`, taken from deployment `litellm_params` overrides else `litellm.model_cost` map, defaulting each side to 5.0 when unknown (`:254-271`); drop deployments whose current-minute tpm/rpm usage would exceed their limits (`:292-295`); sort by cost ascending and return the cheapest (`:302-305`). Async-only (`router.py:1168-1170`).
- **State**: DualCache `f"{model_group}_map"` → per-minute `{"tpm", "rpm"}` per deployment, updated on success (`:99-179`).

### Provider/deployment/tag budget routing (RouterBudgetLimiting)
- Not a selector — a deployment **filter** (`litellm/router_strategy/budget_limiter.py:115`, `_filter_out_deployments_above_budget`, `:191+`): drops deployments whose provider (`provider_budget_config`), deployment-level, or tag-level rolling spend (`{provider}_spend:{duration}` etc. in DualCache/Redis) has reached `max_budget` for the configured `budget_duration`. Enabled via `optional_pre_call_checks=["router_budget_limiting"]` (`router.py:1657-1664`); raises if every deployment is over budget.

### lar1 (custom confidence-based)
- **Algorithm** (`litellm/router_strategy/lar1_routing.py`): reads caller-supplied `metadata.lar1` (confidence, evidence, time dimension); maps to a deployment class via thresholds low=0.3 / medium=0.5 / high=0.7 (`:24`): `UNVERIFIED` evidence → `cloud-smart`; `time==MEM` → `cloud-fast`; `confidence < low` → `cloud-smart`; `< medium` → `cloud-fast`; `< high` → `local`; else `deep` (`_classify_request`, `:134-153`), then picks the first healthy deployment whose `model_info.type` matches (`:155-174`). Registered via `CustomRoutingStrategyBase` (`apply_lar1_routing_strategy`, `:44-53`).

### Routing groups & per-request overrides
- `routing_groups` gives each named group of model_names its own strategy + isolated selector state (`router.py:940-1008`); `_get_routing_context` resolves request → group (`router.py:1058-1095`). A per-request `routing_strategy` (from key/team settings) overrides both, with lazily-built, cached override selectors (`router.py:1010-1056`).

---

## Auto Router / semantic routing

### LiteLLM side (`litellm/router_strategy/auto_router/`)

**Registration.** A deployment whose `litellm_params.model` starts with `auto_router/` (but not `auto_router/complexity_router|adaptive_router|quality_router`) is an auto-router (`_is_auto_router_deployment`, `router.py:7569-7585`; detected during deployment creation at `router.py:8101-8102`). Required `litellm_params`: `auto_router_config_path` (JSON file) **or** `auto_router_config` (inline JSON string), `auto_router_default_model`, `auto_router_embedding_model` (`init_auto_router_deployment`, `router.py:7592-7632`). The instance is registered in `self.auto_routers[model_name]`, tag-scoped (`_register_pre_routing_strategy`, `router.py:7703-7724`).

**Route config format** (`auto_router.py:65-83`): `{"routes": [{"name": ..., "description": ..., "utterances": [...], "score_threshold": ...}]}` — or a full semantic-router JSON loaded via `SemanticRouter.from_json` (`:55-63`). **The route `name` IS the target model**: after matching, `model = route_choice.name or self.default_model` (`auto_router.py:151-154`), and that name is then resolved like any model group by the normal flow.

**Per-request flow** (`AutoRouter.async_pre_routing_hook`, `auto_router.py:108-159`):
1. Lazily build one `SemanticRouter(routes=..., encoder=LiteLLMRouterEncoder(...), auto_sync="local")` (`:133-146`). `auto_sync="local"` embeds all route utterances through the router's own embedding model and stores them in an in-process index.
2. `LiteLLMRouterEncoder` (`litellm/router_strategy/auto_router/litellm_encoder.py:38-119`) subclasses semantic-router's `DenseEncoder`; its `encode_queries/aencode_queries` call `litellm_router_instance.embedding()/aembedding()` with `auto_router_embedding_model`, so utterance and query embeddings go through LiteLLM itself. Default encoder `score_threshold` = **0.3** (`litellm_encoder.py:66`).
3. Extract text from the **last user message** (handles multimodal content blocks and tool-call turns; `_extract_text_from_messages`, `auto_router.py:85-106`).
4. `routelayer(text=...)` → `RouteChoice`; set `model` to the matched route's name, or `default_model` when no route passed its threshold (`:149-154`); return `PreRoutingHookResponse(model=..., messages=...)` — the load-balancing strategy then runs on the *new* model group.

### semantic-router library internals (aurelio-labs/semantic-router)

- **Route** = `name` + `utterances` (+ optional per-route `score_threshold`) (`semantic_router/route.py:50-74`). On sync, every utterance is embedded and stored in a `LocalIndex` (a numpy matrix of vectors with a parallel list of route names).
- **`SemanticRouter.__call__`** (`semantic_router/routers/base.py:571-618`):
  1. Encode the query text to a vector (`SemanticRouter._encode`, `routers/semantic.py:42-60`; uses `encode_queries` for asymmetric encoders like LiteLLM's).
  2. `index.query(vector, top_k=5)` (default `top_k`, `base.py:359`) → **cosine similarity** of the query against every stored utterance embedding: `sim = dot(index, xq) / (|index| * |xq|)` (`semantic_router/linear.py:7-19`), then `np.argpartition` top-k (`linear.py:22-33`; `LocalIndex.query`, `semantic_router/index/local.py:164-202`). Result: top-k `(score, route_name)` pairs — i.e. the k most similar *example utterances*, each tagged with its route.
  3. **Aggregate per route** (`_score_routes`, `base.py:1523-1543`): group the top-k utterance scores by route name (`group_scores_by_class`, `base.py:1582-1601`) and combine with the aggregation method — **default `"mean"`** for `SemanticRouter` (`routers/semantic.py:25`; options `sum`/`mean`/`max`, `base.py:1503-1521`) — then sort routes by aggregate score descending.
  4. **Threshold + choose** (`_pass_routes`, `base.py:620-703`): walk routes best-first; effective threshold = `route.score_threshold` if set, else the router-level threshold (`base.py:647-651`), which is inherited from the **encoder's** `score_threshold` (`_set_score_threshold`, `base.py:537-550`) — 0.3 for LiteLLM's encoder. A route passes if `aggregated_score >= threshold`; with no threshold set it always passes. Default `limit=1` returns the first passing `RouteChoice(name, similarity_score)` (`base.py:687-693`); if **no** route passes, an empty `RouteChoice()` (`name=None`, `semantic_router/schema.py:45-50`) is returned — which is what makes LiteLLM fall back to `auto_router_default_model`.

So the full auto-router decision is: *last user message → embed → cosine-sim against all example utterances → top-5 → mean score per route → highest-scoring route whose mean ≥ threshold (default 0.3) → that route's name is the model group; otherwise the default model.*

---

## Content/complexity classifiers (fork-specific pre-routing strategies)

### Complexity Router (`auto_router/complexity_router` prefix; `litellm/router_strategy/complexity_router/`)
Registered at `router.py:7634-7688`; config `litellm_params.complexity_router_config` (+ `complexity_router_default_model`, defaulting to the MEDIUM/SIMPLE tier's first model, `router.py:7662-7669`).

- **Tiers**: `SIMPLE < MEDIUM < COMPLEX < REASONING` (`config.py:16-30`); `tiers` maps each to a model or pool (defaults `gpt-4o-mini` / `gpt-4o` / `claude-sonnet-4-20250514` x2, `config.py:231-236`); pools are picked from randomly when non-adaptive (`complexity_router.py:469-475`).
- **Heuristic scorer** (`classify`, `complexity_router.py:290-386`): token estimate = `len(prompt)//4` (`:206-211`). Seven weighted dimensions (weights `config.py:201-209`): `tokenCount` (score −1 if <15 est. tokens, +1 if >400; thresholds `config.py:223-226`, weight 0.10), `codePresence` (1 keyword match → 0.5, 2+ → 1.0; weight 0.30; default keyword list `config.py:63-109`), `reasoningMarkers` (user text only; 1 → 0.7, 2+ → 1.0; weight 0.25; **2+ matches force REASONING outright**, `:366-369`), `technicalTerms` (2 → 0.5, 4+ → 1.0; weight 0.25), `simpleIndicators` (any match → −1.0; weight 0.05), `multiStepPatterns` (0.5; weight 0.03), `questionComplexity` (>3 "?" → 0.5; weight 0.02). Keyword matching uses word boundaries for single words (`:225-242`). Weighted sum → tier boundaries **0.15 / 0.35 / 0.60** (`config.py:214-218`; `:371-384`).
- **LLM classifier** (optional, `classifier_type: "llm"`): calls a configured model with a structured-output tier prompt, 3000 ms default timeout, falling back to the heuristic on any failure (`aclassify`/`_classify_with_llm`, `:388-443`; `config.py:239-249`).
- **Keyword tier rules** (deterministic overrides, evaluated before scoring): lexical (`_lexical_tier_override`, `:725-741`; most severe matching tier wins) or **semantic** — builds a `SemanticRouter` with one route per tier whose utterances are the rules' keywords, `aggregation="max"`, threshold = `match_threshold` default **0.5** (`_get_or_create_semantic_routelayer`, `:743-780`; `config.py:369-383`); query embedded manually so spend is attributed to the caller (`_semantic_tier_override`, `:798-836`).
- **Escalation**: case-sensitive substring `"LITELLM ESCALATE"` in the prompt bumps the result one configured tier up (`config.py:165`; `:678-709`).
- **Session affinity** (default **on**): first turn's routed model is pinned per `(api_key_hash, session_id)` in the router cache, TTL 3600s refreshed per hit; later turns skip classification (escalation still honored) (`config.py:386-400`; `async_pre_routing_hook`, `:938-1022`). Disabled when plugins are configured (fail-closed policy, `:953-966`).
- **Adaptive mode** (`adaptive: true`): `_soft_floor_pick` (`:575-676`) — classify request type (regex classifier below), then score every candidate as `quality_weight * ThompsonSample(Beta cell) + cost_weight * normalized_cost − tier_distance_penalty * |tier distance|` (defaults quality 0.3 / cost 0.7, `config.py:336-339`; penalty 0.5/tier-step, `config.py:32`); cold-start picks randomly among never-sampled models of the classified tier (`:595-620`).

### Adaptive Router (`auto_router/adaptive_router` prefix; `litellm/router_strategy/adaptive_router/`)
Registered at `router.py:7690-7849` (config `adaptive_router_config`, per-model priors from `model_info.adaptive_router_preferences`, costs from `input_cost_per_token`).
- **Prompt → request type**: ordered regex rules over the last user message (truncated to 2000 chars) → `CODE_GENERATION`, `CODE_UNDERSTANDING`, `TECHNICAL_DESIGN`, `ANALYTICAL_REASONING`, `WRITING`, `FACTUAL_LOOKUP`, else `GENERAL` (`classifier.py:15-138`).
- **Bandit**: one `Beta(alpha, beta)` posterior per `(request_type, model)` (`bandit.py:28-43`). Cold-start prior mean = `BASE_TIER_WEIGHT[quality_tier]` (`{1: 0.3, 2: 0.5, 3: 0.7}`) + 0.3 strength bonus, capped 0.95, with mass 10 (`config.py:16-20`; `initial_cell`, `bandit.py:45-61`). Selection: Thompson-sample each model, score `0.7*quality + 0.3*normalized_cost` by default (`config.py:13-14`; `score`/`pick_best`, `bandit.py:97-137`); sample cap 200 (hard, drops updates, `config.py:23`; `bandit.py:64-75`). Routing is stateless per turn (`adaptive_router.py:157-196`).
- **Learning**: a post-call hook (`hooks.py`, registered `router.py:7771-7777`) detects response/user-feedback signals (misalignment Jaccard 0.45, stagnation 0.50, loop repeat 3, clean-trace credit after 3 turns; `config.py:26-43`) and applies α/β deltas; state persists to Postgres via an update queue (`adaptive_router.py:124-153`, `update_queue.py`). Chosen model is surfaced as response header `x-litellm-adaptive-router-model` (`config.py:53-54`).

### Quality Router (`auto_router/quality_router` prefix; `litellm/router_strategy/quality_router/quality_router.py`)
Registered at `router.py:7851-7898`. Candidate models declare `model_info.litellm_routing_preferences` (`quality_tier`, optional `keywords`, `order`). Flow (`async_pre_routing_hook`, `:319-422`): (1) **keyword override** — if any declared keyword substring-matches the user message, route to that deployment; ties broken by quality_tier DESC, `order` ASC, input cost ASC, name ASC (`_keyword_override`, `:228-266`); (2) otherwise reuse `ComplexityRouter.classify` (`:63-66`, `:389`), map complexity tier → quality tier via admin `complexity_to_quality`, and resolve to a model by exact tier, then round **up**, then round down, then `default_model` (`_resolve_model_for_quality_tier`, `:268-301`).

---

## Size/complexity-aware behaviors (context windows, pre-call checks)

- **`_pre_call_checks`** (`router.py:10064-10236`, gated by `enable_pre_call_checks: bool = False`, `router.py:323`): per request, counts prompt tokens **once** (only if some deployment declares `max_input_tokens`; `:10124-10137`) and **filters out every deployment whose `max_input_tokens` < prompt tokens** (`:10138-10146`) — routing by *prompt size*, e.g. an oversized prompt automatically lands on the 1M-context deployment in a mixed group. Also filters: deployments at their `rpm` limit for the current minute (`:10151-10166`), deployments outside `allowed_model_region` (`:10168-10178`), and deployments that don't support requested params like `response_format` when `litellm.drop_params` is off (`:10180-10210`). If *all* deployments fail the context check it raises `ContextWindowExceededError` (`:10224-10231`), feeding the fallback layer below; if all fail on rate limits it raises `RouterRateLimitErrorBasic` (`:10219-10222`).
- **`context_window_fallbacks`** (`router.py:320`, stored `:599`): when a call (or the pre-call check) raises `ContextWindowExceededError`, `async_function_with_fallbacks_common_utils` routes the request to the configured bigger-context model group (`router.py:6219-6255`) — size-triggered model escalation. `content_policy_fallbacks` works identically for `ContentPolicyViolationError` (`:6256-6291`).
- **Callback deployment filters** (`router_utils/pre_call_checks/`, run via `async_callback_filter_deployments`, `router.py:7330`; enabled through `optional_pre_call_checks`, `add_optional_pre_call_checks`, `router.py:1590-1675`):
  - `PromptCachingDeploymentCheck` (`prompt_caching_deployment_check.py:45`) — routes to the deployment that previously served the same prompt prefix (provider cache-hit affinity).
  - `DeploymentAffinityCheck` (`deployment_affinity_check.py`) / deprecated `ResponsesApiDeploymentCheck` (`responses_api_deployment_check.py:21-56`, pins `previous_response_id` to the originating deployment) / `EncryptedContentAffinityCheck` — session stickiness.
  - `ModelRateLimitingCheck` (`model_rate_limit_check.py:49`) and IO-token limits (`io_token_rate_limit_check.py`) — pre-call token/requests budget enforcement with reservations.
  - `RouterBudgetLimiting` (`budget_limiter.py:115`) — provider/deployment/tag spend budgets.
- **Routing plugins** (`router.py:10893-10961`) — arbitrary content-aware candidate narrowing; sync path refuses to run when plugins exist so policy can't be bypassed (`router.py:11054-11065`).

---

## Reliability layer (cooldowns, retries, fallbacks)

**Call wrapping**: `acompletion` → `async_function_with_fallbacks` (`router.py:6355`) → `async_function_with_retries` (`router.py:6450`) → `make_call`.

### Retries
- `num_retries` default = `openai.DEFAULT_MAX_RETRIES` (2) unless set on router/`litellm.num_retries` (`router.py:559-563`); per-deployment `num_retries` on the raised exception overrides (`:6488-6491`). Per-exception `RetryPolicy` / per-model-group `model_group_retry_policy` can override counts (`:6503-6512`).
- Backoff (`_time_to_sleep_before_retry`, `router.py:6778-6821`): **retry instantly (0s)** if other healthy deployments remain in the group; otherwise honor `Retry-After` response headers via `litellm._calculate_retry_after` with floor `retry_after` (default 0, `router.py:327`).

### Cooldowns
- Triggered from `deployment_callback_on_failure` (`router.py:6988` → `_set_cooldown_deployments`, `router_utils/cooldown_handlers.py:231-291`) and from strategy rate-limit rejections (`router.py:7305`).
- Never cooled down: `APIConnectionError` strings, 4xx other than 429/401/404/408 (`_is_cooldown_required`, `cooldown_handlers.py:40-93`), provider-default deployments, or when `disable_cooldowns=True` (`:96-148`).
- **Default (v2) decision** (`_should_cooldown_deployment`, `:151-228`): cooldown if 429 (unless the group has a single deployment); or 100% failure rate this minute with ≥ `SINGLE_DEPLOYMENT_TRAFFIC_FAILURE_THRESHOLD` = 1000 requests; or failure rate > `DEFAULT_FAILURE_THRESHOLD_PERCENT` = 0.5 with ≥ `DEFAULT_FAILURE_THRESHOLD_MINIMUM_REQUESTS` = 5 requests (multi-deployment groups only); or a non-retryable status per `litellm._should_retry` (e.g. 401/404). Constants at `litellm/constants.py:26-79`.
- **Legacy policy**: if `allowed_fails`/`allowed_fails_policy` set, cooldown after more than `allowed_fails` failures within the cooldown window (default `litellm.allowed_fails` = 3, `litellm/__init__.py:495`; `should_cooldown_based_on_allowed_fails_policy`, `cooldown_handlers.py:363-391`).
- **Duration**: `cooldown_time` default `DEFAULT_COOLDOWN_TIME_SECONDS` = **5s** (`constants.py:32`; `router.py:546`), stored as a TTL'd DualCache entry `deployment:{model_id}:cooldown` (`router_utils/cooldown_cache.py:64-101`). Cooled-down deployments are filtered from the pool each request (`router.py:10566-10583` async / `11094-11106` sync); health-check-driven cooldowns can be bypassed when they'd empty the pool (`:10576-10583`).

### Fallbacks
- Formats: `fallbacks=[{"model-group": ["fb1", "fb2"]}]`, wildcard `{"*": [...]}`, provider-stripped matching, or client-side `["model-a", "model-b"]` / param-override dicts (`get_fallback_model_group`, `router_utils/fallback_event_handlers.py:47-82`; `_check_non_standard_fallback_format`, `:224-247`). `default_fallbacks` builds a `*` rule (`router.py:317`, `validate_fallbacks`).
- Execution (`async_function_with_fallbacks_common_utils`, `router.py:6093-6352`): after retries are exhausted — (1) **order-based fallbacks**: if deployments define multiple `order` levels, retry the same group at the next-higher order levels first (`:6130-6183`); (2) **weighted intra-group failover** if `enable_weighted_failover` (simple-shuffle only, re-picks among untried deployments, `:6185-6196`); (3) `ContextWindowExceededError` → `context_window_fallbacks` (`:6219-6255`); (4) `ContentPolicyViolationError` → `content_policy_fallbacks` (`:6256-6291`); (5) general `fallbacks` (`:6292-6326`). `run_async_fallback` (`fallback_event_handlers.py:85-165`) loops the fallback groups, re-entering `async_function_with_fallbacks` with `fallback_depth+1`, bounded by `max_fallbacks` (default `ROUTER_MAX_FALLBACKS` = 5, `constants.py:9`; `router.py:565-570`), skipping the original group, raising the last error if all fail. Response headers record attempted fallbacks/retries (`add_fallback_headers_to_response`).

---

## Tag-based routing & aliasing

- **Tag routing** (`litellm/router_strategy/tag_based_routing.py:152-269`, invoked at `router.py:10604`): active when router `enable_tag_filtering=True` or the request carries it (request-level False can't disable a router-level True, `:169-171`). Request `metadata.tags` are matched against deployment `litellm_params.tags` — `match_any` (default True, `router.py:325`) = any intersection; strict mode = request tags ⊆ deployment tags (`is_valid_deployment_tag`, `:46-69`). Extras: `tag_regex` patterns matched against `User-Agent: ...` header strings (`:23-43`, `:102-112`; regex can't bypass strict-tag policy), `!tag` exclusions (`:117-129`), deployments tagged `default` serve untagged/unmatched requests (`:244-262`); no match and no defaults → error (`:247-251`). Tags also disambiguate which pre-routing strategy (auto/complexity/adaptive/quality) handles a shared model name (`router.py:10980-10990`).
- **Aliasing**: `model_group_alias` maps public alias → real model group before lookup (`router.py:322`; `_get_model_from_alias`, `:10238-10255`; applied `:10366-10368`); `litellm.model_alias_map` applies after resolution (`:10446-10449`); wildcard/pattern deployments (e.g. `openai/*`) resolve via `pattern_router` (`:10307-10312`, `router_utils/pattern_match_deployments.py`), with per-team pattern routers (`:10314-10319`) and a catch-all `default_deployment` (`:10321-10326`).

---

## Code References

| Concern | Location |
| --- | --- |
| Router class / constructor defaults | `litellm/router.py:278`, `:287-360` |
| async_get_available_deployment / sync | `litellm/router.py:10643`, `:11043` |
| Pre-routing hook + strategy registries | `litellm/router.py:10992`, `:10963`, `:501-505` |
| Routing plugins pipeline | `litellm/router.py:10893-10961` |
| Strategy resolution (groups/overrides) | `litellm/router.py:1058-1095`, `:940-1008`, `:1012-1056` |
| Healthy-deployment pipeline | `litellm/router.py:10507-10641`, `:10330-10451` |
| Strategy dispatch | `litellm/router.py:1097-1193`, `:848-894` |
| simple-shuffle | `litellm/router_strategy/simple_shuffle.py:21-69` |
| least-busy | `litellm/router_strategy/least_busy.py:16-215` |
| usage-based v1 / v2 | `litellm/router_strategy/lowest_tpm_rpm.py`, `lowest_tpm_rpm_v2.py:32-643`; `base_routing_strategy.py` |
| latency-based | `litellm/router_strategy/lowest_latency.py:23-544` |
| cost-based | `litellm/router_strategy/lowest_cost.py:13-305` |
| budget limiter | `litellm/router_strategy/budget_limiter.py:115`, `:191` |
| lar1 | `litellm/router_strategy/lar1_routing.py` |
| Auto Router (semantic) | `litellm/router_strategy/auto_router/auto_router.py:24-159`, `litellm_encoder.py:38-119`; init `litellm/router.py:7592-7632` |
| semantic-router matching | `semantic_router/routers/base.py:571-703`, `:1523-1543`, `:537-550`; `semantic_router/linear.py:7-33`; `semantic_router/index/local.py:164-202`; `semantic_router/routers/semantic.py:15-60`; `semantic_router/route.py:50-74` |
| Complexity Router | `litellm/router_strategy/complexity_router/complexity_router.py:206-1123`, `config.py:16-471`; init `litellm/router.py:7634-7688` |
| Adaptive Router | `litellm/router_strategy/adaptive_router/{adaptive_router.py,bandit.py,classifier.py,config.py,signals.py,hooks.py}`; init `litellm/router.py:7690-7849` |
| Quality Router | `litellm/router_strategy/quality_router/quality_router.py:37-423`; init `litellm/router.py:7851-7898` |
| Pre-call checks (context window/RPM/region/params) | `litellm/router.py:10064-10236`; callback filters `litellm/router_utils/pre_call_checks/`, wiring `litellm/router.py:1590-1675`, `:7330` |
| Cooldowns | `litellm/router_utils/cooldown_handlers.py:40-421`, `cooldown_cache.py:31-101`; constants `litellm/constants.py:9-79` |
| Retries / backoff | `litellm/router.py:6450-6560`, `:6778-6821` |
| Fallbacks (incl. context-window) | `litellm/router.py:6093-6400`; `litellm/router_utils/fallback_event_handlers.py:47-165` |
| Tag routing | `litellm/router_strategy/tag_based_routing.py:46-296`; invoked `litellm/router.py:10604` |
| Aliasing / wildcards | `litellm/router.py:10238-10328`, `:10446-10449`; `litellm/router_utils/pattern_match_deployments.py` |
| Post-selection RPM gate | `litellm/router.py:7269-7310`; `lowest_tpm_rpm_v2.py:141-225` |
