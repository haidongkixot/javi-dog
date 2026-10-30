# JD-C01 · `@javis-dog/collector-claude-code` — Claude Code collector (`javi`)

Status: **in-progress** (S3c, ADR-0010; Gemini CLI since S5b, Codex CLI since S5c, ADR-0016; agent self-report since S5d, ADR-0017). Sends Claude Code lifecycle, tool and attention signals to Javi's Dog as JGR L0 events. The same `javi` also collects from Gemini CLI with `--platform gemini-cli` ([below](#gemini-cli-s5b-adr-0016)) and from Codex CLI with `--platform codex-cli` ([below](#codex-cli-s5c-adr-0016)). **Never** sends prompts, tool inputs or outputs, assistant messages, file paths or transcript paths. Token usage is opt-in (see below). Projects that opted into privacy class L1 or L2 also get keyed hashes and, for L2, encrypted repo and branch names on one extra event ([below](#privacy-classes-l1-and-l2-s5f-adr-0018)).

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
| `--platform <claude-code\|gemini-cli\|codex-cli>` | On `init`, `uninstall`, `status`, `hook`, `mcp`, `usage on\|off`; default `claude-code` (unchanged behaviour) |
| `javi init … --self-report [--allow-self-report] [--allow-tracked-config]` | Also registers javi's MCP server for agent self-report ([below](#agent-self-report-s5d-adr-0017)) |
| `javi mcp --platform <p> --project <slug>` | javi's self-report MCP server on stdin/stdout; MCP clients start it |
| `javi init … --privacy L1\|L2 [--privacy-key-file <path>]` | Stores the project's recovery key after the server accepted a check event in that class ([below](#privacy-classes-l1-and-l2-s5f-adr-0018)); `--privacy L0` removes it |

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

## Privacy classes L1 and L2 (S5f, ADR-0018)

Opt-in, per project. An owner or admin first raises the project's class on its page, where the browser creates the **recovery key** (`JDK1-…`, shown once). Then, on each machine:

```sh
JAVI_INGEST_TOKEN='<paste token>' node "<repo>/collectors/claude-code/src/cli.ts" init --project <project-slug> --privacy L2
# Recovery key for <project-slug> (input hidden):
```

**Run it yourself, in a terminal.** Never paste the recovery key into an agent chat or an agent's command: it would land in the model provider's transcript. `init` prints this reminder too.

- **Key input, never from argv.** One of: a hidden prompt read from the terminal itself (`/dev/tty`; `CONIN$`/`CONOUT$` on Windows), so a token piped on stdin does not conflict; `--privacy-key-file <path>` (a regular file of at most 1 KiB); or `JAVI_PRIVACY_KEY`, which javi deletes from its environment as soon as it starts. Giving both the file and the variable is refused. Without a terminal and without a file or variable, `init` stops and says so. The checksum is checked; error messages never repeat the input.
- **Slug only.** `--privacy` refuses a project ref that looks like a UUID: the slug is part of every encrypted event (ADR-0018 §4, review H3).
- **Check first, then write** (review H2). Before the token, the key, the hooks, `~/.javi/installation.json` or the javi copy are written, `init` sends the installation event `x.javi.collector.installed` in the requested class through an in-memory spool: for L2 the encrypted canary `{"v":1,"canary":true}`; for L1 the event in class L1 with no hashed attribute (the smallest event the validator accepts as L1, enough for the ingest ceiling check). Any rejection (`privacy_class_not_allowed` when the project's class is lower), a refused token or an unreachable endpoint stops `init` with "Nothing was saved: no token, key or hooks." `--privacy` with `--no-verify` is refused.
- **Storage.** The key is stored in canonical form in the project's entry of `~/.javi/credentials.json` (mode 0600 on POSIX; on Windows the user profile's access rules apply, as for the token). It is never printed. A plain `javi init` (without `--privacy`) keeps a stored key; `javi init --privacy L0` removes it; `javi uninstall --forget-token` removes it with the token.
- **Child processes.** The background `javi flush`, `javi receive`, git (`init`, self-report checks) and the shell and OS proxy probes are started with an explicit environment without `JAVI_PRIVACY_KEY`. The key is never put on a command line.

