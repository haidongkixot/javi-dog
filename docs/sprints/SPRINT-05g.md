# Sprint 05g — GitHub App bridge (JD-M10)

- Dates: 2026-11-01 → 2026-11-01 · Status: CLOSED (code complete; the owner creates the GitHub App and runs the first real delivery)
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
| H1 | `@javis-dog/github-bridge`: signature verification, delivery routing, pure JGR mapping, ids, refs | JD-M10 | TEST_PLAN unit rows; QA vectors pass | DONE (59/59 vectors) |
| H2 | Migration 0006 and the installations/repositories repository | JD-M06 | migration tests; applied to `dev-agent` and `main` after CI is green | DONE |
| H3 | Webhook route, claim and link actions, project-page GitHub card, Integrations status, source labels | JD-APP, JD-M07 | TEST_PLAN route, claim, link, dashboard and status rows | DONE (review fixes merged; real delivery NOT RUN, owner) |
| H4 | Local helper `scripts/github-app-create.mjs` and the owner how-to | tooling | TEST_PLAN helper row | BUILT ([how-to](../how-to/set-up-github-app.md); `pnpm test:scripts` 5/5; real GitHub run NOT RUN, owner) |
| H5 | QA vectors (`docs/jgr/conformance/github/`) and runner | QA | every vector passes, mutation-checked | DONE (59/59, 174 steps, 7/7 mutations caught) |

## Log

Newest first: date — what changed — commit SHA.

