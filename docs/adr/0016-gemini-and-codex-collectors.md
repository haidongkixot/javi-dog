# ADR-0016: Gemini CLI and Codex CLI collectors in `javi`

- Status: **Accepted** 2026-10-29. Owner answers:
  - "Opt-in logs, allowlist" for Codex usage.
  - "Price table, estimated" for Gemini cost.
  - "User-level opt-in" for Gemini OTel.
  - "S5b Gemini, S5c Codex".
- Date: 2026-10-29
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules: JD-C02 (new, `@javis-dog/collector-adapters`), JD-C01 (`javi` wiring), JD-M01 (spec §12 Changes); consumes JD-M02

## Context and problem statement

The roadmap's S5 needs the Codex and Gemini CLI collectors (owner priority "Claude Code, Codex/Gemini CLI, GitHub"). The S5b research used primary sources only: the official repositories `google-gemini/gemini-cli` at `b8fa817` and `openai/codex` at `7c11b80`, both read 2026-10-28. `developers.openai.com` and `docs.cloud.google.com` are blocked from the sandbox. The orchestrator re-checked two facts directly: Gemini `logPrompts` defaults to `true`, and Codex `PROJECT_LOCAL_CONFIG_DENYLIST` contains `otel` and `notify`. A third fact was checked in `googleapis/js-genai` `src/types.ts`: `promptTokenCount` "When `cached_content` is set, this also includes the number of tokens in the cached content".

| | Gemini CLI | Codex CLI |
|---|---|---|
| Hooks | `.gemini/settings.json` (project, trusted folder only) or `~/.gemini/settings.json`; shell command; **synchronous** (SessionEnd best effort); stdin `session_id`, `hook_event_name`, … | `.codex/hooks.json` or `[hooks]`; shell command; each hook **must be approved** (`trusted_hash`) before it runs |
| Session id | hook `session_id` = OTel `session.id` (same `config.getSessionId()`) | hook `session_id`; OTel `conversation.id` (equality UNVERIFIED) |
| OTel scope | project or user; env overrides | **user only** (project `otel` ignored) |
| OTLP HTTP JSON | `otlpProtocol: "http"` sends metrics, logs and traces to one endpoint | `otlp-http`, `protocol = "json"` |
| Tokens | `gemini_cli.token.usage` counter with `session.id`, `model`, `type` ∈ input/output/thought/cache/tool, **cumulative** | per-session only in logs (`codex.sse_event` `response.completed` + `conversation.id`); `codex.turn.cost_microusd` |
| Cost | none | yes (fetched by Codex from OpenAI) |
| Content by default | prompts **on** (`logPrompts: true`); tool args and response text in logs | tool arguments, output previews and `user.email` in logs |

## Decision outcome

1. **One CLI, platform adapters.** `javi` (JD-C01) stays the only program the user installs. A new pure package, JD-C02 `@javis-dog/collector-adapters` (`collectors/adapters`, replacing the planned "otel-bridge"), holds the per-platform logic and does no I/O:
   - hook payload → JGR record mappers;
   - OTLP allowlist parsers;
   - the price table.

   JD-C01 keeps the I/O: settings files, state, spool, receiver and delivery. `javi init --platform <claude-code|gemini-cli|codex-cli>` defaults to `claude-code`, so existing installs are unchanged.