**What is sent** in an L1/L2 project: every event above stays L0, unchanged. After `session.started` and after the collector's own `heartbeat working` (Claude Code and Codex `UserPromptSubmit`, a Codex `SessionStart` from `resume` or `compact`, Gemini `BeforeAgent`; never a self-reported status), javi records one extra event `x.javi.thread.identity` with the same `thread_ref` and the project's class. It has no `agent_ref` (it describes the thread's folder, not an agent) and no status. Its attributes are `platform`, `collector_version` and the L1 hashes `cwd_hash`, `repo_hash`, `branch_hash` (only those available): `sha256:` + HMAC-SHA256 with the project key of each field, NFC first. In an L2 project it also carries `encrypted` (AES-256-GCM, 12-byte random IV, the 256-byte padded payload `{"v":1,"repo":…,"branch":…}`); javi sets the event's `event_id` itself so the AAD (`jgr|v1|<event_id>|<slug>|<producer_id>|<thread_ref>|<type>|<kid>|L2`) covers it. A rejected identity event costs only the names, never the status.

**Reading the session folder** (L1/L2 projects only; review M4, G13). The folder is the hook payload's `cwd` exactly as given; without a `cwd` (or a relative one) no identity event is sent. javi never spawns git in a hook: it walks up from the folder to the first `.git` entry, read with `lstat` first and only as a regular file of at most 1 KiB (opened non-blocking and checked again after opening, so a FIFO or device never hangs a hook). A `.git` file (linked worktree, submodule) is followed one `gitdir:` level, which must be a directory. Only `ref: refs/heads/<branch>` in `HEAD` names a branch; a detached `HEAD`, a symlink, an oversized file or anything else gives none. The repo is the name of the folder that holds `.git` (in a linked worktree, the worktree's folder); outside git it is the session folder's own name.

