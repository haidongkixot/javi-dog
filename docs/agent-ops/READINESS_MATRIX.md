# Project Readiness Matrix — Javi's Dog

> Orcasus template v1.2.1. Evidence, not assumptions. Last updated: 2026-10-20 (Sprint 0).
> Status vocabulary: AVAILABLE / MISSING / UNKNOWN / BLOCKED / NOT NEEDED. Secret values are never recorded.

| Area | Requirement / capability | Resource / permission required | Status | Evidence / path / source | Impact if missing | Options and trade-offs | Recommended action | Owner decision? |
|---|---|---|---|---|---|---|---|---|
| Product | Requirements and acceptance criteria | Owner brief + brand proposal | AVAILABLE | Owner brief (session 2026-10-20); `docs/brand/source/`; `docs/feasibility/FEASIBILITY.md` | — | — | Keep acceptance criteria per sprint in `docs/sprints/` | No |
| Repo & stack | Repository, runtime, package manager | `haidongkixot/javi-dog`, Node, pnpm | AVAILABLE | Repo was empty (no commits) on 2026-10-20; `node v22.22.0`, `pnpm 10.28.0` | — | — | Stack per ADR-0002 | No |
| Rules | Engineering rules to follow | Orcasus repo | AVAILABLE | `haidongkixot/orcasus@00b241b` (v1.2.1) installed in `.claude/skills/`, `docs/agent-ops/` | — | — | — | No |
| UX / assets | Brand, design system, logo, fonts | Owner brand kit | AVAILABLE (concept 0.1) | `docs/brand/BRAND_GUIDE.md`, `docs/brand/PROVENANCE.md` | Trademark not cleared; no official logo files; no dark theme | Logo: template SVG v0.1 (decided) · Dark: light-only MVP (decided) | Replace logo when official files arrive | Done (2026-10-20) |
| UX / a11y | AA-compliant text colors (D1) | Owner acceptance of adjusted text tokens | AVAILABLE | Measured ratios in `BRAND_GUIDE.md` §3: muted 4.00, pills 3.21–4.08, white-on-violet 4.43 | Inaccessible dashboard text | A) AA text tokens, hues unchanged (default) · B) exact template colors (fails AA) · C) new brand palette from designer | A | Done (accepted 2026-10-20) |
| Integrations | Hosting | Vercel project linked to repo, public production | AVAILABLE | Vercel MCP + HTTP checks 2026-10-20: project `javisdog` (`prj_PAwIaHpNB88K59du6ioiLSv4O42u`); every push to `claude/clever-goldberg-wlurty` auto-deploys (latest `dpl_5VWGaHotkQc8NiiqFd2JWfaCtLDh` from `9c9154a`, source git, READY); `https://javisdog.vercel.app` serves the app publicly — all 5 routes HTTP 200 with the disclosure banner, no Vercel login wall (Vercel Authentication `all_except_custom_domains` protects deployment URLs, not the production alias). Env var listing → 403 for the agent | — | — | — | No |
| Integrations | Database | Neon `dev-agent` branch + `DATABASE_URL` | AVAILABLE | 2026-10-20 re-check: `DATABASE_URL` is now a cloud-environment variable (pooled `dev-agent` host); read-only probe OK — PostgreSQL 18.6, `neondb_owner`, 0 public tables. Sandbox Node needs `NODE_USE_ENV_PROXY=1`. Password hash still equals the one pasted in chat → **not rotated** | Exposed credential remains valid | Rotate `neondb_owner` password in Neon, update the env secret (and Vercel if used) | Rotate | **Yes (B1-rotate)** |
| Integrations | GitHub SSO | GitHub OAuth App client id/secret | BLOCKED (invalid values) | 2026-10-20 re-check: `GITHUB_CLIENT_ID` set but 3 characters (placeholder; real IDs ≈ 20, `Ov23…`/`Iv1.…`); `GITHUB_CLIENT_SECRET` set but not 40-hex and **identical to `GOOGLE_CLIENT_SECRET`** (hash comparison) | Sign-in with GitHub impossible | Owner copies the Development OAuth App's real Client ID + generated secret | — | **Yes (B3)** |
| Integrations | Google SSO | Google OAuth client | BLOCKED (invalid secret) | 2026-10-20 re-check: `GOOGLE_CLIENT_ID` well-formed (`*.apps.googleusercontent.com`); `GOOGLE_CLIENT_SECRET` lacks the `GOCSPX-` prefix, equals the GitHub secret; Google token endpoint with a dummy code → **401 `invalid_client`** | Sign-in with Google impossible | Owner copies the client secret from Google Cloud → Credentials | — | **Yes (B4)** |
| Integrations | Email | Resend API key + verified sending domain + `EMAIL_FROM` | PARTIAL | 2026-10-20: `RESEND_API_KEY` present (format `re_…`), authenticates as a **sending-only** key (`GET /domains` → 401 `restricted_api_key`, as recommended), so domain verification cannot be checked by the agent; `EMAIL_FROM` missing | Welcome/alert emails cannot be sent until `EMAIL_FROM` uses a verified domain | Owner sets `EMAIL_FROM` and confirms the domain shows Verified in Resend | — | **Yes (B5)** |
| Integrations | Repo signals | GitHub App (webhooks) | MISSING | — | GitHub fallback collector blocked (S5) | Manifest-based GitHub App created by owner | Prepare manifest in S5 | **Yes (B6)** |
| Secrets | Required env var names | Cloud environment + Vercel | PARTIAL | 2026-10-20 cloud env: present — `DATABASE_URL`, `BETTER_AUTH_SECRET` (valid base64-32B), `BETTER_AUTH_URL=http://localhost:3000`, `GOOGLE_CLIENT_ID`, `RESEND_API_KEY`; invalid — `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`; missing — `EMAIL_FROM`. Vercel env listing still 403; `api.vercel.com` blocked; no `VERCEL_TOKEN` | Vercel side unverifiable | Token, health route or owner-provided names | Health route in S2 | Yes |
| Permissions | Session tool access | GitHub MCP (javi-dog), Vercel MCP | AVAILABLE | GitHub push to `claude/clever-goldberg-wlurty`; Vercel read OK, integration listing 403 | Some Vercel admin reads unavailable | — | Ask owner for marketplace actions | No |
| Environments | Local / preview / production | Vercel project + Neon branches | MISSING | No Vercel project yet | No previews | — | After B1/B2 | Yes |
| Data | Schema, migrations, seed, rollback | Drizzle migrations on Neon branches | NOT NEEDED (S0) | — | — | — | Define in S2 | No |
| Testing | Runner, scripts, CI | Vitest, GitHub Actions | AVAILABLE (S0) | Added in S0 (`vitest`, `.github/workflows/ci.yml`) | — | — | — | No |
| Browser/mobile | Browsers for E2E | Chromium | AVAILABLE | `/opt/pw-browsers/chromium` in session | — | — | Playwright from S2; desktop Chromium first | No |
| Observability | Logs/errors of the platform itself | Vercel runtime logs | AVAILABLE once deployed | Vercel MCP has runtime log tools | — | — | — | No |
| Security | Roles, authz boundaries, sensitive data | Requirements + tests | UNKNOWN | Workspace/role model not yet specified | Data leaks across workspaces | Define in S2 ADR | ADR in S2 | Yes (S2) |
| Performance | Ingest latency/payload targets | Load test + approval | UNKNOWN | Targets p95 < 2s, < 4 KB are hypotheses (brand slide 10) | Unproven SLA | Measure in S5 | Load test with approval | Yes (S5) |
| Budget | Paid plans (Vercel Pro, Neon, Resend) | Owner approval | UNKNOWN | — | Commercial beta blocked on Hobby terms | Free tiers for dev; paid before beta | Decide before S5 release gate | Yes |
| Legal | Pack Pool feasibility | Legal / ToS review | MISSING | Feasibility #14 | Pack Pool cannot proceed | Research only | Engage reviewer before S6 | **Yes (B7)** |
| Delivery | Release target, approvals, rollback | Owner approval | UNKNOWN | — | — | Release gate defined in plan S5 | — | Yes (S5) |