2. **Gemini hooks (S5b).**
   - **Where:** `javi init --platform gemini-cli` writes hook entries, marked `javi-collector`, into the project's `.gemini/settings.json`, with a backup, merging, and an uninstall path. The entries hold no secret: the token stays in `~/.javi`.
   - **Event mapping** (allowlist):

     | Gemini hook | JGR event |
     |---|---|
     | `SessionStart` | `session.started` |
     | `SessionEnd` | `session.ended` |
     | `BeforeAgent` | `heartbeat` `working` (prompt discarded) |
     | `AfterAgent` | `heartbeat` `idle` (prompt and response discarded) |
     | `BeforeTool` | `task.started` (`tool_name` only) |
     | `AfterTool` | `task.completed` (`tool_name` only) |
     | `Notification` `ToolPermission` | `attention.requested` `waiting` |

     Everything else is dropped. Tool failure is not observable without reading `tool_response` content, so `AfterTool` is always `task.completed`. That is a known gap.
   - **Refs:** `thread_ref` = `opaqueRef('gm', session_id, salt)`; `attributes.platform` = `gemini-cli`.
   - **Hooks are synchronous**, so `javi hook` keeps its contract: spool the event, start a detached flush, exit 0 with empty stdout, within a time budget (the test asserts a bound).
   - **Folder trust:** Gemini ignores project settings in untrusted folders. `javi init` says so in its output, and `javi status` reports "no events yet" truthfully.
3. **Gemini usage (S5b), user-level opt-in.**
   - **Settings:** `javi usage on --platform gemini-cli` edits `~/.gemini/settings.json` `telemetry`, with a backup, refusal on conflicting existing values, and `off` restoring the previous values. The block is: `enabled: true`, `target: "local"`, `otlpProtocol: "http"`, `otlpEndpoint: "http://127.0.0.1:<port>"`, `otlpHeaders` with the receiver bearer, **`logPrompts: false` (forced)** and `traces: false`.
   - **Receiver:** the existing loopback receiver also accepts `POST /v1/logs` and `/v1/traces` and answers `200 {}` **without parsing or storing the body**. That is still bounded by the 1 MiB limit and the bearer check.
   - **Parser:** from metrics, only `gemini_cli.token.usage` Sum points are read, and only their `session.id`, `model` and `type` attributes.
   - **Token mapping:**
     - `output` → `output_tokens`
     - `thought` → `reasoning_tokens`
     - `cache` → `cache_read_tokens`
     - `input` → `input_tokens` **minus** the `cache` delta of the same session, model and interval, clamped at 0, because Gemini's input includes cached tokens.
     - `tool` is ignored (it is UNVERIFIED whether it is part of the prompt count). Under-counting is preferred to double counting.
   - **Temporality:** points are cumulative, so the ADR-0011 baseline rules apply. The first point only sets a baseline, and a reset starts a new one.
   - **Attribution:** sessions are attributed only through hooks, the same as ADR-0011; an unknown session is dropped locally.
4. **Gemini cost (S5b), estimated.**
   - **Price table:** JD-C02 ships a dated per-model price table (`GEMINI_PRICES`, `pricedAt`, `source` URL) taken from the official Google Cloud Vertex AI pricing page, read 2026-10-29. It holds the USD price per million tokens for input, cached input and output; reasoning tokens are billed as output. It uses the tier for prompts ≤ 200k tokens.
   - **Estimated reports:** `cost_usd` is computed per usage report and `usage_delta.estimated` is set to `true`, so analytics count it in `estimatedReports` (ADR-0013) and the UI already says "estimated".
   - **Unknown models:** tokens only, no `cost_usd`, `estimated: false`.
   - **Price updates:** the table is reviewed at every collector release. Prices for API keys (AI Studio) and Vertex can differ, and that difference is a documented limitation.
5. **Codex (S5c, decided now, built next).**
   - **Hooks:** written into the project's `.codex/hooks.json`. `javi init` tells the user to approve them in Codex, and `javi status` reports "waiting for approval" until the first event arrives.
   - **Mapping:** `PermissionRequest` → attention; `Stop` → idle.
   - **Usage:** an opt-in edit of the user-level `~/.codex/config.toml` `[otel]` with `log_user_prompt = false`, using the logs exporter and the metrics exporter over OTLP/HTTP JSON to the loopback receiver.
   - **Disclosure:** this replaces Codex's default `statsig` metrics export, and Codex then queries OpenAI for turn cost. `javi usage on` states both before it edits.
   - **Strict allowlist:** from logs, only `codex.sse_event` with kind `response.completed` (token counters + `conversation.id`). From metrics, only `codex.turn.cost_microusd` (+ `conversation.id`). Everything else — tool arguments, output previews, `user.email`, prompts — is dropped in memory and never spooled. Whether `conversation.id` equals the hook `session_id` is UNVERIFIED; if it does not, usage is dropped, never misattributed.
