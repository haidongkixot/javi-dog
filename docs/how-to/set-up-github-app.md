# How to set up the GitHub App (owner)

> Readiness item B6. Decisions: [ADR-0019](../adr/0019-github-app-bridge.md) (decision 7 and design review D0 H1, L1–L5). The GitHub App sends pull request and CI signals to Javi's Dog. About ten minutes, on your own machine.
>
> Never paste the webhook secret, private key or client secret into chat, an issue, a commit or a screenshot. Report names and presence only.

## What you get, and what you do not

The helper registers a **private** GitHub App under your personal account. It asks for:

| Setting | Value |
|---|---|
| Homepage URL | `https://javisdog.vercel.app` |
| Webhook URL | `https://javisdog.vercel.app/api/github/webhook` (active) |
| Setup URL | `https://javisdog.vercel.app/integrations/github` |
| Callback after registration (`redirect_url`) | `http://127.0.0.1:<port>/callback`, served by the helper |
| Visibility | Private (`public: false`): only your own account can install it |
| User authorization on install | Off (`request_oauth_on_install: false`) |
| Repository permissions | Metadata **read**, Pull requests **read**, Checks **read**, Actions **read** |
| Events | `pull_request`, `check_suite`, `workflow_run`. GitHub always sends `installation` and `installation_repositories`. |

What this means in practice:

- **No code access.** The app has no Contents permission, and Javi's Dog makes no GitHub API calls, so it does not read your code, commits or branches. Push events are out of scope (a later ADR).
- **Your account only.** A private app can only be installed on the account that owns it. Other users of this deployment see "available only to this deployment's owner". Organization installations are not supported yet.
- **No API calls.** Javi's Dog only receives webhooks. Production needs the webhook secret, never the private key or the client secret.

## Before you start

- A clone of this repository and Node.js 22 or newer. The helper uses Node's built-in modules only, so `pnpm install` is not needed for it.
- A browser signed in to GitHub as the account that should own the app.
- Run it on **your own machine**, never in a cloud agent session: the result file holds secrets.

## 1. Run the helper

```bash
node scripts/github-app-create.mjs --name "Javi's Dog (your-login)"
```

Options: `--name` (1–34 characters, must be unique on GitHub; the default is `Javi's Dog (<6 random hex>)`), `--base-url` (default `https://javisdog.vercel.app`), `--port` (default: any free port), `--out-dir` (default `~/.javis-dog`), `--timeout` in seconds (default 600). `--help` lists them.

1. The helper prints `Open http://127.0.0.1:<port>/`. Open that address in the browser where you are signed in to GitHub.
2. The page shows the settings above. Click **Continue to GitHub**.
3. On GitHub's **Create GitHub App** page, check the name (change it if GitHub says it is taken) and click **Create GitHub App**.
4. GitHub sends your browser back to the helper. The helper exchanges GitHub's one-time code, saves the result and exits.

What the helper guards:

- It listens on `127.0.0.1` only and refuses requests whose `Host` header is not `127.0.0.1:<port>`.
- A random `state` ties GitHub's redirect to this run. A callback with a wrong state is refused, and the code is exchanged at most once.
- It stops after the callback, or after the timeout.

It prints only the **app slug**, the **app id**, the **owner account id**, the path of the result file and the next steps. It never prints the webhook secret, the private key, the client id, the client secret or GitHub's code.

### The result file

- Default location: `~/.javis-dog/github-app-<slug>.json`. An existing file is never overwritten; the helper adds `-2`, `-3`, … instead.
- It is created with mode `0600` (only you can read it), in a directory created with mode `0700`.
- The helper refuses any output directory inside a git working tree, so it cannot end up in a commit.
- **Windows:** file modes do not apply. The file goes under your user profile (`%USERPROFILE%\.javis-dog`) and the helper prints a warning. Keep that folder private to your Windows account. This case is not tested yet (TEST_PLAN §S5g, owner check).

It contains `id`, `slug`, `owner`, `webhook_secret`, `pem` (the private key), `client_id`, `client_secret` and the other fields GitHub returned.

### If something goes wrong

| Symptom | What to do |
|---|---|
| GitHub says the name is taken | Change the name on GitHub's page, or run again with another `--name`. |
| `no callback within … s` | Nothing was saved. If you did click **Create GitHub App**, delete that app (GitHub → Settings → Developer settings → GitHub Apps → the app → Advanced → Delete) and run the helper again. |
| `GitHub answered HTTP …` | GitHub's code works once and expires after one hour. Delete the half-created app as above and run again. |
| `refusing to write secrets inside a git working tree` | Choose an `--out-dir` outside every repository. |
| The browser cannot reach `127.0.0.1:<port>` after GitHub | The helper has already exited or timed out. Delete the app on GitHub and run again. |

## 2. Configure Vercel and redeploy

Vercel → project **javisdog** → **Settings → Environment Variables**, environment **Production**. Take the values from the helper's output and the result file:

| Variable | Value | Notes |
|---|---|---|
| `GITHUB_APP_WEBHOOK_SECRET` | `webhook_secret` from the result file | Switch **Sensitive** on |
| `GITHUB_APP_ID` | App id | Public identifier |
| `GITHUB_APP_SLUG` | App slug | Public identifier, used for the install link |
| `GITHUB_APP_OWNER_ID` | Owner account id | Public identifier. The install link is shown only to this GitHub account. |

