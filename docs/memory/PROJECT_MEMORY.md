# Project Memory — Javi's Dog

> Read this first in every session. Keep it short and current; history goes to `SESSION_LOG.md`.
> Last updated: 2026-10-28 · Current sprint: **S3f — `npx` packaging (bundle + tarball) + Guru G2** (not started). S3e — token usage via a local OTLP receiver — built, CI green on `a3e4ce8` (`docs/sprints/SPRINT-03e.md`). Last closed: S3d. Waiting on owner: S3b (`CRON_SECRET`), S3c + S3e (first real `javi init` + `javi usage on` + a Claude Code session).

## What we are building

Javi's Dog — *Every agent. One clear signal.* A privacy-aware observability companion for vibe coders: projects, live agents, token burn and effectiveness analytics across coding tools, fed by the **Javi Grande Rules (JGR)** protocol. Later: a keep-the-flow resilience layer. Pack Pool (P2P capacity) is concept-only research.

## Current state

- S0 foundations committed on branch `claude/clever-goldberg-wlurty`: Orcasus adopted, brand guide + logo v0.1, feasibility, readiness, ADR-0001…0003, monorepo scaffold, JD-M13 tokens (29 tests), minimal JD-APP page, CI (GitHub Actions green), vendored skills, Guru agent.
- G0 done: 4 generalized skills in `guru/skills/` (medium confidence); see `guru/WISDOM_LOG.md`.
- S1a done: five-space shell with honest states (JD-APP), JD-M13 components, JD-M04 draft project schema.
- S1b done: JGR v0.1 draft (JD-M01) — spec `docs/jgr/spec/v0.1.md`, ADR-0004, 20 conformance vectors, primary-source research; 89 tests green workspace-wide.
- Deployed: Vercel project `javisdog` (owner-created), auto-deploys every push; `https://javisdog.vercel.app` is public (5 routes verified HTTP 200). Neon `dev-agent` reachable over HTTPS only (PostgreSQL 18.6, empty schema; psql/TCP times out in the sandbox). No auth or ingest yet.
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
| ADR-0005 | Accepted 2026-10-22: module-owned Drizzle tables composed by JD-M06; offline `generate` + neon-http migrator on `dev-agent` only; ingest tokens `jd_it_…` stored as SHA-256; workspace-scoped repository |

## Open questions / blockers (owner)

- **Guru G2-prep findings** (2026-10-22): F1–F4 fixed in the same session; owner decisions open: two-week release cooldown as policy (ADR-0002 amendment), rotation of exposed secrets (B1-rotate + GitHub secret).
- **Vercel env** done 2026-10-22: production `/api/health` → 200, all 9 vars set, DB `ok` (Q5 = A: Production → `dev-agent` until S5). The GitHub client secret pasted in chat on 2026-10-22 is exposed → rotate with B1.
- **B1-rotate** deferred by owner ("use first, rotate later"): rotate `neondb_owner` before real user data or the S5 release gate. **2026-10-23: the connection string was pasted in chat again → rotation now strongly recommended.**
- **ADR-0004** owner review pending.

## Next actions

1. Owner: rotate `neondb_owner` (pasted in chat on 2026-10-20 and 2026-10-23) and the GitHub client secret (pasted 2026-10-22); update Vercel afterwards.
2. Owner: add `CRON_SECRET` on Vercel Production (steps in `SPRINT-03b.md`) → closes S3b.
3. Owner: first real `javi init --usage` + a Claude Code session (steps in `SPRINT-03c.md` + `javi usage on`), then `javi status` → closes S3c (exec-form hook `args`) and S3e (usage forwarded, not dropped = session ids match).
4. S3f — `npx` packaging (esbuild bundle from the lockfile, `pnpm pack` tarball, `javi init` copies the bundle to `~/.javi/bin`), then Guru **G2** + Orcasus PR proposal. S4 (live dashboard; cost labelled as estimated) after.

## Process (owner decisions 2026-10-28)

- Agent team per `docs/agent-ops/TEAM.md`; **this cloud session is the only pusher** to `claude/clever-goldberg-wlurty`; `git fetch` before planning and before every push.
- Reconciliation A (2026-10-27/28): the owner's S3a–S3c line is the baseline; the superseded parallel S3a work stays on the local branch `backup/s3a-parallel` (not pushed).

## Key paths

`CLAUDE.md` · `docs/agent-ops/` · `docs/brand/BRAND_GUIDE.md` · `docs/adr/` · `docs/modules/REGISTRY.md` · `docs/sprints/` · `guru/`
