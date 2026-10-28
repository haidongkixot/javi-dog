# Sprint 04a — Live state: read model, freshness and the real dashboard

- Dates: 2026-10-28 (timebox 30 min) · Status: **BUILT** — closes with CI green on the push; real data waits on the owner's first run
- Goal: Overview, Projects and Live agents show real, workspace-scoped JGR state with honest freshness, refreshed every 10 s.
- Modules touched: JD-M07 (new), JD-APP, docs
- Readiness gate: owner decision "Polling, 10 s" (ADR-0012); production has no real events until the owner's first run, so pages must render correct empty states
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S4a (written before the lanes start)
- Split of roadmap S4: **S4a** live state (this) · **S4b** analytics (JD-M08) · **S4c** budgets, forecast, exhaustion + email alerts (JD-M12) · then Guru G3

## Global constraints

- Product rules 2 and 4: every value shows its source and last signal time with a stale state; nothing is called live; no sample data.
- Workspace isolation: the workspace comes from the session + membership, never from request input.
- L0 only: no attribute other than `tool_name` is displayed; refs stay opaque.
- Brand: `docs/brand/BRAND_GUIDE.md`, `.claude/skills/javis-dog-brand`; accessibility per `web-design-guidelines`. Screenshot budget **0**.
- No new external dependency.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| R1 | Read model | JD-M07 | events, projects → `createDashboardReader(db).snapshot(workspaceId)`, `threadFreshness()` | Rules of ADR-0012 (freshness 180 s inclusive, ended, attention, counters, 24 h window, 25 activity items, DB clock); never returns another workspace's data | Done |
| W1 | Snapshot route + polling hook | JD-APP | reader → `GET /api/dashboard/snapshot`; `useDashboardSnapshot(initial)` | 401 signed out, 503 without DB, `no-store`; polls every 10 s while visible, pauses when hidden; failed refresh keeps data + visible notice | Done |
| W2 | Pages | JD-APP | snapshot → Overview, Live agents, Projects | Real values with last-signal time and stale/ended labels; empty states when no data; attention visible within a 3-second scan | Done |
| Q1 | State vectors (QA, independent) | docs | `docs/jgr/conformance/state/*.json` | Event sequences → expected thread state / counters, from JGR §5 + ADR-0012 text only | Done |

## Review focus

- A thread waiting for permission goes quiet for 5 min → still shows "waiting", labelled stale, counted as needing attention (R1/W2).
- Another workspace's project id or events never appear in a snapshot (R1, W1).
- The poll fails (network, 500) → last data stays with a "could not refresh" notice, never silently old (W1).
- A session that ended an hour ago is "ended", not "stale" (R1).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR-0012, package scaffold + contract types, `package.json`/lockfile/`next.config.ts`, docs, merge, push |
| Developer A | general-purpose, worktree | R1: `packages/realtime/src/reader.ts`, `packages/realtime/test/**` |
| Developer B | general-purpose, worktree | W1 + W2: `apps/web/src/app/{page.tsx,agents/**,projects/page.tsx,api/dashboard/**}`, `apps/web/src/components/dashboard/**`, `apps/web/src/lib/dashboard.ts`, `apps/web/test/dashboard*.test.ts(x)` |
| QA | general-purpose, worktree | Q1: `docs/jgr/conformance/state/**` |
| Reviewer | general-purpose, read-only | combined diff; isolation, freshness truthfulness, accessibility |

Team log, newest first:

- 2026-10-28 — Orchestrator — Merged review fixes (`1c099ce`, declared paths only); changeset for the JD-M07 contract (`needsAttention`); ADR-0012 Changes marked merged.
- 2026-10-28 — Developer — Review fixes 1–9 with tests written first: red 27 web + 3 realtime FAIL for the expected reasons, then green (realtime 60 ×2, web 160 ×2). Timeout uses its own timer + abort (works even when fetch ignores abort).
- 2026-10-28 — Reviewer — no blockers; 3 major (ended threads counted as attention in the UI; values stay "fresh" while refreshes fail; a hung request stops polling silently), 6 minor, nits; reproduced 1–3 in a scratch jsdom test; isolation, caching, window edges verified. Push held until fixed.
- 2026-10-28 — Orchestrator — Runner `packages/realtime/test/state-conformance.test.ts` from the QA README: first run 4 FAIL — runner bug (`atOffsetMs` mapped to `atAt` instead of `at`), vectors correct; fixed → 27/27. Mutations: exclusive 180 s boundary → only 01 FAIL; workspace filters removed → only 17, 20, 21 FAIL; restored. Merged W1+W2 (`64af586`); its async Overview broke `shell.test.tsx` only because this session has `DATABASE_URL` set → test pins it empty. Full gate 759 tests.
- 2026-10-28 — QA — 27 vectors, 14 ambiguities (A7: attention on ended threads untested).
- 2026-10-28 — Developer B — W1+W2: route, polling hook, three pages; 42 tests; copy: "Stale" pill + "No signal for …", UTC absolute times, token card never shows a bare 0.
- 2026-10-28 — Developer A — R1: 3 queries per snapshot (+ DB clock), 30 tests, mutation-checked (tie-break test strengthened).
- 2026-10-28 — Orchestrator — Owner chose 10 s polling over SSE windows (ADR-0012; roadmap said SSE — deviation recorded). Vercel plan UNKNOWN (not visible via the API). Scaffolded JD-M07 with the snapshot contract (`src/types.ts`) and stubs; lockfile adds the workspace importer only. Screenshot budget 0.

## Log

- 2026-10-28 — R1 pushed (`15cc528`, CI 40643889052 PASS); plan/scaffold `a8e586c` (CI 40643312553 PASS). W1+W2 + runner held for review fixes.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm --filter @javis-dog/realtime test` (Developer A, 2 runs) | 0 | — | 30 | 0 | 0 | 0 | 0 | — |
| State runner first run | 1 | — | 24 | 4 | 0 | 0 | 0 | runner bug (`atAt`), fixed |
| State runner | 0 | — | 28 | 0 | 0 | 0 | 0 | 27 vectors + count |
| Mutation: exclusive 180 s boundary | 1 | — | 27 | 1 | 0 | 0 | 0 | vector 01 only |
| Mutation: workspace filters removed | 1 | — | 25 | 3 | 0 | 0 | 0 | vectors 17, 20, 21 only |
| `pnpm --filter @javis-dog/web test` after merge + shell fix | 0 | — | 143 | 0 | 0 | 0 | 0 | dashboard 42 |
| Full gate (`format`/`lint`/`typecheck`/`test`/`build`/`docs`) | 0 | — | 759 | 0 | 0 | 0 | 0 | before review fixes |
| Review fixes: new tests against the old code (red first) | 1 | — | — | 30 | 0 | 0 | 0 | 27 web + 3 realtime |
| Full gate after review fixes | 0 | — | 776 | 0 | 0 | 0 | 0 | — |
| CI on `6377e88` / `6ed8beb` | 0 | — | runs 40647195467 / 40647484633 | 0 | 0 | 0 | 0 | closing pushes |
| Rendered layout of Overview / Live agents / Projects | — | — | — | — | — | — | 1 | screenshot budget 0 |
| Real data on production | — | — | — | — | — | — | 1 | owner's first real run |

## Decisions and deviations

- Owner: 10 s polling (ADR-0012) instead of the roadmap's SSE.
- `(workspace_id, received_at)` index deferred to S4b (measured: sequential scan, ~80 ms at 10 000 events/workspace on PGlite).

- Roadmap says "JD-M07 SSE"; owner chose polling (ADR-0012). The snapshot API can be wrapped in SSE later.

## Retro

- Went well: QA vectors + mutation checks gave the read model an independent oracle; the Reviewer's scratch jsdom tests turned three UI truthfulness bugs into reproducible failures.
- Hurt: the read model and the UI disagreed on "attention" because the contract had no field for it; my runner had a field-mapping bug; the empty-`## Log` blank-line slip recurred (third time).
- Change next sprint: put every derived flag the UI needs into the contract type up front; insert sprint log entries with a blank line before the next heading (or start the Log section with a placeholder line).

## Guru checkpoint

G3 after S4c.
