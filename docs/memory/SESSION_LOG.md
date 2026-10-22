# Session Log

Append-only handoff log, newest first. Each entry: date · session · what happened · state left behind · next step.

## 2026-10-22 · Session 2, continued — Sprint 2b (sign-in)

- Owner: Vercel Production env completed (GitHub pair, `DATABASE_URL`); production `/api/health` 200. "start 2b".
- S2b split (timebox): sign-in now; project/token UI + welcome email → S2c.
- Built JD-M03 (Better Auth 1.7.7, GitHub/Google, org plugin on `workspaces`, personal workspace hook), migration `0001` on `dev-agent`, `/sign-in`, `/api/auth/*`, account menu; ADR-0006; 173 tests green; local build serves both provider URLs.
- Next: owner signs in on production with each provider; agent verifies DB rows; then S2c.

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
