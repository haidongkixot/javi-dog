# How to provision external services (owner)

> Readiness items B1–B5 (`docs/agent-ops/READINESS_MATRIX.md`). The agent never needs a secret pasted into chat. Values go into **two** places:
>
> 1. **Vercel → Project `javi-dog` → Settings → Environment Variables** — used by deployments.
> 2. **Claude Code cloud environment** (session title bar → cloud environment menu → **Edit** → *Network secrets* / environment variables) — used by the agent for migrations and integration tests. A **new session** picks the values up.
> 3. **Network access** of the same cloud environment must allow the hosts the agent calls: the Neon host (`*.neon.tech`), `api.resend.com`, and `javisdog.vercel.app` for smoke tests (Network access → Limited → Allowed domains, keep *Allow package managers* ticked). Steps: <https://code.claude.com/docs/en/cloud-environments#network-access>.
>
> Never paste secret values into chat; if one was pasted, rotate it after storing it properly.
>
> Variable names are listed in `.env.example`. Use separate values for development where noted.

## 0. Vercel project (B2)

The agent's Vercel connection returned `403 forbidden` on project creation, so create it once by hand:

1. Vercel dashboard → team **haidongkixot's projects** → **Add New… → Project** → import GitHub repo `haidongkixot/javi-dog`.
2. **Root Directory:** `apps/web` (Vercel detects Next.js and the pnpm workspace).
3. Leave build/install commands on defaults → **Deploy**.
4. Production domain: **`https://javisdog.vercel.app`** (project `javisdog`, created 2026-10-20). It is `<APP_URL>` below.
5. Deployment Protection (`all_except_custom_domains`) protects per-deployment URLs; the production alias `javisdog.vercel.app` was verified public on 2026-10-20, so OAuth callbacks on it work.

Alternative: put a Vercel access token scoped to this team into the cloud environment as `VERCEL_TOKEN`; the agent can then manage the project through the Vercel API.

## 1. Neon Postgres (B1) → `DATABASE_URL`

Recommended: install through Vercel so every preview deployment gets its own database branch.

1. Vercel → project `javi-dog` → **Storage** → **Create Database** → **Neon** → region close to your users (e.g. Singapore `aws-ap-southeast-1`) → connect to **Production** and **Preview**. Vercel injects `DATABASE_URL` (and related `PG*` / `POSTGRES_*` variables) automatically.
2. In the Neon console for that database, create a branch named **`dev-agent`** from `main`. Copy its **pooled** connection string.
3. Add it to the Claude Code cloud environment as `DATABASE_URL` (the agent runs migrations and integration tests against `dev-agent`, never against production).
4. Agent note: inside the cloud sandbox, Node's `fetch` only uses the egress proxy with `NODE_USE_ENV_PROXY=1`; database scripts set it.

## 2. GitHub OAuth App (B3) → `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App** (create it under the account or organization that should own sign-in).
2. Application name: `Javi's Dog`. Homepage URL: `<APP_URL>`.
3. Authorization callback URL: `<APP_URL>/api/auth/callback/github`.
4. Register → **Generate a new client secret**.
5. Create a **second** OAuth App for development with homepage `http://localhost:3000` and callback `http://localhost:3000/api/auth/callback/github` (GitHub allows one callback URL per OAuth App).
6. Production app values → Vercel (Production). Development app values → Vercel (Preview, Development) and the Claude Code cloud environment.

## 3. Google OAuth client (B4) → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

1. Google Cloud Console → create or select a project (e.g. `javis-dog`).
2. **APIs & Services → OAuth consent screen** → External → app name `Javi's Dog`, support email, logo optional (concept 0.1 — trademark not cleared) → scopes `openid`, `email`, `profile` → add yourself as a test user.
3. **Credentials → Create credentials → OAuth client ID** → *Web application*.
4. Authorized JavaScript origins: `<APP_URL>`, `http://localhost:3000`.
5. Authorized redirect URIs: `<APP_URL>/api/auth/callback/google`, `http://localhost:3000/api/auth/callback/google`.
6. Copy the client ID and secret → Vercel (all environments) and the Claude Code cloud environment.

## 4. Resend (B5) → `RESEND_API_KEY`, `EMAIL_FROM`

1. Resend → **Domains → Add Domain** → use a subdomain you own, e.g. `mail.<your-domain>` → add the shown DNS records (SPF, DKIM, optional DMARC) at your DNS provider → wait for **Verified**.
2. **API Keys → Create API Key** → permission **Sending access**, restricted to that domain.
3. `EMAIL_FROM` = `Javi's Dog <hello@mail.<your-domain>>`.
4. Add both to Vercel (all environments) and the Claude Code cloud environment.

## 5. Better Auth → `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`

1. Generate a secret locally: `openssl rand -base64 32` (one per environment).
2. `BETTER_AUTH_URL` = `<APP_URL>` in Production, `http://localhost:3000` for development.
3. Add to Vercel and to the Claude Code cloud environment (development values).

## 6. Tell the agent

Reply "done" (no values) and start a new session if you edited the cloud environment. The agent will verify **presence** of each variable name, mark B1–B5 AVAILABLE with evidence, and report anything still missing.
