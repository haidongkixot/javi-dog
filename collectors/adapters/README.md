# JD-C02 · `@javis-dog/collector-adapters` — platform adapters for `javi`

Status: **in-progress** (S5b). Pure functions that turn Gemini CLI (and, in S5c, Codex CLI) signals into JGR records for the `javi` collector (JD-C01). No I/O; JD-C01 owns settings files, state, spool, receiver and delivery. Decision: [ADR-0016](../../docs/adr/0016-gemini-and-codex-collectors.md).

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
