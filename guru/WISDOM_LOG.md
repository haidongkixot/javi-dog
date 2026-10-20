# Wisdom Log

Newest checkpoint first. Each entry: date · checkpoint · commit window · lessons (verified / hypothesis) · skills created/updated · proposals for the owner.

## 2026-10-20 · G0 — end of Sprint 0 "Discovery & readiness"

- **Window:** `d3ff6fa` (root) → `07ccacc` (HEAD), 6 commits.
- **Records read:** `docs/sprints/SPRINT-00.md`, `docs/memory/PROJECT_MEMORY.md`, `docs/memory/SESSION_LOG.md`, `docs/agent-ops/READINESS_MATRIX.md`, `DISCOVERY_SUMMARY.md`, `TEST_PLAN.md`, ADR-0001…0003, `docs/brand/BRAND_GUIDE.md` §3, `docs/feasibility/FEASIBILITY.md`, `.claude/skills/SOURCES.md`, `CLAUDE.md`, `scripts/*.mjs`, `packages/ui/src/*.ts`, `packages/ui/test/*.ts`.
- **Re-runs by Guru:** none of the project suites. Two cheap read-only checks: `npm view` of three packages (results below) and a local run of the new `references/contrast.mjs` helper against the origin token values.

### Verified lessons

1. **Measure contrast before building a design system.** The brand prototype's secondary text (4.00:1), all five status-pill texts (3.21–4.08:1) and white on the primary color (4.43:1) fail WCAG AA — found before any component existed (`docs/brand/BRAND_GUIDE.md` §3, `f89e605`). Fix kept the brand hues exact and moved only text tokens and one button background (ADR-0003; `packages/ui/src/tokens.ts`, `d011b8d`), enforced by a parameterized AA test over declared text pairs (`packages/ui/test/contrast.test.ts`; `pnpm test` exit 0, 29 tests). Generated CSS is guarded by `tokens:check` in `docs:check` (exit 0).
2. **Smallest same-hue lightness step reproduces the adjusted tokens.** At G0, an HSL-lightness search (step 0.005, target 4.6:1 on every background) reproduced all eight adjusted values in `tokens.ts`. This verifies consistency of the method with the values, not which tool produced them originally (not recorded).
3. **Doc checks catch real problems when they are allowed to fail.** The link check failed on two broken links after `guru/README.md` was added; fixed by creating the files, not weakening the check. The doc-drift guard was proven with a negative probe (exit 1) and a positive case against `7a501a3` (`docs/sprints/SPRINT-00.md`, Test evidence). Doc drift is correctly reported as SKIPPED while no `main` branch exists.
4. **Docs were corrected in the same commit as the code that changed them.** `d011b8d` updated the brand guide, provenance and ADR-0002 when the font strategy moved from a build-time download to a self-hosted npm package.
5. **Frequent pushes protected work from an abrupt session end.** The session worker restarted mid-sprint; pushing after each coherent step prevented loss (`docs/sprints/SPRINT-00.md`, Retro).
6. **Skill review caught real conflicts before install.** `frontend-design` was declined (pushes a new visual direction and screenshot self-critique; conflicts with the fixed brand and screenshot budget 0); `writing-plans` was declined (depends on its family of skills, mandates per-step TDD); a runtime-fetched rules file was replaced by a pinned copy (`.claude/skills/SOURCES.md`, `web-design-guidelines/SKILL.md`, `509faa5`). Precedence with a worked example is in `CLAUDE.md` §1 (`d3ff6fa`).
7. **Registry checks changed two stack choices.** `next-auth@5` is beta-only → Better Auth 1.7 for the security-critical auth module; `typescript-eslint` peer range `<6.1.0` → TypeScript 5.9 pinned although 7 is `latest` (ADR-0002, `DISCOVERY_SUMMARY.md` findings 2–3). Re-checked at G0 with `npm view`: `typescript-eslint@8.72.0` peer `typescript` `>=4.8.4 <6.1.0`; `typescript` `latest` 7.0.2; `next-auth` `latest` 4.24.15, `beta` 5.0.0-beta.32.
8. **Explicit resource status prevents false readiness.** The readiness matrix keeps the database as UNKNOWN (integration listing returned 403) rather than assuming it, and records env var names only (`docs/agent-ops/READINESS_MATRIX.md`, `7a501a3`).

### Hypotheses (unverified)

- The project-memory + session-log pair will let a fresh session resume with little re-discovery. Only one session exists at G0; test at the first session handoff (S1).
- The doc-drift guard will prevent docs from lagging code once `main` exists; so far it has only run on a probe.
- The Node `>=22.18` engine minimum will surface a clear failure for contributors on older runtimes (review-focus risk in `SPRINT-00.md`; never observed).
- A 4.6:1 target (vs. the 4.5:1 threshold) protects against rounding when tokens are converted between formats. The margin was used; its necessity was not tested.
- Theme-scoped tokens will make a dark theme a role-map addition without component changes. Only one theme exists (decision D2).
- Owner acceptance of the AA-adjusted tokens (D1) is still pending; the visual delta being "acceptable" is unconfirmed.

### Skills created

| Skill | Version | Confidence | Purpose |
|---|---|---|---|
| [`accessible-brand-tokens`](skills/accessible-brand-tokens/SKILL.md) | 0.1.0 | medium | Brand kit → accessible, theme-scoped tokens with contrast test and generated outputs (includes a dependency-free `references/contrast.mjs`) |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.1.0 | medium | Repository memory files and CI doc checks for multi-session agent work (templates: memory files, link check, doc drift) |
| [`vendoring-agent-skills`](skills/vendoring-agent-skills/SKILL.md) | 0.1.0 | medium | Review, pin, record and rank third-party agent skills (template: `SOURCES.md`) |
| [`verify-dependencies-against-registry`](skills/verify-dependencies-against-registry/SKILL.md) | 0.1.0 | medium | Stack pinning against live registry data with deviations recorded in an ADR |

No existing skills were updated (catalog was empty).

### Proposals for the owner

- G0 is not an Orcasus-PR checkpoint; no PR is proposed.
- Future Orcasus candidates (reassess at G2 once each has been reused at least once more): `agent-second-memory` (fits the Orcasus "records" practice), `vendoring-agent-skills` (complements rule precedence), `verify-dependencies-against-registry` (a natural addendum to `project-discovery`). `accessible-brand-tokens` is a domain skill and fits a design-system library better than Orcasus.
- Record evidence that would raise confidence: note the scan commands used when reviewing vendored scripts; log the first cross-session handoff in `SESSION_LOG.md` with what the new session had to re-discover; record the first real doc-drift failure in CI.
- Answer D1 so the token decision can move from default to accepted.