**`javi status`** shows `Privacy class: L2 (key <kid>; the key itself is never shown).` or `Privacy class: L0 (no recovery key stored).`, and the last flush that got rejected events back: when, how many, and the issue codes only (for example `privacy_class_not_allowed` after the project's class was lowered: status events still arrive, only the identity event is refused). The codes are kept in `~/.javi/rejections/<project>.json`; no event content is stored there.

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

**What is sent.** `SessionStart`/`SessionEnd` → `session.started`/`session.ended`; `BeforeAgent`/`AfterAgent` → `heartbeat` working/idle; `BeforeTool`/`AfterTool` → `task.started`/`task.completed` with `tool_name`; `Notification` `ToolPermission` → `attention.requested`. Prompts, responses, tool input and output, `cwd`, transcript paths and notification details are never read into these events (in an L1/L2 project, `cwd` is read only for the identity event, [above](#privacy-classes-l1-and-l2-s5f-adr-0018)). Sessions become `gm_…` refs (`attributes.platform: gemini-cli`). Tool failures are not visible (Gemini only reports them inside tool output).

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
- `uninstall` removes only javi's groups and gives you back your file: javi records at `init` (in `~/.javi/codex-hooks/`, event names only) whether it created `.codex/hooks.json` and which events your file already had, so your empty events (such as `"Stop": []`) stay, and the file is deleted only when javi created it and nothing else is in it. Without that record javi never deletes the file.
- javi **never** writes `[hooks.state]` or `trusted_hash`. Codex loads `.codex/hooks.json` only in a **trusted project** and runs a hook only after **you approve it**, in the "Hooks need review" dialog at startup or with `/hooks`. `javi status --project <slug> --platform codex-cli` reads `~/.codex/config.toml` (read-only) and says "project not trusted", "hooks not approved (n of 9)" or "approved", plus when Codex last ran a javi hook ("waiting for approval in Codex" until then). javi cannot recompute Codex's hash, so a hook that changed after you approved it still shows as approved; then no new events arrive.
- `javi uninstall --project <slug> --platform codex-cli` removes only javi's groups (and the file, if nothing else is left). Your groups **after** javi's in the same event move up, so Codex asks you to approve them again: uninstall lists them by event and count.
- `init` warns when `.codex/hooks.json` is tracked by git (it holds the launcher path with your user name), when the project's `.codex/config.toml` has a `[hooks]` table too, and when your shell prints anything at startup: it runs `$SHELL -c true` and `$SHELL -lc true` (2 s each). Codex passes plain hook output on `SessionStart`, `SubagentStart` and `UserPromptSubmit` to the model as context, and non-JSON output on `Stop` is an error; `javi hook` itself prints nothing.

**What is sent.** `SessionStart`/`SessionEnd` → `session.*` (a `SessionStart` from `compact` or `resume` is a heartbeat); `UserPromptSubmit` → `heartbeat` working; `PreToolUse`/`PostToolUse` → `task.started`/`task.completed` with `tool_name`; `PermissionRequest` → `attention.requested`; `Stop` → `heartbeat` idle; `SubagentStart`/`SubagentStop` → `agent.started`/`agent.stopped`. Prompts, tool input and output, assistant messages, `cwd` and transcript paths are never read into these events (in an L1/L2 project, `cwd` is read only for the identity event, [above](#privacy-classes-l1-and-l2-s5f-adr-0018)). Sessions become `cx_…` refs (`attributes.platform: codex-cli`).

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
- Tokens: `input − cached − cache write` → `input_tokens`, `cached` → `cache_read_tokens`, `cache write` → `cache_write_tokens`, `output` → `output_tokens`, `estimated: false`. Cost comes later as a separate `usage.reported` with only `cost_usd`, and **only for API-key sign-ins**: ChatGPT-plan sessions get tokens only (no cost, no budget impact; a missing cost is never 0). Event ids are keyed hashes of the record (kind-tagged, computed in `codex-usage.ts`). The receiver remembers the ids it spooled (`~/.javi/accepted/codex-cli.json`: ids only, newest 20 000, 7 days), so a record Codex sends again or a turn cost it logs again is skipped before it takes a sequence number: the thread's sequences stay without gaps. Each event is appended on its own; if one cannot be written the request is answered 503 but what was written stays (a later replay is harmless), and javi never deletes a spool file that is already there.
- A sub-agent's usage counts in its parent session, with its `agent_ref`: the `SubagentStart` hook stores the link (hashed refs only, 7 days) before it exits. Usage of a sub-agent Codex resumed, or that arrives before its `SubagentStart`, is dropped (an under-count). Usage of sessions without a javi hook is dropped on this machine and counted in `javi status`.
- Codex sends each log batch once (no retry): usage exported while the receiver is down, or answered 413, is lost.
- **Refusals** (nothing is changed): `config.toml` does not parse as TOML; it has any `otel` setting (table, dotted key or inline table) that is not javi's unchanged block, named by key only; or a proxy applies to `127.0.0.1`. Codex's HTTP client would send its logs and javi's bearer through that proxy. A proxy is:
  - an `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (either case) in your shell or in `$CODEX_HOME/.env` (`HTTPS_PROXY` alone is refused too, to be safe, and the message says so);
  - an OS proxy setting Codex reads: macOS system settings (`scutil --proxy`: an enabled HTTP proxy, or proxy auto-configuration) or Windows Internet Settings (`ProxyEnable` with a `ProxyServer`). javi runs that query with a 2 s timeout and names only the setting, never its value. The macOS bypass list and Windows `<local>` do not cover an IP address.

  Only `NO_PROXY` covers it, read the way Codex's proxy matcher (hyper-util) reads it: the first of `NO_PROXY` and `no_proxy` that is **set** counts (a `NO_PROXY` set to an empty value hides `no_proxy`), and only an entry `127.0.0.1` or an IPv4 range holding it (such as `127.0.0.0/8`) covers the endpoint. `*` and `localhost` do **not**: they are domain entries there, and a domain entry never matches an IP address.
- **Warnings**: `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_LOGS_HEADERS` (shell or `.env`) replace javi's bearer, so the receiver would reject the logs. Every Codex `SessionStart` hook checks its own environment, `$CODEX_HOME/.env` and the OS proxy settings again for those and for an uncovered proxy, and also for **javi's own Claude Code usage header**: a Codex started inside Claude Code (with javi's Claude Code usage on) inherits `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, and Codex merges it into its default metrics export to OpenAI. That secret only opens javi's loopback receiver, but it should not leave your machine: start Codex outside Claude Code, or unset that variable first. Hits leave a warning in `~/.javi/warnings/` (names and paths only) and `javi status` shows it first; a clean session start clears it. This re-check runs only where javi's hooks run, that is in folders where you ran `javi init --platform codex-cli`: Codex sessions in other folders are not checked.
- **Backup.** `usage on` copies `config.toml` once to `config.toml.javi-backup` (mode 0600: it may hold MCP tokens), and never while the file holds javi's block. The file keeps its mode (0600 when javi creates it), a symlink stays a link, and the whole result is parsed again before an atomic rename.
- `javi usage off --platform codex-cli` removes exactly javi's unchanged block (Codex rewrites `config.toml` itself, for example for hook approvals, so the restore is block-based, not byte for byte), removes the backup, and deletes the file if javi had created it and nothing else is in it. Codex's rewrite (toml_edit) can move the `# <<< javi` line to the end of the file, after tables it appended such as `[projects."…"]` or `[hooks.state."…"]`: javi recognises its block by the lines from `# >>> javi usage (do not edit)` through `log_sse_deltas = false`, removes them, and removes one standalone `# <<< javi` line wherever it is; the tables Codex added stay. If you edited javi's lines, `usage off` changes nothing, keeps Codex usage on and lists what to remove by hand: the start line, the `[otel]` header and javi's keys (`exporter`, `log_user_prompt`, `log_agent_responses`, `log_guardian_assessments`, `log_sse_deltas`) and the `# <<< javi` line, not "everything between the markers"; then run `usage off` again.
- Claude Code, Gemini CLI and Codex CLI share one receiver, port and secret. Keys an older Codex does not know can fail `codex --strict-config`.

**Not yet verified on a real Codex run** (ADR-0016): the log attribute names on the wire, which shell runs the first `SessionStart`, Windows (`cmd` and PowerShell with the `.cmd` launcher), proxy behaviour of the released binary, whether a sub-agent's cost is excluded from its parent turn, and `analytics.enabled`.

## Agent self-report (S5d, ADR-0017)

An agent can tell the dashboard what it thinks its state is ("blocked: missing credentials", "now testing") by calling two tools of javi's local MCP server. Only values from fixed lists exist, so no free text leaves the machine. The dashboard labels the result "reported by agent".

```sh
JAVI_INGEST_TOKEN='<paste token>' node "<repo>/collectors/claude-code/src/cli.ts" init --project <project-slug> --self-report [--platform gemini-cli|codex-cli] [--allow-self-report]
```

**Tools.** `report_status { status, reason? }` (`working`, `waiting`, `blocked`, `idle`, `completed`, `failed`; a `reason` such as `missing_credentials` only with `waiting`, `blocked` or `failed`) and `report_task { phase, kind }` (`started`, `completed`, `failed` × `plan`, `research`, `implement`, `test`, `debug`, `review`, `docs`, `build`, `deploy`, `other`). The server is JD-C03 (`@javis-dog/collector-mcp-server`), bundled into `javi.mjs` with no MCP SDK.

**The hook records the report.** The server itself writes nothing. The post-tool hook that already runs for every tool call (Claude Code and Codex `PostToolUse`, Claude Code `PostToolUseFailure`, Gemini `AfterTool`) turns a valid call of javi's own tool into one record on the session's thread:

- `report_status` → `heartbeat` with that status (plus `error_code` `<status>.<reason>`); `report_task` → `task.<phase>` with `task_kind`; both with `tool_name`.
- No generic tool event for these calls; an invalid input records nothing; the pre-tool hook stays silent for them; a sub-agent's `report_status` is dropped. Every other tool maps as before.
- This is the only place a hook reads `tool_input`, and only for javi's two tools.
- A self-reported status other than `working`, a self-reported `task.failed` and the end-of-turn `heartbeat idle` (`Stop`, Gemini `AfterAgent`) are flushed at once.
- A hook that runs again for the same call (Claude Code and Codex `tool_use_id`) records nothing the second time: javi keeps a keyed hash of platform, session id and call id in `~/.javi/self-report/seen.json` (hashes only, newest 512). Gemini's `AfterTool` has no call id, so each one is recorded.

So self-report needs the platform's hooks, and `init --self-report` installs them too.

**Registration.** `init --self-report` adds a server named `javi` to the project file the platform reads:

| Platform | File | Entry |
|---|---|---|
| Claude Code | `.mcp.json` | `mcpServers.javi` |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.javi` |
| Codex CLI | `.codex/config.toml` (the project's) | `[mcp_servers.javi]` between `# >>> javi self-report (do not edit)` and `# <<< javi` |

```json
{ "mcpServers": { "javi": { "command": "/usr/bin/node",
  "args": ["--no-warnings", "/home/you/.javi/bin/javi-mcp.mjs", "--platform", "claude-code", "--project", "web-app"] } } }
```

- `command` is the Node.js that ran `init`. `~/.javi/bin/javi-mcp.mjs` is an unversioned launcher that `init` rewrites to run the installed `javi.mjs` (or `src/cli.ts` from a checkout) with the `mcp` command, so an upgrade never changes the registered command. It pins `JAVI_HOME`; its only output of its own is one fixed stderr line, `javi mcp: javi is not installed here; run javi init` (exit 1), when the javi it names is missing. The entry holds no token and no environment variables. If Node.js moves, run `init --self-report` again; `javi status` warns about a registered Node.js path that no longer exists.
- JSON files are edited in place: everything outside javi's entry keeps its bytes, and `uninstall` gives you back the exact file (deleted when javi created it). Gemini's file also holds javi's hooks, which `init` writes as plain JSON as before. Codex's block goes before the first table header that follows the root keys (above the comment lines directly over it), or at the end when the file has no table: in TOML a key below a table belongs to it, so a key you later add at the end of the file joins your own last table, not `[mcp_servers.javi]`. A `.mcp.json` that javi creates in a git repository is added to `.git/info/exclude` (as `/<path>/.mcp.json`, like `.claude/settings.local.json`); `uninstall` removes exactly that line. Re-running `init` changes nothing when the entry is already right.
- **Refused, with nothing changed** (no token saved, no hooks): a registration file tracked by git, because the entry holds paths on this machine (pass `--allow-tracked-config` to write it anyway), and also when javi cannot tell (git missing, an error such as "dubious ownership", no answer within 5 s): only "not a git repository" or an untracked file counts as untracked; a file that does not parse (JSON with comments included); an `mcpServers` that is not an object; a `javi` server javi did not write; a Codex `mcp_servers` inline table, which a `[mcp_servers.javi]` table cannot extend.
- **Approval.** By default nothing is pre-approved: Claude Code and Gemini CLI ask before each call, and you can choose "always allow" there. `--allow-self-report` adds a narrow pre-approval:
  - Claude Code: exactly `mcp__javi__report_status` and `mcp__javi__report_task` in `permissions.allow` of `.claude/settings.local.json`; javi records which ones it added and removes only those.
  - Gemini CLI: `trust: true` and `includeTools: ["report_status", "report_task"]` on the `javi` entry only.
  - Codex CLI: nothing to write (Codex decides from the tools' annotations).

  `init --self-report` without the flag takes javi's earlier pre-approval back.
- Claude Code asks once whether to use a project's `.mcp.json` servers; Gemini CLI starts stdio servers only in a trusted folder; Codex reads the project `.codex/config.toml` only in a trusted project.

**`javi mcp`.** Answers `initialize`, `ping`, `tools/list` and `tools/call` on stdin/stdout (stdout carries JSON-RPC only, stderr fixed strings only). It never reads the token and starts no receiver and no flush. A valid call answers "noted" when javi's hooks for that platform and project are installed, and `isError` "not recorded: javi hooks are not installed for this project" otherwise. The MCP client's working folder is not always the project, so javi looks in the folders `init --self-report` recorded for that platform and project (`~/.javi/self-report/`, paths and flags only), then in the working folder, and checks the platform's hooks file there.

**`javi status`** shows whether self-report is registered in the project file, whether it is pre-approved, and a warning when the registered Node.js path, the launcher, or the javi the launcher runs is missing. Values read from the registration file are printed without control characters.

**`javi uninstall`** removes javi's MCP entry for the project first (and the allow rules javi added), then the hooks. A `javi` server registered for another project, or one javi did not write, stays. If javi's Codex block was edited, or keys below it (before the next table) would belong to `[mcp_servers.javi]`, `uninstall` changes nothing and names the lines. A registration file javi cannot parse stops `uninstall` only when javi registered self-report in it; otherwise `uninstall` warns once, leaves the file as it is and removes the hooks. The launcher `~/.javi/bin/javi-mcp.mjs` stays: other projects may use it, and it holds no token.

**Not yet verified on a real run** (ADR-0017): which MCP protocol version each CLI sends first, the approval prompts, Windows spawn, and whether Claude Code fires `PostToolUse` or `PostToolUseFailure` for an `isError` result (javi maps both).
