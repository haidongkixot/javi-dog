# Second-memory file templates

Copy each block into the path shown and replace the placeholders. Keep the headings: agents look for them.

## Project memory (`docs/memory/PROJECT_MEMORY.md`)

Overwrite in place every session. Short, current, no history.

```markdown
# Project Memory — <project>

> Read this first in every session. Keep it short and current; history goes to SESSION_LOG.md.
> Last updated: <YYYY-MM-DD> · Current sprint: <ID — name> (docs/sprints/<file>)

## What we are building

<two or three sentences>

## Current state

- <what exists, on which branch, what is deployed — and what is NOT>

## Decisions in force

| Ref | Decision |
|---|---|
| ADR-0001 | <one line> |
| Owner | <owner decision, date> |

## Open questions / blockers (owner)

- **<ID>** <question> — needed by <milestone>

## Next actions

1. <next concrete step>

## Key paths

<entry files, separated by ·>
```

## Session log entry (`docs/memory/SESSION_LOG.md`)

Append-only, newest first. One entry per session.

```markdown
## <YYYY-MM-DD> · Session <n> (<agent/tool>) — <sprint>

- What happened: <facts, with commit SHAs>
- State left behind: <branch, checks status, what is half-done>
- Waiting on owner: <IDs>
- Next: <first step for the next session>
```

## Sprint record (`docs/sprints/SPRINT-NN.md`)

```markdown
# Sprint NN — <name>

- Dates: <start time> → <end time> (timebox <N> min) · Status: <PLANNED | ACTIVE | CLOSING | DONE>
- Goal: <one sentence>
- Split: <"roadmap S<n> = S<n>a (this) + S<n>b (…)" or "none"> · Rolled over in: <items from the previous record, with status>
- Readiness: <link to readiness matrix and its verdict>

## Backlog

| # | Task | Acceptance criteria | Status |
|---|---|---|---|
| 1 | <task> | <observable criterion> | <Done (`sha`) / In progress / Waiting on owner> |

## Log

- <YYYY-MM-DD> — <event> — `<sha>`

## Test evidence

| Command | Exit | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---|
| <command> | <code> | <count> | <count> | <what and why> | — | — | <none / path> |

## Decisions and deviations

- <ADR refs; deviations from the plan and why>

## Retro

- Went well: <evidence-backed>
- Hurt: <evidence-backed>
- Change next sprint: <one or two actions>
```

## Readiness matrix row (`docs/agent-ops/READINESS_MATRIX.md` or equivalent)

```markdown
| Area | Requirement | Resource / permission | Status | Evidence | Impact if missing | Options | Recommendation | Owner decision? |
|---|---|---|---|---|---|---|---|---|
| Integrations | Database | <service + env var NAME only> | UNKNOWN | <command and result, e.g. "listing returned 403"> | <what is blocked> | A) … · B) … | A | Yes (<ID>) |
```

Status vocabulary: AVAILABLE (with evidence) / MISSING / UNKNOWN / BLOCKED / NOT NEEDED. UNKNOWN is never treated as AVAILABLE. Never record secret values.
