# LiteLLM — Admin Dashboard: Complete Map

> The LiteLLM Admin Dashboard (Next.js App Router + Tremor charts, `ui/litellm-dashboard/`) exposes ~18 views for spend/usage analytics, per-request logs with session drill-down, cache & savings visibility, entity budgets, and routing configuration — fed almost entirely by the pre-aggregated `LiteLLM_Daily*Spend` tables (new views) and raw `LiteLLM_SpendLogs` (logs + legacy views).

**Entry point:** `ui/litellm-dashboard/src/app/(dashboard)/page.tsx` (route group `(dashboard)` mounts at `/`; defaults to Virtual Keys, redirects legacy `?page=` deep links via `src/utils/migratedPages.ts:11-51`) | **Last traced:** 2026-07-19

Repo root for all paths below: `/Users/mascott/projects/proxy/research/litellm`. UI networking layer: `ui/litellm-dashboard/src/components/networking.tsx` (7,992 lines; every call is `proxyBaseUrl` + path with `Authorization: Bearer <accessToken>`).

---

## Navigation map (all tabs)

Sidebar definition: `ui/litellm-dashboard/src/components/leftnav.tsx:116-329` (`menuGroups`). Route mapping: `src/utils/migratedPages.ts`.

| Group | Item (page key → route) | Notes |
|---|---|---|
| **AI GATEWAY** | Virtual Keys (`api-keys`), Playground (`llm-playground` → `/playground`), Models + Endpoints (`models` → `/models-and-endpoints`), Agentic (Agents / Workflow Runs / Memory), MCP Servers, Skills, Guardrails, Policies, Tools (Search Tools / Vector Stores / Tool Policies) | leftnav.tsx:117-174 |
| **OBSERVABILITY** | **Usage** (`new_usage` → `/usage`), **Cost Optimization** (`cost-optimization`), **Logs** (`logs`), Guardrails Monitor (`guardrails-monitor`) | leftnav.tsx:175-201 |
| **ACCESS CONTROL** | Teams, Projects (beta), Internal Users, Organizations, Access Groups, **Budgets** | leftnav.tsx:202-234 |
| **DEVELOPER TOOLS** | API Reference, AI Hub (`model-hub-table`), Learning Resources (external), **Caching** (`caching`), Experimental → (Prompts, API Playground `transform-request`, Tag Management, **Old Usage** `usage` → `/old-usage`) | leftnav.tsx:235-273 |
| **SETTINGS** | Router Settings, Logging & Alerts, Admin Settings, Cost Tracking, UI Theme | leftnav.tsx:274-328 |

Sidebar footer: `SidebarUsageCard` (admin only, leftnav.tsx:619-625) — license seat/team meters via `GET /user/available_users` (`networking.tsx:6513`, URL :6524). It shows **no spend** (docstring at `SidebarUsageCard.tsx:64-69`).

---

## Per-view documentation

### 1. Usage (New Usage) — `/usage`

Route: `src/app/(dashboard)/usage/page.tsx` → `UsagePageView.tsx` (`.../usage/_components/components/UsagePageView.tsx`). Docstring (lines 1-7): built on `/user/daily/activity` aggregate tables, works at 1M+ spend logs.

**Data path (dual):**
- Primary: `userDailyActivityAggregatedCall` → **GET `/user/daily/activity/aggregated`** (`networking.tsx:2467`, URL :2483) — single-pass DB `GROUP BY GROUPING SETS`.
- Fallback on failure: `userDailyActivityCall` → **GET `/user/daily/activity`** (`networking.tsx:1384`, URL :1396), auto-paginated by `usePaginatedDailyActivity.ts` with a "fetching pages / Stop" banner (`UsagePageView.tsx:462-498`).
- All daily-activity calls share `buildDailyActivityUrl` (`networking.tsx:1313`) / `fetchDailyActivity` (:1350) — params `start_date`, `end_date`, `page`, `page_size`, `timezone`.

**View selector** (`UsageViewSelect.tsx:45-114`): Global Usage · Your Usage · Organization Usage · Team Usage · Customer Usage · Tag Usage · Agent Usage (A2A) · User Usage · User Agent Activity. Global filters: `AdvancedDatePicker` (default last 7 days, `UsagePageView.tsx:79-86`), admin-only "Filter by user" async select (:502-531).

**Global/Your Usage → inner tabs** (`UsagePageView.tsx:535-539`): **Cost | Model Activity | Key Activity | MCP Server Activity | Endpoint Activity**, plus "Ask AI" (streams **POST `/usage/ai/chat`**, `networking.tsx:4179`) and "Export Data" buttons (:541-567).

Cost tab panels (`UsagePageView.tsx:571-838`):
- Project Spend (`ViewUserSpend`, total vs max_budget) — :597-602
- Usage Metrics cards: Total / Successful / Failed Requests, Avg Cost per Request, Total Tokens — :606-657
- **Token breakdown** (expandable): Input, Output, **Cache Read Tokens**, **Cache Write Tokens** — :658-685
- Daily Spend BarChart (tooltip: spend/requests/success/fail/tokens) — :690-727
- Top Virtual Keys (`TopKeyView`, limit 5/10/25/50, click → `GET /key/info` + `KeyInfoView` modal) — :729-739
- Top Models (Public Model Name vs LiteLLM Model Name toggle) — :742-825
- Spend by Provider (donut + table with success/fail/tokens; zero-spend & unknown toggles, `SpendByProvider.tsx:59-126`) — :828-834

