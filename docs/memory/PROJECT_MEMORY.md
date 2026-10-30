# Project Memory — Javi's Dog

> Read this first in every session. Keep it short and current; history goes to `SESSION_LOG.md`.
> Last updated: 2026-10-29 · Current sprint: **S5c Codex CLI collector — built** (`docs/sprints/SPRINT-05c.md`, ADR-0016 S5c entries). Next: the S5 release gate (`docs/how-to/release-checklist.md`) and Guru G4. Owner items: real Claude Code, Gemini and Codex runs (`docs/how-to/run-first-real-sessions.md`); production stays on `dev-agent` (cutover deferred); the first purge run is checked 2026-10-30 20:20 UTC.

## What we are building

Javi's Dog — *Every agent. One clear signal.* A privacy-aware observability companion for vibe coders: projects, live agents, token burn and effectiveness analytics across coding tools, fed by the **Javi Grande Rules (JGR)** protocol. Later: a keep-the-flow resilience layer. Pack Pool (P2P capacity) is concept-only research.

## Current state

- S0 foundations (Orcasus, brand, ADR-0001…0003, monorepo, CI, Guru): see `docs/sprints/SPRINT-00.md`.
- G0 done: 4 generalized skills in `guru/skills/` (medium confidence); see `guru/WISDOM_LOG.md`.
- S1a done: five-space shell with honest states (JD-APP), JD-M13 components, JD-M04 draft project schema.
- S1b done: JGR v0.1 draft (JD-M01) — spec `docs/jgr/spec/v0.1.md`, ADR-0004, 20 conformance vectors, primary-source research; 89 tests green workspace-wide.
- Deployed: Vercel project `javisdog` (owner-created), auto-deploys every push; `https://javisdog.vercel.app` is public (5 routes verified HTTP 200). Neon `dev-agent` reachable over HTTPS only (PostgreSQL 18.6; psql/TCP times out in the sandbox). *(2026-10-20 snapshot; sign-in and ingest are live since S2b/S3a.)*
- Credentials (2026-10-20 re-check, shape only): all 10 S2 env vars present and well-formed in the cloud env; Google OAuth client authenticates; Resend accepts sends from `eagodi.com` (B5 done); GitHub secret unverifiable from the sandbox; Vercel env still unreadable (403).
- S2a built (2026-10-22): JD-M06 `@javis-dog/event-store` (Neon HTTP client, migrations, `pingDb`), JD-M04 tables + workspace-scoped repository + `jd_it_` tokens stored as SHA-256, `GET /api/health`. Migration `0000` applied on `dev-agent` (3 tables). 145 tests + CI green. Production `/api/health` → 503 `not_configured`: Vercel Production lacks `DATABASE_URL` (intended) and the GitHub OAuth pair. Vercel builds this branch as **Production** (no Preview env).
- S2b built (2026-10-22): JD-M03 `@javis-dog/identity` (Better Auth 1.7.7, GitHub + Google, org plugin mapped onto `workspaces`, personal workspace on first sign-in), migration `0001` on `dev-agent` (9 tables), `/sign-in`, `/api/auth/*`, topbar account menu. Real GitHub + Google sign-in verified on production; tokens encrypted, `id_token` not stored. 174 tests green. ADR-0006.
- S2 delivered as S2a (data layer), S2b (sign-in), S2c (projects, tokens, welcome email) — all closed 2026-10-22.

