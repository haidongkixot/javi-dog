# Sprint 05h — JD-M10 follow-ups (honest CI state, class change with a linked repository)

- Dates: 2026-11-09 → · Status: ACTIVE
- Goal (one sentence): close the two user-visible follow-ups logged at S5g close, so a lost CI result never reads as "in progress" and raising a linked project to L1/L2 says plainly that Javi's Dog still knows the repository name.
- Modules touched: JD-M07 (reader), JD-APP (dashboard, privacy class change, project GitHub card), tooling (gate load note)
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` "Repo signals" (B6) — AVAILABLE since 2026-11-09
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5h

## Global constraints

- CLAUDE.md §3: signal before spectacle; live means verified (source, last update, stale state); privacy by minimization; no mock masquerading as product.
- ADR-0019 and its binding Changes; ADR-0018 (what L1/L2 hide).
- No migration in this sprint. No new dependency. Screenshot budget 0.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| H1 | A CI thread whose newest event is `task.started` and older than 6 h is "No result received", not running (review L-6a) | JD-M07, JD-APP | events → `GithubCounts.ciNoResult`, thread result label | TEST_PLAN §S5h rows 1–2 | PLANNED |
| H2 | Raising a project with a linked repository to L1/L2 needs an explicit server-side confirmation; the GitHub card says the name stays known (review L-6b) | JD-APP | `changePrivacyClassAction` → `needsConfirm` | TEST_PLAN §S5h rows 3–4 | PLANNED |
| H3 | The gate prints the load average next to a test failure (Guru GB-F5) | tooling | `scripts/gate.sh` | TEST_PLAN §S5h row 5 | PLANNED |

Not in scope: review L-4 (a late delivery can restore an old `full_name`; display only, needs a migration), organization installations (needs an ADR).

## Review focus

- A run that legitimately takes longer than 6 h (self-hosted runners, many jobs) shows "No result received" while still running. Expected: the label says what is known ("no result received after 6 h"), never "failed"; H1 owns the test.
- The privacy-class change from the browser key-setup flow must not silently fail when the server asks for confirmation. Expected: the flow shows the warning and retries with the confirmation; H2 owns the test.

## Log

Newest first: date — what changed — commit SHA.

- 2026-11-09 — Planned from the S5g follow-ups (ADR-0019 Changes "S5h").

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

## Team

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | plan, H3, merge, gate, push |
| Developer | worktree agent | H1, H2 |
| Reviewer | read-only agent | combined diff |

Team log, newest first:

- 2026-11-09 — Orchestrator — Sprint planned; one developer lane for H1 and H2 (disjoint from H3).

## Decisions and deviations

- Orchestrator 2026-11-09: 6 h threshold for "No result received" (GitHub-hosted jobs stop at 6 h; a longer run is rare and the label stays factual). Recorded in ADR-0019 Changes.

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

—
