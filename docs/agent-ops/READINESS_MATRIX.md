# Project Readiness Matrix — Javi's Dog

> Orcasus template v1.2.1. Evidence, not assumptions. Last updated: 2026-10-20 (S2a planning re-check).
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
| Integrations | GitHub SSO | GitHub OAuth App client id/secret | AVAILABLE (shape only; live check BLOCKED) | 2026-10-20 S2a re-check: `GITHUB_CLIENT_ID` well-formed (20 chars); `GITHUB_CLIENT_SECRET` now 40 hex chars — no longer the callback URL. Live check impossible: the sandbox proxy returns 403 for `github.com/login/oauth/access_token` (sessions bound to repository paths) | First real check happens at sign-in in S2b | Verify by a real GitHub sign-in on localhost/preview in S2b | Verify in S2b | No |
| Integrations | Google SSO | Google OAuth client | AVAILABLE | 2026-10-20 S2a re-check: `GOOGLE_CLIENT_ID` well-formed; `GOOGLE_CLIENT_SECRET` has the `GOCSPX-` shape (35 chars). Token endpoint with a deliberately invalid code → HTTP 400 `invalid_grant` (client authenticated; previously 401 `invalid_client`). Redirect URI registration not yet proven — first real sign-in in S2b | — | — | Verify redirect URIs (localhost + Vercel) in S2b | No |
| Integrations | Email | Resend API key + verified sending domain + `EMAIL_FROM` | AVAILABLE | 2026-10-20 S2a: `RESEND_API_KEY` is send-only (`GET /domains` → 401 `restricted_api_key`); one probe email from `EMAIL_FROM` (`eagodi.com`) to Resend's test sink `delivered@resend.dev` → HTTP 200 with an email id. Resend rejects sends from unverified domains, so the domain is verified for sending. Inbox delivery to real recipients not yet observed | — | — | Real welcome email test in S2b (JD-M09) | No |
| Integrations | Repo signals | GitHub App (webhooks) | MISSING | — | GitHub fallback collector blocked (S5) | Manifest-based GitHub App created by owner | Prepare manifest in S5 | **Yes (B6)** |
| Secrets | Required env var names | Cloud environment + Vercel | AVAILABLE (cloud env) / UNKNOWN (Vercel) | 2026-10-20 S2a re-check (presence + shape only): `DATABASE_URL` ✓, `GITHUB_CLIENT_ID` ✓, `GITHUB_CLIENT_SECRET` ✓ (hex40), `GOOGLE_CLIENT_ID` ✓, `GOOGLE_CLIENT_SECRET` ✓ (GOCSPX), `BETTER_AUTH_SECRET` ✓ (32 bytes base64), `BETTER_AUTH_URL` ✓ (`http://localhost`), `RESEND_API_KEY` ✓ (`re_`), `EMAIL_FROM` ✓ (`eagodi.com`). Not set: `VERCEL_TOKEN`, `DATABASE_URL_UNPOOLED` (not needed). Vercel env listing via MCP still 403 | Vercel side unverifiable until `/api/health` ships | Health route (S2a task 6) | Ship health route | No |
| Permissions | Session tool access | GitHub MCP (javi-dog), Vercel MCP | AVAILABLE | GitHub push to `claude/clever-goldberg-wlurty`; Vercel read OK, integration listing 403 | Some Vercel admin reads unavailable | — | Ask owner for marketplace actions | No |
| Environments | Local / preview / production | Vercel project + Neon branches | PARTIAL | Vercel `javisdog` auto-deploys every push (production alias public). Neon: only `dev-agent` known; which branch Vercel Preview/Production use is UNKNOWN (env listing 403) | Previews could share or lack a DB | Q3 in `SPRINT-02a.md`: Preview → `dev-agent`, Production unset until S5 (recommended) | Owner sets Vercel `DATABASE_URL` per Q3 | Yes (Q3) |
| Data | Schema, migrations, seed, rollback | Drizzle migrations on Neon branches | PLANNED (S2a) | ADR-0005 (Proposed): module-owned tables composed by JD-M06; `drizzle-kit generate` offline + neon-http migrator; `dev-agent` only; manual down SQL + Neon PITR for rollback | No persistence | — | Implement S2a tasks 1–5 | Yes (Q1, Q3) |
| Testing | Runner, scripts, CI | Vitest, GitHub Actions | AVAILABLE (S0) | Added in S0 (`vitest`, `.github/workflows/ci.yml`) | — | — | — | No |
| Browser/mobile | Browsers for E2E | Chromium | AVAILABLE | `/opt/pw-browsers/chromium` in session | — | — | Playwright from S2; desktop Chromium first | No |
| Observability | Logs/errors of the platform itself | Vercel runtime logs | AVAILABLE once deployed | Vercel MCP has runtime log tools | — | — | — | No |
| Security | Roles, authz boundaries, sensitive data | Requirements + tests | PARTIAL | ADR-0005: workspace-scoped repository, SHA-256-hashed ingest tokens, cross-workspace isolation tests planned (`TEST_PLAN.md`). Roles/membership still undefined → S2b with Better Auth | Data leaks across workspaces | — | S2a tests + S2b role ADR | Yes (S2b) |
| Performance | Ingest latency/payload targets | Load test + approval | UNKNOWN | Targets p95 < 2s, < 4 KB are hypotheses (brand slide 10) | Unproven SLA | Measure in S5 | Load test with approval | Yes (S5) |
| Budget | Paid plans (Vercel Pro, Neon, Resend) | Owner approval | UNKNOWN | — | Commercial beta blocked on Hobby terms | Free tiers for dev; paid before beta | Decide before S5 release gate | Yes |
| Legal | Pack Pool feasibility | Legal / ToS review | MISSING | Feasibility #14 | Pack Pool cannot proceed | Research only | Engage reviewer before S6 | **Yes (B7)** |
| Delivery | Release target, approvals, rollback | Owner approval | UNKNOWN | — | — | Release gate defined in plan S5 | — | Yes (S5) |

## Readiness decision

**Ready for S2a** once Q1–Q4 (`docs/sprints/SPRINT-02a.md`) are answered — every resource it needs is AVAILABLE. **S2b** (sign-in) has its credentials in shape; GitHub can only be proven by a real sign-in. Remaining owner items: Q1–Q4, ADR-0004/0005 review; B1-rotate deferred (before real user data / S5).

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
