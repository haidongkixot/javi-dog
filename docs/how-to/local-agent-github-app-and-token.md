# Local agent runbook: GitHub App setup and ingest-token rotation

> For a coding agent (for example Claude Code) running **on the owner's own Windows machine**, working together with the owner. It covers two owner items from `docs/memory/PROJECT_MEMORY.md` "Next actions": **A.** revoke the ingest token that was pasted in chat on 2026-10-29 and issue a new one, and **B.** create the GitHub App and connect it (readiness B6, ADR-0019). Background and the full human how-to: [set-up-github-app.md](set-up-github-app.md) and [run-first-real-sessions.md](run-first-real-sessions.md).
>
> Every step is marked **AGENT** (the agent runs it) or **OWNER** (a person must do it: browser sign-ins, clicks on GitHub, or typing a secret). An agent cannot do the OWNER steps for the owner; it asks and waits.

## Rules for the agent (read first)

1. **Never print, echo, log, paste, commit or send a secret.** Secrets here: the ingest token (`jd_it_…`), the GitHub App `webhook_secret`, `pem` (private key), `client_secret`, `client_id` and GitHub's one-time `code`. Read them only inside a script that hands them straight to the next program. Report names, presence and status codes only.
2. **Never put a secret in a command-line argument or an environment variable you set yourself.** Arguments land in shell history and process lists. Use stdin or a file path.
3. **Do not commit, do not push.** Only the cloud session pushes to `claude/clever-goldberg-wlurty`. This runbook changes nothing in the repository.
4. **Never write the GitHub App result file inside a git working tree.** The helper refuses that anyway.
5. If a step fails, stop and report the exact non-secret output. Do not retry blindly and do not improvise a workaround that changes what is created on GitHub or Vercel.
6. Never call the connection "live", "secure" or "connected" until the checks in B6 pass.

## 0. Preconditions (AGENT checks, OWNER fixes)

Run in PowerShell from the owner's clone (the path used so far is `D:\Claude Projects\javisdog\javi-dog`):

```powershell
cd "D:\Claude Projects\javisdog\javi-dog"
git fetch origin claude/clever-goldberg-wlurty
git switch claude/clever-goldberg-wlurty
git pull --ff-only origin claude/clever-goldberg-wlurty
git log --oneline -1          # must be c63f006 or newer
node --version                # must be v22 or newer
Test-Path scripts\github-app-create.mjs   # True
vercel --version              # Vercel CLI; if missing: npm i -g vercel@latest
```

| Check | Expected | If not |
|---|---|---|
| `git pull` | fast-forward, clean tree | OWNER: commit or stash local work first (do not push) |
| `node --version` | `v22.x` or newer | OWNER installs Node 22 LTS |
| `vercel --version` | a version is printed; `vercel env add --help` lists `--sensitive` | `npm i -g vercel@latest` |
| `vercel whoami` | the account that owns project **javisdog** | OWNER runs `vercel login` (browser) |
| `vercel link --yes --project javisdog` (in the repo root) | `Linked to …/javisdog` | OWNER picks the right scope; `.vercel/` is git-ignored |

Then confirm production is reachable and still unconfigured for GitHub:

```powershell
$h = Invoke-RestMethod https://javisdog.vercel.app/api/health
$h.deployment.commit; $h.db.migrationsApplied; $h.env.GITHUB_APP_WEBHOOK_SECRET
# expected: a commit id, 7, False
curl.exe -s -o NUL -w "%{http_code}`n" -X POST https://javisdog.vercel.app/api/github/webhook
# expected: 503  (not_configured)
```

---

## Part A — Revoke the exposed ingest token and issue a new one

Why: an ingest token for project `test-01-project-horizos` was pasted into a chat on 2026-10-29. Anyone holding it can send events into that project. Revoking it makes the server refuse it (401) at once.

### A1. Identify which token to revoke (AGENT)

The local collector stores the project's token in `%USERPROFILE%\.javi\credentials.json`. `javi status` shows only a masked prefix, which is safe to read:

```powershell
node "$HOME\.javi\bin\0.1.0\javi.mjs" status --project test-01-project-horizos
```

Note the masked token (`jd_it_` plus the first four characters, then `…`). Do not open `credentials.json` and do not print its contents.

### A2. Revoke it in the web app (OWNER)

1. Open `https://javisdog.vercel.app`, sign in, open **Projects → test-01-project-horizos**.
2. In the **Ingest tokens** card, find the row whose **Token** column (`jd_it_xxxx…`) matches the prefix from A1, and whose **Created** date is on or before 2026-10-29.
3. Click **Revoke**. The row's status becomes **Revoked**.
4. If you are not sure which row was pasted, revoke **every active token created on or before 2026-10-29**. Only revoked tokens stop working; nothing else in the project changes.

