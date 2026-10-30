---
name: diagnose-red-ci-from-history
description: Diagnose a red CI run from the branch's run history instead of re-running it — find the first red run of the same assertion, separate pre-existing and flaky failures from regressions (a red run on a docs-only commit cannot come from its diff), reproduce timing races deterministically by delaying the collaborator, fix the wait rather than the assertion, keep the delay in the test so the race stays covered, and report "green on <sha>" precisely. Also covers fail-fast local gates (a gate that keeps going after a failed step lets a red change be pushed) and CI concurrency cancellation that leaves a pushed commit never evaluated. Includes a fail-fast gate script with a self-test and a read-only CI-history script that flags likely flakes. Use when CI is red after your change, when inheriting a branch or baseline from another session or teammate, before declaring an iteration closed, when a test passes locally but fails in CI, when real-process, network or timer-based tests fail intermittently, when a latency or timeout bound fails "by a few milliseconds", when tests time out only in full parallel runs, when a run fails with "unhandled rejection" although every test passed, when a negative `not.toContain` assertion fails once on an unrelated commit, when a latency bound fails again after it was "fixed", or when tempted to "just re-run CI".
metadata:
  version: "0.3.0"
  origin: "javis-dog G2; updated G3, G4, ad-hoc-self-report (S5d)"
  confidence: "medium (history check and deterministic race reproduction: verified once each; unrecorded reds found by the checkpoint, not the team: three windows (G2, G4, S5d); harness-overhead bound, oversubscription and unhandled-rejection diagnoses: once each, G4; random-needle flake: once, root cause read from the annotation)"
---

# Diagnose red CI from history

A red run tells you *that* something failed at one commit; the branch history tells you *since when* and *whether your change could have caused it*. Re-running until green throws that evidence away and teaches nothing. Reading only the latest run of a baseline misses failures that were already there.

The rule: **before touching code, read the history; before re-running, reproduce; before claiming green, name the run.**

## 1. Read the history, not the latest run

When you inherit a baseline (another session's line, a teammate's branch, a reconciliation) or see a red run, list the branch's runs with commit, conclusion, failing step and failing test:

```bash
scripts/ci-history.sh <branch> 30          # this skill's read-only helper (gh + git)
```

Then answer, with run ids:

- **When did this assertion first fail?** If an earlier commit already failed the same assertion, the failure is pre-existing; your change is not its cause (it may still be yours to fix).
- **Did it pass in between with no change to the code under test?** Then it is intermittent — a race, timer or environment dependency.
- **Did it fail on a commit that changed only docs?** Then it cannot come from that diff. The helper flags these as `FLAKE?`.
- **Was any pushed commit never evaluated?** With "cancel in-progress runs" concurrency, a quick follow-up push cancels the previous run; that commit has no CI result at all. The helper marks these `NOT EVALUATED`.

## 2. Reproduce before you fix

For timing failures in tests that use real processes, sockets or timers:

1. Write down the ordering the test assumes and the ordering the system guarantees. In the origin: the fake server recorded a batch *before* answering, and the client wrote its result file only *after* reading the answer — the test read the file as soon as the batch was recorded.
2. Make the race deterministic by delaying the collaborator (the fake server answers 500 ms late). The old test must now fail every time with the CI error.
3. Fix the **wait**, not the assertion: wait for the state you then assert (the result file exists), keep the assertion unchanged.
4. Keep a smaller delay in the test permanently, so the race stays exercised.
5. Run the fixed test several times, then the full gate; record the reproduction and the runs.

No product code changes unless the reproduction shows a product bug.

Typical intermittent shapes in process tests:

- Asserting on a side effect another process writes after an event you waited for.
- Short idle or exit timers in the code under test that can elapse while a slow CI runner starts the next process.
- Shared state left by another run (caches, temp directories, ports).

### Bounds that measure the harness

A latency bound (`expect(ms).toBeLessThanOrEqual(1500)`) that fails by a few milliseconds is tempting to raise. First compare, **in the same run**, the path under test with any test-only scaffolding around it (stub loaders, `--import` hooks, mock servers). In the origin, the stubbed path took 784–1 522 ms while the real path took 425–540 ms in the same CI run: the bound measured the harness. Remove the scaffolding, keep the bound, and note when an earlier green was "green only by margin".