Activity tabs render `ActivityMetrics` (`src/components/activity_metrics.tsx`) — pure client transform of the same breakdown (`processActivityData` :363-502): Total Tokens Over Time area (:281-300), Requests Over Time success-vs-fail area (:301-320), per-model/key collapsible sections with spend/day, tokens/day, requests/day, and **Prompt Caching Metrics** area (cache_read/cache_creation tokens, :78-178). Endpoint Activity renders `EndpointUsage` (per-endpoint table with success-rate colorization, stacked bar, trend lines — `EndpointUsage/EndpointUsageTable.tsx:39-119`).

**Entity views** (org/team/customer/tag/agent/user) all render `EntityUsage.tsx`; endpoint dispatch table `ENTITY_FETCH_FNS` (`EntityUsage.tsx:101-108`):

| Entity | networking fn (line) | Endpoint | Extra filter param |
|---|---|---|---|
| tag | `tagDailyActivityCall` (1406, URL 1418) | GET `/tag/daily/activity` | `tags` |
| team | `teamDailyActivityCall` (1428, URL 1440) | GET `/team/daily/activity` | `team_ids`, `exclude_team_ids=litellm-dashboard` |
| organization | `organizationDailyActivityCall` (1451, URL 1460) | GET `/organization/daily/activity` | `organization_ids` |
| customer | `customerDailyActivityCall` (1470, URL 1479) | GET `/customer/daily/activity` | `end_user_ids` |
| agent | `agentDailyActivityCall` (1489, URL 1498) | GET `/agent/daily/activity` | `agent_ids` |
| user | `userDailyActivityCall` (1384, URL 1396) | GET `/user/daily/activity` | `user_id` |

Entity Cost tab: Spend Overview cards, Daily Spend bar with per-entity tooltip, "Spend Per {Entity}" bar+table (top 5), Top Keys, Top Models/Agents, Provider Usage (`EntityUsage.tsx:514-816`). Team view adds "Top Agents Driving Spend" and an Agent Activity tab (parallel `agentDailyActivityCall`, :142-152). Tag filter options come from `tagListCall` → GET `/tag/list` (`networking.tsx:5405`).

**Filters summary:** date range, entity multi-select (team/tag/org/customer/agent), user select, model-name toggle, top-N limit (5/10/25/50). Model/key filtering happens client-side over the returned breakdown; the backend also accepts `model` and `api_key` query params (see backend section).

**Export:** `EntityUsageExportModal` — client-side CSV/JSON of fetched data (scopes: daily / daily_with_keys / daily_with_models; `EntityUsageExport/utils.ts:361-394`; CSV includes "Cache Read Input Tokens" columns, `utils.ts:24,129`). CloudZero export modal: GET/PUT `/cloudzero/settings`, POST `/cloudzero/init`, POST `/cloudzero/export` (`cloudzero_export_modal.tsx:44,80-96,129-139`).

### 2. Cost Optimization — `/cost-optimization`

`src/app/(dashboard)/cost-optimization/_components/CostOptimizationView.tsx`. Single feed: `userDailyActivityCall` via `usePaginatedDailyActivity` (:59-63); admin = global, non-admin scoped to own user (:56-57). Filter: date picker, default last 30 days (:50-52).

Panels (all from `SpendMetrics` fields `compression_savings_spend`, `prompt_caching_savings_spend`, `compression_saved_tokens` — `components/UsagePage/types.ts:11-13`):
- **Total saved** card (compression + caching) — :107-111
- **Compression savings** card + "{N} tokens compressed" — :112-116
- **Prompt caching savings** card ("Cache read discount") — :117
- **Savings over time** stacked AreaChart (Compression vs Prompt caching per day) — :120-134
- **Savings by driver** DonutChart (center label = total saved) — :135-151

No cheaper-model recommendation panel exists; the "Ask AI" cost analysis lives in the Usage page's `/usage/ai/chat` SSE agent.

### 3. Logs — `/logs`

Route: `src/app/(dashboard)/logs/page.tsx` → `components/view_logs/index.tsx` (`SpendLogsTable`). Four tabs (index.tsx:238-244): **Request Logs | Audit Logs | Deleted Keys | Deleted Teams**.

**Request Logs table** (`view_logs/columns.tsx:107-431`), columns in order: Time, Type (LLM/Agent/MCP badge with session composition tooltip), Status, **Session ID** (click → session drill-down), Request ID, **Cost** (6 decimals; multi-call rows show `session_total_spend` + MCP spend note), **Duration (s)**, **TTFT (s)** (streaming only; sort field `ttft_ms`), Team Name, Key Hash (click → KeyInfoView), Key Alias, Model, **Tokens** (`total (prompt+completion)`), Internal User, End User, Tags. Server-sortable: `startTime, spend, total_tokens, request_duration_ms, model, ttft_ms` (columns.tsx:12-19). **No cache-hit column or filter exists in the table** — cache data appears only in the detail drawer.

