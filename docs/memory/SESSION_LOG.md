# Session Log

Append-only handoff log, newest first. Each entry: date · session · what happened · state left behind · next step.

## 2026-10-28 · Session 2 (cloud), continued — S4c budgets and alerts

- Owner decisions: monthly USD budget per project; alerts on ingest (no cron); workspace owners at 80 %/100 %. ADR-0014; retention keeps the current UTC month (31-day months).
- Lanes B1 logic, B2 email+ingest, B3 UI, QA 25 vectors, D runner; real-Postgres parallel-claim check on dev-agent; Reviewer 4 major (false "emailed", rounding up, aggregate without budget, Resend timeout) fixed red-first; Resend idempotency semantics unverifiable here → per-attempt keys. CI green on `e968421`; production healthy, no runtime errors.
- Next: Guru G3, owner's first real run with a budget, S5.

## 2026-10-28 · Session 2 (cloud), continued — S4b usage analytics

- ADR-0013 (no owner question needed: within roadmap, no dependency/cost). Migration 0004 index applied to dev-agent after deploy (health 5). Lanes A1 reader, W3 UI, QA 23 vectors; runner + mutation checks; Reviewer 1 major (usage "ago" freezing on open pages) + 4 minor — fixed red-first. CI green on `1993bd8`; production health ok.
- Next: S4c (budgets/alerts — owner decisions + `CRON_SECRET`), then G3.

## 2026-10-28 · Session 2 (cloud), continued — S4a live state

- Owner: "Proceed S4 first"; chose 10 s polling (ADR-0012). S4 split into S4a (live state), S4b (analytics), S4c (budgets/alerts).
- Lanes: R1 read model, W1+W2 route/hook/pages, QA 27 state vectors; orchestrator runner (mutation-checked); Reviewer found 3 UI truthfulness majors (ended = attention, stale data looking fresh, hung poll) — fixed red-first. CI green on `6377e88`.
- Process slip: a memory-update script failed mid-way and the commit chain continued (script not chained) — memory completed in the next commit.
- State: dashboard shows real workspace data once events exist; production has none until the owner's first real run. Next: S4b.

## 2026-10-28 · Session 2 (cloud), continued — S3f packaging, Guru G2

- S3f: esbuild bundle + private, dependency-free tarball; versioned `~/.javi/bin/<version>/` copy; THIRD_PARTY_NOTICES; reviewer round fixed (2 major). Windows UNVERIFIED.
- Guru G2 found CI red on three S3e docs pushes that had not been checked; root cause reproduced (process-test race) and fixed, plus a false port conflict under load; CI no longer cancels branch runs; stale readiness/memory refreshed.
- Next: owner items (CRON_SECRET, first real run incl. `/clear`, secret rotation, G2 proposals), then S4 planning.

## 2026-10-28 · Session 2 (cloud), continued — S3e token usage

- Researcher verified the Claude Code OTel contract; the key fact (project settings cannot enable OTel) changed the plan → owner chose opt-in global OTel and bundle + tarball packaging (no npm publish).
- ADR-0011, test plan before lanes; lanes U1 (parser/mapping), U2 (settings editor), U3 (receiver/CLI/attribution), QA (40 OTLP vectors); orchestrator added the conformance runner (mutation-checked) and accepted QA A3. Reviewer: 3 major + 7 minor; fixed with red-first tests. CI green on `a3e4ce8`, production healthy.
- State: S3e built; runtime check (session id match) waits on the owner's first real run. Next: S3f packaging + G2.

## 2026-10-27/28 · Session 2 (cloud), continued — S3 planning, parallel-work incident, S3d hardening

- 2026-10-27: planned S3 with the Orcasus agent team (owner: roles, seeded smoke, 30-day cron retention, per-project HMAC refs) and built a parallel S3a locally — then found the owner's local session had already pushed S3a–S3c to the same branch (`8fd567c`…`5cc8ac0`, migration 0002 on dev-agent). Nothing of the parallel line was pushed or applied (its migration failed on the first statement); work kept on local `backup/s3a-parallel`.
- Owner chose reconciliation **A** (owner line = baseline), named this cloud session the only pusher, asked to fix the audit's majors first, and chose a local OTLP receiver for S3e.
- S3d: Developer, QA and Reviewer lanes per `TEAM.md`; H1–H6 + ports (TEAM.md, template Team section, worktree ignores, migration-recovery how-to); 43 HTTP conformance vectors + runner; reviewer findings fixed. Migration 0003 applied to dev-agent after a re-run pre-check (0 rows); production `98c7974` healthy (4 migrations), `smoke:live` 7/7.
- CI on `98c7974` failed in `collectors/claude-code/test/process.test.ts` (read the state file before the flusher wrote it). Pre-existing: also red on `fe604d1`. Reproduced with a late-answering receiver, fixed the test (no product change), full gate 383 green locally; CI green on `1bb95e9` (run 40612946751), production healthy on it. S3d closed.
- Next: owner items (`CRON_SECRET`, first real `javi init`, secret rotation), then S3e.

