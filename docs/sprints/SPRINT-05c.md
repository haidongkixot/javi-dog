# Sprint 05c — Codex CLI collector (hooks with user approval, logs-only usage)

- Dates: 2026-10-29 (timebox 30 min, parallel lanes) · Status: **BUILT** 2026-10-29. Waiting on a real Codex CLI run by the owner (UNVERIFIED items in ADR-0016 and the readiness matrix).
- Goal: `javi init --platform codex-cli` and `javi usage on --platform codex-cli` let Codex CLI sessions appear in Javi's Dog with status, attention, tools, sub-agents and tokens, plus cost for API-key sign-ins only, without any prompt, response, tool I/O, path or email leaving the machine.
- Modules touched: JD-C02 (Codex adapters), JD-C01 (`javi` wiring), docs
- Readiness gate: `docs/agent-ops/READINESS_MATRIX.md` rows "Codex CLI surfaces (S5c)" and "Codex runtime checks"
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S5c
- ADR: `docs/adr/0016-gemini-and-codex-collectors.md`, Changes "S5c design" C1–C6

## Global constraints

- Owner decisions 2026-10-29: usage is logs-only, so `metrics_exporter` and statsig are untouched. ChatGPT-plan sessions get tokens only. Sub-agent usage is attributed to the parent session.
- javi never writes Codex hook trust (`[hooks.state]`, `trusted_hash`); the user approves hooks in Codex.
- Claude Code and Gemini CLI behaviour stays unchanged. No new external package and no server change. Screenshot budget 0.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| D0 | Design review | ADR-0016 C1–C6 | read-only | Findings decided before lanes start | Done |
| A1 | Codex hook mapper | JD-C02 | hook stdin → `mapCodexHook` | C2 mapping; `cx_` refs; `agent_ref` from `agent_id`; no content keys read | Done |
| A2 | Codex logs parser | JD-C02 | OTLP/HTTP JSON logs → `parseCodexLogs` | C4 allowlist only; failure variant rejected; `tool_token_count` never summed | Done |
| A3 | Codex delta and cost rule | JD-C02 | records → `usage_delta` | C5: input − cached; cost only for `ApiKey`; deterministic ids | Done |
| B1 | `javi` wiring | JD-C01 | `--platform codex-cli` | C1 append-only hooks in `.codex/hooks.json` (seconds, `commandWindows`), approval status; C3 `[otel]` TOML edit with backup and exact restore, refusal, header-env warning | Done |
| B2 | Receiver and attribution | JD-C01 | `/v1/logs` Codex records → spool | C4 discriminator; C6 sub-agent → parent map; unknown dropped; Gemini logs still unparsed | Done |
| Q1 | Conformance vectors | docs | ADR text → `docs/jgr/conformance/codex/` | Hooks and logs vectors with privacy sentinels, cost by auth mode, sub-agents | Done (41 vectors) |
| R1 | Runner | JD-C01 | README → `test/codex-conformance*.ts` | All vectors pass; mutation checks | Done (41/41 after fixes; 14/14 mutations killed) |
| V1 | Code review | all | read-only | Findings fixed or logged | Done: V1 2 high, 2 medium, 2 low fixed red-first, plus the re-send defect found by R1 |

## Review focus

- A Codex log carrying `user.email`, tool arguments or prompt text reaches the spool → must be impossible (A2/B2, Q1 sentinels).
- The user's own `.codex/hooks.json` groups move position after `init` or `uninstall` → their approvals would be lost (B1).
- `~/.codex/config.toml` with comments or an existing `[otel]` → refused untouched; `usage off` restores the file byte for byte (B1).
- A sub-agent's usage arrives before its `SubagentStart` hook → dropped, not misattributed (B2).

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | ADR, scaffold, merges, docs, push |
| Researcher | general-purpose | done: S5c research (scratch notes); orchestrator re-checked 3 facts in source |
| Reviewer | general-purpose, read-only | D0 now, V1 after the build |

Team log, newest first:

- 2026-10-29 — Orchestrator — Merged Developer E (`ffd1bdd`, which includes the runner `4f4b42f`). The full gate passed with 1698 tests and 0 failed packages; `5574c55` pushed. Unreleased changesets were corrected: the never-released `codexEventIdInput` is not described as a breaking removal.
- 2026-10-29 — Developer E — Fixed V1-H1 through V1-L6 red-first, plus R1's re-send defect (persisted accepted ids). New integration test through the real adapters. Collector 561, adapters 203, Codex conformance 41/41. A baseline flake (1 of 500, unidentified, passed on re-run) was noted and is being watched.
- 2026-10-29 — Developer C — R1 runner: 39/41 against the code before the fixes. The 2 failures (U01, U11) were a **product defect**: a re-sent record was re-spooled with a new sequence, which shows a false signal-loss gap. 14/14 mutations killed. Runtime about 65 s.

