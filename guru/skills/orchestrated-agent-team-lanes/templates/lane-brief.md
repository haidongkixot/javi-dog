# Lane brief — <iteration id> · <lane name> (<role>)

> Copy into the delegated prompt. Fill every field; delete nothing. A lane that finds a stated fact false stops and reports instead of working around it.

## Goal

<one sentence: what this lane delivers>

## Facts you rely on (from the readiness record)

| Fact | Status | Evidence |
|---|---|---|
| <e.g. "runtime X supports Y"> | AVAILABLE / UNKNOWN | <file, command result, doc URL> |

If any row is wrong, stop and report.

## Acceptance (rows from the test plan)

| Requirement | Lowest reliable layer | Test file / assertion |
|---|---|---|
| | | |

## Allowed paths

- `<path/glob>`
- `<path/glob>`

Everything else is read-only for you.

## Interfaces you consume (already committed as stubs)

```text
<signature>   # owner: <orchestrator / other lane>
```

## Forbidden

- Do not push, merge or rebase shared branches.
- Do not edit shared files (lockfile, generated registries, memory/iteration records, CI config); list the edits you need instead.
- Do not run migrations against any real database.
- Do not add external packages.
- Screenshot budget: 0 unless stated here: <budget>.

## QA lanes only

Write expectations from the contract texts listed here, never from implementation code or tests: <decision record(s), spec sections, external specs>. List every ambiguity with an id and the reading you chose.

## Return

1. Commit(s) in your worktree, one coherent unit each.
2. Commands run with exit codes and counts (PASS / FAIL / SKIPPED / BLOCKED / NOT RUN kept distinct).
3. Tests written first and their red result, for any fix.
4. Shared-file edits you need, as a list.
5. Open questions and assumptions, labelled.