### A3. Issue a new token (OWNER)

1. In the same card, enter a name (for example `laptop-2026-11`) and click **Issue token**.
2. The token is shown **once**. Leave it on screen for A4 only. Do not paste it into the agent's chat.

### A4. Store the new token in javi (OWNER types it, AGENT prepares the command)

`javi init` reads the token from the `JAVI_INGEST_TOKEN` variable or stdin, never from an argument. Re-running `init` for the project replaces the stored token; hooks and privacy settings stay. An agent's shell is not interactive, so **the OWNER runs this block in their own PowerShell window** and types the token at the prompt:

```powershell
cd "D:\path\to\your\project"     # the project folder where javi was initialised before
$env:JAVI_INGEST_TOKEN = Read-Host 'Ingest token'
npx "D:\Claude Projects\javisdog\javi-dog\collectors\claude-code\dist\javis-dog-javi-0.1.0.tgz" init --project test-01-project-horizos --usage
Remove-Item Env:JAVI_INGEST_TOKEN
```

- Use the **same flags** you used the first time (for example add `--privacy L2` if the project is L2; add `--platform gemini-cli` or `--platform codex-cli` only if that is the platform you are re-initialising). The token is stored per project, so one `init` updates it for every platform of that project.
- If the tarball is missing, build it first: see step 1 of [run-first-real-sessions.md](run-first-real-sessions.md).
- Close the browser tab that shows the token.

### A5. Verify (AGENT)

```powershell
node "$HOME\.javi\bin\0.1.0\javi.mjs" status --project test-01-project-horizos
```

| Check | Expected |
|---|---|
| Masked token in `status` | a **different** prefix from A1 |
| Project page, Ingest tokens card (OWNER looks) | the old row(s) **Revoked**; the new row shows **Last used** after the next agent session |
| Optional: start one short Claude Code session in the project folder, then reload the project dashboard | a fresh thread appears; no new signal arrives from the revoked token |

Report back (no secrets): the old and new masked prefixes, how many rows were revoked, the time of revocation (with time zone), and whether a fresh signal arrived.

---

## Part B — Create and connect the GitHub App

Order matters: **set the Vercel variables and redeploy (B3–B4) before installing the app (B5).** GitHub sends the `installation` event once and does not retry; if production answers 503 at that moment, the installation never appears to claim (fix: redeliver within 3 days, see B7).

### B1. Run the helper (AGENT starts it, OWNER clicks on GitHub)

AGENT, in the repo root (PowerShell). Pick a name that is unique on GitHub (at most 34 characters):

```powershell
node scripts/github-app-create.mjs --name "Javi's Dog (<your GitHub login>)"
```

- It prints `Open http://127.0.0.1:<port>/ in your browser and follow the button to GitHub.` AGENT may open it with `Start-Process "http://127.0.0.1:<port>/"`.
- OWNER, in the browser signed in to GitHub as the account that should own the app:
  1. check the settings shown (webhook `https://javisdog.vercel.app/api/github/webhook`, setup URL `…/integrations/github`, private, read-only Metadata, Pull requests, Checks, Actions; events `pull_request`, `check_suite`, `workflow_run`);
  2. click **Continue to GitHub**;
  3. on **Create GitHub App**, change the name if GitHub says it is taken, then click **Create GitHub App**.
- GitHub returns to the helper, which saves the result and exits within 10 minutes (`--timeout` to change).

AGENT records only what the helper prints: **app slug**, **app id**, **owner account id**, the **result file path** (default `%USERPROFILE%\.javis-dog\github-app-<slug>.json`), and the helper's exit code (0 = saved).

| Exit / message | Meaning | Action |
|---|---|---|
| 0 | App created and saved | Continue |
| `no callback within … s` (exit 1) | Nothing saved | If the OWNER clicked **Create GitHub App**, OWNER deletes that app (GitHub → Settings → Developer settings → GitHub Apps → the app → Advanced → Delete); run B1 again |
| `GitHub answered HTTP …` (exit 1) | The code exchange failed | Same: delete the half-created app, run again |
| exit 2 | Bad option, or an output directory inside a git tree | Fix the option; use the default `--out-dir` |
| GitHub rejects the `127.0.0.1` callback | Unverified assumption of ADR-0019 | Stop. Report the exact GitHub message to the cloud session; do not work around it |