6. **Spec.** JGR §12 records the Gemini `input` − `cache` rule, the ignored `tool` type, and the estimated cost in the Changelog. No envelope change.

## Consequences

- Positive:
  - One install and one receiver for three agents.
  - Gemini usage is attributable, because hook and OTel share one session id.
  - No new server endpoint.
  - Prompt logging is forced off.
- Negative:
  - Gemini cost is an estimate that can drift from real billing (dated table, ≤ 200k tier, API-key vs Vertex prices).
  - Tool failures are not observed on either platform.
  - Gemini hooks are synchronous (`javi hook` latency is now user-visible).
  - Project hooks need a trusted folder (Gemini) or explicit approval (Codex).
  - Codex usage replaces OpenAI's default metrics export.
- UNVERIFIED until real runs:
  - whether Gemini accepts empty hook stdout without a warning;
  - whether `/clear` starts a new Gemini session id;
  - whether Codex `conversation.id` equals the hook `session_id`;
  - Windows shells for both.

## Changes

- 2026-10-29 (S5b, QA findings G5/G15):
  - **New sibling series.** Gemini exports cumulative series per (session, model, type) with a shared start time. A series that first appears for a (session, model, start) whose sibling series already have baselines counts from 0. This happens when caching starts mid-session: the full `cache` value is the delta and is subtracted from input. A (session, model) without baselines, or a different start time (a new process), still only sets a baseline (ADR-0011). This follows the ADR's preference for under-counting.
  - **Receiver paths.** `POST /v1/traces` and `/v1/logs` answer `200 {}` without parsing, which supersedes OTLP conformance vector 21 (previously 404, updated).
  - **Price selection.** The price table uses the Standard / Global / ≤ 200k text rows. Model ids match exactly; there is no prefix matching. The 3.6/3.7/3.8 Flash introductory prices are promotional ("50 % credits back"), and the table uses the listed effective price.
- 2026-10-29 (S5b implementation, Developer B `092c0f2`):
  - **Project hooks.** Each entry is `{ name: "javi-collector", type: "command", timeout: 5000, command }`, with no matcher, which means all events (gemini-cli `hookPlanner.ts`).
    - The command is the stable `javi` copy plus `hook --platform gemini-cli --project <slug>`.
    - Quoting: POSIX single quotes; PowerShell `& '…'`, which is UNVERIFIED on Windows.
    - Paths containing `$GEMINI_*`/`$CLAUDE_PROJECT_DIR`, a NUL or a newline are refused, because Gemini expands `$GEMINI_*` even inside quotes.
    - A one-time backup `.gemini/settings.json.javi-backup` is written and git-excluded.
    - Hooks are written before the token is saved.
    - Files with comments or that are not plain JSON are refused untouched.
    - `init` warns when the project has its own `telemetry` block, because that overrides the user file.
  - **User telemetry.** `otlpHeaders` is an object `{ "Authorization": "Bearer <secret>" }` (gemini-cli `docs/reference/configuration.md`, `telemetry/config.ts`).
    - The home is resolved from `JAVI_GEMINI_HOME` (tests), then `GEMINI_CLI_HOME`, then the OS home.
    - `usage on` refuses when any non-javi `telemetry` block exists, or when Gemini's telemetry env keys are set in the shell (`GEMINI_TELEMETRY_*`, `OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS`). It reports key names only.
    - The file is written with mode 0600.
    - **Exact restore:** the original text is saved in `~/.javi/gemini-settings.before.json`.
      - `usage off` restores the original bytes when the file's SHA-256 is unchanged.
      - It removes only javi's block when other settings changed.
      - It leaves the file alone, and says so, when the block itself was edited.
  - **Receiver.** The sink paths drain the body without decoding it, so content type and encoding are not checked; the wire limit and bearer still apply. A throwing JD-C02 parser yields no Gemini points and never loses Claude Code usage in the same request.
  - **Baselines and ids.** Baselines are kept per platform (separate maps), and the G5 sibling rule applies to Gemini only. Gemini usage event ids hash `gemini-cli\0` + the group key.
  - **Shared receiver.** One receiver port and secret serve all platforms. `--port` is refused while another platform's usage is on, and `usage off` for one platform keeps the receiver when another still uses it.
  - **Hook latency** in this container is 363–406 ms per hook (map, spool, sequence, detached flush), with exit 0 and empty stdout and stderr.