**Detail drawer** (`LogDetailsDrawer/`): error alert with `error_information`, tags, Request Details card (model/provider/call type/model_id/API base/IP), **Metrics card** (`LogDetailContent.tsx:281-380`): tokens + TokenFlow, cost, duration, TTFT, retries, LiteLLM overhead, and — gated by `hasCacheActivity` (:288-296) — **Cache Hit tag, Cache Read Tokens, Cache Creation Tokens** (:329-343). **Cost Breakdown** viewer with **Cache Read Cost / Cache Write Cost** line items and "(Cached)" $0 totals (`CostBreakdownViewer.tsx:137-162,85-89`). Pretty/JSON **request/response payload viewer** (:390-510) — payloads lazy-loaded per row via `uiSpendLogDetailsCall` → **GET `/spend/logs/ui/{id}`** (`networking.tsx:4755`, URL :4758; hook `useLogDetails.ts:13-26`). Also guardrail/LLM-judge/vector-store viewers and raw metadata JSON.

**Session view — YES.** Not a standalone component: "session mode" inside `LogDetailsDrawer` (`isSessionMode`, LogDetailsDrawer.tsx:118). The list groups rows by `session_id` and collapses multi-call sessions to one representative row (index.tsx:147-203); clicking Session ID or a multi-call row opens the drawer in session mode, which pages through `sessionSpendLogsCall` → **GET `/spend/logs/session/ui`** (`networking.tsx:5540`, URL :5552; 100/page, max 50 pages) and renders a trace tree with total session cost/duration and LLM/Agent/MCP counts (LogDetailsDrawer.tsx:124-164, 265-277, 411-434).

**Filters:** Team, Status (success/failure), Key Alias, End User (via GET `/customer/list`), Error Code, Error Message, Key Hash, **Session ID**, Model (by model_id), public model name (`filter_options.ts:9-82`); toolbar: Request-ID search, quick date ranges (Last Minute…Last 7 Days) + custom datetime range, **Live Tail** (15 s poll, page 1 only), pagination (50/page, capped count indicator) (`LogsTableToolbar.tsx:75-242`, `log_filter_logic.tsx:22-69,153-180`). Main list call: `uiSpendLogsCall` → **GET `/spend/logs/ui`** (`networking.tsx:1975`, URL :1985; params typed at :1945-1964).

**Audit Logs tab** (`audit_logs.tsx`): enterprise-gated; `uiAuditLogsCall` → GET `/audit` (`networking.tsx:6470`, URL :6477); columns Timestamp/Action/Table/Object ID/Changed By/Key Hash; filters object_id, changed_by, team, key hash, action, table.

### 4. Caching — `/caching`

`src/app/(dashboard)/caching/_components/cache_dashboard.tsx:100-408`. Four tabs (:262-403): **Cache Analytics | Cache Health | Cache Settings | Coordination Redis**.

**Cache Analytics** — feed: `adminGlobalCacheActivity` → **GET `/global/activity/cache_hits`** (`networking.tsx:2130`, URL :2136). Filters: Virtual Keys multi-select, Models multi-select, date picker (default 7 days) (:285-317). Metrics (:319-351):
- **Cache Hit Ratio %** = `cache_hits / (cache_hits + llm_api_requests) * 100` (:216-222)
- **Cache Hits** count (sum `cache_hit_true_rows`)
- **Cached Tokens** (sum `cached_completion_tokens`)

Charts (grouped by `call_type`, not time series): stacked "Cache Hits vs API Requests" (:353-368) and "Cached Completion Tokens vs Generated Completion Tokens" (:370-387). **No cost-saved metric, no latency comparison, no hits-over-time chart** here (savings live on Cost Optimization).

**Cache Health** — Run Health Check button → `cachingHealthCheckCall` → **GET `/cache/ping`** (`networking.tsx:3489`, URL :3494); shows status, cache type, ping/set responses, `cache_params`, and Redis details (host/port/version) parsed from the ping response (`cache_health.tsx:104-220`). **No UI wiring** for `/cache/flushall`, `/cache/delete`, `/cache/redis/info` (present only in generated `lib/http/schema.d.ts:1172-1246`). Cache Settings / Coordination Redis tabs are config forms (GET/POST `/cache/settings` — backend `management_endpoints/cache_settings_endpoints.py:252,364`).

### 5. Old Usage — `/old-usage` (Experimental menu)

`src/app/(dashboard)/old-usage/_components/usage.tsx` (deprecation banner). Guard: replaced by a "Database Query Limit Reached" card when `DISABLE_EXPENSIVE_DB_QUERIES` (:525-543). Tabs (:548-562): **All Up | Team Based Usage | Customer Usage | Tag Based Usage**.

