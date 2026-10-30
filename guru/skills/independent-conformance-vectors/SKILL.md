---
name: independent-conformance-vectors
description: Build black-box conformance vectors for an API, protocol endpoint, webhook receiver or parser as an independent test oracle — written by a QA agent or person from the contract text only (decision records, spec, external standards), never from the implementation; one data file per case with every key explicit; an ambiguity register that turns unclear contract lines into owner questions; runner rules that keep PASS, FAIL, BLOCKED, SKIPPED and NOT RUN distinct; and mutation checks that break one rule in the implementation and expect exactly the matching vectors to fail; plus vectors for invariance claims (idempotency, replay, ordering) that vary what the claim says must not matter — the clock above all — and leak checks whose needles cannot occur by chance in random ids. Use when a contract (HTTP endpoint, OTLP/webhook receiver, file format, CLI protocol) gets a second implementation or a hardening pass, when tests were written by the same agent that wrote the code, when a brief or spec may contradict an external standard, when you need evidence that a test suite actually detects regressions, when a runner compares numbers with a tolerance or runs "parallel" steps on a single-connection test database, when money or price rules need a second derivation, when vectors are merged before the runner or the code that satisfies them, when a claim says "a re-run is de-duplicated" or "the same input gives the same id", when a negative assertion (`not.toContain`) fails intermittently, or when asked for "conformance tests", "test vectors", "golden files", "contract tests" or "an independent QA pass".
metadata:
  version: "0.4.0"
  origin: "javis-dog G2; updated G3, G4, ad-hoc-self-report (S5d)"
  confidence: "high (independent vectors + runner + mutation checks: seven suites, seven iterations; the runner found product defects that developers and reviewers missed in two of them); medium (ambiguity register catching a defect in the brief or design: twice; strict-tolerance rule: one hidden defect; independent price derivation: once; invariance claims needing a moving clock: once, a defect every oracle missed; short leak needles as a flake source: once, verified in CI)"
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

A design record that has just been through a review is a good moment for vectors: the reviewer's remedies are new, unreviewed rules (see `review-design-before-code`). In the origin's eighth suite, QA writing vectors from a reviewed record found 19 gaps; one was a design defect introduced by the review's own remedy. Resolve gaps in the record before runners exist, and tell running lanes the same hour.

### Vectors for invariance claims must vary what should not matter

"A re-run is de-duplicated", "the same call gets the same id", "order does not matter": each claim says that some input is irrelevant. A vector can only falsify it if that input **changes** between the runs:

- Re-run with the clock **advanced** (milliseconds and minutes), in a fresh process, with a reordered batch, as relevant.
- A pinned clock is fine for reproducibility, but a pinned clock that is the *same* for both runs makes any id that embeds time look stable.
- Ask, per claim: "what would the implementation have to use for this to break?" — then vary exactly that.

In the origin, the unit test and the vectors both replayed a call under one pinned clock; the implementation put the hook time into the event id, so a real re-fire produced a second record. 71 of 74 mutations were caught and the suite was green; the code reviewer found the defect on the built bundle.

**Mutations come from the same model as the vectors.** They show the suite detects the deviations its authors imagined; they do not find a property nobody wrote a varying vector for.

## 4. Write runner rules, then the runner

The README specifies the fixed environment (fresh receiver per vector, temporary state directory), how side effects are observed, how events or rows are compared (canonical forms, matchers for generated ids), forbidden strings to scan for (identity canaries planted in requests), and result rules:

- One of PASS, FAIL, BLOCKED (setup failed), SKIPPED, NOT RUN per vector.
- BLOCKED is never counted as PASS; a check the runner cannot observe is NOT RUN, reported separately.
- The runner asserts the vector count, so a deleted file fails the suite.

Someone other than the QA author writes the runner from those rules, against the real handler (in-process server, real engine such as an embedded database). Prefer someone who is not the implementation's author either (a fresh lane), so neither oracle nor runner shares the implementer's reading.

Runner rules that the origin learned the hard way:

- **Tolerances are exactly the README's.** No "a few ULPs of slack" for floating point. If a vector only passes with extra slack, the implementation sits on the edge of the tolerance — that is a finding, not noise. In the origin, slack added by the runner hid a defect that rounded 79.99 % up to 80 %; only the reviewer caught it. Fix representation problems in the implementation (exact integers or decimals), never in the comparison.
- **A runner author's "this only passes because…" is a FAIL candidate.** Route it to the owner of the implementation before merging, not into a comment.
- **Parallel steps need parallel infrastructure.** On a single-connection embedded engine, concurrent calls interleave at statement level at most: that proves the claim logic, not the database's arbitration between connections. A runner that serialises "parallel" steps reports them NOT RUN; add one check on a real multi-connection server for the claim.
- **First red: classify before fixing.** When a new runner fails on its first run, decide per failure whether the runner, the vector or the implementation is wrong. In the origin the first state-suite run had 4 FAIL from a runner field-mapping bug (an offset mapped to the wrong timestamp field); the vectors were right.

### Run the runner against the unfixed code

When a review round and a runner run in parallel, run the runner against the code **before** the review fixes and classify each failure: a known review finding (expected red, name it), a vector or runner bug, or a **new product defect**. Record the before-fix counts; they are evidence that the vectors encode the review's rules. In the origin, one runner failed 32 of 54 exactly on the review's open rules; another failed 2 of 41 on a defect nobody had reported.

### Keep vectors, runner and code in step when pushing

Vectors merged ahead of the runner or of the implementation make the shared branch red (`expected 53 to be 40`, `expected 404 to be 200`). On an auto-deploying branch, merge them locally and **hold the push** until runner and code catch up; log the hold and the red that justified it.

### Derive money rules twice

For prices, rates and cost formulas, let QA derive expected values from the vendor's page text independently of the implementation's table, then compare both with the source (find the quoted fragment verbatim, once). Pin every money rule by a vector (cost only for the billing modes that are charged per token; a missing cost is never zero).

### Validate vector inputs against the vendor's schemas

When the vendor publishes schemas for the payloads (hook input schemas, wire formats), validate every vector's input against them, so the oracle never tests a payload the tool cannot send.

### Leak checks need needles that cannot occur by chance

Negative assertions (`expect(json).not.toContain(needle)`) prove that another tenant's or the user's data did not leak — unless the needle is short enough to appear in random output. A 3-digit number appears in a random UUID or timestamp often enough to fail a suite now and then. Use sentinel strings that cannot be produced by your id, time or number formats (`SENTINEL_<CASE>_<FIELD>` with characters outside hex and digits), or assert on parsed fields instead of substrings.

## 5. Prove the runner bites with mutation checks

For each rule that matters (status code for a class of error, a security check, id determinism):

1. Break it in the implementation (change one status, disable one check, randomize one id).
2. Run the suite. Expect **exactly** the vectors that exercise the rule to fail — not zero, not everything.
3. Restore, re-run green, and record the mutation, the failing vector numbers and the exit codes in the iteration's test evidence.

"Exactly" matters: zero failures means the rule is untested; a flood means vectors are coupled and failures will be hard to read.

A **surviving** mutation is either a missing vector (add one; in the origin a new vector killed a shared-baseline mutation) or a mutation that cannot occur under the implementation's invariants. Record which, with the reason; do not count unexplained survivors as killed.

