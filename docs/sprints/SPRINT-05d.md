# Sprint 05d — Agent self-report MCP server

- Dates: 2026-10-30 → 2026-10-30 · Status: CLOSED (code complete; real CLI runs are owner steps)
- Goal (one sentence): an agent can report its state (status with a reason, task phases) through javi's local MCP server, and the dashboard shows it in the session's thread, labelled "reported by agent".
- Modules touched: JD-C03 (new), JD-C02, JD-C01, JD-M07, JD-APP
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
| T1 | Self-report vocabulary, validator and mappers | JD-C02 | → `SELF_REPORT`, `validateSelfReport()`, `selfReportRecord()` | TEST_PLAN rows 1, 6–8 | DONE (`328beb7`) |
| T2 | Hand-written stdio MCP server | JD-C03 | JD-C02 → `createMcpServer()` | rows 2–5 | DONE (`328beb7`) |
| T3 | `javi mcp`, `init --self-report`, uninstall, status, hook wiring for all three platforms | JD-C01 | JD-C02, JD-C03 → CLI | rows 4, 9, 12 | DONE (`e9b2ae4`, review fixes `0a0c7e9`) |
| T4 | Reader precedence, `statusSource`, `statusReason`, attention for agent `blocked`; pill text in all status pills | JD-M07, JD-APP | → `ThreadState.statusSource`, `statusReason` | precedence, reader and pill rows | DONE (`bd616f6`, `d9b51eb`) |
| T5 | Conformance vectors (`docs/jgr/conformance/self-report/`) and runner | QA | ADR-0017 → vectors | every vector PASS, mutation-checked | DONE: 54 of 54 vectors pass; 71 of 74 mutations caught (`8a0cba7`, `44d88da`) |
| T6 | End-to-end test, docs (how-to, spec §12 Changes, registry, changeset) | all | — | row 11; `docs:check` | DONE (`44d88da`, `67d8c01`) |

## Review focus

- A `report_status` call whose input has extra keys holding a prompt-like string → rejected, and the string appears nowhere (T1, T2).
- A third-party MCP server's `tool_input` holding secrets → never read (T1 trap test).
- An existing `.mcp.json` with the user's servers and odd formatting → kept byte-for-byte except javi's entry (T3).
- `/clear` in Claude Code → the next self-report goes to the new session's thread (T1, by construction: the hook's session id).

## Log

Newest first: date — what changed — commit SHA.

- 2026-10-30 — Code review fixes merged (fix lane): M1–M3 and L1–L4, all red-first. Behaviour change: on a machine without git, `--self-report` needs `--allow-tracked-config` — `0a0c7e9`.
- 2026-10-30 — T5 runner part 2 and T6 end-to-end merged (runner lane 2):
  - H group 14 of 14 vectors pass at the collector layer;
  - 20 of 20 mutations caught;
  - end-to-end hook → spool → ingest (PGlite) → reader passes for Claude Code and Codex.

  Commits `44d88da` and lockfile `50f5059`.
