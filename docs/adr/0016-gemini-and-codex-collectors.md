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