## 2026-10-23 · Session 3, continued — Sprint 3c (Claude Code collector)

- Owner deferred `CRON_SECRET`; asked for S3c. A docs agent + direct fetch verified the Claude Code hook contract (events, fields, `async`, exec form, stdout/exit semantics, settings files).
- Built JD-C01 `collectors/claude-code` (`javi` CLI) and a JD-M02 request timeout. 31 collector tests incl. real Windows hook processes with detached delivery. ADR-0010.
- State: not yet run inside a real Claude Code session (needs the owner's ingest token). Next: owner runs `javi init` (SPRINT-03c §Owner steps); then S3d (token usage via OTel).

## 2026-10-23 · Session 3, continued — Sprint 3b (SDK + retention purge)

- Discovery: Vercel root `apps/web`, Hobby cron daily, `CRON_SECRET` only settable by the owner; hook collectors are short-lived → file spool (ADR-0009).
- Built JD-M02 `@javis-dog/jgr-sdk` and the daily purge route + `apps/web/vercel.json`; health now reports `CRON_SECRET`. 280 tests, all checks green.
- State: purge answers 503 `not_configured` until the owner adds `CRON_SECRET` (steps in `SPRINT-03b.md`). Next: owner step, then S3c (Claude Code collector).

## 2026-10-23 · Session 3, continued — Sprint 3a (ingress endpoint)

- Discovery delta: no `DATABASE_URL` on this machine; spec lacked codes for wrong project / privacy above opt-in; dedupe key must be project-scoped; S3 split into S3a/S3b/S3c. Owner: Q1 30-day retention, Q2 Postgres rate limit, Q3 owner runs the migration. ADR-0008.
- Built JD-M05 `@javis-dog/ingest`, JD-M06 `events` + `ingest_rate_windows` (migration 0002 + rollback), JD-M04 `verifyToken` scope + `markTokenUsed`, JD-M01 codes, `POST /api/v1/events`. 243 tests, all checks green, no migration drift.
- Defect caught by the build: Turbopack resolves `new URL('../migrations', import.meta.url)` → separate entry `@javis-dog/event-store/migrations`.
- Owner then pasted the `dev-agent` connection string in chat; agent verified the DB matched production (2 migrations, owner rows), applied 0002, `db:smoke` 10/10, new `smoke:live` 7/7 against production; temp secret file deleted. S3a closed.
- State: production ingest live and verified. Owner action: rotate `neondb_owner` (exposed in chat). Next: S3b.

## 2026-10-23 · Session 3 (Claude Code desktop, owner's Windows machine) — local toolchain

- Owner: run token-saving work on the local machine inside GMT+7 windows (weekdays 23:00–17:00, weekends 22:00–08:00).
- Installed with owner approval: Node 22.23.4 + Git 2.55.0 (winget), pnpm 10.28.0 (npm -g). `pnpm install --frozen-lockfile` exit 0.
- First local run: lint/typecheck/build PASS; test FAIL (event-store 3 failed) and docs:check FAIL. Root causes: (1) `new URL(...).pathname` yields `/D:/Claude%20Projects/…` on Windows → `fileURLToPath` in event-store test helper, `db:migrate`, `check-links`, `modules-registry`; (2) `core.autocrlf=true` checkout → migration file hashes differ from the LF hashes in rollback SQL, registry check sees CRLF → added `.gitattributes` (`* text=auto eol=lf`).
- After fixes: lint, typecheck, test (209 passed), docs:check exit 0 (doc-drift SKIPPED: no `origin/main`), build exit 0 earlier in the session.
- Next: S3 (JGR ingress).

## 2026-10-22 · Session 2, continued — Sprint 2c (projects, tokens, welcome email)

- Built project UI, token issue/revoke, workspace resolution with membership check, JD-M09 welcome email (Resend REST), redacted auth logs, `/sign-in?error=`. ADR-0007. 203 tests green; welcome email accepted by Resend sink.
- Owner ran create project / issue / revoke on production; DB check passed; CI green; S2c closed. Guru checkpoint G2-prep run (see `guru/WISDOM_LOG.md`).
- Next: S3 (JGR ingress).

## 2026-10-22 · Session 2, continued — Sprint 2b (sign-in)

- Owner: Vercel Production env completed (GitHub pair, `DATABASE_URL`); production `/api/health` 200. "start 2b".
- S2b split (timebox): sign-in now; project/token UI + welcome email → S2c.
- Built JD-M03 (Better Auth 1.7.7, GitHub/Google, org plugin on `workspaces`, personal workspace hook), migration `0001` on `dev-agent`, `/sign-in`, `/api/auth/*`, account menu; ADR-0006; 173 tests green; local build serves both provider URLs.
- Owner signed in with GitHub and Google on production (second attempt). Rows verified; Google `id_token` was stored in plain text → account hooks now drop it (test red → green), existing value cleared. S2b closed.
- Next: S2c.

## 2026-10-22 · Session 2, continued — Q5 and Vercel env

- Owner: Q5 = A (Production → `dev-agent` until S5); pasted a GitHub client secret in chat (40 hex, differs from the cloud-env secret by hash; never written to the repo).
- Agent tried to set it on Vercel Production → 403 "Additional permissions are required to create production environment variables". Owner must set the Vercel vars.
- 19:20 UTC: owner updated project env (project `updatedAt`); live build `9b6ea0b` (19:11) still reports `DATABASE_URL`/GitHub pair = false and no redeploy had run → this docs commit triggers the rebuild.
- Rebuild `9cdc766`: production `/api/health` → 200, all 9 vars true, DB `ok` (136 ms, 1 migration).
- Next: S2b (Better Auth GitHub/Google).

## 2026-10-22 · Session 2, continued — Sprint 2a build

- Owner: "go with the recommendations" (Q1 PGlite, Q2 public health, Q3 Preview → dev-agent / Production unset, Q4 events in S3). Session worker restarted mid-sprint; work on disk survived.
- Built JD-M06 package, JD-M04 tables/repository/tokens, `/api/health`; migration `0000` applied to `dev-agent`; smoke 7/7; 145 tests, lint, typecheck, build green; CI gains a migration drift step.
- Defects caught before push: tokens could cross workspaces (composite FK added), `pingDb` crashed on an unmigrated DB, Node type stripping rejected parameter properties (`erasableSyntaxOnly` on).
- Pushed `dc6ef61`; CI run 18 green; production `/api/health` → 503 `not_configured` (no `DATABASE_URL`, no GitHub OAuth pair on Vercel Production). Vercel builds this branch as Production → new owner question Q5. S2a closed.
- Next: owner answers Q5 and adds GitHub vars on Vercel; then S2b (Better Auth).

## 2026-10-20 · Session 2 (Claude Code, cloud) — credential re-check + S2a plan

- Re-checked env vars (presence/shape only): all 10 S2 vars present and well-formed; OAuth secrets no longer hold callback URLs. Neon `dev-agent` OK over HTTPS (PG 18.6, 0 tables); psql/TCP times out. Google client authenticates (`invalid_grant` probe). GitHub token endpoint blocked by the sandbox proxy (403); Vercel env listing still 403. Rotation of `neondb_owner` not verifiable.
- Planned S2a (`docs/sprints/SPRINT-02a.md`), ADR-0005 (Proposed), refreshed `TEST_PLAN.md`, readiness matrix and discovery delta. Sign-in moved to S2b.
- Owner: B1-rotate deferred ("use first, rotate later"); GitHub OAuth to be proven at S2b sign-in. Agent verified B5: one probe send from `EMAIL_FROM` to `delivered@resend.dev` → HTTP 200 (domain verified for sending).
- State: docs only, nothing implemented or deployed. Next: owner answers Q1–Q4, then run S2a.

## 2026-10-20 · Session 1, continued — Sprints 1a and 1b

- Owner: B2 approved (blocked by Vercel 403 — dashboard steps written), D1 accepted, sprints ≤ 30 minutes, owner will provision Neon / GitHub OAuth / Google OAuth / Resend (`docs/how-to/provision-external-services.md`).
- S1a (≈ 9 min): five-space shell, JD-M13 components, JD-M04 draft schema. S1b (≈ 8 min): JGR v0.1 spec, JD-M01 validator, 22 conformance vectors, primary-source research.
- G1 by Javi's Guru: 3 new skills, 2 updated; found 6 defects in the work (weak guard regexes, refs accepting paths/emails, spec contradiction, overclaiming copy, stale memory, config outside typecheck) — reproduced and fixed with red→green evidence.
- State: all checks green; nothing deployed. Next: S2 once credentials exist.

## 2026-10-20 · Session 1 (Claude Code, cloud) — Sprint 0

- Owner brief received; feasibility + 7-sprint plan approved after four owner decisions (resilience first, English docs, Guru → guru/ + Orcasus PRs, collectors Claude Code/Codex/Gemini/GitHub).
- Plan put on hold for brand; owner supplied Concept 0.1 proposal (PDF) and HTML template. Two more decisions: light-only MVP, template SVG logo v0.1.
- Built S0: Orcasus adoption, brand guide + measured contrast, readiness/discovery/feasibility, ADR-0001…0003, monorepo + JD-M13 tokens + JD-APP foundation page, CI, docs checks, vendored skills, Guru agent.
- G0 checkpoint run by Javi's Guru (separate agent); output verified by the orchestrator and committed.
- State: all local checks and GitHub Actions CI green (see `docs/sprints/SPRINT-00.md`); branch `claude/clever-goldberg-wlurty` pushed. Nothing deployed.
- Waiting on owner: B2 (create Vercel project), D1 (AA text tokens), sprint length; B1/B3/B4/B5 before S2.
- Next: S1 — JD-M13 components + five-space shell; JGR research and v0.1 draft (JD-M01).