- 2026-10-29 — Reviewer — **V1 code review**: 2 high, 2 medium, 2 low, each traced, with compiled probes.
  - **High:**
    - `NO_PROXY=*` / `localhost` do not exempt `127.0.0.1` in hyper-util, which is a privacy leak through the proxy.
    - toml_edit moves javi's end marker when Codex appends a table, so `usage off` falsely claimed the export stopped.
  - **Medium:** macOS and Windows system proxies are not checked; the "all-or-nothing" rollback can lose data.
  - **Low:** uninstall deleted the user's `hooks.json`; an unused id helper differed from the real formula.
  - Decisions are in ADR-0016 Changes V1, and the fix lane (Developer E) is running.
- 2026-10-29 — Orchestrator — Merged A (`214334e`), Q1 (`8464f27`) and B (`bcddab3`). The full gate passed with 1640 tests; `1039c02` pushed. The runner lane (R1) and V1 started in parallel.
- 2026-10-29 — Developer B — B1/B2:
  - stable launcher, append-only position-aware `hooks.json` splicer, smol-toml block edit, proxy and header guards, `/v1/logs/codex-cli` with a 5 MiB cap, sub-agent links;
  - 500 collector tests (with local doubles for JD-C02);
  - the bundle lists `smol-toml@1.9.1` in `THIRD_PARTY_NOTICES`.
- 2026-10-29 — QA — 41 vectors (19 hook, 22 usage), validated against the official Codex hook schemas. 26 spec-silent decisions are listed (X1–X26).
- 2026-10-29 — Developer A — A1–A3: 206 adapter tests (118 new Codex tests); 8 mutations killed.
- 2026-10-29 — Orchestrator — D0 decisions recorded (H1–H6, M1–M5); owner chose "Add a TOML parser" (smol-toml 1.9.1), "Detect and warn" and "Stable launcher". Contract stubs `6756557`.
- 2026-10-29 — Reviewer — **D0 design review**: 6 high (proxy redirection, statsig header leak, cache-write double count, hook shell, stdout to the model, TOML safety), 5 medium and several low.

- 2026-10-29 — Orchestrator — ADR-0016 Changes "S5c design" C1–C6 written; the design review (D0) runs before any lane starts.
- 2026-10-29 — Owner — "Logs-only", "Tokens only" for ChatGPT-plan sessions, "Attribute to parent" for sub-agents.
- 2026-10-29 — Researcher — Source at `fa4ebe8`. Root `session_id` equals `conversation.id`. Cost is available from the logs exporter (`codex.turn_cost`). Hook trust is positional and user-only. Timeouts are in seconds. `developers.openai.com/codex` redirects to the blocked `learn.chatgpt.com`.

## Log

- 2026-10-29 — `5574c55` pushed after the full gate. CI: checked in the next entry.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `collectors/adapters` tests (A + E) | 0 | — | 203 | 0 | 0 | 0 | 0 | 8 mutations killed (A) |
| Codex conformance runner, before the fixes | 1 | ~65 s | 39 | 2 | 0 | 0 | 0 | U01, U11: re-send re-spooled (product defect) |
| Codex conformance runner, after E | 0 | ~65 s | 41 | 0 | 0 | 0 | 0 | mapper layer NOT RUN (optional) |
| Runner mutation checks | — | 3–7 s each | 14 killed | 0 survived | — | — | — | — |
| `collectors/claude-code` tests (after E) | 0 | ~2 min | 561 | 0 | 0 | 0 | 0 | incl. `codex-integration.test.ts` (real adapters) |
| Forced full gate on `5574c55` | 0 | — | 1698 | 0 | 0 | 0 | 0 | — |
| Real Codex CLI session | — | — | — | — | — | — | NOT RUN | owner |

## Decisions and deviations

- ADR-0016 Changes "S5c design": logs-only usage, which corrects §5's "replaces statsig".

## Retro

- Went well:
  - Reviewing the design before code (D0) caught 6 high issues before a line was written.
  - V1 used compiled probes against Codex's exact dependency versions, which turned "probably" into evidence: `NO_PROXY=*` does not exempt IPs, and toml_edit moves the end marker.
  - The independent runner caught a defect that neither the developers nor the reviewer saw: the re-send sequence gap.
- Hurt:
  - Developer B tested against local doubles while A was in progress, so the end-to-end path was only proven at merge.
  - The design still carried two wrong assumptions, about `NO_PROXY` and the marker, that only probes revealed.
  - The lanes ran long: the timebox was exceeded, recorded as a deviation.
- Change next sprint: for a third-party integration, write a probe of the target's real parser or matcher behaviour as part of the research, not only during review.

## Guru checkpoint

G4 at the S5 release gate.
