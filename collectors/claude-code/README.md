# JD-C01 · `@javis-dog/collector-claude-code` — Claude Code collector (`javi`)

Status: **in-progress** (S3c, ADR-0010; Gemini CLI since S5b, Codex CLI since S5c, ADR-0016). Sends Claude Code lifecycle, tool and attention signals to Javi's Dog as JGR L0 events. The same `javi` also collects from Gemini CLI with `--platform gemini-cli` ([below](#gemini-cli-s5b-adr-0016)) and from Codex CLI with `--platform codex-cli` ([below](#codex-cli-s5c-adr-0016)). **Never** sends prompts, tool inputs or outputs, assistant messages, file paths or transcript paths. Token usage is opt-in (see below).

## Set up a project

Create an ingest token on the project page in Javi's Dog (it is shown once), then in the project's directory, from this repository checkout:

```powershell
$env:JAVI_INGEST_TOKEN = '<paste token>'
node "<repo>/collectors/claude-code/src/cli.ts" init --project <project-slug>
Remove-Item Env:JAVI_INGEST_TOKEN
```

`init` stores the token in `~/.javi/credentials.json` (not in the repository), registers hooks in `.claude/settings.local.json` (git-ignored), and sends one check event. Claude Code picks up the hooks without a restart.

## Install from the tarball

No checkout needed: `javi` also ships as one self-contained file in a tarball (Node.js 22 or newer, no dependencies, nothing fetched from a registry). It is not published to npm. Build it from this repository:

```sh
pnpm --filter @javis-dog/collector-claude-code pack:cli   # → collectors/claude-code/dist/javis-dog-javi-<version>.tgz
```

`node scripts/build.mjs --out <dir>` and `node scripts/pack.mjs --out <dir>` write somewhere other than `dist/` (the tests use a temp dir). The tarball contains `javi.mjs`, a README, and `THIRD_PARTY_NOTICES.md`: the name, version and full licence text of every third-party package bundled into `javi.mjs` (today: `smol-toml` and `zod`). The list comes from the build's own record of bundled files, and packing fails if a bundled package has no licence file.

Then, in the project's directory:

```powershell
$env:JAVI_INGEST_TOKEN = '<paste token>'
npx ./javis-dog-javi-<version>.tgz init --project <project-slug>
Remove-Item Env:JAVI_INGEST_TOKEN
```

`init` from the tarball copies javi to `~/.javi/bin/<version>/javi.mjs` (for example `~/.javi/bin/0.1.0/javi.mjs`; `init` prints the version and path) and points the project's hooks there, so they keep working after the npx cache is cleared. Each version gets its own folder: a project keeps the javi version it was set up with, and running an older tarball later cannot replace the copy other projects use. Running `init` again with the same tarball keeps the existing copy. If the copy cannot be written, `init` stops with one error line naming the path, before it saves the token or touches any hooks. Use `node "$HOME/.javi/bin/<version>/javi.mjs" <command>` for `status`, `flush` and the rest. Run from a repository checkout, `init` registers `src/cli.ts` as before.

`javi uninstall` removes hooks (and with `--forget-token` the token) but never deletes these copies, because other projects' hooks may still run them. To see which versions are still used, search your projects' `.claude/settings.local.json` files for `.javi/bin/`. Then delete a folder you no longer need, for example `rm -r ~/.javi/bin/0.1.0` (PowerShell: `Remove-Item -Recurse "$HOME\.javi\bin\0.1.0"`).

| Command | What it does |
|---|---|
| `javi init --project <slug> [--endpoint <url>] [--dir <path>] [--no-verify]` | Token from `JAVI_INGEST_TOKEN` or stdin; https endpoints only (http for localhost) |
| `javi status --project <slug>` | Endpoint, masked token, spooled events, last flush |
| `javi flush --project <slug>` | Deliver the spool now |
| `javi uninstall --project <slug> [--forget-token]` | Remove our hooks (others stay); optionally delete the stored token |
| `javi hook --project <slug>` | Called by Claude Code; silent, always exit 0 |
| `javi usage on [--port <n>]` / `javi usage off` | Opt in to / out of token usage (below); no `--project` needed |
| `javi receive` | The local usage receiver; hooks start it for you |
| `--platform <claude-code\|gemini-cli\|codex-cli>` | On `init`, `uninstall`, `status`, `hook`, `usage on\|off`; default `claude-code` (unchanged behaviour) |