If your environment blocks running mutations (an agent permission classifier did in the origin's first attempt), record the check as BLOCKED and ask for permission up front next time.

## Pitfalls

- **QA reading the code "just to understand it".** The oracle is then a copy.
- **Silent defaults in vector files.** A runner that assumes a missing header means "none" tests something the author did not write.
- **Choosing a reading without logging it.** Ambiguities resolved silently resurface as bugs.
- **Counting BLOCKED as PASS.** A vector that could not run proves nothing.
- **A green suite as evidence of detection.** Only a mutation that turns it red shows that.
- **Widening a tolerance in the runner.** It turns a contract into a suggestion and hides edge-of-tolerance defects.
- **Parallel steps on one connection reported as PASS.**
- **Replay vectors under the same clock.** They cannot falsify an id that embeds time.
- **Short numeric needles in leak checks.** A random UUID will contain them eventually.
- **Pushing vectors ahead of their runner or implementation** on a deploying branch.
- **Lanes testing only against local doubles.** The end-to-end path is then first exercised at merge; add one integration test through the real adapters.

## Evidence from origin project

Javi's Dog, Sprints 3d and 3e (2026-10-28). Confidence **high** for vectors + runner + mutation (two suites, each mutation failed exactly the expected vectors), **medium** for brief-defect discovery (one accepted case).

- HTTP ingest suite: 43 vectors from the ingest decision record including its *Changes* section, 20 ambiguities (`docs/jgr/conformance/http/README.md`, `9d50e82`); runner written by the orchestrator from the README rules (`packages/ingest/test/conformance.test.ts`, `3273725`): 45 tests (43 vectors + count + equivalence group) exit 0. Mutation: handler answering 400 instead of 415 → exactly vectors 32–34 FAIL (exit 1), restored (`docs/sprints/SPRINT-03d.md` Test evidence).
- Local OTLP receiver suite: 40 vectors / 46 steps from the receiver decision record, the OTLP specification and the vendor's telemetry docs; 20 ambiguities; the standard's website was blocked and the same text was read from its official proto repository (`docs/jgr/conformance/otlp/README.md`, `d5f85a9`). Runner `collectors/claude-code/test/otlp-conformance.test.ts` (`6504ef4`): 41 tests exit 0. Mutations: Host check disabled → exactly vector 09 FAIL; random event ids → exactly vectors 39 and 40 FAIL; restored (`docs/sprints/SPRINT-03e.md` Test evidence).
- Brief defect: ambiguity A3 (brief vs. OTLP unknown-field and empty-request rules) → parser fix `ecc2c2c` ("an object without `resourceMetrics` is an empty request"); recorded in the receiver decision record's *Changes* (`docs/adr/0011-local-otlp-usage-receiver.md`).
- Earlier attempt: a mutation check in S3a was blocked by the session's permission classifier and recorded as BLOCKED; the retro asked for permission up front (`docs/sprints/SPRINT-03a.md`). Mutation checks ran in S3d, S3e and S3f.
- Not verified: that vectors keep *several* implementations consistent (each suite has one implementation).

### Update at G3 (Sprints 4a–4c, 2026-10-28)

Three more suites, each for a new read model or write path, each with a runner written by someone other than the QA author and mutation checks that failed exactly the expected vectors (`docs/sprints/SPRINT-04a.md`, `SPRINT-04b.md`, `SPRINT-04c.md` Test evidence):

| Suite | Vectors / ambiguities | Runner | Mutations (each restored) |
|---|---|---|---|
| Thread state (`docs/jgr/conformance/state/`, `91c705e`) | 27 / 14 | orchestrator, `7e5f1e3`: first run 4 FAIL — runner bug, vectors correct; then 27/27 | exclusive 180 s boundary → only 01; workspace filters removed → only 17, 20, 21 |
| Usage analytics (`…/analytics/`, `58f3f54`) | 23 / 12 | orchestrator, `8f0b7e1`: 23/23 first run | bucket by producer time instead of receipt time → only 10; workspace filters removed → only 19, 20, 23 |
| Budgets and alerts (`…/budgets/`, `e8fbc48`) | 25 / 16 | fresh lane independent of the implementation, `3ef3bdb`: 25/25 | no `ON CONFLICT` in the claim → 9 vectors (10, 11, 13–19); stale window 0 → only 18 |

- Hidden defect: the budget runner's comparison added `8 × Number.EPSILON × max(…)` to the README tolerance (`3ef3bdb`). Its author flagged that vectors 09 and 11 passed only through that slack; the implementation rounded percent to one decimal (`fa20a50`), so 79.99 % became 80.0 %, |80.0 − 79.99| exceeding 0.01 by about 5 × 10⁻¹⁵. The reviewer reported "percent rounded up into false thresholds" as a major; fix `12fdd97` (exact, floored); runner made strict in `e968421` — 25/25 still pass (`SPRINT-04c.md` Team log and Retro: "conformance tolerances are never widened in runners").
- Parallel steps: the budgets README (l. 111) states that PGlite interleaves at statement level and that a serialising runner must report NOT RUN; the orchestrator added a real-Postgres check (5 parallel claims over separate connections → exactly 1 job) (ADR-0014 *Changes*).
- QA ambiguity registers kept surfacing gaps that later became review findings: state A7 ("attention on ended threads untested") matched the S4a reviewer's first major (ended threads counted as attention in the UI).
- Not verified: that vectors keep *several* implementations consistent (still one implementation per suite).

### Update at G4 (Sprints 5b and 5c, 2026-10-29)

Two more suites for two third-party CLI collectors, each with a runner by a lane that wrote neither the vectors nor the code (`docs/sprints/SPRINT-05b.md`, `SPRINT-05c.md` Team log and Test evidence):

| Suite | Vectors / spec-silent decisions | Runner before fixes | After fixes | Mutations |
|---|---|---|---|---|
| Gemini CLI (`docs/jgr/conformance/gemini/`, 20 hook + 33 usage) | 53 (40 first, 13 for the review rules) / 20 ambiguities | 22 pass, 32 fail — all mapped to open review rules R2, R5, R9 | 54/54 tests (as recorded for 53 vectors) | 32: 30 killed; 2 survivors "cannot happen under D's series identity"; vector U32 added to kill the shared-baseline mutation |
| Codex CLI (`docs/jgr/conformance/codex/`, 19 hook + 22 usage) | 41 / 26 (X1–X26); inputs validated against the official hook schemas | 39 pass, 2 fail (U01, U11) — a **new product defect**: a re-sent record was spooled with a new sequence, which the server shows as possible signal loss | 41/41 | 14/14 killed |

- The Codex defect was missed by the developers and by the code reviewer (retro: "The independent runner caught a defect that neither the developers nor the reviewer saw"); fixed by persisting accepted event ids and skipping duplicates before they get a sequence (`ffd1bdd`; ADR-0016 *Changes* "S5c review fixes").
- Independent money derivation: the implementation lane's 13-row price table and QA's prices derived from the page text agreed on the checked models before and after an introductory-price end date; the orchestrator found two fragments verbatim and exactly once in the page text (`SPRINT-05b.md` Team log).
- Push holds verified in CI history: no run exists for `3ad3f60`…`64f9f1a` — they went out with `0cff148`, after the runner was updated ("held back on purpose … the runner failed with `expected 53 to be 40`"); vector 21's update was held until the receiver lane merged ("before B it failed with `expected 404 to be 200`"); the Codex runner `4f4b42f` (red against pre-fix code) went out only with the fixes (`5574c55`).
- Doubles: "Developer B tested against local doubles while A was in progress, so the end-to-end path was only proven at merge" (S5c retro); the fix lanes added integration tests through the real adapters (`codex-integration.test.ts`).

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

Self-report suite (`docs/jgr/conformance/self-report/`): 54 vectors — 22 MCP protocol, 14 hook mapping across three hosts, 18 reader precedence — from ADR-0017 only (`1f40a78`, aligned `781c561`). Runners by two lanes that wrote neither vectors nor code (`a78066b`, `08a33bc`); vector files validated against the suite's schema with Ajv resolved through an existing dev dependency, no new package.

| Group | Runner layer | Result | Mutations |
|---|---|---|---|
| M (protocol) | server instance over in-memory streams | 22/22 | 51/54 caught across M and R; survivors → coverage gaps (client response object, `report_task` without arguments, ending a thread while waiting) and one record clarification |
| R (reader) | thread reader on PGlite | 18/18 | (as above) |
| H (hooks) | real hook processes from the hosts' config files, pinned clock | 14/14 | 20/20 |

- Spec gaps: "19 spec gaps; G8 was a design defect: an agent's `working` would have hidden a real permission prompt. All resolved in ADR-0017 (Changes 'QA spec gaps'). Developers A and B were told mid-lane" (`SPRINT-05d.md` Team log).
- Same-clock replay: H12 "a fresh HOME with the same salt and clock replays H11 calls … get the same `event_id` as in H11 (a re-run hook dedupes)"; README "Run H11 and H12 in the same run with the same salt and clock". The pre-fix unit test used `now: () => CLOCK` for both runs. Code review M1 found the duplicate; fix test advances the clock 50 ms (`d6c989b`). At this checkpoint no vector moves the clock (Guru finding SR-F5).
- Leak needle flake (Guru, from CI annotations): run 41080177974 on `08f7b2e` (a lockfile and registry commit) failed `packages/analytics/test/reader.test.ts:545` — `expected '{"generatedAt":…' not to contain '777'`; the received JSON contains `"projectId":"f609498d-25ce-4777-9101-…"`, tenant A's random UUID. The needle list there includes `'777'` and `'7.77'`. Not recorded in the sprint file (Guru finding SR-F2).
