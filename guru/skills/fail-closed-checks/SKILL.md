---
name: fail-closed-checks
description: Make guard checks fail closed — every check that protects a push, a commit, an install or an edit of someone's file answers yes, no or unknown, and "unknown" (the tool errored, timed out, is missing, or got bad input) is treated like the unsafe answer unless the user explicitly overrides it. Covers three-valued exit codes that shell idioms collapse to two (grep 0/1/2 read by `if grep` or `! grep`; `git ls-files --error-unmatch` 0/1/128; `diff`/`cmp` 0/1/2; timeouts and missing binaries), validating the check's own inputs (pattern compiles, revision range resolves, argument present), chaining guards with `&&` and making the chain a script rather than a habit, self-tests that prove a check can say "cannot", choosing the failure direction deliberately when the guarded action is recording data rather than changing it, and searching for twins of a fail-open check. Includes a fail-closed secret-scan script with a self-test. Use when writing a pre-push or pre-commit secret scan, a "is this file tracked/ignored/committed" check, a guard before editing a user's config, a CI or release gate, any `check; act` or `check && act` shell line, a wrapper around grep/git/diff exit codes, or when a check "passed" on a machine where its tool is missing, or when asked to "add a safety check", "scan before push" or "refuse unless".
metadata:
  version: "0.1.0"
  origin: "javis-dog ad-hoc-self-report (S5d), drawing on G2–G4 records"
  confidence: "high (the failure class: seven recorded fail-open or ungated guard slips in four checkpoint windows, three of them after the team had recorded the rule against them); medium (the remedies: a tri-state git check fixed red-first once; the secret-scan script verified by its own self-test only, not yet in the origin's CI)"
---

# Fail-closed checks

A guard check exists to stop something: a push with a secret, an edit of a committed file, a release on a red build. It usually has three outcomes — safe, unsafe, and *could not tell* — but the shell and most wrappers have two. `if grep -q pattern` reads grep's "error" exit as "no match". A git error mapped to "not tracked" lets an edit through. `check; git push` pushes whatever the check said. In each case the guard is quiet exactly when it has stopped working, which is when nobody looks.

The rule: **every guard returns yes, no or unknown; unknown is refused like the unsafe answer, with a message that says the check could not run and an explicit override; the guard and the guarded action are chained so the action cannot run after a failure.**

## Forces

- **Convenience vs. correctness.** `if grep …` is one line; mapping three exit codes is five.
- **Availability vs. safety.** Refusing on "unknown" blocks users whose machine lacks the tool (no git) or whose repository is odd (another owner, a timeout). That cost is visible and fixable with a flag; a silent pass is neither.
- **Habit vs. mechanism.** A rule recorded after the first slip ("chain with `&&`") was broken three more times by the same team. A script that encodes the chain was the eventual fix.
- **Which failure is recoverable.** For a guard, refusing is recoverable. For a recorder (a dedupe marker in front of a data write), dropping data is not; there, "unknown" should let the data through as a possible duplicate.

## 1. Map every outcome explicitly

List the tool's exit codes and output shapes, and map each to yes / no / unknown before writing the condition:

| Tool | Outcomes | Common fail-open idiom |
|---|---|---|
| `grep -q` | 0 match · 1 no match · ≥ 2 error (bad pattern, unreadable file) | `if grep -q …; then fail; fi` — an error is "clean" |
| `git ls-files --error-unmatch <path>` | 0 tracked · 1 untracked · 128 not a repository, dubious ownership, other errors | "non-zero → untracked" |
| `git check-ignore -q <path>` | 0 ignored · 1 not ignored · 128 error | "non-zero → not ignored" |
| `diff`, `cmp` | 0 same · 1 different · 2 trouble | "non-zero → different" |
| Any subprocess | spawn error (binary missing), timeout, signal | `catch { return false }` |

For git, first ask whether you are inside a work tree (`git rev-parse --is-inside-work-tree`): "not a git repository" is a real **no** for a tracked-file question; every other error is **unknown**. Run the subprocess without a shell, with a timeout and a fixed locale (`LC_ALL=C`) if you parse its messages, and make the runner injectable so tests can simulate exit 128, a missing binary and a timeout.

## 2. Validate the check's own inputs

A check with bad inputs answers "no match" to everything:

- **Pattern:** run it once against empty input; a valid extended regex makes grep exit 1, a broken one exits 2.
- **Range or target:** produce the diff or file list as its own step and stop when that step fails (an unknown revision, a missing repository).
- **Arguments:** an empty or missing argument is an error, not "scan nothing". Print what was scanned ("clean (origin/main..HEAD, 412 changed lines)"), so an accidental empty range is visible.

## 3. Refuse on unknown, with a reason and an override

- The message names the reason in words: "could not check git (exit 128); pass `--allow-tracked-config` to continue". Names and paths only, never values.
- The override is explicit, per invocation, and documented next to the check.
- Changes behaviour for some users (no git installed → the flag is now needed). Write that into the change log and the help text.

## 4. Chain the guard, then make the chain a script

- `scan && gate && git push` — never `;`, never a loop that prints failures and continues.
- The origin recorded "gate steps are chained with `&&`" after a gate that did not stop, then had an ungated `;` push two sprints later, another one four sprints later, and in the same iteration a malformed scan command that failed open. A checked-in script (`scripts/push.sh` calling the gate and the scan) removes the per-push typing that the habit depended on.
- Put the scan inside your fail-fast gate as one step (see `diagnose-red-ci-from-history`, `scripts/gate.sh`).