Copy the secret straight from the file into Vercel, for example by opening the file in an editor. Do not echo it in a shared terminal.

Variables only reach new deployments: redeploy production (Deployments → latest → ⋯ → **Redeploy**). These are separate from the sign-in variables `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`; do not reuse them.

Recommended: in Vercel → project → **Firewall**, add a rate-limit rule for the path `/api/github/webhook` (design review L1). Whether your Vercel plan offers rate-limit rules is unverified; check the Firewall page. GitHub sends one request per event, so a limit far above your real PR and CI volume is enough.

## 3. Put away the private key and the client secret

Javi's Dog never uses `pem` or `client_secret`. Either:

- keep the result file offline (a password manager or an encrypted disk), or
- delete those two values, or the whole file once the webhook secret is in Vercel.

Both can be regenerated later on the app's settings page on GitHub. The webhook secret can be replaced too (see "Rotate the webhook secret").

## 4. Install the app on selected repositories

1. Open `https://github.com/apps/<slug>/installations/new` (the helper prints it), or GitHub → Settings → Developer settings → GitHub Apps → the app → **Install App**.
2. Choose your personal account.
3. Choose **Only select repositories** and pick the repositories whose PRs and CI you want to see (design review L2). Avoid **All repositories**.
4. Click **Install**. GitHub then opens the setup URL, `/integrations/github`.

## 5. Claim the installation and link a repository

1. Sign in to Javi's Dog with **GitHub**, using the same GitHub account that owns the app. A claim is accepted only when your signed-in GitHub account id equals the installation's account id from GitHub's signed webhook. The `installation_id` in the setup URL is only a hint.
2. On `/integrations/github`, claim the installation for your workspace.
3. Open the project page and link one of the installation's repositories. One project per repository.
4. **L1/L2 projects:** linking reveals the repository's name (`owner/repo`) to Javi's Dog, which L1/L2 otherwise hide (ADR-0018). The page warns and asks you to confirm.

## 6. Verify with evidence

Until a signed delivery has been stored, the Integrations page shows **"Waiting for the first delivery"**. It shows **"Connected"** only with the time of the last verified delivery. Do not call the integration working before both checks below pass.

1. **GitHub side:** GitHub → Settings → Developer settings → GitHub Apps → the app → **Advanced** → **Recent Deliveries**. The `installation` delivery and the next PR or CI delivery should show response **200**. A **202** means GitHub's request was accepted and dropped on purpose, for example a repository that is not linked yet.
2. **Javi's Dog side:** open or update a pull request, or run a workflow, in a linked repository. A "GitHub PR" or "GitHub CI" thread appears on the project's dashboard, and the Integrations page shows the time of the last verified delivery.

Record the result (status codes and times, no payloads) in the sprint log. Until then the "Real app" row of TEST_PLAN §S5g stays NOT RUN.

## Runbook

| Symptom | Check | Action |
|---|---|---|
| Recent Deliveries show `503` | `GITHUB_APP_WEBHOOK_SECRET` missing on Production | Add it (Sensitive) and redeploy. Setting only `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` also gives `503`. |
| Recent Deliveries show `401` | The secret in Vercel differs from the app's webhook secret | Put the same value in both places, redeploy, then redeliver. |
| `202` for a repository you want | The repository is not linked, the installation is not claimed or is suspended | Claim and link (step 5), then redeliver. |
| `500` | A database failure on our side | See [operate-production.md](operate-production.md), then redeliver from Recent Deliveries. |
| The installation never shows up to claim | The first `installation` delivery failed | Redeliver it from Recent Deliveries within 3 days. After 3 days: uninstall the app and install it again (design review L4). |

Things to know:

- **GitHub does not retry failed deliveries.** You can redeliver from Recent Deliveries for 3 days. Deliveries whose event time is more than 3 days old are acknowledged and dropped by Javi's Dog, so signals from a longer outage are lost.
- **Redeliveries are deduplicated.** A redelivered body that was already stored is acknowledged (`202`) and stores nothing new.

### Rotate the webhook secret

Javi's Dog checks the current secret first and then `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS`, so you can rotate without dropping deliveries (design review L5).

1. Generate a new secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. In Vercel Production: set `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` to the **old** secret and `GITHUB_APP_WEBHOOK_SECRET` to the **new** one (both Sensitive). Redeploy.
3. On GitHub, open the app's settings page and set the webhook secret to the new value.
4. Check that new deliveries show **200** in Recent Deliveries.
5. **Remove `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS`** and redeploy. Leaving it set keeps the old secret valid.

### Remove the app

Uninstall it: GitHub → Settings → Applications → **Installed GitHub Apps** → **Configure** next to the app, then uninstall. Javi's Dog deletes the installation's rows and links when the signed `installation` `deleted` delivery arrives. To remove the registration as well, delete the app under Developer settings → GitHub Apps → Advanced, then remove the four `GITHUB_APP_*` variables from Vercel and redeploy.