## Readiness decision

**Partial.** Sprint 1 (brand shell, JGR research/spec) can proceed. Sprint 2 is blocked on B1, B3, B4, B5 — owner will provision them following `docs/how-to/provision-external-services.md` (2026-10-20). B2 blocked on Vercel permission.

### Blockers and decisions

| ID | Blocker / unknown | Evidence | Option A | Option B | Option C | Recommendation | Decision owner | Decision / date |
|---|---|---|---|---|---|---|---|---|
| B0 | Brand kit | Owner upload | Use as Concept 0.1 | — | — | A | Owner | Accepted 2026-10-20 |
| B1 | Neon database | Connectivity verified; secret only shared in chat | Env secret + rotate password | — | — | A | Owner | Connectivity done 2026-10-20; secret storage pending |
| B2 | Vercel project | Created by owner as `javisdog`; production READY | — | — | — | — | Owner | **Done 2026-10-20** |
| B2a | Production behind Vercel Authentication | Re-checked: production alias is public (HTTP 200, real app) | — | — | — | — | — | **Resolved 2026-10-20 — not an issue** |
| B3 | GitHub OAuth | Missing | OAuth App | GitHub App user auth | — | A | Owner | Pending |
| B4 | Google OAuth | Missing | Google Cloud OAuth client | GitHub-only launch | — | A | Owner | Pending |
| B5 | Resend | Missing | Resend + domain | Defer email | — | A | Owner | Pending |
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
