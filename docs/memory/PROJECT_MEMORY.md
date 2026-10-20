# Project Memory — Javi's Dog

> Read this first in every session. Keep it short and current; history goes to `SESSION_LOG.md`.
> Last updated: 2026-10-20 · Current sprint: **S2a — Data layer & health** (PLANNED, waiting on owner Q1–Q4); S2b = sign-in. Last closed: S1b (`docs/sprints/SPRINT-01b.md`)

## What we are building

Javi's Dog — *Every agent. One clear signal.* A privacy-aware observability companion for vibe coders: projects, live agents, token burn and effectiveness analytics across coding tools, fed by the **Javi Grande Rules (JGR)** protocol. Later: a keep-the-flow resilience layer. Pack Pool (P2P capacity) is concept-only research.

## Current state

- S0 foundations committed on branch `claude/clever-goldberg-wlurty`: Orcasus adopted, brand guide + logo v0.1, feasibility, readiness, ADR-0001…0003, monorepo scaffold, JD-M13 tokens (29 tests), minimal JD-APP page, CI (GitHub Actions green), vendored skills, Guru agent.
- G0 done: 4 generalized skills in `guru/skills/` (medium confidence); see `guru/WISDOM_LOG.md`.
- S1a done: five-space shell with honest states (JD-APP), JD-M13 components, JD-M04 draft project schema.
- S1b done: JGR v0.1 draft (JD-M01) — spec `docs/jgr/spec/v0.1.md`, ADR-0004, 20 conformance vectors, primary-source research; 89 tests green workspace-wide.
- Deployed: Vercel project `javisdog` (owner-created), auto-deploys every push; `https://javisdog.vercel.app` is public (5 routes verified HTTP 200). Neon `dev-agent` reachable over HTTPS only (PostgreSQL 18.6, empty schema; psql/TCP times out in the sandbox). No auth or ingest yet.
- Credentials (2026-10-20 re-check, shape only): all 10 S2 env vars present and well-formed in the cloud env; Google OAuth client authenticates; GitHub secret unverifiable from the sandbox; Vercel env still unreadable (403).
- S2 split: **S2a** JD-M06 + JD-M04 persistence + `/api/health` (`docs/sprints/SPRINT-02a.md`, ADR-0005 Proposed); **S2b** Better Auth GitHub/Google (JD-M03), project UI, welcome email.

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
| ADR-0005 | Proposed: module-owned Drizzle tables composed by JD-M06; offline `generate` + neon-http migrator on `dev-agent` only; ingest tokens `jd_it_…` stored as SHA-256; workspace-scoped repository |

## Open questions / blockers (owner)

- **Q1–Q4** for S2a (`docs/sprints/SPRINT-02a.md`): PGlite test dependency; public `/api/health`; Neon branch per Vercel environment; `events` table now or S3.
- **B1-rotate** confirm the `neondb_owner` password was rotated (not verifiable by the agent this session).
- **B5** confirm `eagodi.com` is Verified in Resend.
- **ADR-0004** owner review pending; **ADR-0005** owner review pending.

## Next actions

1. Owner: answer Q1–Q4; set Vercel `DATABASE_URL` per Q3.
2. S2a: JD-M06 package, JD-M04 tables/tokens/repository, migration `0000` on `dev-agent`, `/api/health`, verify on Vercel.
3. S2b: Better Auth GitHub/Google (JD-M03) mapped onto `workspaces`, project CRUD UI, JD-M09 welcome email.

## Key paths

`CLAUDE.md` · `docs/agent-ops/` · `docs/brand/BRAND_GUIDE.md` · `docs/adr/` · `docs/modules/REGISTRY.md` · `docs/sprints/` · `guru/`
