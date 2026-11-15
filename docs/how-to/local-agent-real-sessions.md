# Local agent runbook: real agent sessions (release gate G6) and token rotation

> For a coding agent (for example Claude Code) running **on the owner's Windows machine**, working together with the owner. It closes release-checklist **G6** (a real Claude Code session with hooks and attributed usage) and the UNVERIFIED readiness rows "OTel session correlation" and "Gemini runtime checks", and it finishes the open token rotation (the ingest token created on 2026-10-29 is still active). Human version with more background: [run-first-real-sessions.md](run-first-real-sessions.md). Decisions: ADR-0010, ADR-0011, ADR-0016, ADR-0017.
>
> Each step is marked **AGENT** or **OWNER**. The owner types the token, approves trust prompts and drives the real interactive sessions; the agent prepares, checks and collects the evidence. An agent cannot do an OWNER step: it asks and waits.

## Rules for the agent (read first)

1. **Never see, print, log, paste or commit an ingest token.** The owner types it at a masked prompt in their own terminal. Report only the masked prefix that `javi` prints (`jd_it_xxxx…`).
2. **Do not commit, do not push.** Only the cloud session pushes to `claude/clever-goldberg-wlurty`. Evidence files go to `%TEMP%\javi-g6\`, never into a repository.
3. **Run the agent from the `javi-dog` checkout, not from the test project folder.** `javi init` installs hooks in the project folder, so an agent session started there would report itself into the project and blur the evidence. Do not start `claude`, `gemini` or `codex` sessions yourself; the owner's sessions are the evidence.
4. Never edit `%USERPROFILE%\.javi\*`, `%USERPROFILE%\.claude\settings.json`, `.gemini\settings.json` or `.codex\config.toml` by hand. Only `javi` changes them.
5. If a command fails or prints a refusal, stop and record the exact output (it names files and settings, never secret values). Do not retry blindly and do not work around a refusal.
6. Never call the result "live" or "working" until the checks in step 7 pass.
7. **Shell.** The blocks below are PowerShell. If your command tool runs bash (Claude Code on Windows usually uses Git Bash), save each block to a `.ps1` file under `%TEMP%\javi-g6\` and run it with `pwsh -NoProfile -File <file>` (or `powershell -NoProfile -ExecutionPolicy Bypass -File <file>`). Variables do not survive between calls, so every AGENT block starts by defining `$log` and `$javi`.

## 0. Preconditions (AGENT)

```powershell
cd "D:\Claude Projects\javisdog\javi-dog"
git fetch origin claude/clever-goldberg-wlurty
git switch claude/clever-goldberg-wlurty
git pull --ff-only origin claude/clever-goldberg-wlurty
New-Item -ItemType Directory -Force "$env:TEMP\javi-g6" | Out-Null
$log = "$env:TEMP\javi-g6\evidence.txt"
"G6 run $(Get-Date -Format o)" | Out-File $log
git log --oneline -1 | Out-File -Append $log
node --version   | Out-File -Append $log   # must be v22 or newer
claude --version | Out-File -Append $log
gemini --version | Out-File -Append $log   # skip the Gemini steps if not installed
codex --version  | Out-File -Append $log   # skip the Codex steps if not installed
```

Build the collector tarball:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @javis-dog/collector-claude-code pack:cli
Test-Path "collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz"   # True
git status --short   # must be empty; if collectors\claude-code\src\cli.ts shows a mode change only, ignore it (do not commit)
```

**OWNER** names the test project folder: a real project where you normally run `claude`, **not** the `javi-dog` checkout. The agent records it (path only) in the evidence file. The Codex launcher path `%USERPROFILE%\.javi\bin` must contain no spaces; `init` refuses otherwise.

## 1. Rotate the ingest token (OWNER, AGENT checks)

The token created on 2026-10-29 for `test-01-project-horizos` was pasted into a chat and is still active. Rotate it before any session, so the sessions run on a clean token.

