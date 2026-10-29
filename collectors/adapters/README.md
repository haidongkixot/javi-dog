# JD-C02 · `@javis-dog/collector-adapters` — platform adapters for `javi`

Status: **in-progress** (S5b). Pure functions that turn Gemini CLI (and, in S5c, Codex CLI) signals into JGR records for the `javi` collector (JD-C01). No I/O; JD-C01 owns settings files, state, spool, receiver and delivery. Decision: [ADR-0016](../../docs/adr/0016-gemini-and-codex-collectors.md).

| Export                                                                                 | Contract                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `mapGeminiHook(raw, ctx)`                                                              | Gemini hook stdin → JGR record or `null` (allowlist; prompts, responses, tool I/O, paths never read)                                  |
| `geminiThreadRef(sessionId, salt)`                                                     | `opaqueRef('gm', sessionId, salt)`: HMAC-SHA-256, first 32 hex chars (same scheme as JD-C01)                                          |
| `parseGeminiMetrics(body)`                                                             | OTLP/HTTP JSON → usage points from `gemini_cli.token.usage` only (`session.id`, `model`, `type`)                                      |
| `geminiUsageDelta(delta, model, at)`                                                   | Final counters: input − cache (clamped), estimated cost from the price table                                                          |
| `GEMINI_PRICES`, `estimateGeminiCostUsd(model, counters, at)`, `findGeminiPrice`       | Dated Vertex AI price table (USD per 1M tokens), estimate (`null` for unknown models) and the row valid at a date (exact id match)     |
| `GEMINI_HOOK_EVENTS`, `GEMINI_PLATFORM`, `GEMINI_THREAD_PREFIX`, `GEMINI_TOKEN_METRIC` | Constants                                                                                                                             |

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

## Usage and estimated cost (ADR-0016 §3–§4)

- `parseGeminiMetrics` returns raw points; cumulative → delta and grouping stay in JD-C01 (ADR-0011 baselines).
- `geminiUsageDelta` carries only `input_tokens` (= input − cache_read, clamped at 0, set only when there is an input delta), `output_tokens`, `cache_read_tokens` and `reasoning_tokens`. Zero counters are kept as computed; dropping groups with no counter > 0 is the caller's job (as JD-C01's `toUsageGroups` does). A group with any raw counter > 0 keeps one after the clamp.
- Cost = (input × inputPerM + cache_read × cachedInputPerM + (output + reasoning) × outputPerM) / 1e6, rounded to 1e-9 USD; `estimated: true` with `cost_usd` when the model has a price valid at `at`, else no `cost_usd` and `estimated: false`.
- Price table: Vertex AI pricing page read 2026-10-29, Standard tab, Global, ≤ 200k tokens. Each row in `src/prices.ts` quotes its page fragment. Intro windows: `validUntil` exclusive, `validFrom` inclusive, UTC midnight. Limitations: the ≤ 200k tier is assumed (the metric has no per-request prompt size), and AI Studio (API key) prices can differ from Vertex.
