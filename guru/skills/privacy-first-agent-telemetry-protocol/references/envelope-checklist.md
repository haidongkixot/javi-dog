# Envelope checklist and reference values

Reference material for the `privacy-first-agent-telemetry-protocol` skill. Values are the origin project's v0.1 draft choices; treat them as a starting point, not a standard.

## Field table

| Field | Requirement | Rule |
|---|---|---|
| protocol version | MUST | Exact string, e.g. `"0.1"`; unknown versions rejected |
| `event_id` | MUST | ULID or UUID; deduplication key together with `producer_id` |
| `producer_id` | MUST | Stable per installation; opaque |
| `project_ref` | MUST | Registered project slug or ID |
| `thread_ref` | MUST | One session in one tool; salted hash or random token, never a path |
| `agent_ref` | MAY | Main agent or subagent within the thread; opaque |
| `sequence` | MUST | Non-negative integer, strictly increasing per (`producer_id`, `thread_ref`) |
| `type` | MUST | Core type or `x.<vendor>.<name>` extension; extensions stored, not interpreted |
| `status` | conditional | Required for heartbeat and agent start/stop; `stale` is never sent |
| `occurred_at` | MUST | RFC 3339 with offset; future skew limit (origin: 5 min) |
| `usage_delta` | conditional | Required for usage reports; at least one counter |
| `privacy_class` | SHOULD | Default lowest class |
| `attributes` | MAY | Bounded map (origin: 16 keys, strings up to 128 chars, numbers, booleans); allowlisted per class |
| `encrypted` | conditional | Required if and only if the highest class is used |

Opaque-reference shape (recommended after the G1 probe): `<prefix>_<token>` where the token is a fixed-length lowercase base32/hex string, for example `^[a-z]{2,8}_[0-9a-z]{8,64}$`. This cannot carry `/`, `.`, `@` or spaces, so paths, emails and sentences fail validation.

## Core event types

| Type | Meaning |
|---|---|
| `session.started` / `session.ended` | Thread lifecycle |
| `agent.started` / `agent.stopped` | Main agent or subagent lifecycle (status required) |
| `heartbeat` | Still alive, with current status (status required) |
| `task.started` / `task.completed` / `task.failed` | Unit of work: tool call, plan step, test run |
| `attention.requested` | Waiting for a human (approval, question) |
| `usage.reported` | Token/cost delta (usage required) |
| `error` | Producer- or tool-level error, with an error code attribute |

Status values used: `working`, `waiting`, `idle`, `blocked`, `failed`, `completed`.

## Usage delta counters

`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` (non-negative integers), `cost_usd` (non-negative number), `model`, `estimated` (default `false`).

## Limits used in the origin

| Limit | Value |
|---|---|
| Event size | 8 KB hard, 4 KB target (target is a hypothesis) |
| Batch | 1–100 events, 256 KB uncompressed |
| Reference length | 128 characters |
| Future clock skew | 5 minutes |

## Error codes

`schema`, `too_large`, `privacy_forbidden_attribute`, `privacy_unhashed_identifier`, `privacy_encrypted_requires_l2`, `privacy_l2_requires_encrypted`, `status_required`, `usage_required`, `clock_skew`.

## Conformance vector set to start with

Valid: minimal heartbeat; usage report with reasoning tokens; attention request; subagent started; extension type; hashed identifiers in the middle class; encrypted payload in the top class.

Invalid: wrong version; unknown top-level field; missing thread; heartbeat without status; usage report without delta; negative token count; `stale` sent by a producer; future timestamp; forbidden attribute in the default class; file path as an attribute; unhashed identifier in the middle class; encrypted payload in the default class; top class without payload.

Add after the G1 probe: path-shaped `thread_ref`; email-shaped `agent_ref`; unknown optional field from a higher minor version (expected verdict per your forward-compatibility rule).

## Tool-native telemetry facts (dated)

Retrieved 2026-10-20 by the origin's research agent from official docs or official source repositories. Tool behaviour changes; re-verify before relying on any of these.

| Fact | Source | Verification |
|---|---|---|
| Claude Code OTel standard attributes include `user.email`, "always included when available" | <https://code.claude.com/docs/en/monitoring-usage> | Spot-checked by direct fetch |
| Claude Code redacts prompt content by default; `OTEL_LOG_USER_PROMPTS=1` enables it | same page | Spot-checked |
| Claude Code `OTEL_EXPORTER_OTLP_PROTOCOL` has no default (`grpc`, `http/json`, `http/protobuf`) | same page | Spot-checked |
| Claude Code `UserPromptSubmit` hook input contains the raw prompt text | <https://code.claude.com/docs/en/hooks> | Research agent only |
| Gemini CLI telemetry `logPrompts` defaults to `true` | <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md> | Research agent, via GitHub source (docs site blocked) |
| Codex CLI `log_user_prompt` defaults to `false`; OTLP over HTTP (json or binary) or gRPC | <https://github.com/openai/codex/blob/main/codex-rs/config/src/types.rs> | Research agent, via source code (docs site blocked) |
| OTel GenAI semantic conventions are Development status; token metrics renamed after v1.41 | <https://github.com/open-telemetry/semantic-conventions-genai> | Research agent, via GitHub (opentelemetry.io blocked) |
| CloudEvents 1.0.2: `source` + `id` unique per event; re-sends keep the same `id` | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md> | Research agent |
| `Idempotency-Key` header is an IETF draft, not an RFC | `draft-ietf-httpapi-idempotency-key-header` | Draft status NOT VERIFIED (datatracker blocked) |

Added 2026-10-28 (origin G2; Researcher lane in S3e, re-fetched by the orchestrator and again by Guru at G2):

| Fact | Source | Verification |
|---|---|---|
| Claude Code ignores the OTel exporter variables in a repository's `.claude/settings.json` and `.claude/settings.local.json`; set them in managed settings, the shell or `~/.claude/settings.json` | <https://code.claude.com/docs/en/monitoring-usage> (l. 69 of the `.md` page at G2) | Researcher; re-fetched by the S3e orchestrator and at G2 |
| Metrics temporality defaults to `delta` (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`) | same page (l. 131) | Re-fetched (S3e, G2) |
| `session.id` is Claude Code's own session id, which `/clear` replaces; `OTEL_METRICS_INCLUDE_SESSION_ID` defaults to true | same page (l. 153, 583) | Read at G2 |
| That the OTel `session.id` equals the hooks' `session_id` | — | NOT VERIFIED (docs silent at G2); runtime check pending |
| OTLP/HTTP JSON: unknown fields MUST be ignored; an empty request SHOULD succeed | OTLP specification, read from the `opentelemetry-proto` repository (website blocked) | QA lane (S3e) |