1. **AGENT:** `node "$HOME\.javi\bin\0.1.0\javi.mjs" status --project test-01-project-horizos` (if the file exists) and record the masked token prefix. If `javi` was never installed, note "none".
2. **OWNER:** on `https://javisdog.vercel.app` → **Projects → test-01-project-horizos** → **Ingest tokens**: click **Revoke** on every active token created on or before 2026-10-29 (the row's **Token** column shows the same masked prefix). Then **Issue token** (name it e.g. `g6-2026-11`). It is shown once; keep it on screen for step 2 only.

## 2. Install javi for all three platforms with one token entry (OWNER)

The owner runs this block **in their own PowerShell window**, in the test project folder. The token is read once at a masked prompt and removed afterwards; the output goes to a file the agent can read (`javi` masks tokens in its output).

```powershell
cd "D:\path\to\your\project"
$tgz = "D:\Claude Projects\javisdog\javi-dog\collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz"
$out = "$env:TEMP\javi-g6\init.txt"
$env:JAVI_INGEST_TOKEN = Read-Host 'Ingest token' -MaskInput   # PowerShell 7.1+; on Windows PowerShell 5.1 drop -MaskInput
& { npx $tgz init --project test-01-project-horizos --usage
    npx $tgz init --project test-01-project-horizos --platform gemini-cli
    npx $tgz init --project test-01-project-horizos --platform codex-cli } *>&1 | Tee-Object $out
Remove-Item Env:JAVI_INGEST_TOKEN
```

- Drop the `gemini-cli` or `codex-cli` line if that CLI is not installed.
- Optional, agent self-report (ADR-0017): add `--self-report` to each `init` line. Each CLI then asks once to approve the `javi` MCP server.
- Close the browser tab that shows the token.

**AGENT** then reads `%TEMP%\javi-g6\init.txt` and appends it to the evidence file. Expected: one `Token stored in … as jd_it_xxxx…` line with a **new** prefix, hooks registered for each platform, and no `failed` or `refusing` line. Then the agent switches usage on for the other two platforms (no token needed):

```powershell
$log = "$env:TEMP\javi-g6\evidence.txt"; $javi = "$HOME\.javi\bin\0.1.0\javi.mjs"
node $javi usage on --platform gemini-cli *>&1 | Tee-Object -Append $log
node $javi usage on --platform codex-cli  *>&1 | Tee-Object -Append $log
```

If `usage on` refuses, it is protecting the logs from a proxy or a foreign telemetry target (ADR-0016). Record its message and continue with the other platforms.

## 3. Claude Code session (OWNER drives, AGENT records)

**OWNER**, in the test project folder, starts a **new** `claude` session (only sessions started after step 2 export usage) and:

1. asks for something that uses tools (read or edit a file, run a command);
2. accepts at least one permission prompt;
3. runs `/clear`, then works a little more;
4. exits.

The owner tells the agent the start time, the `/clear` time and the end time (with time zone). **AGENT** waits about 2 minutes (usage is exported about once a minute), then:

```powershell
$log = "$env:TEMP\javi-g6\evidence.txt"; $javi = "$HOME\.javi\bin\0.1.0\javi.mjs"
"--- Claude Code $(Get-Date -Format o)" | Out-File -Append $log
node $javi status --project test-01-project-horizos *>&1 | Tee-Object -Append $log
```

| Line in `status` | Expected |
|---|---|
| `Project test-01-project-horizos: endpoint https://javisdog.vercel.app/api/v1/events, token jd_it_…` | the **new** prefix |
| `Spooled events:` | `0` |
| `Last flush:` | `"status":"ok"`, `accepted` > 0, `rejected` 0 |
| `Usage: on (port …)` · `Usage receiver: running (pid …)` | on and running |
| `Last usage export:` | a time after the session started |
| `Rejected events:` | `none recorded` |

## 4. Gemini CLI session (OWNER drives, AGENT records)

**OWNER** starts `gemini` in the same folder and **trusts the folder** when asked (otherwise no hook runs). Then: ask for something that uses a tool and approve it, run `/clear`, exit. Note the times.

**AGENT**, about 1 minute later:

```powershell
$log = "$env:TEMP\javi-g6\evidence.txt"; $javi = "$HOME\.javi\bin\0.1.0\javi.mjs"
"--- Gemini CLI $(Get-Date -Format o)" | Out-File -Append $log
node $javi status --project test-01-project-horizos --platform gemini-cli *>&1 | Tee-Object -Append $log
```

Same expectations as step 3, with `Gemini CLI usage: on (…)`. Record any hook error Gemini printed (the owner copies it).

## 5. Codex CLI session (OWNER drives, AGENT records)

**OWNER** starts `codex` in the same folder. It asks to **review the new hooks**: trust them (or use `/hooks`). Then: ask for something that uses a tool, approve a permission, start a sub-agent if you can, run `/clear`, exit. Note the times.

**AGENT**, about 3 minutes later (cost estimates arrive later):

```powershell
$log = "$env:TEMP\javi-g6\evidence.txt"; $javi = "$HOME\.javi\bin\0.1.0\javi.mjs"
"--- Codex CLI $(Get-Date -Format o)" | Out-File -Append $log
node $javi status --project test-01-project-horizos --platform codex-cli *>&1 | Tee-Object -Append $log
```

Expected in addition: `Codex CLI hooks: approved (n of n)` with both numbers equal.

## 6. Optional: agent self-report (OWNER drives)

Only if `--self-report` was added in step 2. In a new session on any platform, the owner asks: "Use javi's report_status tool to report that you are blocked because credentials are missing." then gives one small task. **OWNER** checks the dashboard: "Blocked · missing credentials · reported by agent" and "Needs you" within a minute, back to working after the next prompt. **AGENT** records the `Self-report:` lines of `javi status`.

## 7. Check the dashboard (OWNER), then report back

**OWNER**, on the project page and **Live agents**:

- one thread per session (Claude Code, Gemini CLI, Codex CLI), each with a fresh last signal and its platform;
- after `/clear`, the new conversation continues as described in the session (a new thread or the same thread, note which);
- token usage for the project's sessions on the usage chart, attributed to those sessions (ADR-0011 session-id match);
- the GitHub CI/PR threads stay separate from the agents.

**AGENT** appends the owner's observations to the evidence file, re-reads it to make sure no line contains a full token (only `jd_it_` plus four characters and `…`), and gives the owner this to paste into the cloud session:

```text
G6 real sessions
- versions: node …, claude …, gemini …, codex …
- token rotation: old prefix jd_it_xxxx… revoked (N rows); new prefix jd_it_yyyy…
- init: claude-code ok/failed, gemini-cli ok/failed, codex-cli ok/failed (paste refusals verbatim)
- usage on: gemini-cli ok/refused (message), codex-cli ok/refused (message)
- Claude Code session: start …, /clear …, end … (time zone); status: last flush ok accepted N rejected 0; last usage export …
- Gemini CLI session: start …, /clear …, end …; status: …; hook errors: none/…
- Codex CLI session: start …, /clear …, end …; hooks approved n of n; status: …
- self-report (optional): dashboard showed …; Self-report lines …
- dashboard: threads per platform yes/no; usage attributed yes/no; anything unexpected (exact text)
- evidence file: %TEMP%\javi-g6\evidence.txt kept locally (not committed)
```

The cloud session then checks the stored events read-only (per platform: hook events, `usage.reported` and their session match at the reported times), records the evidence in the sprint log, and moves G6 and the UNVERIFIED readiness rows on.

## Undo (AGENT, when the owner asks)

```powershell
$javi = "$HOME\.javi\bin\0.1.0\javi.mjs"
node $javi usage off
node $javi usage off --platform gemini-cli
node $javi usage off --platform codex-cli
node $javi uninstall --project test-01-project-horizos --platform codex-cli
node $javi uninstall --project test-01-project-horizos --platform gemini-cli
node $javi uninstall --project test-01-project-horizos --forget-token
```

Run these from the test project folder (`uninstall` removes the hooks there). `--forget-token` removes the stored token from this machine; revoke it on the project page too if the machine is no longer used.
