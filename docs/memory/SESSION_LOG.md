# Session Log

Append-only handoff log, newest first. Each entry: date · session · what happened · state left behind · next step.

## 2026-10-20 · Session 2 (Claude Code, cloud) — credential re-check + S2a plan

- Re-checked env vars (presence/shape only): all 10 S2 vars present and well-formed; OAuth secrets no longer hold callback URLs. Neon `dev-agent` OK over HTTPS (PG 18.6, 0 tables); psql/TCP times out. Google client authenticates (`invalid_grant` probe). GitHub token endpoint blocked by the sandbox proxy (403); Vercel env listing still 403. Rotation of `neondb_owner` not verifiable.
- Planned S2a (`docs/sprints/SPRINT-02a.md`), ADR-0005 (Proposed), refreshed `TEST_PLAN.md`, readiness matrix and discovery delta. Sign-in moved to S2b.
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