## What is sent

| Claude Code hook | JGR event |
|---|---|
| SessionStart / SessionEnd | `session.started` / `session.ended` |
| UserPromptSubmit | `heartbeat` working (prompt discarded) |
| PreToolUse / PostToolUse / PostToolUseFailure | `task.started` / `task.completed` / `task.failed` + `tool_name`, `duration_ms` |
| Notification (permission, idle, elicitation, agent needs input) | `attention.requested` waiting |
| SubagentStart / SubagentStop | `agent.started` / `agent.stopped` |
| Stop | `heartbeat` idle |

Session and agent ids become `cc_…` / `ag_…` refs: HMAC-SHA-256 with a salt that never leaves `~/.javi`.

## Token usage (opt-in)

Hooks carry no token counts, so usage comes from Claude Code's own OpenTelemetry metrics, sent to a small receiver on your machine (ADR-0011). It is off until you turn it on:

```powershell
node "<repo>/collectors/claude-code/src/cli.ts" usage on      # or: javi init ... --usage
```

**What changes.** `usage on` backs up `~/.claude/settings.json` once (`settings.json.javi-backup`), and only while the file has none of javi's keys, so the backup never holds javi's secret; the output says whether a copy was made, an earlier one kept, or none needed. It adds these keys to its `env`: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (`http://127.0.0.1:4319/v1/metrics`), `OTEL_EXPORTER_OTLP_METRICS_HEADERS` (a local secret kept in `~/.javi/usage.json`) and `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`. Only metrics are exported: no logs or traces, so no prompt or tool content. If you already have telemetry set up (any `OTEL_*` or `CLAUDE_CODE_ENABLE_TELEMETRY` in that file or your shell), javi changes nothing and names the keys in the way.

**What is sent.** Per session, model and minute: input, output, cache read and cache write tokens and Claude Code's cost estimate, as `usage.reported`. The session id is hashed like the hooks do (`cc_…`). Identity attributes (`user.email`, `user.id`, `organization.id`, account uuid, terminal) are dropped on your machine and never stored or sent.

**What to expect.** Claude Code exports about every 60 s, so numbers lag by up to a minute. Only sessions started after `usage on` export. A session counts once a hook has seen it, so usage of projects without `javi init` is dropped locally (counted in `javi status`) and never leaves this machine. The receiver listens on 127.0.0.1 only, accepts only requests with the local secret, starts with the next hook and stops after 30 idle minutes; usage exported while it is not running is lost. `javi status --project <slug>` shows whether usage is on, whether the receiver is running, the forwarded and dropped counts and the last export.

**Turning it off.** `javi usage off` removes only the keys whose values are still the ones javi wrote, stops the receiver and forgets the local secret. When every key javi wrote was removed, the backup is removed too (and `usage off` says so); when you had changed one of them, the backup stays where it is. If `~/.claude/settings.json` is not valid JSON at that moment (a trailing comma, say), javi removes nothing, keeps its local secret and tells you so: fix the file, then run `javi usage off` again. If the file is a symlink (dotfiles), javi edits the file it points to and the link stays a link.

**Not yet verified on a real Claude Code run:** that Claude Code's OTel session id equals the hook session id. Until then, `javi status` shows whether usage is matched (forwarded) or dropped.

**Good to know.**

- Settings `env` may also reach programs Claude Code runs. If an app of yours exports OTel metrics from inside a Claude Code session, it may send them to javi's receiver; javi ignores everything except Claude Code's token and cost metrics of sessions it knows.
- OTel variables from direnv or an IDE's launch environment are overridden by `~/.claude/settings.json` while usage is on.
- Organisation-managed settings (a managed settings file, MDM or the claude.ai console) can override or turn off the export, and javi cannot see them. `javi status` then shows no forwarded usage.
- If another program holds the usage port, it receives Claude Code's exports, identity attributes included. `javi status` warns you when that happens; run `javi usage off`, or `javi usage on --port <n>` to move to a free port.

