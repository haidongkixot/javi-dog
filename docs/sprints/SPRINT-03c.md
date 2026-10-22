# Sprint 03c — Claude Code collector

- Dates: 2026-10-23 (timebox 30 min) · Status: **BUILT** — waiting on the owner's first real run
- Goal: a developer runs `javi init` once and Claude Code sessions in that project appear in Javi's Dog as JGR signals, without any content leaving the machine and without slowing Claude down.
- Modules touched: JD-C01 (new package `collectors/claude-code`), JD-M02 (request timeout)
- Readiness gate: S3a ingest live; S3b SDK; hook contract verified against code.claude.com docs (2026-10-23)
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S3c
- Decisions: ADR-0010

## Global constraints

- Allowlist mapping: only event kind, tool name, duration, salted session/agent refs leave the machine.
- A hook is neutral: no stdout, exit 0 always, `async: true` (SessionEnd: sync, 5 s).
- The token never enters argv, the repository or any output.

## Backlog

| # | Task | Module | Acceptance criteria | Status |
|---|---|---|---|---|
| 1 | Hook → JGR mapping | JD-C01 | 10 hook events per ADR-0010; every mapped event valid for JD-M01; content fields never in output; salted refs | Done |
| 2 | Local state | JD-C01 | Installation id + salt once; credentials 0600 outside the repo; sequences unique under concurrency; one flusher per project | Done |
| 3 | Settings writer | JD-C01 | Exec-form async hooks merged into `.claude/settings.local.json`; idempotent; foreign hooks kept; unparsable file never overwritten; uninstall removes only ours; git exclude | Done |
| 4 | CLI | JD-C01 | `init` (verify event), `hook`, `flush`, `status` (masked), `uninstall` | Done |
| 5 | SDK timeout | JD-M02 | Hung request aborted after `requestTimeoutMs` and retried | Done |
| 6 | First real run | owner | `javi init` in a real project; a Claude Code session shows `session.started` … in the database | Pending owner |

## Owner steps

In the project you want to observe (for example this repository), with a fresh ingest token from its project page:

```powershell
$env:JAVI_INGEST_TOKEN = '<paste token>'
node "D:/Claude Projects/javi-dog/collectors/claude-code/src/cli.ts" init --project <project-slug>
Remove-Item Env:JAVI_INGEST_TOKEN
```

Expect "Connection verified". Then use Claude Code in that directory and check `node …/cli.ts status --project <project-slug>` (spooled 0, last flush ok).

## Log

- 2026-10-23 — Built tasks 1–5. A docs agent and a direct fetch verified the hook contract (events, fields, `async`, exec form, stdout/exit semantics, settings precedence, gitignore behaviour). Design changes from that: exec form instead of shell form (Windows Git Bash vs PowerShell), async hooks, Notification matcher, `duration_ms`, `agent_needs_input`. First collector run: 10 red in the mapping test — a clock-dependent fixture (`occurred_at` 00:00Z while the real clock was 23:54Z → correct `clock_skew`); clock pinned in the test, code unchanged.
- 2026-10-23 — Sprint start (S3 split: OTLP / token usage → S3d).

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm --filter @javis-dog/collector-claude-code test` | 0 | ~4 s | 31 | 0 | 0 | 0 | 0 | mapping 14, settings 4, state 4, CLI e2e on PGlite 7, real processes 2 |
| Real `node cli.ts hook` process on Windows → detached flush → local HTTP receiver | 0 | — | 2 | 0 | — | — | — | exit 0, empty stdout/stderr, event delivered with bearer token |
| First real Claude Code session against production | — | — | — | — | — | — | 1 | owner step |

Screenshots: 0.

## Decisions and deviations

- OTLP receiver and `usage.reported` moved to S3d; packaging for `npx` too.

## Retro

## Guru checkpoint

G2 after S3d (signal path incl. usage) or now if the owner prefers.
