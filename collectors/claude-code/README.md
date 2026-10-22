# JD-C01 · `@javis-dog/collector-claude-code` — Claude Code collector (`javi`)

Status: **in-progress** (S3c, ADR-0010). Sends Claude Code lifecycle, tool and attention signals to Javi's Dog as JGR L0 events. **Never** sends prompts, tool inputs or outputs, assistant messages, file paths or transcript paths. Token usage arrives in S3d.

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
