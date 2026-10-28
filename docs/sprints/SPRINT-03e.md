# Sprint 03e — Token usage via a local OTLP receiver

- Dates: 2026-10-28 (timebox 30 min) · Status: **ACTIVE**
- Goal: Claude Code token and cost usage reaches Javi's Dog as `usage.reported` events, received locally by `javi`, attributed to the right project, with no identity or content leaving the machine.
- Modules touched: JD-C01, JD-M02, docs
- Readiness gate: rows "OTel exporter config scope", "OTel session correlation", "Local receiver port" in `docs/agent-ops/READINESS_MATRIX.md`
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S3e (written before the lanes start)
- ADR: ADR-0011. Packaging (`npx`, bundle + tarball) and Guru G2 follow in S3f.

## Global constraints

- Screenshot budget 0. No new external package (lockfile unchanged except workspace links).
- L0 only: from OTel attributes read `session.id`, `model`, `type` — nothing else.
- `~/.claude/settings.json` is changed only by `javi usage on|off`, never by tests (tests use a temp `HOME`/path).
- Hooks stay neutral: no stdout, exit 0, even when the receiver cannot start.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| U0 | SDK caller-supplied `event_id` | JD-M02 | `RecordInput.event_id?` | Valid id kept (canonicalized by JD-M01); invalid id → `ok: false`; default ULID unchanged | Done |
| U1 | OTLP JSON parser + usage mapping | JD-C01 `src/otlp.ts`, `src/usage.ts` | OTLP JSON → `UsagePoint[]` → `UsageGroup[]` → `RecordInput` | Allowlist attributes only; delta/cumulative; int64 string/number; deterministic UUID ids; zero groups skipped | Done |
| U2 | Claude user-settings editor | JD-C01 `src/claude-env.ts` | `enableUsageEnv` / `disableUsageEnv` | Backup once; refuses on parse error or foreign `OTEL_*`/telemetry keys (file or shell); revert removes only unchanged own keys | Done |
| U3 | Receiver, lifecycle, CLI, attribution | JD-C01 `src/receiver.ts`, `cli.ts`, `run.ts`, `state.ts` | HTTP → spool → `runFlush`; `javi usage on` / `off`, `javi receive`, `javi status` | 401/403/413/415/400/200 rules; unknown sessions dropped + counted; hooks start the receiver; idle exit | Done |
| Q1 | OTLP vectors (QA, independent) | docs | `docs/jgr/conformance/otlp/*.json` | Vectors from the OTLP spec + Claude Code docs only; runner in U3 tests | Done |

## Review focus

- A local web page POSTs to `http://127.0.0.1:4319/v1/metrics` → 401 (no bearer) / 403 (foreign Host) — never recorded (U3).
- Claude Code retries an export after a timeout → same `event_id` → server `duplicates: 1` (U1 + e2e).
- A user with their own OTel collector runs `javi usage on` → refused, settings untouched (U2).
- A session in a project without `javi init` → its usage is dropped locally and counted (U3).
- Data point with `user.email`, `organization.id` → nothing of it in the spool (U1 + U3).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR-0011, U0, interface stubs, spec/README/changeset, merge, push |
| Researcher | general-purpose | Claude Code OTel contract (done; 2 facts re-fetched by orchestrator) |
| Developer A | general-purpose, worktree | U1: `collectors/claude-code/src/{otlp,usage}.ts`, `test/{otlp,usage}.test.ts` |
| Developer B | general-purpose, worktree | U2 + U3: `src/{claude-env,receiver}.ts`, `src/{cli,run,state}.ts`, `test/{claude-env,receiver,usage-e2e}.test.ts`, README |
| QA | general-purpose, worktree | Q1: `docs/jgr/conformance/otlp/**` |
| Reviewer | general-purpose, read-only | combined diff, security focus on the localhost listener and the settings edit |

Team log, newest first:

- 2026-10-28 — Reviewer — launched on `4386501..HEAD` (security focus: listener, settings edit, privacy).
- 2026-10-28 — Orchestrator — Runner `test/otlp-conformance.test.ts` from the QA README: 40/40 PASS. Mutation checks: Host check disabled → exactly vector 09 FAIL; random event ids → exactly 39 and 40 FAIL; code restored. Full gate: 604 tests.
- 2026-10-28 — Orchestrator — Merged U3 (`5e3730a`, declared paths only; 208 collector tests, 3 runs). Exported the receiver API; changeset notes `Io.spawnReceiver`.
- 2026-10-28 — Orchestrator — QA A3 accepted: an object without `resourceMetrics` is an empty OTLP request → 200 (parser fixed, U3 told before it wrote that test). Test fix: `resourceMetrics: null` is the proto3 JSON default (empty), not malformed.
- 2026-10-28 — QA — 40 vectors / 46 steps from ADR-0011 + OTLP spec + Claude Code docs, 20 ambiguities (A1–A20); opentelemetry.io blocked, same text read from `opentelemetry-proto/docs/specification.md`.
- 2026-10-28 — Orchestrator — Merged U1 (`f8ced2c`); added `session.id` fallback to the resource block (docs do not say where standard attributes sit; `model`/`type` stay data-point only).
- 2026-10-28 — Orchestrator — Merged U2 (`222f654`; 43 tests). Note: rewriting `~/.claude/settings.json` sets mode 0600 (stricter).
- 2026-10-28 — Orchestrator — Owner decisions: opt-in global OTel (project settings cannot enable it — verified); packaging = bundle + tarball, no npm publish (S3f). Screenshot budget 0.
- 2026-10-28 — Researcher — OTel contract report; orchestrator re-fetched `monitoring-usage.md` lines 69 (project settings ignored) and 131 (delta default): both confirmed. `session.id` = hook `session_id` UNVERIFIED.
- 2026-10-28 — Orchestrator — `git fetch`: origin at `4386501`, nothing new. Verified locally that Node refuses type stripping under `node_modules` (packaging needs a JS bundle).

## Log

- 2026-10-28 — U0–U3 + Q1 merged locally; runner 40/40; Reviewer running. Pushed so far: `1e10741`, `222f654`, `774549e`, `ecc2c2c` (library code only; nothing calls it in production).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm --filter @javis-dog/jgr-sdk test` (U0) | 0 | — | 32 | 0 | 0 | 0 | 0 | — |
| `pnpm --filter @javis-dog/collector-claude-code test` after U2 / U1 / U3 merges | 0 | — | 74 / 166 / 208 | 0 | 0 | 0 | 0 | U3 lane ran it 3× |
| `vitest run test/otlp-conformance.test.ts` | 0 | — | 41 | 0 | 0 | 0 | 0 | 40 vectors + count |
| Mutation: Host check off | 1 | — | 40 | 1 | 0 | 0 | 0 | vector 09 only; restored |
| Mutation: random event ids | 1 | — | 39 | 2 | 0 | 0 | 0 | vectors 39, 40 only; restored |
| Full gate `format:check` / `lint` / `typecheck` / `test` / `build` / `docs:check` | 0 | — | 604 tests | 0 | 0 | 0 | 0 | collector 251, sdk 32 |
| OTel `session.id` = hook `session_id` (runtime) | — | — | — | — | — | — | 1 | owner's first real run |

## Decisions and deviations

## Retro

## Guru checkpoint

G2 at S3f close.