### Timeouts that grow with parallel load

A test that takes 4 s alone and times out at 30 s in a full run is usually starved, not slow. Measure it alone and in the full run at the default concurrency; count the worker processes (each test runner process with its own WASM or browser workers) against the CPU cores. Cap the orchestrator's concurrency (for example `turbo run test --concurrency=2`) and record wall time before and after. Do not raise the timeout or skip the test.

### "All tests passed" but the run failed

Test runners report unhandled promise rejections after the tests and fail the run. That is usually a **product** bug (an eager promise left floating that fails first), not test noise: find the creator of the promise, mark it handled where it is created, keep awaiting it where it matters, red-first (count rejections before and after), then search for the same pattern.

### A bound that fails again after its fix

When a latency bound that was "fixed" (harness removed, bound kept) fails again on an unrelated commit, the earlier diagnosis explained only part of the variance. Do not raise the bound on one sample: collect the measured values the test already prints (`console.info` of the durations) from every CI run since the fix, look at the distribution, then decide between a bound with a stated percentile, a test on a quieter layer, or a product change. Record the decision with the numbers.

### Negative assertions with short needles

`expect(output).not.toContain('777')` fails whenever a random id, timestamp or generated value happens to contain the needle. Read the received value in the annotation: if the needle sits inside a UUID or a time, the test is flaky by construction. Replace the needle with a sentinel that your id and number formats cannot produce, or assert on parsed fields.

### Twins and "no others"

After fixing a pattern, search for it across the workspace and **read the output before writing "no others"**. In the origin the first log entry said there were none; the same search had listed a second instance, fixed in the next commit and the entry corrected.

## 3. Make the local gate fail fast

A gate that runs every step regardless (`a; b; c`, or a loop that prints failures and continues) lets a later green step hide an earlier red one, and the push goes out. Chain steps so the first failure stops the gate and prints which step failed:

```bash
scripts/gate.sh "<format check>" "<lint>" "<typecheck>" "<tests>" "<build>" "<docs check>"
scripts/gate.sh --self-test   # proves the gate stops on a failing step
```

Run it after the **last** edit before pushing — including edits to iteration records and other docs, which docs linters check too.

The same applies to **any scripted edit-then-commit sequence** (a script that updates memory files, then commits and pushes): run it under `set -e` or chain with `&&`, so a failed edit stops the commit instead of committing half the update.

**Pin the environment your tests read.** A test that passes in CI and fails locally (or the reverse) because an ambient variable is set in one place only (a database URL, a token) is an environment leak, not a flake: pin the variable in the test.

## 4. Report green precisely

- "CI green on `<sha>` (run `<id>`)" — never "CI green" for a branch.
- Write the claim only after the run has **completed**, and put the run id into the iteration record that closes on it — a memory file that says "green on `<sha>`" without the id makes the next checkpoint re-derive it.
- Re-read the history at iteration close: a later docs-only commit going red is a flake signal about tests that are already merged.
- Record flakes in the iteration's test evidence with run ids, even when you do not fix them yet, and open a diagnosis item. Never quarantine, skip or loosen a test to make the history green.
- **A local flake that "passed on re-run" is still a flake:** record the test name, the count (1 of 500) and the seed or log, and open a diagnosis item.
- **Check the last pushed tip's run before the next push.** A red result discovered after two more pushes is harder to attribute and leaves the record claiming "built" over a red branch. A rule in a skill was not enough in the origin (below); put it in the team's merge checklist or in the push script, and list every pushed tip's run in the iteration record.

## Pitfalls

- **Blind re-runs.** A green re-run of a race proves only that the race went the other way.
- **"Not my change, so not my problem."** Pre-existing red still blocks every later claim of green.
- **Fixing the assertion.** Loosening `status: 'ok'` to "any result" hides the bug the test exists for.
- **Removing the delay after fixing.** Then nothing exercises the ordering again.
- **Trusting a cancelled run's commit.** It was never tested.
- **Raising a latency bound or a timeout.** Measure the harness and the load first.
- **`;` in a push command.** `gate; git push` pushes after a failed gate; use `&&`.

## Evidence from origin project