Script: [`scripts/secret-scan.sh`](scripts/secret-scan.sh) — exit 0 clean, 1 match (file names only, never the matched text), 2 could not scan; patterns from `SECRET_SCAN_PATTERNS`.

```bash
SECRET_SCAN_PATTERNS='<your token prefixes>|<connection-string shapes>' \
  scripts/secret-scan.sh "origin/<branch>..HEAD" && scripts/gate.sh "<steps…>" && git push
scripts/secret-scan.sh --self-test   # clean, match, unknown revision, missing/empty argument, bad pattern, no repository
```

## 5. Prove the check can say "cannot"

A self-test or unit test per guard with at least: a known-safe input (passes), a known-unsafe input (fails), and a broken environment (bad pattern, missing tool, error exit, timeout) that must fail. Run the self-test in CI so a later edit of the pattern or wrapper cannot silently turn the guard off. Build test secrets at run time so the test file itself never matches a scanner.

## 6. Choose the direction when the guarded action records data

"Fail closed" means *fail toward the recoverable outcome*:

- Guard before a push, an edit of a user's file, a release → refuse.
- A dedupe marker in front of recording a user's event → if the marker cannot be read or written, **record** (a duplicate is recoverable downstream; a lost event is not). Write that choice as a comment at the line.
- A check that only drives a **warning** may fail open, if the code says so; log it as a known gap and give it a follow-up rather than leaving the pattern to be copied into a refusing path.

## 7. Search for the twin

After fixing one fail-open mapping, search for the same helper or idiom elsewhere (`catch { return false }`, `status !== 0 →`, `if grep -q`). In the origin the fixed git check had a twin in a sibling installer that only drove a warning; it was logged as a follow-up.

## Pitfalls

- **`if grep -q …; then MATCH; fi` as a scanner.** A broken pattern, an unreadable input or a pipe error reads as clean.
- **`set -o pipefail` with `grep -q` at the end of a pipe.** An early match can make the writer exit with SIGPIPE; the pipeline is then non-zero for the wrong reason. Feed grep from a here-string or a file.
- **"Non-zero means no."** Only the documented "no" code means no.
- **A guard that is a habit.** The next tired push skips it.
- **Silent success.** "Revert done" when the file could not be read; "clean" when nothing was scanned.
- **Failing closed on a recorder.** A dedupe store that drops events when it is corrupt loses data the user cannot get back.

## Evidence from origin project

Javi's Dog, a privacy-aware observability product built by an orchestrated agent team, Sprints 3–5d (2026-10-23 → 2026-10-30). Confidence **high** that guard checks fail open in practice (seven recorded instances in four checkpoint windows, three of them after the rule was recorded); **medium** for the remedies.

Recorded slips:

- S3e: revert reported success on an unreadable settings file (review major, fixed red-first, `95a4b5a`).
- S3f: a gate "did not stop on that step"; a docs-lint error was pushed (`d45cc4c`); the record then says "gate steps are chained with `&&` since" (`SPRINT-03f.md` Log and Deviations, `4c0577f`; G2 lesson).
- S4a: a memory-update script failed mid-way and the commit chain continued (`SESSION_LOG.md` S4a entry; G3).
- S5b: a push ran `git push` after a `;` (`8baec90`; `SPRINT-05b.md` Team log); rule "chain with `&&`" recorded.
- S5d: "the gated push of `d9b51eb` chained the secret scan with `;` instead of `&&`. The scan was clean (exit 1)" — note the grep convention, 1 = clean (`SPRINT-05d.md` Team log).
- S5d: "one scan command was malformed and failed open"; "both pushes were clean when re-scanned. Fixed with a fail-closed scan script" (`SESSION_LOG.md` 2026-10-30; `SPRINT-05d.md` Retro). The exact malformed command is **not recorded**.
- S5d code review M3: "`gitTracked` mapped every git failure (exit 128 for dubious ownership, git missing) to 'untracked', which bypassed the git-tracked refusal." Fix `567422e`: `rev-parse --is-inside-work-tree`, then `ls-files --error-unmatch`, `spawnSync` without a shell, 5 s timeout, `LC_ALL=C`, injectable runner; tracked / untracked / unknown; unknown refuses unless `--allow-tracked-config`; red-first (ADR-0017 *Changes* "Code review"). Twin logged as follow-up F3: the sibling installer's tracked check "has the same fail-open pattern but only drives a warning".

Direction choice in the same iteration: the seen-call dedupe marker (`d6c989b`) records the event when the marker file cannot be read or written — code comment "a marker that cannot be read or written never costs the report (a duplicate is better)".

Guru verification at this checkpoint:

- The orchestrator's replacement scan script lives in the session's scratch directory, **not in the repository**. Its condition `if printf … | grep -qE '<patterns>'; then … exit 1; fi` still maps grep exit 2 to "clean": Guru's probe with an unbalanced `(` printed `grep: Unmatched (` and then took the "clean" branch. Its fixed pattern compiles, so it was not wrong in use.
- This skill's `scripts/secret-scan.sh`: `--self-test` → 8 checks ok, "self-test PASS", exit 0; scan of the S5d window `23f0394..1ec4ca4` with the defaults and with the project's own token patterns → "clean … 27919 changed lines scanned", exit 0. Not yet adopted in the origin's gate.
- Not verified: that a checked-in push script prevents further slips (not yet tried).