- S2c built (2026-10-22): project list/create, project detail with ingest-token issue (shown once) / revoke, workspace from session + membership only; JD-M09 `@javis-dog/notify` welcome email via Resend REST; redacted auth logs; failed sign-ins return to `/sign-in?error=`. 203 tests. ADR-0007.
- S3a built (2026-10-23): JD-M05 `@javis-dog/ingest` + `POST /api/v1/events` (bearer ingest token, 256 KB after gzip, JD-M01 validation, `project_mismatch` / `privacy_class_not_allowed`, per-project dedupe, 60 batches/min/token, verified `last_signal_at`); JD-M06 `events` + `ingest_rate_windows` (migration 0002 applied on `dev-agent`: 3 migrations). 243 tests; `db:smoke` 10/10 and `smoke:live` 7/7 against production. S3a closed. ADR-0008: 30-day retention (purge job in S3b), Postgres rate limit.
- S3b built (2026-10-23): JD-M02 `@javis-dog/jgr-sdk` (`record`/`flush`, monotonic ULIDs, file + memory spool, batches ≤ 100/256 KB with gzip, full-jitter retry + `Retry-After`, 401/403 keep spool, 413 halves, 400 drops); daily `GET /api/cron/purge-events` (Vercel Cron 20:00 UTC, `CRON_SECRET`, 30 days). 280 tests. ADR-0009. Purge inactive until the owner sets `CRON_SECRET`.
- S3c built (2026-10-23): JD-C01 `collectors/claude-code` — `javi` CLI (`init`/`hook`/`flush`/`status`/`uninstall`), exec-form `async` hooks in `.claude/settings.local.json`, allowlist mapping (no prompts/tool I/O/paths), salted `cc_`/`ag_` refs, token in `~/.javi`, detached flush. Hook contract verified against code.claude.com docs. 31 collector tests incl. real Windows processes. ADR-0010. Token usage (OTel) → S3d.
- Local Windows dev machine ready (2026-10-23): Node 22.23.4, pnpm 10.28.0, Git 2.55.0; all checks green (209 tests). Repo now forces LF (`.gitattributes`) and resolves file URLs with `fileURLToPath` — required for Windows paths with spaces. Owner prefers local runs in GMT+7 windows: weekdays 23:00–17:00, weekends 22:00–08:00.

- S3d (2026-10-28): ingest hardening H1–H6 (canonical event ids + migration 0003 check, signal on duplicate retries with DB-clock cap, bounded purge, 415 for media type/encoding with SDK keeping the spool, >100 events → 413, sorted inserts, DB-clock rate window); 43 QA conformance vectors + runner (mutation-checked); 383 tests; production smoke 7/7; dev-agent at 4 migrations. CI on `98c7974` FAIL (collector `process.test.ts` ordering race, pre-existing since `fe604d1`); test fixed in `1bb95e9` (CI green), product code unchanged.
- S3e built (2026-10-28, ADR-0011): opt-in `javi usage on|off` edits `~/.claude/settings.json` env (project settings cannot enable OTel — verified), local receiver `javi receive` on `127.0.0.1:4319` (bearer + Host checks, 1 MiB, http/json only), allowlist parser (`session.id`, `model`, `type`), deterministic UUID event ids, sessions attributed via hooks (unknown → dropped locally). JD-M02 optional caller `event_id`. 40 QA OTLP vectors + runner (mutation-checked); Reviewer: 3 major fixed (red-first tests); 628 tests. UNVERIFIED until a real run: OTel `session.id` = hook `session_id`.
- S3f built (2026-10-28): `pnpm pack:cli` → private, dependency-free `javis-dog-javi-0.1.0.tgz` (`npx ./…tgz init`), versioned stable copy `~/.javi/bin/<version>/javi.mjs`, `THIRD_PARTY_NOTICES.md`; Windows UNVERIFIED. Guru G2 done (5 new skills, 5 updated; Orcasus PR proposal only). G2 found CI red on three docs pushes (`474427c`, `a632803`, `92a9244`) from a process-test race (receiver idle timer vs start-up) — fixed, plus a false port-conflict under load; CI no longer cancels branch runs.
- S4a built (2026-10-28, ADR-0012, owner: 10 s polling): JD-M07 `@javis-dog/realtime` read model (thread state, freshness 180 s, `needsAttention`, counters, activity, project health; 3 workspace-scoped queries); `GET /api/dashboard/snapshot`; real Overview / Live agents / Projects with client-clock aging, "Not current" on failed refreshes, 8 s timeout. 27 QA state vectors + runner (mutation-checked); Reviewer 3 major fixed red-first; 776 tests.
- S4b built (2026-10-28, ADR-0013): JD-M08 `@javis-dog/analytics` (per-UTC-day tokens, estimated cost, tasks, by model/project, `estimatedReports`); migration 0004 `events_workspace_received_idx` (dev-agent: 5 migrations); Overview token chart (grouped columns + table) + usage by project, Project detail usage; absolute UTC stamps. 23 QA analytics vectors + runner (mutation-checked); Reviewer 1 major fixed red-first; 888 tests. Rendered chart layout NOT verified (screenshot budget 0).
- S4c built (2026-10-28, ADR-0014; owner: monthly USD per project, alerts on ingest, owners at 80 %/100 %): JD-M12 `@javis-dog/resilience` (`project_budgets` with composite FK, `budget_alerts` exactly-once claims, linear forecast, budget-first claim), migration 0005 (dev-agent: 6 migrations), retention keeps the current UTC month (ADR-0008 change), JD-M09 budget email (one per owner, 10 s timeout, per-attempt idempotency key), JD-M05 `onStored` + `after()`. 25 QA budget vectors + strict runner; real-Postgres parallel-claim check; Reviewer 4 major fixed red-first; 1105 tests. Known limitation: a partial email failure can resend to owners who already got it (≤ 5 attempts).

