# Project Readiness Matrix — Javi's Dog

> Orcasus template v1.2.1. Evidence, not assumptions. Last updated: 2026-10-22 (S2c close, Guru G2-prep).
> Status vocabulary: AVAILABLE / MISSING / UNKNOWN / BLOCKED / NOT NEEDED. Secret values are never recorded.

| Area | Requirement / capability | Resource / permission required | Status | Evidence / path / source | Impact if missing | Options and trade-offs | Recommended action | Owner decision? |
|---|---|---|---|---|---|---|---|---|
| Product | Requirements and acceptance criteria | Owner brief + brand proposal | AVAILABLE | Owner brief (session 2026-10-20); `docs/brand/source/`; `docs/feasibility/FEASIBILITY.md` | — | — | Keep acceptance criteria per sprint in `docs/sprints/` | No |
| Repo & stack | Repository, runtime, package manager | `haidongkixot/javi-dog`, Node, pnpm | AVAILABLE | Repo was empty (no commits) on 2026-10-20; `node v22.22.0`, `pnpm 10.28.0` | — | — | Stack per ADR-0002 | No |
| Rules | Engineering rules to follow | Orcasus repo | AVAILABLE | `haidongkixot/orcasus@00b241b` (v1.2.1) installed in `.claude/skills/`, `docs/agent-ops/` | — | — | — | No |
| UX / assets | Brand, design system, logo, fonts | Owner brand kit | AVAILABLE (concept 0.1) | `docs/brand/BRAND_GUIDE.md`, `docs/brand/PROVENANCE.md` | Trademark not cleared; no official logo files; no dark theme | Logo: template SVG v0.1 (decided) · Dark: light-only MVP (decided) | Replace logo when official files arrive | Done (2026-10-20) |
| UX / a11y | AA-compliant text colors (D1) | Owner acceptance of adjusted text tokens | AVAILABLE | Measured ratios in `BRAND_GUIDE.md` §3: muted 4.00, pills 3.21–4.08, white-on-violet 4.43 | Inaccessible dashboard text | A) AA text tokens, hues unchanged (default) · B) exact template colors (fails AA) · C) new brand palette from designer | A | Done (accepted 2026-10-20) |
| Integrations | Hosting | Vercel project linked to repo, public production | AVAILABLE | Vercel MCP + HTTP checks 2026-10-20: project `javisdog` (`prj_PAwIaHpNB88K59du6ioiLSv4O42u`); every push to `claude/clever-goldberg-wlurty` auto-deploys (latest `dpl_5VWGaHotkQc8NiiqFd2JWfaCtLDh` from `9c9154a`, source git, READY); `https://javisdog.vercel.app` serves the app publicly — all 5 routes HTTP 200 with the disclosure banner, no Vercel login wall (Vercel Authentication `all_except_custom_domains` protects deployment URLs, not the production alias). Env var listing → 403 for the agent | — | — | — | No |
| Integrations | Database | Neon `dev-agent` branch + `DATABASE_URL` | AVAILABLE | 2026-10-20 S2a re-check: `DATABASE_URL` present (pooled Neon host, `sslmode=require`); HTTP probe via `@neondatabase/serverless` OK — PostgreSQL 18.6, `neondb_owner`, 0 public tables, read-write session, ~1.2 s round trip. `psql` over TCP 5432 **times out** in the sandbox (proxy passes HTTPS only) → migrations must use the HTTP migrator (ADR-0005). Node needs `NODE_USE_ENV_PROXY=1`. Password **not rotated yet — owner decision 2026-10-20: use first, rotate later** (accepted risk; `dev-agent` holds no real user data) | Credential pasted in chat stays valid until rotated | Rotate `neondb_owner` in Neon, update the env secret (and Vercel) | Rotate before real user data or the S5 release gate, whichever comes first | Deferred (B1-rotate) |
| Integrations | GitHub SSO | GitHub OAuth App client id/secret | AVAILABLE | 2026-10-22: owner signed in with GitHub on production; account row created (`read:user,user:email`, tokens encrypted). OAuth App redirect URI `https://javisdog.vercel.app/api/auth/callback/github` | — | — | — | No |
| Integrations | Google SSO | Google OAuth client | AVAILABLE | 2026-10-22: owner signed in with Google on production; account row created (`openid email profile`, access token encrypted); authorize URL accepted by Google | — | — | — | No |
| Integrations | Email | Resend API key + verified sending domain + `EMAIL_FROM` | AVAILABLE | 2026-10-22: send-only key; welcome email (JD-M09) accepted by Resend for `delivered@resend.dev`; sent on first sign-in of new users. Inbox delivery to a real recipient not yet observed | — | — | Observe with the next new user | No |
| Integrations | Repo signals | GitHub App (webhooks) | MISSING | — | GitHub fallback collector blocked (S5) | Manifest-based GitHub App created by owner | Prepare manifest in S5 | **Yes (B6)** |
| Secrets | Required env var names | Cloud environment + Vercel | AVAILABLE | Cloud env 2026-10-20: all 9 present and well-formed. **Vercel Production 2026-10-22 19:2x UTC via `/api/health` (`9cdc766`): all 9 = true** (owner added `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). Values, `BETTER_AUTH_URL` correctness and GitHub callback registration are not observable by the agent | — | — | Prove with the first production sign-in (S2b) | No |
| Permissions | Session tool access | GitHub MCP (javi-dog), Vercel MCP | AVAILABLE (read) / BLOCKED (Vercel env write) | GitHub push to `claude/clever-goldberg-wlurty`; Vercel deployments read OK; env list → 403; **env create (production) → 403 "Additional permissions are required"** (2026-10-22); no `VERCEL_TOKEN` for the CLI | Agent cannot configure Vercel env vars | A) Owner sets vars in the dashboard · B) owner upgrades the agent's Vercel role / provides a scoped token | A | Yes |
| Environments | Local / preview / production | Vercel project + Neon branches | AVAILABLE (dev-grade) | 2026-10-22: Vercel builds `claude/clever-goldberg-wlurty` as **production**; Q5 = A applied — `https://javisdog.vercel.app/api/health` → HTTP 200, `db.status = ok`, 136 ms, 1 migration (`9cdc766`). Production reads the `dev-agent` branch until S5 | Public site shares dev data (test rows only) | Separate production branch at S5 | Revisit at S5 release gate | No (S5) |
| Data | Schema, migrations, seed, rollback | Drizzle migrations on Neon branches | AVAILABLE (dev-agent) | 2026-10-22: migration `0000_jd_m04_workspaces_projects_tokens` applied to `dev-agent` (neon-http migrator, exit 0); `db:smoke` 7/7 PASS; rollback SQL committed and exercised on PGlite; CI fails on schema/SQL drift. How-to: `docs/how-to/run-database-migrations.md` | — | — | Production branch only at S5 (Q3) | No |
| Testing | Runner, scripts, CI | Vitest, GitHub Actions | AVAILABLE (S0) | Added in S0 (`vitest`, `.github/workflows/ci.yml`) | — | — | — | No |
| Environments | Local Windows dev machine | Node ≥ 22.18, pnpm 10.28.0, Git | AVAILABLE | 2026-10-23: owner's Windows 10 machine, Node 22.23.4 / pnpm 10.28.0 / Git 2.55.0 (winget + npm -g, owner-approved); lint, typecheck, test (209), docs:check, build exit 0 after LF + `fileURLToPath` fixes. `gh` not installed | — | — | Use within owner's GMT+7 time windows | No |
| Browser/mobile | Browsers for E2E | Chromium | AVAILABLE | `/opt/pw-browsers/chromium` in session | — | — | Playwright from S2; desktop Chromium first | No |
| Observability | Logs/errors of the platform itself | Vercel runtime logs | PARTIAL | 2026-10-22: Vercel MCP runtime-log and runtime-error queries returned nothing for this project (even for known requests); `/api/health` is the working observation path; auth now writes redacted JSON log lines (ADR-0007) — their arrival in Vercel logs is unverified | A failure may leave no trace | A) Owner checks the Vercel dashboard log view once · B) add a log drain later | A | Yes |
| Security | Roles, authz boundaries, sensitive data | Requirements + tests | PARTIAL | ADR-0006 (2026-10-22): Better Auth roles owner/admin/member on workspaces; personal workspace per user; open sign-up; telemetry off; OAuth tokens encrypted at rest (confirmed on real rows 2026-10-22), provider `id_token` not stored. Real GitHub and Google sign-in verified on production. Tests: redirect URLs, workspace creation/isolation/cascade, id_token dropped, not-configured 503. S2c: every page/action resolves the workspace via session + membership (tested incl. forged ids); auth logs redacted (ADR-0007) | Data leaks across workspaces | — | S2c: derive `workspaceId` from session + membership only | Yes (S2c) |
| Performance | Ingest latency/payload targets | Load test + approval | UNKNOWN | Targets p95 < 2s, < 4 KB are hypotheses (brand slide 10) | Unproven SLA | Measure in S5 | Load test with approval | Yes (S5) |
| Budget | Paid plans (Vercel Pro, Neon, Resend) | Owner approval | UNKNOWN | — | Commercial beta blocked on Hobby terms | Free tiers for dev; paid before beta | Decide before S5 release gate | Yes |
| Legal | Pack Pool feasibility | Legal / ToS review | MISSING | Feasibility #14 | Pack Pool cannot proceed | Research only | Engage reviewer before S6 | **Yes (B7)** |
| Delivery | Release target, approvals, rollback | Owner approval | UNKNOWN | — | — | Release gate defined in plan S5 | — | Yes (S5) |

