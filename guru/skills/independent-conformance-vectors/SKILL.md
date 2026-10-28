---
name: independent-conformance-vectors
description: Build black-box conformance vectors for an API, protocol endpoint, webhook receiver or parser as an independent test oracle — written by a QA agent or person from the contract text only (decision records, spec, external standards), never from the implementation; one data file per case with every key explicit; an ambiguity register that turns unclear contract lines into owner questions; runner rules that keep PASS, FAIL, BLOCKED, SKIPPED and NOT RUN distinct; and mutation checks that break one rule in the implementation and expect exactly the matching vectors to fail. Use when a contract (HTTP endpoint, OTLP/webhook receiver, file format, CLI protocol) gets a second implementation or a hardening pass, when tests were written by the same agent that wrote the code, when a brief or spec may contradict an external standard, when you need evidence that a test suite actually detects regressions, or when asked for "conformance tests", "test vectors", "golden files", "contract tests" or "an independent QA pass".
metadata:
  version: "0.1.0"
  origin: "javis-dog G2"
  confidence: "high (independent vectors + runner + mutation checks: two suites, two iterations); medium (ambiguity register catching a defect in the brief: once)"
---

# Independent conformance vectors

Tests written by the agent that wrote the code tend to agree with the code, including where both misread the contract. An independent oracle — cases derived only from the contract — can disagree, and every disagreement is either an implementation bug or a contract ambiguity worth an owner decision. A mutation check then proves the runner notices when a rule breaks.

The rule: **vectors come from the contract text; the runner follows written rules; each important rule is shown to make exactly its vectors fail when broken.**

## 1. Fix the oracle's inputs

List the contract texts the QA author may read: the decision record (including any *Changes* section, which overrides older lines), your spec, and external standards (RFCs, the wire-format spec). State in the suite README: "no implementation code or test was read to write these". If a source site is blocked, read the same text from the standard's official source repository and say so.

## 2. One file per case, every key explicit

- File name `<NN>-<kebab-name>.<ext>`, validated by a schema.
- Fields: `description`, `contract` (which line/section the case proves), `ambiguities` (ids it depends on), `setup`, `request` (method, path, headers, body or raw body, compression, padding size for limit tests), `expect` (status, headers, error code, counts, side effects such as stored rows or "no event").
- **All keys always present** (unused ones `null`, `[]`, `{}`) so the runner never guesses a default.
- Use placeholders for runtime values (`$PORT`, `$SECRET`, `$WRONG_SECRET` defined precisely) instead of literals.
- Prefer margins over exact boundaries when the contract is vague on a limit (accept 900 000 bytes, reject 1 100 000) and log the boundary as an ambiguity.

Template: [`templates/suite-README.md`](templates/suite-README.md).

## 3. Keep an ambiguity register

Every contract line that can be read two ways gets an id (A1…An), the contract text, the question, and the reading the vectors chose. A FAIL on a vector that depends on an ambiguity is reported with its id, so the owner decides whether the reading or the implementation is wrong. Expect many: both origin suites listed 20 ambiguities each.

The register is where the oracle pays off most. In the origin, the brief said "a non-OTLP JSON object → 400", while the OTLP JSON encoding says unknown fields MUST be ignored and an empty request SHOULD succeed. QA recorded it as A3 and chose the standard's reading; the orchestrator accepted it and fixed the parser before the dependent lane wrote its tests.

## 4. Write runner rules, then the runner

The README specifies the fixed environment (fresh receiver per vector, temporary state directory), how side effects are observed, how events or rows are compared (canonical forms, matchers for generated ids), forbidden strings to scan for (identity canaries planted in requests), and result rules:

- One of PASS, FAIL, BLOCKED (setup failed), SKIPPED, NOT RUN per vector.
- BLOCKED is never counted as PASS; a check the runner cannot observe is NOT RUN, reported separately.
- The runner asserts the vector count, so a deleted file fails the suite.

Someone other than the QA author writes the runner from those rules, against the real handler (in-process server, real engine such as an embedded database).

## 5. Prove the runner bites with mutation checks

For each rule that matters (status code for a class of error, a security check, id determinism):

1. Break it in the implementation (change one status, disable one check, randomize one id).
2. Run the suite. Expect **exactly** the vectors that exercise the rule to fail — not zero, not everything.
3. Restore, re-run green, and record the mutation, the failing vector numbers and the exit codes in the iteration's test evidence.

"Exactly" matters: zero failures means the rule is untested; a flood means vectors are coupled and failures will be hard to read.

If your environment blocks running mutations (an agent permission classifier did in the origin's first attempt), record the check as BLOCKED and ask for permission up front next time.

## Pitfalls

- **QA reading the code "just to understand it".** The oracle is then a copy.
- **Silent defaults in vector files.** A runner that assumes a missing header means "none" tests something the author did not write.
- **Choosing a reading without logging it.** Ambiguities resolved silently resurface as bugs.
- **Counting BLOCKED as PASS.** A vector that could not run proves nothing.
- **A green suite as evidence of detection.** Only a mutation that turns it red shows that.

## Evidence from origin project

Javi's Dog, Sprints 3d and 3e (2026-10-28). Confidence **high** for vectors + runner + mutation (two suites, each mutation failed exactly the expected vectors), **medium** for brief-defect discovery (one accepted case).

- HTTP ingest suite: 43 vectors from the ingest decision record including its *Changes* section, 20 ambiguities (`docs/jgr/conformance/http/README.md`, `9d50e82`); runner written by the orchestrator from the README rules (`packages/ingest/test/conformance.test.ts`, `3273725`): 45 tests (43 vectors + count + equivalence group) exit 0. Mutation: handler answering 400 instead of 415 → exactly vectors 32–34 FAIL (exit 1), restored (`docs/sprints/SPRINT-03d.md` Test evidence).
- Local OTLP receiver suite: 40 vectors / 46 steps from the receiver decision record, the OTLP specification and the vendor's telemetry docs; 20 ambiguities; the standard's website was blocked and the same text was read from its official proto repository (`docs/jgr/conformance/otlp/README.md`, `d5f85a9`). Runner `collectors/claude-code/test/otlp-conformance.test.ts` (`6504ef4`): 41 tests exit 0. Mutations: Host check disabled → exactly vector 09 FAIL; random event ids → exactly vectors 39 and 40 FAIL; restored (`docs/sprints/SPRINT-03e.md` Test evidence).
- Brief defect: ambiguity A3 (brief vs. OTLP unknown-field and empty-request rules) → parser fix `ecc2c2c` ("an object without `resourceMetrics` is an empty request"); recorded in the receiver decision record's *Changes* (`docs/adr/0011-local-otlp-usage-receiver.md`).
- Earlier attempt: a mutation check in S3a was blocked by the session's permission classifier and recorded as BLOCKED; the retro asked for permission up front (`docs/sprints/SPRINT-03a.md`). Mutation checks ran in S3d, S3e and S3f.
- Not verified: that vectors keep *several* implementations consistent (each suite has one implementation).