- S5a (2026-10-28, ADR-0015; owner: release-first, Neon `main` as production, no secret rotation, quotas without migration):
  - `main` is migrated through the Neon MCP (`db:statements`) and matches `dev-agent`.
  - Rollback plan, runbooks and release checklist are written.
  - 52 access-boundary tests.
  - Security review: 0 critical/high. Fixed:
    - the organization plugin's HTTP surface is closed (404);
    - project and token actions are owner/admin only;
    - 20 projects per workspace and 10 tokens issued per 24 h;
    - a nesting guard (400 instead of 503);
    - security headers.
  - Capped load-test and packed e2e scripts are ready for one production run.
  - Tests run at turbo concurrency 2 (oversubscription diagnosed).

- S5b (2026-10-29, ADR-0016). Owner decisions: Gemini OTel is a user-level opt-in; cost is estimated from a dated price table and only for API-key/Vertex auth; Codex uses opt-in logs with an allowlist (S5c); "detect, refuse, warn" for telemetry redirection.
  - **JD-C02** `@javis-dog/collector-adapters` (pure): Gemini hook mapper, OTLP parser (hidden series id and auth type), delta rule (input − cache), and a 13-row Vertex price table.
  - **JD-C01** `javi --platform gemini-cli`: hooks in `.gemini/settings.json`; a telemetry block in `~/.gemini/settings.json` with exact restore; the logs and traces sink; a `.env` redirection guard at setup and at every session start.
  - **Tests:** 53 QA vectors and a runner (30 of 32 mutations killed). The review round fixed 1 high and 5 medium findings red-first. 1461 tests.

- S5a was completed on production (`dev-agent`):
  - load test p95 1 529 ms;
  - packed e2e smoke PASS, after fixing hook stderr under `NODE_USE_ENV_PROXY` (`--no-warnings`);
  - `CRON_SECRET` set (purge answers 401 without the secret);
  - cleanup done.
- S5c (2026-10-29). Owner decisions: logs-only usage, tokens only for ChatGPT plans, sub-agent usage attributed to the parent, smol-toml 1.9.1, detect and warn about the header leak, stable launcher. Built:
  - JD-C02 Codex adapters;
  - JD-C01 `--platform codex-cli`: launcher, append-only `hooks.json`, a TOML-validated `config.toml` block, proxy, system-proxy and header guards, `/v1/logs/codex-cli`, persisted accepted ids;
  - 41 QA vectors with a runner (14/14 mutations).

  The design review (6 high) ran before any code, and the code review (2 high) was fixed red-first. 1698 tests.
