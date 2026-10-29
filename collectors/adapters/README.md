# JD-C02 · `@javis-dog/collector-adapters` — platform adapters for `javi`

Status: **in-progress** (S5b, S5c). Pure functions that turn Gemini CLI and Codex CLI signals into JGR records for the `javi` collector (JD-C01). No I/O; JD-C01 owns settings files, state, spool, receiver and delivery. Decision: [ADR-0016](../../docs/adr/0016-gemini-and-codex-collectors.md).

| Export                                                                                 | Contract                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapGeminiHook(raw, ctx)`                                                              | Gemini hook stdin → JGR record or `null` (allowlist; prompts, responses, tool I/O, paths never read)                                            |
| `geminiThreadRef(sessionId, salt)`                                                     | `opaqueRef('gm', sessionId, salt)`: HMAC-SHA-256, first 32 hex chars (same scheme as JD-C01)                                                    |
| `parseGeminiMetrics(body)`                                                             | OTLP/HTTP JSON → usage points from `gemini_cli.token.usage` only (`session.id`, `model`, `type`), plus in-memory-only `seriesId` and `authType` |
| `geminiUsageDelta(delta, model, at, authType)`                                         | Final counters: input − cache (clamped), estimated cost only for per-token-billed auth, always `estimated: false`                                |
| `GEMINI_PRICES`, `estimateGeminiCostUsd(model, counters, at)`, `findGeminiPrice`       | Dated Vertex AI price table (USD per 1M tokens), estimate (`null` for unknown models) and the row valid at a date (exact id match)               |
| `GEMINI_AUTH_TYPES`, `GEMINI_PRICED_AUTH_TYPES`                                        | gemini-cli `AuthType` allowlist, and the per-token-billed subset (`vertex-ai`, `gemini-api-key`)                                                |
| `GEMINI_HOOK_EVENTS`, `GEMINI_PLATFORM`, `GEMINI_THREAD_PREFIX`, `GEMINI_TOKEN_METRIC` | Constants                                                                                                                                       |

## Hook mapping (ADR-0016 §2)

| Gemini hook                                   | JGR record                                 |
| --------------------------------------------- | ------------------------------------------ |
| `SessionStart`                                | `session.started`, status `working`        |
| `SessionEnd`                                  | `session.ended`, status `completed`        |
| `BeforeAgent`                                 | `heartbeat`, status `working`              |
| `AfterAgent`                                  | `heartbeat`, status `idle`                 |
| `BeforeTool`                                  | `task.started`, `attributes.tool_name`     |
| `AfterTool`                                   | `task.completed`, `attributes.tool_name`   |
| `Notification` with `notification_type` `ToolPermission` | `attention.requested`, status `waiting` |
| anything else (other notifications, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `PreCompress`, unknown) | `null` |

Statuses match JD-C01's Claude Code equivalents. Only `session_id`, `hook_event_name`, `tool_name` (tool events, ≤ 128 chars) and `notification_type` are read; `attributes` holds `platform: gemini-cli`, `collector_version` and, for tool events, `tool_name`. The hook `timestamp` is not read: the SDK stamps `occurred_at`, as in JD-C01. `AfterTool` is always `task.completed` (failure is only visible inside `tool_response`).

## Usage and estimated cost (ADR-0016 §3–§4, Changes R4–R6)

- `parseGeminiMetrics` returns raw points; cumulative → delta and grouping stay in JD-C01 (ADR-0011 baselines, ADR-0016 Changes R2–R3).
- **In-memory-only fields.** Each point also carries two **non-enumerable** properties, so `JSON.stringify`, object spread and `structuredClone` never copy them into a spool, state file or batch; read them directly (`point.seriesId`):
  - `seriesId` (R4): SHA-256 (hex) over **all** the data point's attributes (sorted by key, values as sent, including `user.email`, `auth_type`, `experiments.ids`, `interactive`), its `startNs` and the resolved session id. Gemini adds those attributes to every point, so one (session, model, type) can have several cumulative series; JD-C01 keeps one baseline per `seriesId`. The attribute values themselves are never kept.
  - `authType` (R6): the point's `auth_type` when it is one of `GEMINI_AUTH_TYPES` (`oauth-personal`, `gemini-api-key`, `vertex-ai`, `cloud-shell`, `compute-default-credentials`, `gateway`); absent otherwise.
- `geminiUsageDelta` carries only `input_tokens` (= input − cache_read, clamped at 0, set only when there is an input delta), `output_tokens`, `cache_read_tokens` and `reasoning_tokens`. Zero counters are kept as computed; dropping groups with no counter > 0 is the caller's job (as JD-C01's `toUsageGroups` does). A group with any raw counter > 0 keeps one after the clamp. `authType` is never copied into the output.
- `estimated` is always `false` (R5): Gemini's token counts are exact, and JGR §6 reserves `estimated: true` for counts a producer cannot read exactly. Every cost is labelled estimated in the UI (ADR-0013).
- Cost (R6) only when `authType` is `vertex-ai` or `gemini-api-key` (per-token billing) and the model has a price valid at `at`: (input × inputPerM + cache_read × cachedInputPerM + (output + reasoning) × outputPerM) / 1e6, rounded to 1e-9 USD. Any other or missing auth type (for example a Google login, which is not billed per token) or an unpriced model gets tokens only, no `cost_usd`.
- Price table: Vertex AI pricing page read 2026-10-29, Standard tab, Global, ≤ 200k tokens. Each row in `src/prices.ts` quotes its page fragment. Intro windows: `validUntil` exclusive, `validFrom` inclusive, UTC midnight. Limitations: the ≤ 200k tier is assumed (the metric has no per-request prompt size), and the AI Studio (API key) price can differ from the Vertex list price the table holds.

## Codex CLI (ADR-0016 Changes "S5c design" C1–C6 and "S5c design review" H1–H6, M1–M5)

| Export | Contract |
|---|---|
| `mapCodexHook(raw, ctx)` | Codex hook stdin → JGR record or `null` (allowlist; prompts, tool I/O, assistant messages, paths, `permission_mode`, `model` never read) |
| `codexSubagentLink(raw)` | `SubagentStart` payload → `{ agentId, sessionId }` (raw; JD-C01 hashes both before storing) or `null` |
| `codexThreadRef(sessionId, salt)`, `codexAgentRef(agentId, salt)` | `opaqueRef('cx', …)` and `opaqueRef('ag', …)`: HMAC-SHA-256, first 32 hex chars (same scheme as JD-C01) |
| `parseCodexLogs(body)` | OTLP/HTTP JSON logs → token records (`codex.sse_event` `response.completed`) and cost records (`codex.turn_cost`) only |
| `codexUsageDelta(record)` | H3 counters: input − cached − cache write (clamped), `estimated: false` |
| `codexCostDelta(record)` | `{ cost_usd, estimated: false }` only for `ApiKey` auth, else `null` |
| `CODEX_HOOK_EVENTS`, `CODEX_PLATFORM`, `CODEX_THREAD_PREFIX`, `CODEX_AGENT_PREFIX`, `CODEX_AUTH_MODES`, `CODEX_PRICED_AUTH_MODES`, `CODEX_SSE_EVENT`, `CODEX_RESPONSE_COMPLETED`, `CODEX_TURN_COST_EVENT`, `CODEX_LOGS_PARSE_ERROR` | Constants |

### Hook mapping (C2, review Low, M4)

| Codex hook | JGR record |
|---|---|
| `SessionStart` (`source` `startup`, `clear`, `fork` or missing) | `session.started`, status `working` |
| `SessionStart` (`source` `compact` or `resume`) | `heartbeat`, status `working` |
| `SessionEnd` | `session.ended`, status `completed` |
| `UserPromptSubmit` | `heartbeat`, status `working` |
| `PreToolUse` / `PostToolUse` | `task.started` / `task.completed`, `attributes.tool_name` (≤ 128 chars) |
| `PermissionRequest` | `attention.requested`, status `waiting` |
| `Stop` | `heartbeat`, status `idle` |
| `SubagentStart` / `SubagentStop` (with `agent_id`) | `agent.started` (`working`) / `agent.stopped` (`completed`), `agent_ref` |
| anything else (`Interrupt`, `PreCompact`, `PostCompact`, model-request events, unknown) | `null` |

- `thread_ref` = `opaqueRef('cx', session_id, salt)`; `attributes` holds `platform: codex-cli` and `collector_version` (plus `tool_name` on tool events). Statuses match JD-C01's Claude Code mapping.
- Codex sends the **root** `session_id` on sub-agent hooks, so a sub-agent's events land on the parent thread. `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest` and the sub-agent events carry `agent_ref = opaqueRef('ag', agent_id, salt)` when `agent_id` is set (as JD-C01 does for Claude Code). `SessionStart`, `SessionEnd` and `Stop` have no `agent_id` in Codex's schema.
- Only `session_id`, `hook_event_name`, `source` (SessionStart), `tool_name` (tool events) and `agent_id` are read. `PostToolUse` is always `task.completed`: failure is only visible inside `tool_response`. `PermissionRequest` does not carry `tool_name`, like the Claude Code and Gemini attention events.

### Logs allowlist (C4, M2)

- Per log record only `attributes` is read (never `body`, the resource or the scope). An attribute's `value` is read only for allowlisted keys; for any other record only the `event.name` value is read.
- **Tokens:** `event.name` = `codex.sse_event`, `event.kind` = `response.completed`, **no** `error.message` key (the failure variant has the same name and kind), and `input_token_count`, `cached_token_count`, `cache_write_token_count`, `output_token_count` all present as non-negative safe integers, each given as `stringValue` (decimal string) or `intValue` (JSON string or number). Also required: `conversation.id`, `model` (≤ 64 chars, the JGR limit) and `event.timestamp` (RFC 3339 with offset). `auth_mode` is kept only when it is `ApiKey` or `Chatgpt` (Codex `TelemetryAuthMode`), else `null`.
- **Cost:** `event.name` = `codex.turn_cost` with `usage.estimated_usd` matching `^\d+(\.\d+)?$`, `turn.id` and `conversation.id`; `auth_mode` as above.
- Ids (`conversation.id`, `turn.id`, `event.timestamp`) must be ≤ 256 chars without NUL. The raw ids stay in memory; the caller hashes them.
- Never read: `tool_token_count` (it is the **total**), `reasoning_token_count` (a subset of output), `user.email`, `user.account_id` and every other attribute or record (`codex.tool_result`, `codex.user_prompt`, …). `ignored` counts log records that produced nothing.
- `ok: false` with the constant `CODEX_LOGS_PARSE_ERROR` (never body content) only when the body is not a JSON object or `resourceLogs` is not an array; an absent or null `resourceLogs` is an empty request.

### Usage, cost and event ids (H3, C5)

- `codexUsageDelta`: `input_tokens` = max(0, input − cached − cache write), because Codex's input includes both (official test: 100 = 40 + 60); `cache_read_tokens` = cached; `cache_write_tokens` = cache write; `output_tokens` = output; `model`; `estimated: false`. Zero counters are kept; dropping empty records is the caller's job.
- `codexCostDelta`: only `auth_mode` `ApiKey` (`CODEX_PRICED_AUTH_MODES`) → `{ cost_usd, estimated: false }`, rounded to 1e-9 USD. `Chatgpt`, missing or any other auth mode → `null`: tokens only, no budget impact. A missing cost is never zero; a parsed `"0"` is a real zero. The figure is OpenAI's (or the provider's) estimate, labelled estimated in the UI (ADR-0013).
- Event ids are not computed here: JD-C01 (`codex-usage.ts`, `codexTokenEventId` / `codexCostEventId`) derives them from the records with a record-kind tag, so that formula has a single source.
