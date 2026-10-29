# Sprint 05c — Codex CLI collector (hooks with user approval, logs-only usage)

- Dates: 2026-10-29 (timebox 30 min, parallel lanes) · Status: **PLANNED** (design review before code)
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
| D0 | Design review | ADR-0016 C1–C6 | read-only | Findings decided before lanes start | In progress |
| A1 | Codex hook mapper | JD-C02 | hook stdin → `mapCodexHook` | C2 mapping; `cx_` refs; `agent_ref` from `agent_id`; no content keys read | Planned |
| A2 | Codex logs parser | JD-C02 | OTLP/HTTP JSON logs → `parseCodexLogs` | C4 allowlist only; failure variant rejected; `tool_token_count` never summed | Planned |
| A3 | Codex delta and cost rule | JD-C02 | records → `usage_delta` | C5: input − cached; cost only for `ApiKey`; deterministic ids | Planned |
| B1 | `javi` wiring | JD-C01 | `--platform codex-cli` | C1 append-only hooks in `.codex/hooks.json` (seconds, `commandWindows`), approval status; C3 `[otel]` TOML edit with backup and exact restore, refusal, header-env warning | Planned |
| B2 | Receiver and attribution | JD-C01 | `/v1/logs` Codex records → spool | C4 discriminator; C6 sub-agent → parent map; unknown dropped; Gemini logs still unparsed | Planned |
| Q1 | Conformance vectors | docs | ADR text → `docs/jgr/conformance/codex/` | Hooks and logs vectors with privacy sentinels, cost by auth mode, sub-agents | Planned (QA) |
| R1 | Runner | JD-C01 | README → `test/codex-conformance*.ts` | All vectors pass; mutation checks | Planned |
| V1 | Code review | all | read-only | Findings fixed or logged | Planned |

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

- 2026-10-29 — Orchestrator — ADR-0016 Changes "S5c design" C1–C6 written; the design review (D0) runs before any lane starts.
- 2026-10-29 — Owner — "Logs-only", "Tokens only" for ChatGPT-plan sessions, "Attribute to parent" for sub-agents.
- 2026-10-29 — Researcher — Source at `fa4ebe8`. Root `session_id` equals `conversation.id`. Cost is available from the logs exporter (`codex.turn_cost`). Hook trust is positional and user-only. Timeouts are in seconds. `developers.openai.com/codex` redirects to the blocked `learn.chatgpt.com`.

## Log

- Placeholder — entries newest first.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

## Decisions and deviations

- ADR-0016 Changes "S5c design": logs-only usage, which corrects §5's "replaces statsig".

## Retro

- Went well:
- Hurt:
- Change next sprint:

## Guru checkpoint

G4 at the S5 release gate.