### B2. Protect the result file (AGENT)

The file holds the webhook secret, the private key and the client secret. On Windows the helper's file mode does not apply, so restrict it to the owner's account:

```powershell
$f = "$HOME\.javis-dog\github-app-<slug>.json"
icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)"
icacls $f      # expect one entry: your account
```

Never `Get-Content` or `type` this file in the agent's shell.

### B3. Put the four variables into Vercel Production (AGENT)

Save this script **outside the repository** (for example `$env:TEMP\javi-gh-env.mjs`). It reads the result file and pipes each value into `vercel env add` on stdin, so no value appears in arguments, history or output:

```js
// javi-gh-env.mjs — usage: node javi-gh-env.mjs <result file>
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const app = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const vars = [
  ['GITHUB_APP_WEBHOOK_SECRET', app.webhook_secret, '--sensitive'],
  ['GITHUB_APP_ID', String(app.id), '--no-sensitive'],
  ['GITHUB_APP_SLUG', app.slug, '--no-sensitive'],
  ['GITHUB_APP_OWNER_ID', String(app.owner?.id ?? ''), '--no-sensitive'],
];
for (const [name, value, kind] of vars) {
  if (!value || value.trim() !== value) {
    console.error(`${name}: missing or has surrounding whitespace in the result file; stopping`);
    process.exit(1);
  }
  const r = spawnSync(
    'vercel',
    ['env', 'add', name, '--environment', 'production', kind, '--force', '--yes'],
    { input: value, stdio: ['pipe', 'ignore', 'pipe'], shell: process.platform === 'win32' },
  );
  console.log(`${name}: ${r.status === 0 ? 'set' : `FAILED (exit ${r.status})`}`);
  if (r.status !== 0) process.exit(1);
}
```

```powershell
node "$env:TEMP\javi-gh-env.mjs" "$HOME\.javis-dog\github-app-<slug>.json"
vercel env ls --environment production   # names only; expect the four GITHUB_APP_* names
```

- Expected output: four lines ending in `set`. The CLI's own stdout is discarded on purpose; on a failure, rerun that single `vercel env add` interactively (OWNER pastes the value at the CLI prompt) rather than printing it.
- Do **not** set `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` now; it is only for a later rotation.
- Fallback (OWNER, dashboard): Vercel → project **javisdog** → Settings → Environment Variables → Production; add the same four names, with **Sensitive** on for the webhook secret only. Copy the secret without a trailing newline.

### B4. Redeploy production and verify the secret (AGENT)

Variables only reach new deployments.

```powershell
$dep = vercel inspect https://javisdog.vercel.app 2>&1 | Select-String -Pattern 'https://\S+\.vercel\.app' | Select-Object -First 1
vercel redeploy $dep.Matches[0].Value
```

Fallback (OWNER): Vercel → Deployments → the latest Production deployment → ⋯ → **Redeploy**. Another fallback: ask the cloud session to push; every push redeploys production.

Wait until the redeploy is **Ready**, then verify. Save this check script outside the repo too (`$env:TEMP\javi-gh-ping.mjs`). It signs a harmless `ping` with the secret from the file and sends it; the secret never leaves the script:

```js
// javi-gh-ping.mjs — usage: node javi-gh-ping.mjs <result file>
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const secret = JSON.parse(readFileSync(process.argv[2], 'utf8')).webhook_secret;
const body = Buffer.from(JSON.stringify({ zen: 'javi local check', hook_id: 1, at: Date.now() }));
const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const r = await fetch('https://javisdog.vercel.app/api/github/webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sig },
  body,
});
console.log('status', r.status, await r.text());
```

```powershell
(Invoke-RestMethod https://javisdog.vercel.app/api/health).env.GITHUB_APP_WEBHOOK_SECRET   # True
node "$env:TEMP\javi-gh-ping.mjs" "$HOME\.javis-dog\github-app-<slug>.json"
```

