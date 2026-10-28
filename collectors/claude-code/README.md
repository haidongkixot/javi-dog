# JD-C01 · `@javis-dog/collector-claude-code` — Claude Code collector (`javi`)

Status: **in-progress** (S3c, ADR-0010). Sends Claude Code lifecycle, tool and attention signals to Javi's Dog as JGR L0 events. **Never** sends prompts, tool inputs or outputs, assistant messages, file paths or transcript paths. Token usage is opt-in (see below).

## Set up a project

Create an ingest token on the project page in Javi's Dog (it is shown once), then in the project's directory, from this repository checkout:

```powershell
$env:JAVI_INGEST_TOKEN = '<paste token>'
node "<repo>/collectors/claude-code/src/cli.ts" init --project <project-slug>
Remove-Item Env:JAVI_INGEST_TOKEN
```

`init` stores the token in `~/.javi/credentials.json` (not in the repository), registers hooks in `.claude/settings.local.json` (git-ignored), and sends one check event. Claude Code picks up the hooks without a restart.

| Command | What it does |
|---|---|
| `javi init --project <slug> [--endpoint <url>] [--dir <path>] [--no-verify]` | Token from `JAVI_INGEST_TOKEN` or stdin; https endpoints only (http for localhost) |
| `javi status --project <slug>` | Endpoint, masked token, spooled events, last flush |
| `javi flush --project <slug>` | Deliver the spool now |
| `javi uninstall --project <slug> [--forget-token]` | Remove our hooks (others stay); optionally delete the stored token |
| `javi hook --project <slug>` | Called by Claude Code; silent, always exit 0 |
| `javi usage on [--port <n>]` / `javi usage off` | Opt in to / out of token usage (below); no `--project` needed |
| `javi receive` | The local usage receiver; hooks start it for you |

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

**What changes.** `usage on` backs up `~/.claude/settings.json` once (`settings.json.javi-backup`) and adds these keys to its `env`: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (`http://127.0.0.1:4319/v1/metrics`), `OTEL_EXPORTER_OTLP_METRICS_HEADERS` (a local secret kept in `~/.javi/usage.json`) and `OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false`. Only metrics are exported: no logs or traces, so no prompt or tool content. If you already have telemetry set up (any `OTEL_*` or `CLAUDE_CODE_ENABLE_TELEMETRY` in that file or your shell), javi changes nothing and names the keys in the way.

**What is sent.** Per session, model and minute: input, output, cache read and cache write tokens and Claude Code's cost estimate, as `usage.reported`. The session id is hashed like the hooks do (`cc_…`). Identity attributes (`user.email`, `user.id`, `organization.id`, account uuid, terminal) are dropped on your machine and never stored or sent.

**What to expect.** Claude Code exports about every 60 s, so numbers lag by up to a minute. Only sessions started after `usage on` export. A session counts once a hook has seen it, so usage of projects without `javi init` is dropped locally (counted in `javi status`) and never leaves this machine. The receiver listens on 127.0.0.1 only, accepts only requests with the local secret, starts with the next hook and stops after 30 idle minutes; usage exported while it is not running is lost. `javi status --project <slug>` shows whether usage is on, whether the receiver is running, the forwarded and dropped counts and the last export.

**Turning it off.** `javi usage off` removes only the keys whose values are still the ones javi wrote, stops the receiver and forgets the local secret. Your backup stays where it is. If `~/.claude/settings.json` is not valid JSON at that moment (a trailing comma, say), javi removes nothing, keeps its local secret and tells you so: fix the file, then run `javi usage off` again. If the file is a symlink (dotfiles), javi edits the file it points to and the link stays a link.

**Not yet verified on a real Claude Code run:** that Claude Code's OTel session id equals the hook session id. Until then, `javi status` shows whether usage is matched (forwarded) or dropped.

**Good to know.**

- Settings `env` may also reach programs Claude Code runs. If an app of yours exports OTel metrics from inside a Claude Code session, it may send them to javi's receiver; javi ignores everything except Claude Code's token and cost metrics of sessions it knows.
- OTel variables from direnv or an IDE's launch environment are overridden by `~/.claude/settings.json` while usage is on.
- Organisation-managed settings (a managed settings file, MDM or the claude.ai console) can override or turn off the export, and javi cannot see them. `javi status` then shows no forwarded usage.
- If another program holds the usage port, it receives Claude Code's exports, identity attributes included. `javi status` warns you when that happens; run `javi usage off`, or `javi usage on --port <n>` to move to a free port.