## Readiness decision

**S2 complete** (2026-10-22): data layer, sign-in and project/token UI verified on production. **S3 (JGR ingress)** can start; it needs a retention/partitioning ADR for `events`. Open owner items: secret rotation (B1-rotate + GitHub client secret pasted in chat), release-cooldown policy, ADR-0004 review, B6 GitHub App (S5), B7 legal (S6).

### Blockers and decisions

| ID | Blocker / unknown | Evidence | Option A | Option B | Option C | Recommendation | Decision owner | Decision / date |
|---|---|---|---|---|---|---|---|---|
| B0 | Brand kit | Owner upload | Use as Concept 0.1 | — | — | A | Owner | Accepted 2026-10-20 |
| B1 | Neon database | Connectivity verified; `DATABASE_URL` is an env secret | Env secret + rotate password | — | — | A | Owner | Secret stored 2026-10-20; **rotation deferred by owner** ("use first, rotate later") — due before real user data / S5 |
| B2 | Vercel project | Created by owner as `javisdog`; production READY | — | — | — | — | Owner | **Done 2026-10-20** |
| B2a | Production behind Vercel Authentication | Re-checked: production alias is public (HTTP 200, real app) | — | — | — | — | — | **Resolved 2026-10-20 — not an issue** |
| B3 | GitHub OAuth | Secret now well-formed; live check blocked by sandbox | OAuth App | GitHub App user auth | — | A | Owner | **Provisioned 2026-10-20** — prove at S2b sign-in |
| B4 | Google OAuth | Client authenticates (`invalid_grant` probe) | Google Cloud OAuth client | GitHub-only launch | — | A | Owner | **Done 2026-10-20** |
| B5 | Resend | Test send from `EMAIL_FROM` accepted (HTTP 200) | Resend + domain | Defer email | — | A | Owner | **Done 2026-10-20** |
| B6 | GitHub App | Missing | Manifest-based app | — | — | A (S5) | Owner | Pending |
| B7 | Pack Pool legal review | Missing | External review | Drop Pack Pool | — | A before S6 | Owner | Pending |
| D1 | AA text tokens | Measured contrast | AA tokens, hues unchanged | Exact template colors | Designer revises palette | A | Owner | **A accepted 2026-10-20** |
| D2 | Dark mode | Not in brand kit | Light-only MVP, theme-scoped tokens | — | — | A | Owner | Accepted 2026-10-20 |

### Gate before implementation (Sprint 0)

- [x] Existing resources, reusable components, assets and licenses inspected.
- [x] Permissions and integrations checked using available evidence.
- [x] Missing resources and unknowns remain explicitly labelled.
- [x] Alternatives and material trade-offs presented to owner.
- [x] No workaround silently changes required behavior or quality.
- [x] Architecture decision and acceptance criteria recorded (ADR-0001…0003, `docs/sprints/SPRINT-00.md`).
- [x] Test plan and artifact budget approved (`docs/agent-ops/TEST_PLAN.md`, screenshot budget 0).