- 2026-10-29 (S5b review V1; owner "Detect, refuse, warn" and "Price API-key/Vertex only"; the other points are orchestrator decisions):
  - **R1 (high, privacy) — user-wide telemetry can be redirected.** Gemini enables telemetry for every folder once `~/.gemini/settings.json` has it. Telemetry env keys from a trusted project's `.gemini/.env` or `.env` (the lookup walks up from cwd, then `~/.gemini/.env`, then `~/.env`) take precedence over settings. A workspace `telemetry` block is deep-merged. Either can send logs, which include tool arguments, response text and `user.email`, plus javi's bearer, to another endpoint. javi cannot prevent this. So:
    - **At setup.** `usage on --platform gemini-cli` scans that `.env` lookup chain from the cwd and the user home, and the cwd project's `.gemini/settings.json`. It **refuses** when any Gemini telemetry env key (`GEMINI_TELEMETRY_*`, `OTEL_EXPORTER_OTLP_*`) or a workspace `telemetry` block is present, and reports names and paths only.
    - **At every session start.** Each Gemini `SessionStart` hook checks its own process env (Gemini passes the loaded `.env` to hooks) and the project's `.gemini/settings.json` for the same keys and block. A hit writes a local warning record (key names, project slug, time; never values). `javi status` shows it prominently with the fix: remove the keys, or `javi usage off --platform gemini-cli`.
    - **Wording.** Output and docs say plainly that Gemini usage reporting is user-wide.
  - **R2 — first export.** A cumulative series whose `startTimeUnixNano` is at or after the receiver process's own start time counts from 0, because the receiver has seen every export since the series began. Otherwise the first point only sets a baseline (ADR-0011), because the receiver may have missed earlier exports. The G5 sibling rule still applies when the shared start is **before** the receiver start: a new sibling of an already-baselined (session, model, start) counts from 0 (QA G21, orchestrator 2026-10-29). After a receiver restart, tokens accrued during the downtime are under-counted (preferred to double counting).
  - **R3 — grouping.** Gemini groups by (session, model, `endNs`), because the points of one export share their end time. Reset detection stays per series.
  - **R4 — series identity.** A Gemini cumulative series is identified by a hash of **all** its data-point attributes plus `startNs`. Gemini adds `user.email`, `auth_type`, `experiments.ids` and `interactive` to every point, so one (session, model, type) can have several series. The hash exists in memory only and is never written to disk, spooled or sent. Each series' deltas are summed into its group.
  - **R5 — the `estimated` flag.** Per JGR §6 it means "cannot read exact counts", and the UI renders it as estimated *token counts*. Gemini token counts are exact, so `estimated: false`. Every cost in the UI is already labelled estimated (ADR-0013), which keeps the owner's "Price table, estimated". This supersedes §4 "`usage_delta.estimated` is set to `true`".
  - **R6 — cost only for per-token billing.** The parser also allowlists the point attribute `auth_type` (gemini-cli `AuthType`: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `cloud-shell`, `compute-default-credentials`, `gateway`). Cost is estimated only for `vertex-ai` and `gemini-api-key`. The table is the Vertex list price, and the AI Studio API-key price can differ; that is documented. Any other or missing `auth_type` gets tokens only, no `cost_usd`, and no budget impact. `auth_type` is used only in memory and never copied into the record.
  - **R7 — the backup never holds javi's own secret.** The backup is taken only when the file has no javi block, and a successful `usage off` restore removes it.
  - **R8 — `uninstall --forget-token`** keeps the project token, with a notice, while the other platform's hooks for the same project are still installed.
  - **R9 — logs and traces over 1 MiB** are drained and answered `200 {}`. They are never buffered, so this is safe. The bearer and Host checks still apply.
