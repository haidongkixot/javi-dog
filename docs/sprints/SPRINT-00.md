# Sprint 00 — Discovery & readiness

- Dates: 2026-10-20 → 2026-10-20 · Status: **CLOSED** (owner: B2 approved but blocked on Vercel permission; D1 accepted; sprint timebox ≤ 30 min)
- Goal: adopt Orcasus, record discovery and feasibility, turn the brand kit into a working design-token foundation, and set up the second-memory and Guru systems.
- Modules touched: JD-APP, JD-M13
- Readiness: `docs/agent-ops/READINESS_MATRIX.md` (verdict **Partial** — S0/S1 unblocked; S2 needs B1, B3, B4, B5)
- Test plan: `docs/agent-ops/TEST_PLAN.md`

## Global constraints

- Orcasus v1.2.1 rules; screenshot budget 0.
- All docs in English. Brand Concept 0.1 is the visual and voice source of truth.
- Light theme only (D2). Text tokens must pass WCAG AA (≥ 4.5:1).
- Never show sample data or "live" states without a disclosure.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | Adopt Orcasus + root `CLAUDE.md` | — | Skills installed, contract merged, precedence defined | Done (`d3ff6fa`) |
| 2 | Brand guide, logo v0.1, ADR-0003 | JD-M13 | Sources archived with checksums; contrast measured; tokens decision recorded | Done (`f89e605`) |
| 3 | Discovery, readiness, feasibility, ADR-0001/0002, roadmap, project memory | — | Every resource has a status with evidence; blockers have options | Done (`7a501a3`) |
| 4 | Monorepo scaffold, JD-M13 tokens, JD-APP foundation page, CI, doc checks | JD-M13, JD-APP | lint/typecheck/test/build/docs:check exit 0 | Done (`d011b8d`) |
| 5 | Vendor reviewed third-party skills + `javis-dog-brand` skill | — | Provenance, license and overrides recorded | Done (`509faa5`) |
| 6 | Javi's Guru agent + `/guru-checkpoint` + G0 | — | Agent defined; G0 entry and first skills in `guru/` | Done (`07ccacc`, G0 commit) |
| 7 | Create Vercel project `javi-dog` (B2) | — | Project linked to repo | **BLOCKED** — MCP 403; owner creates via dashboard (rolls to S1a) |

## Review focus

- A developer clones the repo on Node < 22.18 → `tokens:build`/`tokens:check` (TypeScript type-stripping) fail. `engines.node` and `.nvmrc` declare 22; CI uses `.nvmrc`. Owner: S1, add a friendly version check if it bites.
- Someone edits `tokens.ts` and forgets to regenerate CSS → `tokens:check` fails in CI (covered).
- A module's source changes without docs → doc-drift fails once `main` exists (verified with a negative probe; SKIPPED until then).

## Log

- 2026-10-20 — Orcasus adopted, CLAUDE.md written — `d3ff6fa`
- 2026-10-20 — Brand kit archived; BRAND_GUIDE, PROVENANCE, logo SVGs, ADR-0003 — `f89e605`
- 2026-10-20 — Discovery, readiness matrix, feasibility, ADR-0001/0002, roadmap, project memory — `7a501a3`
- 2026-10-20 — Monorepo + JD-M13 tokens + JD-APP foundation page + CI + doc checks — `d011b8d`
- 2026-10-20 — Third-party skills vendored after review; `javis-dog-brand` skill — `509faa5`
- 2026-10-20 — G0: Guru packaged 4 generalized skills (medium confidence), 8 verified lessons, 6 hypotheses — G0 commit
- 2026-10-20 — Guru agent, checkpoint skill, sprint template — `07ccacc`

## Test evidence

Fresh run on 2026-10-20 after clearing `.turbo` and `.next` caches (Node 22.22.0, pnpm 10.28.0, Linux):

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm format:check` | 0 | 1.2s | all files | 0 | — | — | — | none |
| `pnpm lint` | 0 | 4.4s | 2 packages + scripts, 0 warnings | 0 | — | — | — | none |
| `pnpm typecheck` | 0 | 3.2s | 2 packages | 0 | — | — | — | none |
| `pnpm test` | 0 | 1.5s | 29 tests (2 files, JD-M13) | 0 | 0 | 0 | — | none |
| `pnpm build` | 0 | 10.0s | Next.js 16.4.2 static build (`/`, `/icon.svg`) | 0 | — | — | — | `.next/` (gitignored) |
| `pnpm docs:check` | 0 | 3.0s | markdownlint 0 issues; 26 files link-checked; registry (17 modules); tokens.css in sync | 0 | doc-drift (no `main` yet) | — | — | none |
| Built HTML assertion (grep `.next/server/app/index.html`) | 0 | — | disclosure text present; tagline present; `--jd-text-muted:#6e6e8a` in CSS bundle | 0 | — | — | — | none |
| Doc-drift probe (throwaway worktree) | 1 (expected) | — | negative case fails as designed; positive case PASS against `7a501a3` | — | — | — | — | worktree removed |

Screenshots / traces / videos: **0 / 0 / 0**. NOT RUN: E2E (no user journey yet), integration tests (no database). CI on GitHub Actions: see the first workflow run for this branch.

Notable failure caught during the sprint: the first `docs:check` after adding `guru/README.md` failed on two broken links (files not yet created). Fixed by creating the catalog and log skeletons, not by weakening the check.

## Decisions and deviations

- ADR-0001 modular monolith; ADR-0002 stack — **Better Auth instead of Auth.js v5** (v5 still beta); TypeScript 5.9 pinned (typescript-eslint `<6.1`); Inter self-hosted via `@fontsource-variable/inter` instead of `next/font` (no build-time download).
- ADR-0003 brand → tokens: AA text tokens (D1 default), sidebar label `#8F8DAE`, primary button `#6A5DF6`.
- Owner decisions: resilience before Pack Pool; English docs; Guru → `guru/` + Orcasus PR proposals at G2/G4; collectors Claude Code + Codex/Gemini + GitHub; light-only MVP; template SVG logo v0.1.
- Not adopted: `frontend-design`, `writing-plans` (reasons in `.claude/skills/SOURCES.md`).

## Retro

- Went well: measuring contrast before writing the design system surfaced a real accessibility gap in the brand template early, with a fix that keeps the brand's hues unchanged. Pinning dependency versions against the live registry avoided a beta auth library and a TypeScript/ESLint incompatibility.
- Hurt: the session worker restarted mid-sprint; pushing after each coherent step prevented loss.
- Change next sprint: confirm sprint length with the owner; create the Vercel project so every push gets a preview.

## Guru checkpoint

G0 — completed 2026-10-20. Skills: `accessible-brand-tokens`, `agent-second-memory`, `vendoring-agent-skills`, `verify-dependencies-against-registry` (all v0.1.0, medium confidence). Orchestrator verification: secret scan clean, `contrast.mjs` reproduces `#6E6E8A`, full suite exit 0. Entry: `guru/WISDOM_LOG.md`.