- S5d (2026-10-30, ADR-0017). Owner decisions: JD-C03 next; the hook emits the event; a hand-written server; the reason goes in `error_code`; opt-in registration, plus an opt-in `--allow-self-report`; a self-reported `blocked` needs attention. Built:
  - JD-C02 self-report vocabulary, validator, matcher and mapper;
  - JD-C03 hand-written stdio MCP server, with no runtime dependency (the SDK client is used only in tests);
  - JD-C01: `javi mcp`, `init --self-report`, an unversioned launcher, git-tracked refusal (fail-closed), a seen-call marker, urgent flush for self-reports and end of turn;
  - JD-M07 precedence rule, `statusSource` and `statusReason`;
  - JD-APP pill "Blocked · missing credentials · reported by agent";
  - 54 QA vectors and runners: 71 of 74 mutations caught;
  - an end-to-end hook → ingest → reader test.

  The design review ran before code (2 high), QA spec gaps (19, including a real design flaw), and the code review (0 high, 3 medium fixed red-first). 2200 tests. Real CLI runs are NOT RUN (owner, how-to step 6).
- S5e (2026-10-30, owner "proceed"):
  - F1: "needs you" wording;
  - F2: 59 self-report vectors (step clock, H15 catches a disabled seen-call marker);
  - F3: Codex `hooks.json` tracked check fails closed;
  - push gate: `pnpm secrets:scan` (fail-closed), plus TEAM.md rules for the previous tip's CI, dead-endpoint probes, module IDs and one-hand lockfile.

  2212 tests; CI green on `ec20396`.

## Decisions in force