- 2026-10-29 (S5b review fixes, Developer D `5e2bd33`):
  - **R1 detection.**
    - The `.env` chain follows gemini-cli `findEnvFile`: for each folder from cwd up to the root, `<dir>/.gemini/.env` then `<dir>/.env`; then `<home>/.gemini/.env` and `<home>/.env`. Home is `GEMINI_CLI_HOME` or the OS home.
    - javi checks **every** file in the chain, because which file Gemini loads depends on folder trust and flags javi cannot see. This can cause extra refusals but never a miss.
    - Keys: any `GEMINI_TELEMETRY_*` or `OTEL_EXPORTER_OTLP_*`, except a value identical to what javi itself set for Claude Code (a Gemini CLI started inside Claude Code inherits those). The comparison happens in memory only.
    - The SessionStart check also reads the `.env` chain, because Gemini redacts the hook env in strict or GitHub mode. The warning file `~/.javi/warnings/gemini-telemetry.<project>.json` holds `{project, at, overrides:[{source, keys}]}` and no values. A clean SessionStart clears it, and so does `usage off`.
    - Not visible to javi: `--telemetry-*` command-line flags, system settings files, and folders without javi hooks.
  - **R3/R6 grouping.** The Gemini group key is (session, model, auth type, endNs). The event id hashes `gemini-cli\0session\0model\0authType\0endNs`.
  - **R4 series id.** The hidden, non-enumerable `seriesId` is a SHA-256 over all point attributes, `startNs` and the resolved session id. A Gemini restart is a new series, so G21 applies to it.
  - **R7 backups.** The status is reported as created, kept or skipped. The backup is removed after a `restored` outcome and kept after a `removed` one.
  - **R9.** Sink bodies of any size are drained and answered `200 {}`. Metrics keep the 1 MiB limit.

