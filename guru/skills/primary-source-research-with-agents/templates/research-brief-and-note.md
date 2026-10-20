# Research brief and note templates

Copy the brief into the research agent's task; copy the note into `docs/<area>/research/<YYYY-MM-DD>-<topic>.md` when results return.

## Research brief (task for the research agent)

```markdown
Research task: <topic> (<YYYY-MM-DD>)

Answer each question from PRIMARY sources only: official documentation, specifications/RFCs,
official source repositories, official SDK source. Blogs, forums, mirrors and summaries do not count.

Questions (each answer should change a decision):
1. <question> — decision it affects: <decision>
2. <question> — decision it affects: <decision>

For every fact, return: the URL, the fact (quote short key phrases verbatim), and a status:
VERIFIED (read on the primary source) · VIA SOURCE REPO (official repository of a blocked docs site) ·
NOT VERIFIED (could not reach a primary source).

If a site is blocked, try the official source repository of the same document and say so.
Never fill a gap from memory. List every blocked site at the top of your answer.
Separate facts from your recommendations; label recommendations as such.
```

## Research note (committed record)

```markdown
# <Topic> research — primary sources (<YYYY-MM-DD>)

- Method: <who researched, how>. Blocked sites: <list>; fallbacks used per item below.
- Orchestrator spot-check: <which items were re-fetched directly, how; result>.
- Anything not verified is marked **NOT VERIFIED**.

## 1. <Source or topic> — <primary URL>

- <fact> *(spot-checked | via source repo | NOT VERIFIED)*

## Decisions taken into <spec/design> (see <path>)

| Finding | Change |
|---|---|
| <finding with item number> | <change and where it landed> |

## Suggestions not adopted

| Suggestion | Reason | Revisit when |
|---|---|---|
| <researcher's recommendation> | <reason, link to decision record> | <trigger> |
```