Javi's Dog, Sprints 3c–3f (2026-10-23 → 2026-10-28), GitHub Actions. Confidence **medium**: one race reproduced and fixed with the method; the history rule came from one incident; at G2 the same blind spot recurred (below).

- Inherited red: CI failed on the owner's `fe604d1` (run 39875014031) in `collectors/claude-code/test/process.test.ts` ("detached flusher delivers", `lastFlush` null), passed on `5cc8ac0`, and failed with the same assertion on `98c7974` (run 40612408695) after reconciliation. Diagnosed, not re-run: pre-existing ordering race; reproduced with the fake receiver answering 500 ms late; fixed by waiting for the flusher's result with a permanent 200 ms late answer, product code unchanged (`1bb95e9`, run 40612946751 green; `docs/sprints/SPRINT-03d.md` Log and Test evidence). Retro: "check CI history of the baseline, not only the latest run."
- G2 finding (read with `gh` at G2, not recorded in the iteration files): `collectors/claude-code/test/usage-process.test.ts:120` failed on three docs-only commits — `474427c` (run 40617386527), `a632803` (run 40617962893) and `92a9244` (run 40619197881), whose message reads "CI green on a3e4ce8" — and passed on `a3e4ce8`, `11f2e93` and `f7390b7`: 3 failures in the 6 completed runs since the test was added (`37ac271`). The assertion expects the first receiver's pid and receives `0`. **Root cause not diagnosed** (hypothesis: the test's 1 500 ms idle timeout elapses while the second process starts on the runner). The lane reported 3 local passes (`SPRINT-03e.md`).
- Not evaluated: `d45cc4c`'s run (40619965768) was cancelled by the push of `f7390b7` 18 seconds later. Linting `d45cc4c`'s iteration file with the repository's rules at G2 reports MD022 and MD032 errors, fixed by `f7390b7`. The iteration record states the cause: "gate command did not stop on that step"; "gate steps are chained with `&&` since" (`docs/sprints/SPRINT-03f.md` Log and Deviations, `4c0577f`). The exact earlier command is not recorded.
- Script verification at G2: `gate.sh --self-test` → "self-test PASS", exit 0; `gate.sh true false "echo nope"` → stops at step 2, exit 1, step 3 not run. `ci-history.sh` on the origin branch flags `474427c`, `a632803`, `92a9244` as `FLAKE? (docs-only diff) failed: Run pnpm test`, `98c7974` as `CODE`, and `d45cc4c` as `NOT EVALUATED`.

### Update at G3 (Sprints 4a–4c, 2026-10-28)

- History read by Guru (`gh run list`): 12 pushed tips in the window, all completed `success`: `a8e586c` 40643312553, `15cc528` 40643889052, `6377e88` 40647195467, `6ed8beb` 40647484633, `0a02c57` 40648378728, `cd23c29` 40649033508, `1993bd8` 40652083951, `ed7c7cf` 40652522728, `025e35d` 40680524099, `fd61ca5` 40681669775, `e968421` 40684915546, `e564df8` 40685564553 (in progress when the G3 read started; re-read to completion). No cancelled run, no red run, no docs-only red in the window — the G2 changes (race fix, no cancellation of branch runs) held for 12 pushes.
- Every "CI green on `<sha>`" in the memory files was written after its run completed (commit times vs. run completion). The sprint files record run ids only for the early pushes of each iteration, not for the closing push.
- Non-chained script: "a memory-update script failed mid-way and the commit chain continued (script not chained) — memory completed in the next commit" (`docs/memory/SESSION_LOG.md`, S4a entry; follow-up `6ed8beb`). It was pushed; CI passed because the half-update was valid markdown.
- Environment leak: an async page made a shell test depend on `DATABASE_URL`, which was set only in the session; the test now pins it empty (`68c68f4`, `SPRINT-04a.md` Team log).

### Update at G4 (Sprints 5a–5c, 2026-10-28/29)

History read by Guru (`gh run list`, check-run annotations): 27 pushed tips from `4daa69c` to `76b3a42`: 23 `success`, 2 `failure`, 0 cancelled, and 2 (`f8f5aa3`, `76b3a42`) still running when the G4 read started; re-read at the end of G4: both `success` (runs 40975320265, 40976001842). So 25 of 27 green, 2 red, both diagnosed.

