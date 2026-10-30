# Sprint 05d — Agent self-report MCP server

- Dates: 2026-10-30 → · Status: ACTIVE
- Goal (one sentence): an agent can report its state (status with a reason, task phases) through javi's local MCP server, and the dashboard shows it in the session's thread, labelled "reported by agent".
- Modules touched: JD-C03 (new), JD-C02, JD-C01, JD-M12, JD-M13
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows "Self-report MCP protocol", "Self-report correlation", "Self-report on Windows", "MCP SDK client for tests"
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5d

## Global constraints

- ADR-0017 is the contract; vocabularies and annotations are copied exactly from it.
- JGR L0 only: no free text, and the input is never echoed in any output.
- No new runtime dependency. The MCP SDK is a pinned dev dependency of JD-C03 only.
- Hooks read `tool_input` only for javi's two tools.
- Node ≥ 22; the `javi.mjs` bundle stays self-contained.
- Screenshot budget 0.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| T1 | Self-report vocabulary, validator and mappers | JD-C02 | → `SELF_REPORT`, `validateSelfReport()`, `selfReportRecord()` | TEST_PLAN rows 1, 6–8 | PLANNED |
| T2 | Hand-written stdio MCP server | JD-C03 | JD-C02 → `createMcpServer()` | rows 2–5 | PLANNED |
| T3 | `javi mcp`, `init --self-report`, uninstall, status, hook wiring for all three platforms | JD-C01 | JD-C02, JD-C03 → CLI | rows 4, 9, 12 | PLANNED |
| T4 | Reader precedence, `statusSource`, `statusReason`, attention for agent `blocked`; pill text in all status pills | JD-M12, JD-M13 | → `ThreadState.statusSource`, `statusReason` | precedence, reader and pill rows | PLANNED |
| T5 | Conformance vectors (`docs/jgr/conformance/self-report/`) and runner | QA | ADR-0017 → vectors | every vector PASS, mutation-checked | PLANNED |
| T6 | End-to-end test, docs (how-to, spec §12 Changes, registry, changeset) | all | — | row 11; `docs:check` | PLANNED |

## Review focus

- A `report_status` call whose input has extra keys holding a prompt-like string → rejected, and the string appears nowhere (T1, T2).
- A third-party MCP server's `tool_input` holding secrets → never read (T1 trap test).
- An existing `.mcp.json` with the user's servers and odd formatting → kept byte-for-byte except javi's entry (T3).
- `/clear` in Claude Code → the next self-report goes to the new session's thread (T1, by construction: the hook's session id).

## Log

Newest first: date — what changed — commit SHA.

- 2026-10-30 — Discovery, research, owner decisions, ADR-0017, TEST_PLAN §S5d, readiness rows.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator | Claude (this session) | ADR, merges, gate, push |
| Reviewer (design) | read-only agent | ADR-0017 before code |
| QA | worktree agent | `docs/jgr/conformance/self-report/` |
| Developer A | worktree agent | `collectors/adapters`, `collectors/mcp-server` |
| Developer B | worktree agent | `collectors/claude-code`, `packages/realtime`, `apps/web` |

Team log, newest first:

- 2026-10-30 — Reviewer — Design review D0 of ADR-0017, before any code: 2 High (H1 the end-of-turn `idle` overwrote self-reports; H2 self-reports waited in the spool), 7 Medium, 5 Low. Orchestrator verified H1/H2 in `mapping.ts:103-104`, `queries.ts:21,80-81`, `run.ts:23,228-236`. All folded into ADR-0017 (Changes D0). The orchestrator also found that pre-tool hooks would leave an unmatched `task.started` for javi's tools, now silent. Owner: self-reported `blocked` counts as attention; opt-in `--allow-self-report`.
- 2026-10-30 — Orchestrator — Research agent report (primary sources). The orchestrator re-checked hook firing for MCP tools in the Codex and Gemini sources. That led to a uniform "hook emits" design, with no server-side Codex path.

## Decisions and deviations

- Owner 2026-10-30: JD-C03 next; hook emits; hand-written server; reason in `error_code`; opt-in registration without pre-granted permissions (ADR-0017).
- Owner 2026-10-30 (after design review): self-reported `blocked` needs attention; opt-in `--allow-self-report` flag for a narrow allowance.

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

—