- All Up → Cost sub-tab: monthly spend bar (`adminSpendLogsCall` → GET `/global/spend/logs`, `networking.tsx:2031`), Top Keys (GET `/global/spend/keys?limit=5`, :2043), Top Models (GET `/global/spend/models?limit=5`, :2202), Spend by Provider donut (GET `/global/spend/provider`, :2092). Activity sub-tab: API Requests + Tokens per day globally (GET `/global/activity`, :2113) and per model (GET `/global/activity/model`, :2166).
- Team Based: Total Spend Per Team BarList + Daily Spend Per Team stacked bar (GET `/global/spend/teams`, :1856).
- Customer: date picker + key selector → top end-users table (POST `/global/spend/end_users`, :2071).
- Tag Based: date picker + tag MultiSelect (premium-gated; names via GET `/global/spend/all_tag_names`, :1906) → Spend Per Tag bar (GET `/global/spend/tags`, :1866).

### 6. User Agent Activity (Usage sub-view)

`src/components/user_agent_activity.tsx` — analytics per client user-agent (Claude Code, Cursor, etc., extracted from `User-Agent:` tags, :198-203). Panels: top-4 agent summary cards (Success Requests / Tokens / Cost) via GET `/tag/summary` (`networking.tsx:7026`); **DAU/WAU/MAU** stacked bars via GET `/tag/dau|/tag/wau|/tag/mau` (:6932/:6959/:6986); tag filter via GET `/tag/distinct` (:7013). "Per User Usage" tab → `per_user_usage.tsx`: user table (success gens, tokens, failed, cost) + request-count distribution histogram via GET `/tag/user-agent/per-user-analytics` (:7057).

### 7. Models + Endpoints — `/models-and-endpoints`

`src/app/(dashboard)/models-and-endpoints/ModelsAndEndpointsView.tsx:332-483`. Tabs: **All/Your Models | Add Model | LLM Credentials | Pass-Through Endpoints | Health Status | Model Retry Settings | Model Group Alias | Price Data Reload** (tabs 3-8 admin-only).

- **All Models** (`AllModelsTab.tsx`): list via `useModelsInfo` → `modelInfoCall` → **GET `/v2/model/info`** (`networking.tsx:1595`, URL :1611; params page/size/search/teamId/sort). Columns (`molecules/models/columns.tsx`): Model ID, Model Information (public + LiteLLM name), Credentials, Created By, Updated, **Costs (per 1M in/out)**, Team ID, Access Group, Status (DB vs Config), Actions (pause/delete). Filters: team selector, current-vs-all view, name search, access-group filter, server pagination. Detail: `ModelInfoView` (GET `/v1/model/info?litellm_model_id=`, :1673) — includes editable **Cache Read Cost per 1M tokens** (`model_info_view.tsx:351-364`).
- **Model Retry Settings** (`ModelRetrySettingsTab.tsx:26-33`): per-exception retry counts (BadRequest 400, Authentication 401, Timeout 408, RateLimit 429, ContentPolicyViolation, InternalServerError 500), global default or per-model-group; load GET `/get/config/callbacks`, save `setCallbacksCall` → **POST `/config/update`** with `retry_policy` / `model_group_retry_policy`.
- **Health Status** (`model_dashboard/HealthCheckComponent.tsx`): per-deployment GET `/health?model_id=` (`networking.tsx:3457`) + cached GET `/health/latest` (:3521).

**IMPORTANT: the Model Analytics tab no longer exists.** No UI code calls `/model/metrics`, `/model/metrics/slow_responses`, `/model/metrics/exceptions`, or `/model/streaming_metrics` — those functions are absent from `networking.tsx`; the routes survive only in the generated OpenAPI types (`lib/http/schema.d.ts:7529,7549,7569,7629`) and the backend (see table below). Per-model latency/TTFT/exception charts were removed from the dashboard.

### 8. AI Hub — `/model-hub-table`

`src/components/AIHub/ModelHubTable.tsx`. Tabs: **Model Hub | Agent Hub | MCP Hub | Skill Hub** (:429-434). Model table (`ModelHubTableColumns.tsx`): Public Model Name, Provider, Mode, Tokens (max in/out), **Cost/1M** (`cost * 1e6`, :49), Features (`supports_*`), Public flag, Actions. Detail modal adds rate limits (tpm/rpm), supported OpenAI params, Python snippet (:604-753). Feeds: admin `modelHubCall` → **GET `/model_group/info`** (`networking.tsx:1762`); public GET `/public/model_hub` (:1704), `/public/agent_hub` (:1719), `/public/skill_hub` (:1749). Public variant: `public_model_hub.tsx`.

### 9. Router Settings — `/router-settings`

`src/app/(dashboard)/router-settings/_components/general_settings.tsx:222-294`. Tabs: **Loadbalancing | Routing Groups | Fallbacks | Prompt Caching | General**.

- **Loadbalancing** (`components/router_settings/index.tsx`): routing strategy selector (options + descriptions from **GET `/router/settings`**, `networking.tsx:3206`); latency-based config (`ttl`, `lowest_latency_buffer`) shown for `latency-based-routing`; tag-filtering toggle; reliability fields (`num_retries`, `timeout`, `cooldown_time`, `allowed_fails`, `retry_after`). Load GET `/get/config/callbacks` (:3158); save **POST `/config/update`** (:3436).
- **Routing Groups** (`components/routing_groups/`): named groups {strategy + models}, persisted as `router_settings.routing_groups` via POST `/config/update`.
- **Fallbacks** (`Settings/RouterSettings/Fallbacks/Fallbacks.tsx`): model → fallback-chain table; add/delete via POST `/config/update`; **Test fallback** button sends a real chat completion with `mock_testing_fallbacks: true` through the OpenAI SDK (:70-115).
- **Prompt Caching** (general_settings.tsx:93-151): `enable_anthropic_prompt_caching` + TTL via POST `/config/field/update` / `/config/field/delete` (`networking.tsx:3368/:3387`).
- **General**: config-field table from GET `/config/list?config_type=general_settings` (:3174).

