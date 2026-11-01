# Sprint 05g — GitHub App bridge (JD-M10)

- Dates: 2026-11-01 → · Status: ACTIVE
- Goal (one sentence): everything for the GitHub App is built and tested against test secrets, so that the owner's five-minute setup (local helper, three env vars, install, claim, link) brings PR and CI signals into the project's dashboard.
- Modules touched: JD-M10 (new), JD-M06 (migration 0006), JD-APP, JD-M07
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows "Repo signals" (B6), "GitHub webhook facts", "Migration 0006", "GitHub org installations"
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5g

## Global constraints

- ADR-0019 is the contract.
- No GitHub API calls at runtime.
- No new runtime dependency.
- Nothing personal or code-related is stored (the never-stored list).
- Run `pnpm gate` before every push and read the previous tip's CI first (TEAM.md).
- Screenshot budget 0.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| H1 | `@javis-dog/github-bridge`: signature verification, delivery routing, pure JGR mapping, ids, refs | JD-M10 | TEST_PLAN unit rows; QA vectors pass | PLANNED |
| H2 | Migration 0006 and the installations/repositories repository | JD-M06 | migration tests; applied to `dev-agent` and `main` after CI is green | PLANNED |
| H3 | Webhook route, claim and link actions, project-page GitHub card, Integrations status, source labels | JD-APP, JD-M07 | TEST_PLAN route, claim, link, dashboard and status rows | PLANNED |
| H4 | Local helper `scripts/github-app-create.mjs` and the owner how-to | tooling | TEST_PLAN helper row | PLANNED |
| H5 | QA vectors (`docs/jgr/conformance/github/`) and runner | QA | every vector passes, mutation-checked | PLANNED |

## Log

Newest first: date — what changed — commit SHA.

- 2026-11-01 — Discovery, research (primary sources through source repositories; two facts re-checked), owner decisions, ADR-0019, TEST_PLAN §S5g, readiness rows.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

## Team

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | ADR, migration apply, merges, gate, push |
| Reviewer (design) | read-only agent | ADR-0019 before code |
| QA | worktree agent | `docs/jgr/conformance/github/` |
| Developers | worktree agents | per wave |

Team log, newest first:

- 2026-11-01 — Reviewer — Design review D0 of ADR-0019, before code: 4 High (owner-only scope; replay and dedupe on unsigned headers; the schema could not enforce the workspace; the 3-day rule had no timestamp), 6 Medium, 5 Low. The orchestrator verified H1 and H2 in sources and code. All were folded into ADR-0019 as binding rules; TEST_PLAN rows added.
- 2026-11-01 — Orchestrator — The research agent re-read GitHub's docs through `github/docs` and the OpenAPI description (docs.github.com is blocked). The orchestrator re-checked the HMAC test vector and the Contents-read requirement for push.

## Decisions and deviations

- Owner 2026-11-01: JD-M10 prep; PRs and CI only; owner link with an L1/L2 warning; local helper; migration 0006 approved.

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

—