- 2026-10-30 — T5 runner part 1 merged: the M group (22/22, instance layer) and the R group (18/18, PGlite) pass; 51/54 mutations caught. Survivors were logged as coverage gaps; one ADR clarification (client response objects are ignored). The H group waits on T3 — `8a0cba7`.
- 2026-10-30 — Orchestrator follow-ups to T4: reasons only on `waiting`/`blocked`/`failed` in the reader, "CI failing" capitalised, reader ↔ JD-C02 vocabulary equality test (red-first: 3 new tests failed before the fix) — `d9b51eb`.
- 2026-10-30 — T4 merged (Developer B): reader precedence, `statusSource`, `statusReason`, attention for agent `blocked`, pill text in squad, feed and agents table — `bd616f6`.
- 2026-10-30 — Registry: JD-C03 out of `planned.json` into `REGISTRY.md` — `c59b260`.
- 2026-10-30 — T1 + T2 merged (Developer A): JD-C02 self-report core, JD-C03 hand-written server, SDK client interop test (dev dependency 1.32.2) — `328beb7`.
- 2026-10-30 — T5 vectors merged (QA): 54 vectors (M 22, H 14, R 18) — `c965708`, citations `1595b4e`.
- 2026-10-30 — Discovery, research, owner decisions, ADR-0017, TEST_PLAN §S5d, readiness rows.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm -s test --force` (main tree after T1, T2, T4 merges, `d9b51eb`) | 0 | — | 1997 | 0 | 0 | 0 | 0 | 15 packages; no "Unhandled" |
| `pnpm -s build`; migration drift check; `format:check`, `lint`, `typecheck`, `docs:check` | 0 | — | — | — | — | — | — | — |
| CI `c25cf2d` / `1595b4e` | success | — | — | — | — | — | — | runs 41072581103, 41073502748 |
| Conformance runner M (`collector-mcp-server` tests) / R (`realtime` tests), runner worktree | 0 / 0 | — | 22 / 18 vectors | 0 | 0 | 0 | H: 14 | 114 / 136 package tests; mutations 51/54 caught |
| QA vector checks (schema, negatives, satisfiability; QA worktree) | 0 | — | 54 + 9 + 181 | 0 | 0 | 0 | 0 | scratch scripts, not committed |

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

- 2026-10-30 — Reviewer — Code review of `2d4dcc2..08f7b2e`:
  - **Result:** 0 High, 3 Medium, 5 Low. All Mediums were reproduced against a built bundle.
  - **Medium:**
    - M1: a re-fired hook is not deduplicated, because the event id's time part is the wall clock.
    - M2: `uninstall` is blocked by a user's unparsable `.mcp.json`, even without self-report.
    - M3: the git-tracked refusal fails open on git errors.
  - **Low:**
    - L1: launcher stack trace on stderr;
    - L2: a javi-created `.mcp.json` is not git-excluded;
    - L3: `javi status` prints repo-controlled control characters;
    - L4: keys appended after javi's Codex block;
    - L5: cosmetic line endings and quoting.
  - **Fix lane:** M1–M3 and L1–L4, red-first. L5 is accepted (no data loss; the round trip is byte-exact).
  - **Closed UNVERIFIED point:** Codex tool hooks carry `agent_id` only for thread-spawned sub-agents (`codex-rs/core/src/hook_runtime.rs:1144`, `hooks/src/schema.rs:72-84`). So the sub-agent rule does not drop root Codex reports.
  - **Disclosure:** one reviewer `init` without `--endpoint` sent a single request with a fake token to production. It got `401`; nothing was written. Later runs used a dead local endpoint.
- 2026-10-30 — Runner — Coverage gaps from surviving mutations, for QA follow-up (F2):
  - a client response object is not covered by any vector;
  - `report_task` has no case for missing or non-object `arguments` (M18);
  - no vector ends a thread while it is waiting or blocked.

  The success text varying per call is allowed by the ADR. The R store is truncated between vectors rather than recreated (45 s versus 5.5 s); accepted.
- 2026-10-30 — Orchestrator — Process slip: the gated push of `d9b51eb` chained the secret scan with `;` instead of `&&`. The scan was clean (exit 1), so nothing slipped, and the scan is chained again from the next push.
- 2026-10-30 — Developer B — Corrected module labels (the reader is JD-M07, the pill is JD-APP). Open: project-level "N waiting for you" now also counts agent-`blocked` threads; the wording is logged as a follow-up (F1), not changed.
- 2026-10-30 — QA — 50 vectors (M 21, H 14, R 15) from the ADR only, `1f40a78` in the QA worktree. 19 spec gaps; G8 was a design defect: an agent's `working` would have hidden a real permission prompt. All resolved in ADR-0017 (Changes "QA spec gaps"). Developers A and B were told mid-lane, and QA is updating the vectors.
- 2026-10-30 — Reviewer — Design review D0 of ADR-0017, before any code: 2 High (H1 the end-of-turn `idle` overwrote self-reports; H2 self-reports waited in the spool), 7 Medium, 5 Low. Orchestrator verified H1/H2 in `mapping.ts:103-104`, `queries.ts:21,80-81`, `run.ts:23,228-236`. All folded into ADR-0017 (Changes D0). The orchestrator also found that pre-tool hooks would leave an unmatched `task.started` for javi's tools, now silent. Owner: self-reported `blocked` counts as attention; opt-in `--allow-self-report`.
- 2026-10-30 — Orchestrator — Research agent report (primary sources). The orchestrator re-checked hook firing for MCP tools in the Codex and Gemini sources. That led to a uniform "hook emits" design, with no server-side Codex path.

## Decisions and deviations

- Owner 2026-10-30: JD-C03 next; hook emits; hand-written server; reason in `error_code`; opt-in registration without pre-granted permissions (ADR-0017).
- Owner 2026-10-30 (after design review): self-reported `blocked` needs attention; opt-in `--allow-self-report` flag for a narrow allowance.

## Retro

- **Went well:**
  - Each independent check caught what the previous one missed. Research verified hook firing in source. The design review found the end-of-turn overwrite. QA found the permission-prompt masking (G8). The code review found the re-fire duplicate, which a test with a frozen clock had hidden.
  - Lanes on disjoint paths merged without a conflict.
  - Mid-lane ADR amendments reached the developers before they built the wrong rule.
- **Hurt:**
  - Two secret-scan slips in the push chain (`;`, then a malformed command that failed open).
  - `pnpm install` keeps rewriting three unrelated `better-auth` peer strings, so every lockfile edit is made by hand.
  - The ADR named the wrong module IDs (JD-M12, JD-M13).
  - The sprint ran well past the 30-minute timebox. The owner's reply time is outside the timebox, but the five lanes were not.
- **Change next sprint:**
  - Use the fail-closed `secret-scan` script for every push.
  - Check module IDs against `module.json` when writing an ADR.
  - Write tests that move the clock between runs whenever a claim depends on idempotency.
  - Decide whether to fix the lockfile churn (pin `@babel/core` peer resolution) as a chore.

## Guru checkpoint

—
