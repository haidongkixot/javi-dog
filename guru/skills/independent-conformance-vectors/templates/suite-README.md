# <Contract name> conformance vectors

Black-box cases for `<METHOD> <path>` (or `<parser / receiver name>`).

- **Oracle independence.** Every expectation is derived only from: <decision record incl. its Changes section (normative, overrides older lines)>, <your spec §…>, <external standard + section>. No implementation code or test was read to write them.
- **Format.** One file per case, `<NN>-<kebab-name>.json`, valid against `schema.json` (JSON Schema, kept next to the vectors).
- **Status.** Written <date> for <iteration/task>. Runner: `<path to runner test>` (written by someone other than the vector author).
- **Blocked sources.** <site> was blocked; the same text was read from <official source repository path>. / none

## Vector file format

```json
{
  "description": "What the case proves",
  "contract": "<record> <section/line> / <spec §N>",
  "ambiguities": [],
  "setup": { "token": "valid", "preload": [], "state": {} },
  "request": {
    "method": "POST",
    "path": "/v1/…",
    "headers": { "content-type": "application/json" },
    "gzip": false,
    "body": {},
    "rawBody": null,
    "bodyPadBytes": null
  },
  "expect": {
    "status": 200,
    "headers": {},
    "errorCode": null,
    "sideEffects": { "stored": 0 }
  }
}
```

All keys are always present (unused ones are `null`, `[]` or `{}`), so a runner never guesses a default.

## Runner rules

### Fixed environment

| Item | Rule |
|---|---|
| Server | A fresh instance per vector on `127.0.0.1:$PORT` (any free port the runner chooses). |
| Secrets | `$SECRET` = the configured secret; `$WRONG_SECRET` = `$SECRET` with its last character replaced by a different character of the same class. |
| State | A fresh temporary state directory / database per vector. |

A runner that cannot build this setup reports the vector **BLOCKED**.

### Observation and comparison

- How side effects are observed: <spool files / rows / emitted events>.
- Canonical comparison: <field order irrelevant; ids matched by pattern `…`; times compared as instants>.
- Forbidden strings: every value planted as an identity/content canary in a request must not appear in any observed output.

### Results

One of PASS, FAIL, BLOCKED, SKIPPED, NOT RUN per vector. BLOCKED is never counted as PASS. A check the runner cannot observe is reported NOT RUN separately. The runner asserts the total vector count.

## Vectors

| # | File | Case | Expect |
|---|---|---|---|
| 01 | | | |

### Not covered

| Behaviour | Why |
|---|---|
| | |

## Ambiguities

Line numbers refer to `<record>` at commit `<sha>`.

| ID | Contract text | Question | Vector choice |
|---|---|---|---|
| A1 | | | |

## Mutation checks (fill in when run)

| Mutation | Expected failing vectors | Observed | Exit |
|---|---|---|---|
| <e.g. 415 → 400 in the handler> | <32–34> | | |