- 2026-11-01 — Wave 2 merged: webhook handler + `POST /api/github/webhook` (2e1009a), claim/link + `/integrations/github` + project card + status (4d6d749), reader `source` + GitHub counts + labels (17c0ba5), QA runner (46131a3); orchestrator: G24 (f62dabf), re-verify across GitHub accounts (0459de6), fixtures (99abf5b).
- 2026-11-01 — Migration 0006 applied: `dev-agent` first (12 statements, one transaction; ledger 7, 3 github tables), then restore branch `restore-pre-0006-2026-11-01` from `main`, then `main` (same transaction). Verified: `main` ledger 7 with the 0006 hash last; `compare_database_schema` `main` vs `dev-agent` empty. Code pushed after the migration (purge reads `github_deliveries`).
- 2026-11-01 — Wave 1 merged: Developer A lane (JD-M10 package, migration 0006, reserved ingest prefixes), QA vectors (59, `docs/jgr/conformance/github/`), shared edits — 0960bae, bbb7ae8.
- 2026-11-01 — Discovery, research (primary sources through source repositories; two facts re-checked), owner decisions, ADR-0019, TEST_PLAN §S5g, readiness rows.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm gate --csp` (wave 2 merged, before the QA runner) | 0 | 438 s | 3052 tests, 17 packages; `test:scripts` 5; CSP check | 0 | 0 | 0 | 0 | — |
| `npx vitest run test/github-conformance.test.ts` (QA runner) | 0 | ~12 s | 257 (59 vectors, 174 route steps, 20 S01 cases, R21 supplement) | 0 | 0 | 0 | 0 | — |
| QA mutation check (7 mutations, each restored) | — | — | 7 caught | 0 | 0 | 0 | 0 | — |
| `pnpm gate --csp` (review fixes, before push 39bf130) | 0 | 348 s | 3330 tests, 17 packages; `test:scripts` 5; CSP check | 0 | 0 | 0 | 0 | — |
| CI on pushed tips | 0 | — | dc26f32 run 41267384071, b96a25c run 41270489476, 39bf130 run 41271405032 — all success | 0 | 0 | 0 | 0 | — |
| Production after b96a25c | — | — | `/api/health` 7 migrations, webhook secret `false`; `POST /api/github/webhook` → 503 `not_configured`; `/integrations/github` 200 | 0 | 0 | 0 | 0 | — |
| Real GitHub delivery (owner) | — | — | — | — | — | — | 1 | owner step |

QA mutations (each applied alone, then restored): (1) previous secret not tried → S01, S03; (2) hash recorded before `insertEvents` → R21 supplement only (no vector); (3) 3-day rule dropped → R13, R14; (4) `cancelled` → `task.completed` → M05, M14; (5) `head_branch` copied into `tool_name` → 48 steps incl. M01–M10, P01, P02; (6) raw non-GUID `X-GitHub-Delivery` logged → R22; (7) body-hash dedupe skipped → R01, R21. The QA cross-check reference programs (2 756 checks) were not committed (Guru GB-F3).
| `pnpm gate` (wave 1 merged) | 0 | 266 s | 2856 tests, 17 packages; format, lint, typecheck, build, migration drift, docs | 0 | 0 | 0 | 0 | — |

## Team

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | ADR, migration apply, merges, gate, push |
| Reviewer (design) | read-only agent | ADR-0019 before code |
| QA | worktree agent | `docs/jgr/conformance/github/` |
| Developers | worktree agents | per wave |

Team log, newest first:

- 2026-11-01 — Developer F + Orchestrator — Review fixes merged (a8ac0e4, fe92c73): M-1 runbook, M-2 stale/suspended/project-level status, L-1 one secret rule shared by handler, setup status and health, L-2 account checked first, L-3 release clears evidence, L-5 link guard, R21 README note. Every new test failed before its fix except the PGlite link race (PGlite runs one statement at a time; a statement-shape test covers the guard).
- 2026-11-01 03:47 — Orchestrator — Secret scan matched fake database URLs in three new tests (dead endpoints `127.0.0.1:9`, `db.example`); reshaped so they no longer look like credentials (b96a25c); scan clean. Wave 2 pushed `dc26f32..b96a25c` after `pnpm gate` PASS (3 309 tests) and CI green on dc26f32.
- 2026-11-01 — Reviewer — Adversarial review of wave 2 (read-only): 0 High, 2 Medium (M-1 the runbook said "redeliver after linking", but an unrouted 202 records the hash, so redelivery dedupes; M-2 "Connected" ignored suspension and never went stale), 6 Low (L-1 whitespace secrets; L-2 claim results allowed id enumeration, org branch unreachable; L-3 release kept `last_verified_delivery_at`; L-4 a late delivery can revert a renamed `full_name` (display only, logged, not fixed); L-5 concurrent links, last wins; L-6 a run whose `completed` delivery was lost counts as running for 24 h, and an L0→L1/L2 class change keeps a link without a warning (both logged as follow-ups)). M-1 fixed in the runbook, not the hash rule (H2 binding, Y11 vectors). Developer F lane fixes M-1, M-2, L-1, L-2, L-3, L-5.
- 2026-11-01 — QA — Runner merged: 59/59 vectors through the real route on PGlite; 7/7 mutations caught. Vector gap: R21 cannot catch "hash before a failed insert" (its fault fails `hasDelivery` first); the runner adds an insert-only supplement. Not run: JD-M01 re-validation of stored events (`@javis-dog/jgr-spec` is not a web dependency; the handler validates before insert).
- 2026-11-01 — Developers B, C, E — Merged. B: `readRawBody` instead of JD-M05 `readBoundedBody` (decoded text conflicts with L1); G24 found via M12 (fixed by the orchestrator). C: install link only for `GITHUB_APP_OWNER_ID`; gap "re-verify across accounts" closed by the orchestrator (`accountId` on `workspaceInstallations`). E: GitHub rows never set status or count as agent tasks, ended by highest sequence.
- 2026-11-01 03:17 — Orchestrator — `pnpm gate` FAIL at test: `apps/web/test/privacy-session.test.tsx` "/sign-in" timed out at 5 007 ms (limit 5 000 ms); the claude-code collector task shows no failing test (turbo stopped it after the failure). Diagnosis: CPU contention, load average 19.8 with three lanes running tests in worktrees; the file alone passes 8/8 in 3.9 s. Not pushed; the gate reruns once the lanes finish (no timeout change, no skip).
- 2026-11-01 — Developer D — Local helper + how-to merged (25ff837). 5/5 `node:test` against a stub GitHub API (manifest exact, state single-use, 0600 file outside the repo, no secret in output, Host check, failed exchange, timeout). Facts checked in `github/docs` and the REST OpenAPI description; unverified: GitHub accepting a loopback `redirect_url` in a manifest (owner's first run). Orchestrator added `test:scripts` to package.json, `scripts/gate.sh` and CI, and the five `GITHUB_APP_*` lines to `.env.example`.
- 2026-11-01 — Orchestrator — Wave 2 launched in worktrees: Developer B (webhook handler with injected deps + route; `event-store` already depends on `github-bridge`, so no cycle), Developer E (reader `source`, GitHub counts, labels), Developer C (claim/link, `/integrations/github`, status card), Developer D (local helper + how-to). Decision: public env `GITHUB_APP_OWNER_ID` gates the install link (ADR-0019 Changes). QA runner follows Developer B.
- 2026-11-01 — Reviewer — Design review D0 of ADR-0019, before code: 4 High (owner-only scope; replay and dedupe on unsigned headers; the schema could not enforce the workspace; the 3-day rule had no timestamp), 6 Medium, 5 Low. The orchestrator verified H1 and H2 in sources and code. All were folded into ADR-0019 as binding rules; TEST_PLAN rows added.
- 2026-11-01 — Orchestrator — The research agent re-read GitHub's docs through `github/docs` and the OpenAPI description (docs.github.com is blocked). The orchestrator re-checked the HMAC test vector and the Contents-read requirement for push.

## Decisions and deviations

- Owner 2026-11-01: JD-M10 prep; PRs and CI only; owner link with an L1/L2 warning; local helper; migration 0006 approved.

## Retro

- Went well: QA vectors written before code found the installation-replay gap, the namespace mismatch and G24; the injected-deps handler avoided a workspace cycle; the review found no High after D0.
- Hurt: running three lanes' test suites at once pushed load to ~20 and made a 5 s test time out in the gate; lanes could not add workspace dependencies, so two lanes typechecked only with a temporary line.
- Change next sprint: run the gate only when lanes are idle; declare needed workspace dependencies in the plan so the orchestrator adds them before lanes start.

## Guru checkpoint

Sprint end, `ad-hoc-github-bridge` (d1e6caa): new skill `guru/skills/signed-webhook-receiver` (0.1.0); seven skills refined; `guru/WISDOM_LOG.md` S5g entry. Findings GB-F1 (evidence), GB-F2 (mutation list), GB-F4 (superseded ADR lines) and GB-F6 (scanner comment) closed in the S5g close commit; GB-F3 (QA reference programs) and GB-F5 (retro actions are conventions only) stay open as process proposals for the owner.