| `status` | Meaning | Action |
|---|---|---|
| `202 {"ok":true,…}` | The deployed secret matches the app's secret | Continue to B5 |
| `401` | Secret differs (or a stray whitespace was stored) | Rerun B3 for `GITHUB_APP_WEBHOOK_SECRET`, redeploy, check again |
| `503` | Not configured on this deployment | The redeploy is not live yet, or the variable is missing / padded; recheck B3–B4 |

This ping stores no event: it is acknowledged and dropped, and only its body hash is kept (purged after 3 days). Each run sends a different body, so it can be repeated. Optional (OWNER): in Vercel → Firewall, add a rate-limit rule for `/api/github/webhook` if the plan offers it.

### B5. Put away the private key and client secret (OWNER decides, AGENT executes)

Javi's Dog never uses `pem` or `client_secret`. Choose one:

- move the result file into a password manager or an encrypted disk, then delete it from `%USERPROFILE%\.javis-dog`; or
- keep it there (protected by B2) until the setup is verified, then delete it.

Both values can be regenerated on GitHub later. AGENT deletes with `Remove-Item` only when the OWNER says so.

### B6. Install, claim, link, prove (OWNER, AGENT assists)

1. **Install (OWNER):** open `https://github.com/apps/<slug>/installations/new` → your **personal** account → **Only select repositories** → pick the repositories → **Install**. GitHub then opens `https://javisdog.vercel.app/integrations/github`.
2. **Sign in (OWNER):** sign in to Javi's Dog **with GitHub**, as the same account that owns the app. The install link and the claim only work for that account (`GITHUB_APP_OWNER_ID`).
3. **Claim (OWNER):** on `/integrations/github`, click claim for the installation. Organization installations are not supported yet.
4. **Link (OWNER):** open the project page, in the GitHub card link one of the installation's repositories. For an L1/L2 project, confirm the warning that Javi's Dog will then know the repository name.
5. **Trigger a new event (AGENT can do this with the GitHub CLI if `gh auth status` is signed in; otherwise OWNER):** deliveries from before the link are already acknowledged and are not stored on redelivery, so make a new one:

   ```powershell
   gh run list --repo <owner>/<repo> --limit 1          # pick a recent run id
   gh run rerun <run-id> --repo <owner>/<repo>
   ```

   or push a commit to an open pull request in that repository.
6. **Prove it (OWNER looks, AGENT records):**
   - Javi's Dog: the project dashboard shows a **GitHub CI** or **GitHub PR** thread, and `/integrations/github` shows **Connected** with the time of the last verified delivery.
   - GitHub: Settings → Developer settings → GitHub Apps → the app → **Advanced → Recent Deliveries**: the `installation` delivery and the new `workflow_run` / `check_suite` / `pull_request` delivery show **200**. A **202** means accepted and dropped on purpose (for example a repository that was not linked yet).

### B7. If something is off

| Symptom | Fix |
|---|---|
| The installation never appears to claim | Recent Deliveries → the `installation` delivery → **Redeliver** (within 3 days). After 3 days: uninstall and install again |
| Deliveries show `401` | B3 secret differs from GitHub's; rerun B3, redeploy (B4) |
| Deliveries show `503` | Variable missing or padded on the live deployment; B3–B4 |
| `202` for a repository you linked | It was delivered before the link; trigger a new event (B6.5) |
| "No verified delivery since …" later | Nothing verified for 7 days: check Recent Deliveries; `401`s mean the secret changed |

## Report back to the cloud session (no secrets)

Paste this, filled in:

```text
A. Token rotation
- old masked prefix: jd_it_xxxx…   new masked prefix: jd_it_yyyy…
- rows revoked: N   revoked at: <time, time zone>
- fresh signal after rotation: yes/no

B. GitHub App
- helper exit code: 0   app slug: …   app id: …   owner account id: …
- vercel env add: 4/4 set   redeploy: Ready at <time>
- health GITHUB_APP_WEBHOOK_SECRET: True   signed ping status: 202
- installed on: personal account, N selected repositories
- claim: done   link: <project slug> ↔ <owner/repo>
- new event: workflow re-run / PR push at <time>
- Recent Deliveries: installation 200, <event> 200
- dashboard: GitHub CI/PR thread visible yes/no; Integrations shows "Connected · <time>"
- result file: deleted / moved to password manager / kept (protected)
- anything unexpected (exact messages, no secret values):
```

The cloud session then records the evidence in `docs/sprints/SPRINT-05g.md`, flips the TEST_PLAN §S5g "Real app" row from NOT RUN, and updates the readiness matrix (B6).