### 10. Playground — `/playground` (+ API Playground `/transform-request`)

`src/app/(dashboard)/playground/page.tsx` tabs: **Chat | Compare | Compliance | Agent Builder (deprecated)**. Chat pane is the "Test Key" flow (`ChatUI.tsx:1714`): key source = UI session token or pasted virtual key (:170-181, 1045-1067); endpoint selector covering `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, images/edits, embeddings, audio speech/transcription, A2A, MCP tools, realtime, interactions (`chatConstants.ts:36-49`); model list via `modelHubCall`. Requests go through the OpenAI JS SDK pointed at the proxy with `stream_options:{include_usage:true}` (`llm_calls/chat_completion.tsx:47-133`). **Per-response metrics shown** (`chat_ui/ResponseMetrics.tsx`): TTFT, total latency, in/out/reasoning/total tokens, and **cost** (from the streamed `usage.cost`, `chat_completion.tsx:227-229`). Compare tab = side-by-side models.

**API Playground** (`transform-request/TransformRequestPanel.tsx`): dry-run — POST `/utils/transform_request` (`networking.tsx:1262`) shows the exact provider-bound request as a copyable curl; no LLM call.

### 11. Virtual Keys — `/api-keys`

`components/VirtualKeysPage/VirtualKeysTable.tsx` + `keyTableColumns.tsx:121-364`. Columns: Key (alias + status Active/Blocked/Expired), Key ID, Team, Org, User, dates, **Spend/Budget** (`SpendBudgetCell` meter with team-budget fallback and over/warning tones — `shared/table_cells/spend_budget_cell.tsx:12-41`), Budget Reset, Models, **Rate Limits (TPM/RPM)**. Filters: key-alias search, team, org, user ID, key hash; server sort/pagination (50/page). List: `useKeys.ts:75` → **GET `/key/list`** (also `networking.tsx:2387`, URL :2405). Detail (`templates/key_info_view.tsx`): Overview (Spend vs budget, Rate Limits incl. `throttle_on_budget_exceeded`, models, guardrails, auto-rotation) + Settings (budget, budget fallbacks, tags, TPM/RPM/max-parallel/model- and tag-level limits); actions Regenerate (POST `/key/{key}/regenerate`, `networking.tsx:1562`), Reset Spend, Delete. Deleted Keys view: `GET /key/list?status=deleted` with Spend/Budget columns.

### 12. Teams — `/teams`

`components/Teams.tsx` (tabs: Your Teams | Available Teams | Default Team Settings) + `TeamsPage/teamTableColumns.tsx:131-287`: Team, Org, Resources (member/model/key counts), **Spend/Budget** meter, Created, Members, Models, **Rate Limits (TPM/RPM)**, Updated, Actions. List: **GET `/v2/team/list`** (`hooks/teams/useTeams.ts:62`; legacy GET `/team/list` at `networking.tsx:1096`). Detail (`team/TeamInfo.tsx:738+`): Overview (**Budget Status**: spend vs max_budget, reset duration, member budget; **Rate Limits** incl. per-model TPM/RPM), My User, Virtual Keys, Members, Member Permissions, Settings (max/soft budget, alert emails, member budget/duration). Team usage: GET `/team/daily/activity` (`networking.tsx:1428`). Deleted Teams: `/v2/team/list?status=deleted`.

### 13. Internal Users — `/users`

`app/(dashboard)/users/_components/view_users.tsx` + `view_users/columns.tsx:17-192`: User ID, Email, Status (SCIM), Role, Alias, **Spend (USD)**, **Budget (USD)**, SSO ID, Key count, dates. Filters: email search, user_id, role, team, model, **min/max spend**. List: **GET `/user/list`** (`networking.tsx:943`, params incl. sort). Detail (`user_info_view.tsx`): Spend card vs max_budget, Teams table, personal models, Details (max budget, budget reset). Info: GET `/user/info` (:1018), GET `/v2/user/info` (:1009).

### 14. Organizations — `/organizations`

`app/(dashboard)/organizations/_components/organizations.tsx` (premium-gated). Table: Org ID/Name, Created, **Spend (USD)**, **Budget (USD)** (`litellm_budget_table.max_budget`), Models, **TPM/RPM limits**, member count. Create modal: max budget, reset (24h/7d/30d), TPM/RPM. Detail (`organization/organization_view.tsx:243+`): Overview (Budget Status + Rate Limits), Members (with per-member **Spend**), Settings. Endpoints: GET `/organization/list` (`networking.tsx:1134`), GET `/organization/info` (:1156), POST `/organization/new` (:1186); usage GET `/organization/daily/activity` (:1451).

### 15. Budgets — `/budgets`

`app/(dashboard)/budgets/_components/budget_panel.tsx`. Budget *templates* (no live spend column): table Budget ID, **Max Budget**, **TPM**, **RPM** (`BudgetTableColumns.tsx:66-123`). Create/edit modal: budget id, tpm/rpm limits, max budget, reset duration 24h/7d/30d (`budget_modal.tsx:49-83`). Endpoints: GET `/budget/list` (`networking.tsx:3143`), POST `/budget/new` (:610), `/budget/update` (:629), `/budget/delete` (:591).

### 16. Tag Management — `/tag-management` (Experimental)

`app/(dashboard)/tag-management/_components/`. Tag table (name/description/allowed models; dynamic spend tags read-only). Create: name, description, models, **max budget + reset duration** (TPM/RPM explicitly unsupported — `CreateTagModal.tsx:106-119`). Detail shows `litellm_budget_table` budget fields; per-tag *spend* lives in Usage → Tag Usage, not here. Endpoints: GET `/tag/list` (`networking.tsx:5405`), POST `/tag/info` (:5371), `/tag/new` (:5319), `/tag/update` (:5345), `/tag/delete` (:5442).

### 17. Guardrails Monitor — `/guardrails-monitor`

`_components/GuardrailsOverview.tsx`: cards Total Evaluations, Blocked Requests, **Pass Rate %**, Avg latency added (ms), Active Guardrails; score chart; per-guardrail table (requests, fail rate + trend, latency, health). Feeds: GET `/guardrails/usage/overview` (`networking.tsx:3809`), `/guardrails/usage/detail/{id}` (:3834), `/guardrails/usage/logs` (:3866). Filter: date range (default 7 days).

---

## Backend analytics endpoints

Paths relative to `litellm/proxy/`. `SM` = `spend_tracking/spend_management_endpoints.py`, `PS` = `proxy_server.py`.

| Endpoint | Purpose | Aggregation / source | file:line |
|---|---|---|---|
| GET `/spend/logs/ui` (+`/v2`) | Paginated request logs for Logs tab | `LiteLLM_SpendLogs` raw SQL, excludes heavy cols; count capped; UI path enriches `session_total_count/spend`, MCP counts (`_build_ui_spend_logs_response` :3334) | SM:1603/1611 |
| GET `/spend/logs/ui/{request_id}` | Full request/response payload for drawer | SpendLogs + cold storage fallback | SM:2124 |
| GET `/spend/logs/session/ui` | Session drill-down (all logs for `session_id`) | SpendLogs `WHERE session_id=$1` paginated | SM:3243 |
| GET `/spend/logs` | Legacy logs (deprecated, summarize pivot) | Prisma group_by api_key/user/model/day | SM:2207 |
| GET `/user/daily/activity` | New Usage per-user daily | `LiteLLM_DailyUserSpend` find_many + Python rollup | management_endpoints/internal_user_endpoints.py:2452 |
| GET `/user/daily/activity/aggregated` | New Usage primary feed | Single SQL `GROUP BY GROUPING SETS` over date/api_key/model/model_group/provider/mcp_tool/endpoint (`_build_aggregated_sql_query`, common_daily_activity.py:381-501) | internal_user_endpoints.py:2561 |
| GET `/team/daily/activity` | Team usage | `LiteLLM_DailyTeamSpend` | management_endpoints/team_endpoints.py:5095 |
| GET `/tag/daily/activity` | Tag usage | `LiteLLM_DailyTagSpend` (no cross-tag dedup, comment :671-678) | management_endpoints/tag_management_endpoints.py:614 |
| GET `/organization/daily/activity` | Org usage | `LiteLLM_DailyOrganizationSpend` | management_endpoints/organization_endpoints.py:322 |
| GET `/customer/daily/activity` | Customer usage | daily-spend tables | management_endpoints/customer_endpoints.py:789 |
| POST `/usage/ai/chat` | "Ask AI" cost analysis (SSE agent over daily activity) | daily-activity tools | management_endpoints/usage_endpoints/endpoints.py:30 |
| GET `/global/activity` | Requests+tokens/day (Old Usage) | SpendLogs `date_trunc('day')` | SM:289 |
| GET `/global/activity/model` | Same per model (top 10) | SpendLogs GROUP BY model_group, day | SM:428 |
| GET `/global/activity/cache_hits` | **Caching dashboard feed** (hits vs requests, cached tokens by call_type) | SpendLogs `cache_hit` | SM (route in same file; UI call `networking.tsx:2130`) |
| GET `/global/activity/exceptions` (+`/deployment`) | 429s/day per model group / deployment | `LiteLLM_ErrorLogs` status_code='429' | SM:724 / :579 |
| GET `/global/spend` | Total spend + max_budget | `MonthlyGlobalSpend` materialized view | SM:2676 |
| GET `/global/spend/logs` | Spend/day 30d | `MonthlyGlobalSpend[PerKey]` views | SM:2587 |
| GET `/global/spend/keys` | Top keys by spend | `Last30dKeysBySpend` view | SM:2768 |
| GET `/global/spend/models` | Top models by spend | `Last30dModelsBySpend` view | SM:3017 |
| GET `/global/spend/teams` | Daily spend per team 30d | SpendLogs ⋈ TeamTable | SM:2814 |
| POST `/global/spend/end_users` | Top customers by spend | SpendLogs | SM:2935 |
| GET `/global/spend/provider` | Spend per provider | SpendLogs by model_id → router provider map | SM:830 |
| GET `/global/spend/report` | Grouped report (team/customer/api_key) w/ per-model detail | SpendLogs CTEs, premium-only | SM:958 |
| GET `/global/spend/tags` / `/all_tag_names` | Tag spend / names | `DailyTagSpend` / SpendLogs | SM:1299 / :1247 |
| POST `/global/spend/refresh` / `/reset` | Refresh materialized views / zero key+team spend | views / VerificationToken+TeamTable | SM:2470 / :2435 |
| GET `/provider/budgets` | Provider budget vs spend | in-memory router budget limiter | SM:3054 |
| GET `/model/metrics` | Avg latency **per token** per model/day (excludes cache hits) | SpendLogs | PS:12255 |
| GET `/model/streaming_metrics` | TTFT per model/api_base | SpendLogs `completionStartTime-startTime` | PS:12125 |
| GET `/model/metrics/slow_responses` | Requests ≥ alerting threshold per api_base | SpendLogs | PS:12370 |
| GET `/model/metrics/exceptions` | Exception counts per model × type | `LiteLLM_ErrorLogs` | PS:12459 |
| GET `/cache/ping` | Cache health (type, ping, set test, masked params) | live cache | caching_routes.py:51 |
| POST `/cache/delete` / GET `/cache/redis/info` / POST `/cache/flushall` | Redis ops (**no UI wiring**) | live redis | caching_routes.py:123/181/217 |
| GET/POST `/cache/settings` | Cache config CRUD | `LiteLLM_Config` | management_endpoints/cache_settings_endpoints.py:252/364 |
| GET `/get/ui_settings` / PATCH `/update/ui_settings` | UI flags | `LiteLLM_UISettings` | ui_crud_endpoints/proxy_setting_endpoints.py:1230/1285 |
| GET `/get/config/callbacks` | Router settings + callbacks for UI | config DB | PS:15318 |
| POST `/config/update` | Persist router settings/fallbacks/retry policy | `LiteLLM_Config` per-section upsert | PS:14342 |
| GET `/guardrails/usage/overview` | Guardrail pass rate/blocked/latency | `LiteLLM_DailyGuardrailMetrics` | guardrails/usage_endpoints.py:261 |
| GET `/tag/dau|wau|mau|summary|distinct`, `/tag/user-agent/per-user-analytics` | User-agent activity analytics | tag-based daily spend | (UI calls `networking.tsx:6932-7067`) |

**Response shapes (key ones):**
- Daily activity: `SpendAnalyticsPaginatedResponse{results:[DailySpendData{date, metrics:SpendMetrics, breakdown:BreakdownMetrics}], metadata:DailySpendMetadata}`. `SpendMetrics` = `spend, prompt_tokens, completion_tokens, cache_read_input_tokens, cache_creation_input_tokens, compression_saved_tokens, compression_savings_spend, prompt_caching_savings_spend, total_tokens, successful_requests, failed_requests, api_requests` (`litellm/types/proxy/management_endpoints/common_daily_activity.py:19-31`). `breakdown` buckets: `models, model_groups, providers, endpoints, mcp_servers, api_keys, entities` — each with its own metrics + nested `api_key_breakdown` (`common_daily_activity.py:95-265`).
- `/spend/logs/ui`: `{data, total, page, page_size, total_pages, total_is_capped}`; rows exclude `messages/response/proxy_server_request` and compute `request_duration_ms`; sortable by `spend,total_tokens,startTime,endTime,request_duration_ms,model,ttft_ms` (SM:1613-1674, 1987-2001).
- `/global/activity`: `{daily_data:[{date, api_requests, total_tokens}], sum_api_requests, sum_total_tokens}` (SM:353-362).
- `/model/metrics`: `{data:[{date, "<model>": avg_latency_per_token}], all_api_bases}` (PS:12286-12319).
- `/cache/ping`: `CachePingResponse{status, cache_type, ping_response, set_cache_response, litellm_cache_params, health_check_cache_params}` (caching_routes.py:51-120).

**Performance note:** Old Usage/Activity and model-metrics endpoints scan raw `LiteLLM_SpendLogs` (some via materialized views needing `POST /global/spend/refresh`); the New Usage family reads pre-aggregated `LiteLLM_Daily*Spend` tables — the intended path at >1M logs. `/view/spend/tables` does not exist anywhere.

---

## Cache & optimization visibility

Where the UI surfaces cache hits / savings (complete list):

1. **Cost Optimization page** — the only *dollar-savings* view: Total saved, Compression savings (+tokens compressed), **Prompt caching savings** ("Cache read discount"), savings-over-time area, savings-by-driver donut (`CostOptimizationView.tsx:107-151`), from `compression_savings_spend` / `prompt_caching_savings_spend` / `compression_saved_tokens` daily metrics (populated backend-side by `litellm/proxy/spend_tracking/compression_savings.py` and `savings.py`).
2. **Caching dashboard** — Cache Hit Ratio %, Cache Hits count, Cached Tokens, hits-vs-requests and cached-vs-generated-token bar charts per call_type (`cache_dashboard.tsx:319-387`; feed GET `/global/activity/cache_hits`). No dollar figure.
3. **Log detail drawer** — per-request Cache Hit tag + Cache Read/Creation token counts (`LogDetailContent.tsx:288-343`) and Cache Read/Write **cost** line items with "(Cached)" $0 totals (`CostBreakdownViewer.tsx:85-162`). No cache column/filter in the logs table itself.
4. **Usage page** — Cache Read/Write token totals in the token breakdown (`UsagePageView.tsx:658-685`), per-model "Prompt Caching Metrics" charts (`activity_metrics.tsx:159-171`), and "Cache Read Input Tokens" columns in CSV export (`EntityUsageExport/utils.ts:24,129`).
5. **Model config** — per-model `cache_read_input_token_cost` input (`add_model/advanced_settings.tsx:217-218`, `model_info_view.tsx:351-364`) and cache-control injection settings (`add_model/cache_control_settings.tsx`); Router Settings → Prompt Caching tab toggles `enable_anthropic_prompt_caching` (+TTL).
6. **Playground** — live per-response cost/TTFT/latency/token metrics (`chat_ui/ResponseMetrics.tsx:33-94`), useful for A/B-ing prompt shapes.

Gaps worth knowing: no cache-hit-rate-over-time chart, no "cost saved by caching" on the Caching dashboard (only Cost Optimization has $), no latency cached-vs-uncached comparison, no UI for `/cache/flushall`/`/cache/redis/info`, and the per-model latency/exception analytics tab was removed from the UI (backend `/model/metrics*` routes remain callable).

---

## Code References

**UI (under `ui/litellm-dashboard/src/`):**
- `components/leftnav.tsx:116-329` — full navigation config
- `components/networking.tsx` — all endpoint wrappers (lines cited inline above)
- `app/(dashboard)/usage/_components/components/UsagePageView.tsx` — New Usage container; `EntityUsage/EntityUsage.tsx:101-108` — entity endpoint dispatch; `hooks/usePaginatedDailyActivity.ts` — pagination/fallback
- `components/activity_metrics.tsx:363-502` — breakdown → charts transform
- `app/(dashboard)/cost-optimization/_components/CostOptimizationView.tsx` — savings view
- `components/view_logs/index.tsx`, `columns.tsx:107-431`, `LogDetailsDrawer/LogDetailsDrawer.tsx:118-164` (session mode), `LogDetailContent.tsx:281-380`, `CostBreakdownViewer.tsx`
- `app/(dashboard)/caching/_components/cache_dashboard.tsx`, `cache_health.tsx`
- `app/(dashboard)/models-and-endpoints/ModelsAndEndpointsView.tsx:332-483`, `components/AllModelsTab.tsx`, `components/ModelRetrySettingsTab.tsx`
- `components/AIHub/ModelHubTable.tsx`, `ModelHubTableColumns.tsx`
- `app/(dashboard)/router-settings/_components/general_settings.tsx`, `components/router_settings/`, `components/routing_groups/`, `components/Settings/RouterSettings/Fallbacks/Fallbacks.tsx`
- `app/(dashboard)/playground/components/chat_ui/ChatUI.tsx`, `components/llm_calls/chat_completion.tsx`, `components/chat_ui/ResponseMetrics.tsx`
- `components/VirtualKeysPage/keyTableColumns.tsx`, `components/TeamsPage/teamTableColumns.tsx`, `app/(dashboard)/users/_components/view_users/columns.tsx`, `app/(dashboard)/organizations/_components/organizations.tsx`, `app/(dashboard)/budgets/_components/`, `app/(dashboard)/tag-management/_components/`
- `components/shared/table_cells/spend_budget_cell.tsx` — shared spend/budget meter
- `components/user_agent_activity.tsx`, `components/per_user_usage.tsx`

**Backend (under `litellm/proxy/`):**
- `spend_tracking/spend_management_endpoints.py` — 27 routes (lines in table above)
- `management_endpoints/common_daily_activity.py:381-501,557-940` — GROUPING SETS aggregation + breakdown assembly
- `management_endpoints/internal_user_endpoints.py:2452,2561`; `team_endpoints.py:5095`; `tag_management_endpoints.py:614`; `organization_endpoints.py:322`; `customer_endpoints.py:789`
- `proxy_server.py:12125,12255,12370,12459` — model metrics; `:14342` config update; `:15318` callbacks
- `caching_routes.py:51-240`; `management_endpoints/cache_settings_endpoints.py:252,364`
- `management_endpoints/usage_endpoints/endpoints.py:30` — `/usage/ai/chat`
- `ui_crud_endpoints/proxy_setting_endpoints.py:1230,1285`
- `guardrails/usage_endpoints.py:261`
- `litellm/types/proxy/management_endpoints/common_daily_activity.py:19-98` — SpendMetrics / response models