| Ref | Decision |
|---|---|
| Plan | Approved 2026-10-20 (feasibility + 7-sprint roadmap, `docs/explanation/roadmap.md`) |
| Owner | Resilience layer first; Pack Pool research only (S6, gated by legal review B7) |
| Owner | All documentation in English |
| Owner | Guru skills live in `guru/`; propose PRs to `haidongkixot/orcasus` at G2 and G4 |
| Owner | First collectors: Claude Code, Codex/Gemini CLI, GitHub |
| Owner | Light-only MVP; tokens theme-scoped for a later dark theme (D2) |
| Owner | Logo = template SVG as concept 0.1, trademark clearance pending |
| ADR-0001 | Modular monolith, `JD-*` module IDs, lint-enforced boundaries |
| ADR-0002 | Next.js 16 / React 19 / TS 5.9 / Tailwind 4 / Neon + Drizzle / **Better Auth** / Resend / Vitest |
| ADR-0003 | Brand → theme-scoped tokens; AA text tokens with unchanged hues (D1 accepted 2026-10-20) |
| ADR-0004 | JGR v0.1: own strict envelope over HTTPS batches; OTLP/HTTP accepted and stripped at the edge (owner review pending) |
| Owner | Sprint timebox ≤ 30 minutes; oversized sprints are split (S1a/S1b, S2a/S2b) |
| ADR-0010 | Accepted 2026-10-23: Claude Code collector = command hooks (exec form, async) + local allowlist mapping + file spool + detached flush; HTTP hooks rejected (would ship raw prompts) |
| ADR-0009 | Accepted 2026-10-23: SDK delivery rules (full jitter, `Retry-After`, 401/403 keep, 413 halve, 400 drop), one-file-per-event spool, daily Vercel Cron purge with `CRON_SECRET` |
| ADR-0008 | Accepted 2026-10-23: `events` in JD-M06 (dedupe per project), 30-day raw retention, Postgres per-token rate limit (60/min), receiver codes `project_mismatch` / `privacy_class_not_allowed`, 256 KB after gzip |
| ADR-0007 | Accepted 2026-10-22: welcome email via Resend REST from `onUserCreated`; PII-free auth logging; `errorURL` → `/sign-in` |
| ADR-0006 | Accepted 2026-10-22: Better Auth organization plugin mapped onto `workspaces`; personal workspace (owner) on first sign-in; open sign-up; telemetry off; OAuth tokens encrypted |
| ADR-0017 | Accepted 2026-10-30: agent self-report through javi's local MCP server (`javi mcp`, two tools with fixed lists). The post-tool hook emits the event in the session's thread. A hand-written server; the reason goes in `error_code`; opt-in registration without pre-granted permissions (opt-in `--allow-self-report`). The dashboard labels the agent's own claim and keeps it until real activity |
| ADR-0016 | Accepted 2026-10-29: one `javi` CLI with pure platform adapters (JD-C02). For Gemini: hooks per project, OTel as a user opt-in with forced `logPrompts:false` and a redirection guard; cost estimated only for per-token auth; `estimated:false` because the tokens are exact. Codex follows in S5c (opt-in logs allowlist); S5c: logs-only Codex usage (statsig untouched), cost only for `ApiKey`, sub-agents attributed to the parent, stable launcher, smol-toml block edit, loopback `NO_PROXY` rule, system-proxy guard, persisted accepted ids |
| ADR-0015 | Accepted 2026-10-28: production database = Neon `main` (the integration's production branch). Migrations go through drizzle `readMigrationFiles` and the Neon MCP, one transaction each. Cutover is an owner step. Rollback paths have stated limits: 6 h restore. The load-test budget is fixed. Accepted risk: no rotation of the exposed secrets |
| ADR-0005 | Accepted 2026-10-22: module-owned Drizzle tables composed by JD-M06; offline `generate` + neon-http migrator on `dev-agent` only; ingest tokens `jd_it_…` stored as SHA-256; workspace-scoped repository |

## Open questions / blockers (owner)

- **Guru G2-prep findings** (2026-10-22): F1–F4 fixed in the same session; owner decisions open: two-week release cooldown as policy (ADR-0002 amendment), rotation of exposed secrets (B1-rotate + GitHub secret).
- **Vercel env** done 2026-10-22: production `/api/health` → 200, all 9 vars set, DB `ok` (Q5 = A: Production → `dev-agent` until S5). The GitHub client secret pasted in chat on 2026-10-22 is exposed → rotate with B1.
- **B1-rotate** superseded 2026-10-28 by the owner's accepted risk (no rotation before release; readiness "Accepted risk" row). **2026-10-23: the connection string was pasted in chat again → rotation now strongly recommended.**
- **ADR-0004** owner review pending.

## Next actions

1. Owner: revoke the ingest token pasted in chat on 2026-10-29 (project `test-01-project-horizos`) and issue a new one.
2. Owner: run the real Claude Code, Gemini CLI and Codex CLI sessions (`docs/how-to/run-first-real-sessions.md`, e.g. via a local Claude Code) and paste the "Report back" items → closes release-checklist G6 and the UNVERIFIED runtime rows (session-id match, Gemini/Codex hook behaviour, Windows). Step 6 covers agent self-report (S5d): protocol version, approval prompts, Windows spawn.
3. Owner: decide the release exceptions in `docs/how-to/release-checklist.md` (G2 cutover deferred; G4/G5 measured on `dev-agent`) and G13 (paid plans / Vercel Hobby terms).
4. Agent: 2026-10-30 20:20 UTC — verify the first purge run by data (scheduled check) → G9.
5. Owner: review the G4 Orcasus PR proposal and the `CLAUDE.md` §2 rule-4 proposal in `guru/WISDOM_LOG.md` (nothing opened).
6. Owner (optional): approve upgrading dev-only tooling with advisories (`markdownlint-cli2`, `drizzle-kit`; readiness "Dependency advisories").
7. Owner (optional): approve a bounded visual check of the dashboard/chart (≤ 6 screenshots).
8. Agent: the S5d follow-ups F1–F3 are done (S5e). Next development candidates are JD-M11 privacy L1/L2 (needs an ADR and owner decisions) and JD-M10 GitHub App (blocked on the owner creating the app).

## Process (owner decisions 2026-10-28)

- Agent team per `docs/agent-ops/TEAM.md`; **this cloud session is the only pusher** to `claude/clever-goldberg-wlurty`; `git fetch` before planning and before every push.
- Reconciliation A (2026-10-27/28): the owner's S3a–S3c line is the baseline; the superseded parallel S3a work stays on the local branch `backup/s3a-parallel` (not pushed).

## Key paths

`CLAUDE.md` · `docs/agent-ops/` · `docs/brand/BRAND_GUIDE.md` · `docs/adr/` · `docs/modules/REGISTRY.md` · `docs/sprints/` · `guru/`
