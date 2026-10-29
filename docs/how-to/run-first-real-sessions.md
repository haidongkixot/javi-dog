# How to run the first real Claude Code, Gemini CLI and Codex CLI sessions (Windows)

The owner (or a local Claude Code session on the owner's machine) follows these steps to close the runtime checks that the cloud sandbox cannot do. That is release-checklist item G6, plus the UNVERIFIED rows "OTel session correlation" and "Gemini runtime checks" in the readiness matrix. Decisions: ADR-0010, ADR-0011, ADR-0016.

## Rules for whoever runs this

- **Never paste, print or commit an ingest token.** Enter it only at the `Read-Host` prompt below. If a token was ever pasted into a chat, revoke it on the project page and issue a new one.
- **Only the cloud session pushes** to `claude/clever-goldberg-wlurty` (`docs/agent-ops/TEAM.md`). A local session must not commit or push to that branch. It collects the outputs listed under "Report back", and the owner pastes them into the cloud session.
- Use a real project folder where you normally run `claude` or `gemini`, not the `javi-dog` checkout itself.

## 1. Build the tarball (once per update)

```powershell
cd "D:\Claude Projects\javisdog\javi-dog"
git fetch origin
git checkout claude/clever-goldberg-wlurty
git pull
pnpm install
pnpm --filter @javis-dog/collector-claude-code pack:cli
```

The last command prints the path of `collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz`. Node.js 22 or newer is required (`node --version`).

## 2. Get a token

On `https://javisdog.vercel.app`, sign in, open the project (for example `test-01-project-horizos`) and issue an ingest token. It is shown once. Keep it on screen for the next step only.

## 3. Claude Code

```powershell
cd "D:\path\to\your\project"
$env:JAVI_INGEST_TOKEN = Read-Host 'Ingest token'
npx "D:\Claude Projects\javisdog\javi-dog\collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz" init --project test-01-project-horizos --usage
Remove-Item Env:JAVI_INGEST_TOKEN
```

1. Start a **new** session in that folder with `claude`. Only sessions started after `--usage` export usage.
2. In it:
   - ask for something that uses tools (read or edit a file, run a command);
   - accept at least one permission prompt;
   - run `/clear`, then work a little more;
   - exit.
3. Wait about 2 minutes, because usage is exported about once a minute. Then:

```powershell
node "$HOME\.javi\bin\0.1.0\javi.mjs" status --project test-01-project-horizos
```

## 4. Gemini CLI

From the same folder:

```powershell
$env:JAVI_INGEST_TOKEN = Read-Host 'Ingest token'
npx "D:\Claude Projects\javisdog\javi-dog\collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz" init --project test-01-project-horizos --platform gemini-cli
Remove-Item Env:JAVI_INGEST_TOKEN
node "$HOME\.javi\bin\0.1.0\javi.mjs" usage on --platform gemini-cli
```

- If `usage on` refuses, a `.env` file or a settings file would send Gemini's telemetry elsewhere (ADR-0016 R1). Keep its message: it names files and keys, never values.
- Start `gemini` in that folder and **trust the folder** when asked; otherwise no hook runs. Then:
  - ask for something that uses a tool and approve the permission;
  - run `/clear`;
  - exit.
- Wait about 1 minute, then:

```powershell
node "$HOME\.javi\bin\0.1.0\javi.mjs" status --project test-01-project-horizos --platform gemini-cli
```

## 5. Codex CLI

From the same folder (the launcher path `%USERPROFILE%\.javi\bin` must not contain spaces; `init` refuses otherwise):

```powershell
$env:JAVI_INGEST_TOKEN = Read-Host 'Ingest token'
npx "D:\Claude Projects\javisdog\javi-dog\collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz" init --project test-01-project-horizos --platform codex-cli
Remove-Item Env:JAVI_INGEST_TOKEN
node "$HOME\.javi\bin\0.1.0\javi.mjs" usage on --platform codex-cli
```

- `usage on` refuses if a proxy setting (environment, `%USERPROFILE%\.codex\.env`, or Windows Internet Settings) would send Codex's logs through a proxy, or if `config.toml` already has an `[otel]` section. Keep its message: it names files and settings, never values.
- Start `codex` in that folder. It asks you to **review the new hooks**: choose to trust them (or use `/hooks`). Until you do, no hook runs.
- Ask for something that uses a tool, approve a permission, start a sub-agent if you can, run `/clear`, exit.
- Wait about 3 minutes (cost estimates arrive later), then:

```powershell
node "$HOME\.javi\bin\0.1.0\javi.mjs" status --project test-01-project-horizos --platform codex-cli
```

## Report back (paste into the cloud session)

- The full output of each `init`, of `usage on --platform gemini-cli`, and of both `status` commands. Tokens are masked in that output.
- Any warning or error that Claude Code or Gemini CLI showed, especially a Gemini hook error.
- The approximate time (with time zone) of each session and of each `/clear`.
- `node --version`, `claude --version`, `gemini --version`, `codex --version`.

## Undo

```powershell
node "$HOME\.javi\bin\0.1.0\javi.mjs" usage off
node "$HOME\.javi\bin\0.1.0\javi.mjs" usage off --platform gemini-cli
node "$HOME\.javi\bin\0.1.0\javi.mjs" usage off --platform codex-cli
node "$HOME\.javi\bin\0.1.0\javi.mjs" uninstall --project test-01-project-horizos --platform codex-cli
node "$HOME\.javi\bin\0.1.0\javi.mjs" uninstall --project test-01-project-horizos --platform gemini-cli
node "$HOME\.javi\bin\0.1.0\javi.mjs" uninstall --project test-01-project-horizos --forget-token
```
