# ADR-0011: Token usage through a local OTLP receiver in the collector

- Status: **Accepted** 2026-10-28 (owner: "local in the collector", then "opt-in global OTel" after the settings constraint below was found)
- Date: 2026-10-28
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules: JD-C01, JD-M02; consumes JD-M01
- Supersedes: the S3d follow-up in ADR-0010 ("local OTLP receiver or server-side receiver")

## Context and problem statement

Hooks (ADR-0010) give lifecycle and attention signals but no token usage. Claude Code exports `claude_code.token.usage` (attribute `type` = `input` / `output` / `cacheRead` / `cacheCreation`, plus `model`) and `claude_code.cost.usage` (USD) as OpenTelemetry metrics. Facts verified 2026-10-28 against `code.claude.com/docs/en/monitoring-usage` and `/settings-reference` (Researcher lane; the orchestrator re-fetched and confirmed rows 1 and 2):

1. Claude Code **ignores the OTel exporter variables in a repository's `.claude/settings.json` and `.claude/settings.local.json`**; they work in managed settings, the shell, or `~/.claude/settings.json`. A value in a settings `env` overrides the shell.
2. Metrics temporality defaults to **delta**; export interval 60 s; protocols `grpc`, `http/json`, `http/protobuf`, with no default.
3. Every data point carries `session.id`; `user.email`, `user.id`, `organization.id`, `terminal.type` are always included when available; `user.account_uuid` unless `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`.
4. Cost metrics "are approximations".
5. **UNVERIFIED:** that OTel `session.id` equals the hooks' `session_id`.

OTLP/HTTP JSON (opentelemetry.io OTLP spec): `POST /v1/metrics`, `application/json`, lowerCamelCase fields, 64-bit integers as decimal strings or numbers, unknown fields ignored, optional gzip, success = `200` with an `ExportMetricsServiceResponse`.

## Considered options

1. **Opt-in global OTel + local receiver** — `javi usage on` writes the exporter variables to `~/.claude/settings.json` and runs a receiver on `127.0.0.1`.
2. Shell exports printed for the user to add manually; same receiver.
3. Read token counts from the session transcript in the `Stop` hook (no OTel).
4. Server-side OTLP receiver on Vercel (spec §12 edge rules).

## Decision outcome

**Option 1** (owner, 2026-10-28). Option 2 is error-prone; option 3 depends on an undocumented file format and has no cost; option 4 sends identity attributes over the network before they are dropped and needs a new public endpoint.

- **Opt-in and reversible.** `javi usage on [--port <n>]` (also `javi init --usage`) backs up `~/.claude/settings.json` once, then merges into its `env`: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/json`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://127.0.0.1:<port>/v1/metrics`, `OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer <local secret>`, `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`. Logs and traces exporters are **not** set, so no prompt or tool content is exported. It **refuses** (and changes nothing) when the file is unparsable, or when any `CLAUDE_CODE_ENABLE_TELEMETRY` / `OTEL_*` variable is already set in that file or in the current shell by someone else — `javi` never takes over an existing telemetry setup. `javi usage off` removes only the keys whose values are still the ones `javi` wrote.
- **Receiver.** `javi receive` listens on `127.0.0.1:<port>` (default **4319**, not the OTLP default 4318, so a user's own collector keeps working). It accepts `POST /v1/metrics` and `/`, requires the bearer secret (401), a loopback `Host` (403, DNS-rebinding guard), `application/json` (415; `http/protobuf` is not offered locally), gzip or identity encoding (415 otherwise), ≤ 1 MiB decoded (413), and answers `200 {}`. Malformed JSON → 400.
- **Lifecycle.** No OS service. Every hook (when usage is on) checks `~/.javi/receiver.json` (pid, port) and, if the receiver is not alive, starts a detached `javi receive`; a second instance exits when the port is taken. The receiver exits after 30 min without requests. Metrics exported while no receiver ran are lost (Claude Code only retries briefly); `javi status` shows the receiver state.
- **Parsing (allowlist).** Only `claude_code.token.usage` and `claude_code.cost.usage` Sum data points are read, and from their attributes only `session.id`, `model` and `type` (data point; `session.id` falls back to the resource block when the point has none, because the docs do not say where standard attributes sit). Every other attribute — identity (`user.email`, `user.id`, `user.account_uuid`, `organization.id`), `terminal.type`, resource attributes — is never copied. `asInt` (string or number) and `asDouble` are accepted.
- **Temporality.** Delta points are used as-is. Cumulative points (possible only if managed settings force it) become deltas against an in-memory baseline per series; the first point of a series without a baseline only sets the baseline (it can under-count once after a receiver restart; it never double-counts). A counter going backwards starts a new baseline.
- **Mapping → JGR.** Points are grouped by (`session.id`, `model`, `startTimeUnixNano`, `timeUnixNano`) into one `usage.reported` event: `usage_delta` = `{ input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, model, estimated: false }` (all-zero groups are skipped), `occurred_at` = the point's end time, `thread_ref` = `opaqueRef('cc', session.id, salt)` — the same ref the hooks produce — and `sequence` from the shared per-thread counter. Token counts are exact, hence `estimated: false`; the cost is Claude Code's approximation and the dashboard (S4) must label cost as estimated.
- **Idempotent retries.** `event_id` = a canonical lowercase UUID (version 8 layout) from HMAC-SHA-256(salt, group key). An export that Claude Code retries yields the same id, so the receiver-side dedupe (JGR §9) drops it. JD-M02 `RecordInput` gains an optional `event_id` (additive).
- **Project attribution.** Telemetry is machine-wide, so the receiver forwards only sessions it can attribute: each hook records `thread_ref → project` in `~/.javi/sessions/` (hashed refs only, pruned after 7 days). Points of unknown sessions are **dropped locally** and counted (`javi status`). Usage of projects that never ran `javi init` never leaves the machine.
- **Delivery.** Events go to the project's spool; the receiver runs the existing locked `runFlush` in-process, debounced to one flush per 3 s.

## Consequences

- Positive: documented contract (OTel) with cost; no prompt or identity data leaves the machine; nothing is changed in the user's telemetry setup without an explicit command; reversible.
- Negative: a machine-wide settings change (opt-in); a background process; up to 60 s lag (export interval); usage before the first hook of a session, or while no receiver runs, is lost; cumulative baseline is in memory.
- Risk (UNVERIFIED fact 5): if OTel `session.id` differs from the hook `session_id`, every point is unattributed and dropped (visible in `javi status`, never sent wrongly). The owner's first real run is the runtime check; readiness row "OTel session correlation".
- Spec §12: the local receiver is a collector component, not the serverless edge; it accepts `http/json` only. Recorded in the spec changelog.