- 2026-10-29 (S5c design; owner: "Logs-only", "Tokens only" for ChatGPT-plan sessions, "Attribute to parent" for sub-agents). This supersedes §5 where they differ. Facts come from S5c research on `openai/codex` at `fa4ebe8`. The orchestrator re-checked three of them: `core/src/session/session.rs:993` "session_id is equal to the root thread's ID"; `app-server/src/turn_cost_worker.rs` spawns with a logs **or** metrics OTLP exporter; `hooks/src/config_rules.rs:12-13` project layers "do not get to write user hook state". `developers.openai.com/codex/*` redirects to `learn.chatgpt.com`, which is blocked, so documentation wording stays unquoted.
  - **Hooks (C1).** javi appends its groups to the project's `.codex/hooks.json`, creating the file when it is missing.
    - It never reorders existing groups, because Codex trusts a hook by its **position** plus a hash of the handler.
    - Each entry is `{ type: "command", command, commandWindows, timeout: 5 }`. The timeout is in **seconds**; SessionEnd and Interrupt are capped at 3.
    - The command must stay stable: a new path or slug means Codex asks for review again.
    - javi **never writes** `[hooks.state]` or `trusted_hash`. Approval is the user's decision, made in Codex's "Hooks need review" dialog or with `/hooks`. Until the first event arrives, `javi status --platform codex-cli` says "waiting for approval in Codex".
    - Shell: `$SHELL -lc` on Unix, `cmd.exe /C` on Windows, with its own quoting. `javi hook` prints nothing.
  - **Mapping (C2).**

    | Codex hook | JGR event |
    |---|---|
    | `SessionStart` / `SessionEnd` | `session.*` |
    | `UserPromptSubmit` | `heartbeat` working (prompt discarded) |
    | `PreToolUse` / `PostToolUse` | `task.started` / `task.completed` (`tool_name` only) |
    | `PermissionRequest` | `attention.requested` waiting |
    | `Stop` | `heartbeat` idle (last message discarded) |
    | `SubagentStart` / `SubagentStop` | `agent.started` / `agent.stopped` with `agent_ref` from `agent_id` |

    `Interrupt`, the compact events and model-request events are dropped. Thread ref: `opaqueRef('cx', session_id, salt)`; `attributes.platform` = `codex-cli`.
  - **Usage, logs only (C3).**
    - `javi usage on --platform codex-cli` edits only the user-level `~/.codex/config.toml` `[otel]` section (project-level `otel` is ignored by Codex):
      - `exporter = { otlp-http = { endpoint = "http://127.0.0.1:<port>/v1/logs", protocol = "json", headers = { Authorization = "Bearer <secret>" } } }` (full path; Codex appends none);
      - `log_user_prompt = false`, `log_agent_responses = false`, `log_sse_deltas = false`.
    - It leaves `metrics_exporter`, and so Codex's default statsig export, **untouched**.
    - It refuses when `[otel]` already has an exporter it did not write, with a backup and exact restore as for Gemini.
    - It warns when `OTEL_EXPORTER_OTLP_HEADERS` is set, because that overrides the bearer, so the receiver would reject the exports (nothing leaks).
    - Disclosure: Codex will ask OpenAI for each turn's cost estimate, and its logs carry `user.email` and tool arguments to the local receiver, which drops them in memory.
  - **Receiver allowlist (C4).** On `/v1/logs`, for records whose attributes say they come from Codex, read only these two records. Everything else is drained unparsed beyond the record name, as for Gemini.
    1. `event.name = codex.sse_event`, `event.kind = response.completed`, with the token counters present and **no** `error.message`. Keep `input_token_count`, `cached_token_count`, `cache_write_token_count`, `output_token_count`, `model`, `conversation.id`, `auth_mode`, `event.timestamp`.
    2. `event.name = codex.turn_cost`. Keep `usage.estimated_usd`, `turn.id`, `conversation.id`, `auth_mode`.

    `tool_token_count` (which is `total_tokens`) and `reasoning_token_count` (a subset of output) are never added.
  - **Token and cost mapping (C5).** Each response becomes one `usage.reported`:
    - `input_tokens` = input − cached (clamped at 0), `cache_read_tokens` = cached, `cache_write_tokens` = cache write, `output_tokens` = output;
    - `estimated: false`;
    - event id = HMAC(salt, `codex-cli`, conversation, timestamp, counters), so OTLP retries deduplicate.

    Cost arrives later (Codex polls about every 150 s, best effort) as a separate `usage.reported` carrying only `cost_usd`, with event id = HMAC(salt, `codex-cli`, conversation, `turn.id`). It is produced **only when `auth_mode = ApiKey`**. `Chatgpt` or a missing auth mode means tokens only: no `cost_usd` and no budget impact, the same rule as Gemini R6. A missing cost is never zero.
  - **Attribution (C6).** `conversation.id` equals the hook `session_id` for root sessions. A sub-agent's `conversation.id` is its `agent_id`. `SubagentStart` hooks record `agent_id → parent session_id` locally (hashed refs only), and sub-agent usage counts in the parent thread with its `agent_ref`. Unknown ids are dropped locally.
  - **Still UNVERIFIED** (real run): the attribute names of the log records on the wire (`event.name` / `event.kind` as attributes), Windows `cmd.exe` quoting, and whether login-shell profile output can reach hook stdout.