- `d4f2710` (docs-only tip; run 40867278461): annotation `gemini-hook-process.test.ts:145 expected 1522 to be less than or equal to 1500`. Diagnosis in the record: the stub-loader path took 784–1 522 ms, the real path 425–540 ms in the same run; `0cff148` was "green only by margin" (run 40876190084). Fix `354bc05`: stub run removed, checks on the real adapters, bound unchanged (`docs/sprints/SPRINT-05b.md` Log).
- `354bc05` (run 40878049774): all 440 collector tests passed; vitest reported one unhandled rejection (`ENOENT mkdir`) → product bug in `createState()`, fixed red-first (`d3ebf6d`, run 40879764043 green); twin in the SDK spool (`ce3f3f7`, run 40880475250 green). The log's first "no other eager fs promise exists (grep)" was corrected in `ce3f3f7`. The annotation API shows only the exit code for this run; the rejection text is from the iteration record.
- Oversubscription (local, S5a): `jgr-sdk` e2e test timed out at 30 s in two forced full runs; 4.1 s alone; ~13 vitest processes with PGlite WASM workers on 4 cores; fix `--concurrency=2`: wall 126 s → 139 s, that test 24.7 s → 3.3 s; no timeout raised (`SPRINT-05a.md` Team log; root `package.json`).
- Timing gap (G4 finding): run 40867278461 completed red at 11:45 UTC; the next two pushes (`0cff148` 12:47, `bd11886` 12:48) went out and the memory commit called S5b "built" before the red was recorded (`354bc05`, 12:56). Whether it was known earlier is not recorded.
- Ungated push: "the `8baec90` push command ran `git push` after a `;`, so it was not gated"; gate re-run afterwards passed; CI on `8baec90` green (run 40859738459) (`SPRINT-05b.md` Team log).
- Local flake: "a baseline flake (1 of 500, unidentified, passed on re-run) was noted and is being watched" (`SPRINT-05c.md` Team log, Developer E) — no test name recorded (G4 finding).

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

History read by Guru (`gh run list`, run attempts, check-run annotations) for `23f0394..1ec4ca4`: 14 pushed tips, 12 `success`, 2 `failure`, 0 cancelled; the last two were running when the read started and were re-read to completion (`66c2250` 41086178358, `1ec4ca4` 41086336891, both `success`). **CI is green on `1ec4ca4` (run 41086336891).** Other pushed tips and runs: `1737210` 40978670362 · `8ee07d1` 40987295188 · `2d4dcc2` 41069381721 · `c25cf2d` 41072581103 · `1595b4e` 41073502748 · `d9b51eb` 41075775993 · **`6fa2f03` 41076014566 FAIL** · `d889b01` 41079240444 · **`08f7b2e` 41080177974 FAIL** · `67d8c01` 41080435860 · `d0eb360` 41082021287 · `50f5059` 41084532779.

- Neither red is mentioned in `SPRINT-05d.md`, `SESSION_LOG.md` or `PROJECT_MEMORY.md`; both have `run_attempt` 1 (no re-run). The red on `6fa2f03` completed at 15:05:58 UTC and `d889b01` was pushed at 15:16; the red on `08f7b2e` completed at 15:25:14 and `d0eb360` was pushed at 15:34 — so pushes continued after each red without a record. Same pattern as G4-F2; the G4 proposal to add "check the previous tip's CI before the next push" to the team file is still open.
- `6fa2f03` changed only `docs/sprints/SPRINT-05d.md`: `gemini-hook-process.test.ts:112 expected 1695 to be less than or equal to 1500` — the real-adapter bound kept by the G4 fix (`354bc05`), failing by 195 ms. Undiagnosed (Guru finding SR-F3). Hypothesis only: runner variance.
- `08f7b2e` changed only `pnpm-lock.yaml` (+3 lines) and `REGISTRY.md`: `packages/analytics/test/reader.test.ts:545` `not to contain '777'`; the annotation's received JSON contains `"projectId":"f609498d-25ce-4777-…"` (a random UUID). Root cause verified from the annotation: the needle list includes `'777'` (Guru finding SR-F2).
- Both later tips were green without a change to the failing tests, which is consistent with flakes and is not a diagnosis.
