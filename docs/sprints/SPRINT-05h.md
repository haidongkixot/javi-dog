# Sprint 05h — JD-M10 follow-ups (honest CI state, class change with a linked repository)

- Dates: 2026-11-09 → 2026-11-10 · Status: CLOSED
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
| H1 | A CI thread whose newest event is `task.started` and older than 6 h is "No result received", not running (review L-6a) | JD-M07, JD-APP | events → `GithubCounts.ciNoResult`, thread result label | TEST_PLAN §S5h rows 1–2 | DONE |
| H2 | Raising a project with a linked repository to L1/L2 needs an explicit server-side confirmation; the GitHub card says the name stays known (review L-6b) | JD-APP | `changePrivacyClassAction` → `needsConfirm` | TEST_PLAN §S5h rows 3–4 | DONE |
| H3 | The gate prints the load average next to a test failure (Guru GB-F5) | tooling | `scripts/gate.sh` | TEST_PLAN §S5h row 5 | DONE |

Not in scope: review L-4 (a late delivery can restore an old `full_name`; display only, needs a migration), organization installations (needs an ADR).

## Review focus

- A run that legitimately takes longer than 6 h (self-hosted runners, many jobs) shows "No result received" while still running. Expected: the label says what is known ("no result received after 6 h"), never "failed"; H1 owns the test.
- The privacy-class change from the browser key-setup flow must not silently fail when the server asks for confirmation. Expected: the flow shows the warning and retries with the confirmation; H2 owns the test.

## Log

Newest first: date — what changed — commit SHA.

- 2026-11-10 — Developer G lane merged (6dea2cb): H1 `GithubCounts.ciNoResult`, `GITHUB_NO_RESULT_AFTER_MS`, `githubNoResult()`; H2 `changePrivacyClassAction(projectId, class, { confirmLinkedRepo })` → `needsConfirm`. Plan and H3 pushed 4482685.
- 2026-11-09 — Planned from the S5g follow-ups (ADR-0019 Changes "S5h").

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm gate --csp` (after the H1/H2 merge) | 0 | 321 s | 3376 tests, 17 packages; CSP check | 0 | 0 | 0 | 0 | — |
| Red-before (Developer G) | — | — | — | 30 new tests failed before the change (H1 reader 5, web 3; H2 action 13, key setup 6, card 3) | 0 | 0 | 0 | scratchpad `h1-red-reader.txt` |
| `bash gate-test.sh` (copy of `scripts/gate.sh` with a forced failing first step, run from the scratchpad) | 1 | <1 s | prints `gate: FAIL — forced-fail` then `gate: load average (1/5/15 min): 0.46 0.42 0.23` | 0 | 0 | 0 | 0 | — |

## Team

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | plan, H3, merge, gate, push |
| Developer | worktree agent | H1, H2 |
| Reviewer | read-only agent | combined diff |

Team log, newest first:

- 2026-11-10 — Reviewer + Orchestrator — Adversarial review of `4482685..6dea2cb` (read-only): 0 High, 0 Medium, 4 Low. Fixed red-first by the orchestrator: L1 cancelling after a confirmed retry that threw no longer says "Nothing changed" (the server may have changed the class); L2 the current class is read first and only a raise reads the links, so lowering never depends on them; L4 a snapshot without `ciNoResult` (older deployment) renders and ages. Accepted, not fixed: L3 write skew between a concurrent raise and link by two admins within milliseconds (needs a row lock in both actions; `membershipLimit: 1` today means one admin per workspace).
- 2026-11-10 — Developer G — H1 and H2 built; red-before shown for every new test group. Deviations accepted by the orchestrator: the `needsConfirm` answer also carries `error` (callers that ignore `needsConfirm`, such as `lower-class.tsx`, show why nothing changed instead of failing silently) and `repositories` (a project can have several links); three test files that mocked the whole `@javis-dog/realtime` module now spread the real module (the dashboard imports a value from it). Known window: a repository linked by someone else between the link read and the class write is not caught; linking to an L1/L2 project has its own confirmation.
- 2026-11-09 — Orchestrator — Sprint planned; one developer lane for H1 and H2 (disjoint from H3).

## Decisions and deviations

- Orchestrator 2026-11-09: 6 h threshold for "No result received" (GitHub-hosted jobs stop at 6 h; a longer run is rare and the label stays factual). Recorded in ADR-0019 Changes.

## Retro

- Went well: one lane for two small tasks, red-before shown for every new test group; the review found only Lows, each with a one-line fix.
- Hurt: the action's read order (links before class) made lowering depend on an unrelated read; the review, not the plan, caught it.
- Change next sprint: when an action gains a guard, write the "what must still work when the guard's read fails" row into the test plan up front.

## Guru checkpoint

—
