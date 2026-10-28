---
name: diagnose-red-ci-from-history
description: Diagnose a red CI run from the branch's run history instead of re-running it — find the first red run of the same assertion, separate pre-existing and flaky failures from regressions (a red run on a docs-only commit cannot come from its diff), reproduce timing races deterministically by delaying the collaborator, fix the wait rather than the assertion, keep the delay in the test so the race stays covered, and report "green on <sha>" precisely. Also covers fail-fast local gates (a gate that keeps going after a failed step lets a red change be pushed) and CI concurrency cancellation that leaves a pushed commit never evaluated. Includes a fail-fast gate script with a self-test and a read-only CI-history script that flags likely flakes. Use when CI is red after your change, when inheriting a branch or baseline from another session or teammate, before declaring an iteration closed, when a test passes locally but fails in CI, when real-process, network or timer-based tests fail intermittently, or when tempted to "just re-run CI".
metadata:
  version: "0.1.0"
  origin: "javis-dog G2"
  confidence: "medium (history check and deterministic race reproduction: verified once each; unrecorded flakes found at G2)"
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

## 3. Make the local gate fail fast

A gate that runs every step regardless (`a; b; c`, or a loop that prints failures and continues) lets a later green step hide an earlier red one, and the push goes out. Chain steps so the first failure stops the gate and prints which step failed:

```bash
scripts/gate.sh "<format check>" "<lint>" "<typecheck>" "<tests>" "<build>" "<docs check>"
scripts/gate.sh --self-test   # proves the gate stops on a failing step
```

Run it after the **last** edit before pushing — including edits to iteration records and other docs, which docs linters check too.

## 4. Report green precisely

- "CI green on `<sha>` (run `<id>`)" — never "CI green" for a branch.
- Re-read the history at iteration close: a later docs-only commit going red is a flake signal about tests that are already merged.
- Record flakes in the iteration's test evidence with run ids, even when you do not fix them yet, and open a diagnosis item. Never quarantine, skip or loosen a test to make the history green.

## Pitfalls

- **Blind re-runs.** A green re-run of a race proves only that the race went the other way.
- **"Not my change, so not my problem."** Pre-existing red still blocks every later claim of green.
- **Fixing the assertion.** Loosening `status: 'ok'` to "any result" hides the bug the test exists for.
- **Removing the delay after fixing.** Then nothing exercises the ordering again.
- **Trusting a cancelled run's commit.** It was never tested.

## Evidence from origin project

Javi's Dog, Sprints 3c–3f (2026-10-23 → 2026-10-28), GitHub Actions. Confidence **medium**: one race reproduced and fixed with the method; the history rule came from one incident; at G2 the same blind spot recurred (below).

- Inherited red: CI failed on the owner's `fe604d1` (run 39875014031) in `collectors/claude-code/test/process.test.ts` ("detached flusher delivers", `lastFlush` null), passed on `5cc8ac0`, and failed with the same assertion on `98c7974` (run 40612408695) after reconciliation. Diagnosed, not re-run: pre-existing ordering race; reproduced with the fake receiver answering 500 ms late; fixed by waiting for the flusher's result with a permanent 200 ms late answer, product code unchanged (`1bb95e9`, run 40612946751 green; `docs/sprints/SPRINT-03d.md` Log and Test evidence). Retro: "check CI history of the baseline, not only the latest run."
- G2 finding (read with `gh` at G2, not recorded in the iteration files): `collectors/claude-code/test/usage-process.test.ts:120` failed on three docs-only commits — `474427c` (run 40617386527), `a632803` (run 40617962893) and `92a9244` (run 40619197881), whose message reads "CI green on a3e4ce8" — and passed on `a3e4ce8`, `11f2e93` and `f7390b7`: 3 failures in the 6 completed runs since the test was added (`37ac271`). The assertion expects the first receiver's pid and receives `0`. **Root cause not diagnosed** (hypothesis: the test's 1 500 ms idle timeout elapses while the second process starts on the runner). The lane reported 3 local passes (`SPRINT-03e.md`).
- Not evaluated: `d45cc4c`'s run (40619965768) was cancelled by the push of `f7390b7` 18 seconds later. Linting `d45cc4c`'s iteration file with the repository's rules at G2 reports MD022 and MD032 errors, fixed by `f7390b7`. The iteration record states the cause: "gate command did not stop on that step"; "gate steps are chained with `&&` since" (`docs/sprints/SPRINT-03f.md` Log and Deviations, `4c0577f`). The exact earlier command is not recorded.
- Script verification at G2: `gate.sh --self-test` → "self-test PASS", exit 0; `gate.sh true false "echo nope"` → stops at step 2, exit 1, step 3 not run. `ci-history.sh` on the origin branch flags `474427c`, `a632803`, `92a9244` as `FLAKE? (docs-only diff) failed: Run pnpm test`, `98c7974` as `CODE`, and `d45cc4c` as `NOT EVALUATED`.