## Gemini CLI (S5b, ADR-0016)

The same `javi` collects from [Gemini CLI](https://github.com/google-gemini/gemini-cli) with `--platform gemini-cli`. One token per project, one receiver per machine; the Gemini adapter logic (hook mapping, metrics allowlist, price table) lives in JD-C02 `@javis-dog/collector-adapters`.

```sh
JAVI_INGEST_TOKEN='<paste token>' node "<repo>/collectors/claude-code/src/cli.ts" init --project <project-slug> --platform gemini-cli
```

**Hooks.** `init` adds one hook per event (`SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`) to the project's `.gemini/settings.json`, merged with your settings and hooks. Each entry is marked `"name": "javi-collector"`, has `"timeout": 5000` and no matcher, and runs a shell command (Gemini runs hooks through `bash -c`, or PowerShell on Windows), with every path quoted:

```json
{ "hooks": [{ "name": "javi-collector", "type": "command", "timeout": 5000,
  "command": "/usr/bin/node /home/you/.javi/bin/0.1.0/javi.mjs hook --platform gemini-cli --project web-app --source javi-collector" }] }
```

The token is never in that file. An existing file is backed up once as `.gemini/settings.json.javi-backup` (added to `.git/info/exclude`). A file javi cannot parse as plain JSON — including one with comments, which Gemini allows — is refused before the token is saved. Re-running `init` replaces only javi's entries; `javi uninstall --project <slug> --platform gemini-cli` removes only them. If you commit `.gemini/settings.json`, javi's entries (paths on this machine) go with it.

**What is sent.** `SessionStart`/`SessionEnd` → `session.started`/`session.ended`; `BeforeAgent`/`AfterAgent` → `heartbeat` working/idle; `BeforeTool`/`AfterTool` → `task.started`/`task.completed` with `tool_name`; `Notification` `ToolPermission` → `attention.requested`. Prompts, responses, tool input and output, `cwd`, transcript paths and notification details are never read into events. Sessions become `gm_…` refs (`attributes.platform: gemini-cli`). Tool failures are not visible (Gemini only reports them inside tool output).

**Good to know.**

- Gemini CLI loads `.gemini/settings.json` **only in a trusted folder**. In an untrusted folder no hook runs; `javi status --project <slug> --platform gemini-cli` then says "no events yet" instead of guessing. It shows whether javi's hooks are in the file and when Gemini last ran one.
- Gemini may warn before it runs new or changed project hooks.
- Gemini hooks are **synchronous**: Gemini waits for `javi hook`, so it only spools the event, starts a detached flush and exits 0 with empty stdout and stderr (Gemini parses stdout as JSON and falls back to stderr). Measured from the TypeScript source on the dev container: about 0.2–0.4 s per hook; the bundle starts faster. Gemini does not wait for `SessionEnd`, so session end is best effort.

**Token usage (opt-in, user-wide).** Gemini usage reporting is **user-wide**: once it is on, every Gemini CLI session of your user, in any folder, exports telemetry, not only projects with `javi init`. `javi usage on --platform gemini-cli` edits `~/.gemini/settings.json` (or `$GEMINI_CLI_HOME/.gemini/settings.json`) and adds:

```json
"telemetry": {
  "enabled": true, "target": "local", "otlpProtocol": "http",
  "otlpEndpoint": "http://127.0.0.1:4319",
  "otlpHeaders": { "Authorization": "Bearer <local secret from ~/.javi/usage.json>" },
  "logPrompts": false, "traces": false
}
```

- `logPrompts` is forced off (Gemini's default is on). With `otlpProtocol: "http"`, Gemini sends metrics, logs and traces to the receiver; `/v1/logs` and `/v1/traces` are answered `200 {}` and drained **without being parsed, buffered or stored**, at any size (the bearer and Host checks still apply; metrics keep the 1 MiB limit). From `/v1/metrics` only `gemini_cli.token.usage` points are read, with `session.id`, `model`, `type` and `auth_type`.
- **Telemetry can be redirected per folder, and javi cannot prevent it.** Gemini lets a folder override the user file: a `GEMINI_TELEMETRY_*` or `OTEL_EXPORTER_OTLP_*` variable from the shell or from the `.env` file Gemini loads (it looks from the folder upwards for `.gemini/.env`, then `.env`, then `~/.gemini/.env`, then `~/.env`; `packages/cli/src/config/settings.ts` `findEnvFile`), or a `telemetry` block in the folder's `.gemini/settings.json` (merged over yours). Gemini then sends its logs — tool arguments, response text and your email — together with javi's local bearer to wherever that points. So:
  - `usage on --platform gemini-cli` **refuses** when it finds any of those in the current folder's lookup chain, its `.gemini/settings.json` or your shell, naming only files and keys. Run it from the folder you work in.
  - Every Gemini `SessionStart` hook checks again (its own environment, the folder's `.env` chain and `.gemini/settings.json`). A hit leaves a local warning in `~/.javi/warnings/` (key names, paths, project, time; never values) and `javi status` shows it first, with the fix: remove those keys and that block, or `javi usage off --platform gemini-cli`. A clean session start clears it. Folders without javi hooks are never checked.
  - Not visible to javi: command-line flags (`--telemetry-*`), system settings files and variables set only inside Gemini.
- Counters are cumulative, with one baseline per series: Gemini puts `user.email`, `auth_type`, `experiments.ids` and `interactive` on every point, so a series is identified by a hash of all its point attributes and its start time. That hash exists only in the receiver's memory; it is never written or sent. A series that started after the receiver did counts from 0, because the receiver saw all its exports; so does a new series of a session whose other series already have baselines (for example `cache`, which appears with the first cache hit). Any other first export only sets a baseline (ADR-0011): tokens used while the receiver was down are under-counted rather than double counted. Baselines are kept per platform, so the two never mix. One `usage.reported` per session, model and export: `input` minus `cache` → `input_tokens`, `cache` → `cache_read_tokens`, `output` → `output_tokens`, `thought` → `reasoning_tokens`; `tool` is ignored.
- Token counts are exact, so `estimated` is `false`. Gemini reports no cost: `cost_usd` is estimated from JD-C02's dated Vertex AI price table only for sign-ins billed per token (`auth_type` `gemini-api-key` or `vertex-ai`; the AI Studio price can differ). A Google login (`oauth-personal`), Cloud Shell, other or missing auth types and models without a price get tokens only, with no cost and no budget impact. Every cost in the app is labelled estimated.
- A session counts only once one of its hooks ran in a project with `javi init --platform gemini-cli`; other usage is dropped on this machine.
- Refusals: javi changes nothing when `~/.gemini/settings.json` already has a `telemetry` block it did not write, when the redirections above are found, or when the file is not plain JSON. A variable whose value is exactly what javi wrote for Claude Code (a Gemini CLI started inside Claude Code inherits those) does not count. It names the keys, never their values.
- Claude Code and Gemini CLI share one receiver, port and secret. `--port` cannot move the port while the other platform's usage is on.
- **Backup.** `usage on` copies `~/.gemini/settings.json` once to `settings.json.javi-backup`, and only while the file has no javi block, so the backup never holds javi's secret; the output says whether a copy was made, an earlier one kept, or none needed.
- `javi usage off --platform gemini-cli` restores the file byte for byte when it is exactly as javi left it (and deletes it if javi created it), then removes the backup. If you changed other settings since, it removes only javi's unchanged `telemetry` block and keeps the backup; if you changed that block, it leaves the file alone and says so. It also clears the session-start warnings. The receiver keeps running while Claude Code usage is still on.
- `javi uninstall --platform <p> --forget-token` keeps the project token, and says so, while the other platform's javi hooks for the same project are still in that folder; the last uninstall forgets it.

**Not yet verified on a real Gemini CLI run** (ADR-0016): that Gemini accepts empty hook output without a warning (its source treats empty stdout and stderr with exit 0 as success), whether `/clear` starts a new session id, and Windows (PowerShell quoting).

## Codex CLI (S5c, ADR-0016)

The same `javi` collects from [Codex CLI](https://github.com/openai/codex) with `--platform codex-cli`. The Codex adapter logic (hook mapping, logs allowlist, token and cost deltas) lives in JD-C02 `@javis-dog/collector-adapters`.

```sh
JAVI_INGEST_TOKEN='<paste token>' node "<repo>/collectors/claude-code/src/cli.ts" init --project <project-slug> --platform codex-cli
```

**Launcher.** Codex runs hook commands in a shell and trusts each hook by its exact command, so `init` writes one stable, unversioned launcher and the hooks call only that: `~/.javi/bin/javi-hook` (POSIX `sh`, mode 0755) and `~/.javi/bin/javi-hook.cmd` (Windows). It pins `JAVI_HOME` and runs `node --no-warnings <javi> hook "$@"` with the Node.js that ran `init` and the current javi copy (`~/.javi/bin/<version>/javi.mjs`, or `src/cli.ts` from a checkout). Re-running `init` rewrites only the launcher, so an upgrade does not ask you to approve the hooks again. The launcher path goes into the hook command unquoted: `init` refuses, naming the path, when it has spaces or shell metacharacters (POSIX: anything but letters, digits and `. _ - /`; Windows also allows `:` and `\`). Set `JAVI_HOME` to such a folder in that case.

**Hooks.** `init` appends one group per event (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`) at the **end** of the project's `.codex/hooks.json` (created when missing):

```json
{ "hooks": [{ "type": "command", "timeout": 5,
  "command": "/home/you/.javi/bin/javi-hook --platform codex-cli --project web-app --source javi-collector",
  "commandWindows": "C:\\Users\\you\\.javi\\bin\\javi-hook.cmd --platform codex-cli --project web-app --source javi-collector" }] }
```

- The timeout is in **seconds** (`SessionEnd`: 3, Codex's cap). There is no token in that file.
- Codex keys a hook's approval by its **position** (`<hooks.json path>:<event>:<group>:<handler>`). So javi never reorders or rewrites your groups: they keep their position and, wherever possible, their exact text. Re-running `init` leaves javi's groups where they are (a changed slug is updated in place). A file that is not valid JSON is refused before the token is saved.
- javi **never** writes `[hooks.state]` or `trusted_hash`. Codex loads `.codex/hooks.json` only in a **trusted project** and runs a hook only after **you approve it**, in the "Hooks need review" dialog at startup or with `/hooks`. `javi status --project <slug> --platform codex-cli` reads `~/.codex/config.toml` (read-only) and says "project not trusted", "hooks not approved (n of 9)" or "approved", plus when Codex last ran a javi hook ("waiting for approval in Codex" until then). javi cannot recompute Codex's hash, so a hook that changed after you approved it still shows as approved; then no new events arrive.
- `javi uninstall --project <slug> --platform codex-cli` removes only javi's groups (and the file, if nothing else is left). Your groups **after** javi's in the same event move up, so Codex asks you to approve them again: uninstall lists them by event and count.
- `init` warns when `.codex/hooks.json` is tracked by git (it holds the launcher path with your user name), when the project's `.codex/config.toml` has a `[hooks]` table too, and when your shell prints anything at startup: it runs `$SHELL -c true` and `$SHELL -lc true` (2 s each). Codex passes plain hook output on `SessionStart`, `SubagentStart` and `UserPromptSubmit` to the model as context, and non-JSON output on `Stop` is an error; `javi hook` itself prints nothing.

**What is sent.** `SessionStart`/`SessionEnd` → `session.*` (a `SessionStart` from `compact` or `resume` is a heartbeat); `UserPromptSubmit` → `heartbeat` working; `PreToolUse`/`PostToolUse` → `task.started`/`task.completed` with `tool_name`; `PermissionRequest` → `attention.requested`; `Stop` → `heartbeat` idle; `SubagentStart`/`SubagentStop` → `agent.started`/`agent.stopped`. Prompts, tool input and output, assistant messages, `cwd` and transcript paths are never read into events. Sessions become `cx_…` refs (`attributes.platform: codex-cli`).

**Token usage (opt-in, user-wide, logs only).** `javi usage on --platform codex-cli` appends one marked block to `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`):

```toml
# >>> javi usage (do not edit)
[otel]
exporter = { otlp-http = { endpoint = "http://127.0.0.1:4319/v1/logs/codex-cli", protocol = "json", headers = { Authorization = "Bearer <local secret>" } } }
log_user_prompt = false
log_agent_responses = false
log_guardian_assessments = false
log_sse_deltas = false
# <<< javi
```

- It is **user-wide**: every Codex session of your user, in any folder, sends its logs to javi's receiver. `metrics_exporter` (Codex's default metrics export to OpenAI) is left as it is.
- With a log exporter set, **Codex asks OpenAI for each turn's cost estimate** (about every 150 s, best effort).
- Codex's logs carry **your email and tool arguments**. They go only to the local receiver, on its own path `/v1/logs/codex-cli` (5 MiB limit, `413` beyond, constant error messages). There JD-C02 reads two records: `codex.sse_event` `response.completed` (token counts, model, session) and `codex.turn_cost` (cost estimate, turn). Everything else is dropped in memory and never stored. `/v1/logs` and `/v1/traces` stay unread sinks for Gemini CLI.
- Tokens: `input − cached − cache write` → `input_tokens`, `cached` → `cache_read_tokens`, `cache write` → `cache_write_tokens`, `output` → `output_tokens`, `estimated: false`. Cost comes later as a separate `usage.reported` with only `cost_usd`, and **only for API-key sign-ins**: ChatGPT-plan sessions get tokens only (no cost, no budget impact; a missing cost is never 0). Event ids are keyed hashes of the record, so a replay of the same record dedupes. One request is spooled all or nothing.
- A sub-agent's usage counts in its parent session, with its `agent_ref`: the `SubagentStart` hook stores the link (hashed refs only, 7 days) before it exits. Usage of a sub-agent Codex resumed, or that arrives before its `SubagentStart`, is dropped (an under-count). Usage of sessions without a javi hook is dropped on this machine and counted in `javi status`.
- Codex sends each log batch once (no retry): usage exported while the receiver is down, or answered 413, is lost.
- **Refusals** (nothing is changed): `config.toml` does not parse as TOML; it has any `otel` setting (table, dotted key or inline table) that is not javi's unchanged block, named by key only; or an `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (either case) is set in your shell or in `$CODEX_HOME/.env` and `NO_PROXY`/`no_proxy` does not cover `127.0.0.1` (`*`, `127.0.0.1` or a CIDR holding it; `localhost` alone does not count, because the endpoint is an IP address). Codex's HTTP client would send its logs and javi's bearer through that proxy.
- **Warnings**: `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_LOGS_HEADERS` (shell or `.env`) replace javi's bearer, so the receiver would reject the logs. Every Codex `SessionStart` hook checks its own environment and `$CODEX_HOME/.env` again for those and for an uncovered proxy, and also for **javi's own Claude Code usage header**: a Codex started inside Claude Code (with javi's Claude Code usage on) inherits `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, and Codex merges it into its default metrics export to OpenAI. That secret only opens javi's loopback receiver, but it should not leave your machine: start Codex outside Claude Code, or unset that variable first. Hits leave a warning in `~/.javi/warnings/` (names and paths only) and `javi status` shows it first; a clean session start clears it.
- **Backup.** `usage on` copies `config.toml` once to `config.toml.javi-backup` (mode 0600: it may hold MCP tokens), and never while the file holds javi's block. The file keeps its mode (0600 when javi creates it), a symlink stays a link, and the whole result is parsed again before an atomic rename.
- `javi usage off --platform codex-cli` removes exactly javi's unchanged block (Codex rewrites `config.toml` itself, for example for hook approvals, so the restore is block-based, not byte for byte), removes the backup, and deletes the file if javi had created it and nothing else is in it. If you edited the block, it leaves the file alone and says so.
- Claude Code, Gemini CLI and Codex CLI share one receiver, port and secret. Keys an older Codex does not know can fail `codex --strict-config`.

**Not yet verified on a real Codex run** (ADR-0016): the log attribute names on the wire, which shell runs the first `SessionStart`, Windows (`cmd` and PowerShell with the `.cmd` launcher), proxy behaviour of the released binary, whether a sub-agent's cost is excluded from its parent turn, and `analytics.enabled`.
