# Sprint 05e — S5d follow-ups and push-gate hardening

- Dates: 2026-10-30 → 2026-10-30 · Status: CLOSED
- Goal (one sentence): close the S5d follow-ups F1–F3 and adopt the Guru's push-gate lessons, so that no check can pass by failing.
- Modules touched: JD-C01, JD-APP; conformance suite of JD-C03
- Readiness gate: none new; S5d rows unchanged
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5d (rows extended by F2); unit and process tests red-first

## Global constraints

- ADR-0017 is the contract; no product behaviour beyond F1–F3.
- Screenshot budget 0.
- No new dependency.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| F1 | "needs you" wording wherever agent-reported `blocked` is counted as attention | JD-APP | web tests red-first; the status label "Waiting for you" stays on `waiting` only | DONE |
| F2 | Vectors for the S5d coverage gaps: client response object, `report_task` missing arguments, re-fired hook with a moved clock, ended waiting thread | QA (JD-C03 suite) | vectors from the ADR only; runners pass; mutations caught | DONE |
| F3 | Codex `hooks.json` tracked check fails closed (`codexHooksTracking`, warning on `unknown`) | JD-C01 | unit and CLI tests red-first | DONE |
| P1 | Fail-closed push scan in the repo (`scripts/secret-scan.sh`, `pnpm secrets:scan`) and TEAM.md rules (check previous tip CI, dead-endpoint probes, module IDs from `module.json`, one-hand lockfile) | process | self-test PASS; TEAM.md updated | DONE |

## Log

Newest first: date — what changed — commit SHA.

- 2026-10-30 — F2 merged:
  - QA added M23, H15 and R19–R21, and extended M18 and H12.
  - Runners: the vector totals are updated, and the H runner supports `clockAdvanceMs`.
  - All 59 vectors pass, and a disabled seen-call marker is caught only by H15.
  - QA gaps G20 and G21 are clarified in ADR-0017.
- 2026-10-30 — F1, F3 and P1 implemented by the orchestrator (small, red-first). F2 is with QA.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| F3 red: `vitest run test/codex-hooks.test.ts` (new tests, old code) | 1 | — | — | 2 | — | — | — | `codexHooksTracking is not a function` |
| F3 red: CLI test against the previous `cli.ts` | 1 | — | — | 1 | — | — | — | warning missing |
| F1 red: `vitest run test/dashboard-views.test.tsx` (new copy, old components) | 1 | — | 34 | 2 | — | — | — | — |
| `bash scripts/secret-scan.sh --self-test` | 0 | — | 8 | 0 | — | — | — | — |
| Runners: `collector-mcp-server`, `realtime`, H runner (`self-report-conformance.test.ts`) | 0 | — | M 23, R 21, H 15 vectors | 0 | 0 | 0 | 0 | 59 of 59 vectors |
| CI `2516380` / `ec20396` | success | — | — | — | — | — | — | runs 41113430736, 41115146514 |
| Mutation: seen-call marker off | 1 (expected) | — | — | H15 only | — | — | — | restored, no diff |

## Team

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | F1, F3, P1; merges, gate, push |
| QA | worktree agent | `docs/jgr/conformance/self-report/**` (F2) |

Team log, newest first:

- 2026-10-30 — Orchestrator — Rule 9 slip on the very next push: `ec20396` went out before CI on `2516380` was read. That run was green (41113430736). The rule stands; it was checked before closing the sprint.
- 2026-10-30 — Orchestrator — The Guru's TEAM.md proposals are adopted under the owner's "proceed" (2026-10-30). The owner can revert any of them.

## Decisions and deviations

- The F1 wording ("needs you") follows the brand voice (warm, brief), and ADR-0017 §6 makes agent `blocked` count as attention. The status label "Waiting for you" is unchanged.

## Retro

- **Went well:**
  - Spec-first QA again found two real spec gaps (G20, G21) and a stale vector description.
  - The step-clock extension stayed optional, so no existing vector changed.
  - Mutation evidence shows the new vector earns its place: only H15 catches a disabled seen-call marker.
- **Hurt:** the new rule 9 was broken on the first push after it was written, because a rule nothing enforces depends on memory.
- **Change next sprint:** read CI on the previous tip as the first command of every push step. That command is part of the gate, not a separate thought.

## Guru checkpoint

—
