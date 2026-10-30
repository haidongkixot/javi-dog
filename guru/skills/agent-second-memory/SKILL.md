---
name: agent-second-memory
description: Bootstrap and maintain a repository's "second memory" so coding agents (and humans) can resume work across sessions without re-deriving context — project memory, append-only session log, sprint records with a team log, ADRs, a readiness matrix, a generated module registry, CI checks for markdown lint, broken links, stale generated docs, doc drift and stale memory (dates, unclosed iterations, empty retros), and short timeboxed iterations that are split and rolled over truthfully. Use when starting a new repository or project with AI agents, when agents keep losing context between sessions, when asked to set up docs-as-code, ADRs, handoff notes, a project log or "memory", when docs drift from code, when an owner sets a short timebox per sprint or iteration, or before a long multi-session build.
metadata:
  version: "0.3.3"
  origin: "javis-dog G0; updated G1, G2-prep, G2, G3, G4, ad-hoc-self-report"
  confidence: medium
---

# Agent second memory

Coding agents start every session with no recollection of the last one, and sessions end abruptly (context limits, worker restarts). Chat history is not a record. A repository that will be built over many sessions needs its own memory: a small set of files that say what is true now, what happened, what was decided and what is blocked — plus checks that stop those files from rotting.

The rule of thumb: **anything the next session needs must be in a committed file, and anything generated must be checkable.**

## The file set

Create these at the start, before the first feature. Templates: [`templates/memory-files.md`](templates/memory-files.md).

| File | Write mode | Purpose |
|---|---|---|
| Agent instructions (`CLAUDE.md`, `AGENTS.md` or equivalent) | Edited rarely, owner-reviewed | Rules, precedence, commands, the mandatory session-start reading list |
| `docs/memory/PROJECT_MEMORY.md` | Overwritten each session | Current state, decisions in force, open blockers, next actions. Short. |
| `docs/memory/SESSION_LOG.md` | Append-only, newest first | What each session did, the state it left, the next step |
| `docs/sprints/SPRINT-NN.md` (+ a template) | One per iteration | Goal, backlog with acceptance criteria, log with SHAs, test evidence, retro; with agent teams also a roster and a newest-first team log (who did what, merges, fetch results, corrections) |
| `docs/adr/NNNN-*.md` | One per decision, MADR format | Context, options, decision, consequences; deviations from plans |
| Readiness matrix | Updated when resources change | Every external resource with status and evidence; blockers with options |
| Generated registry (modules, services, packages) | Generated, never hand-edited | Inventory with stable IDs, derived from per-module manifests |

Why two memory files: the project memory answers "what is true now?" and must stay small enough to read every time; the session log answers "how did we get here?" and may grow. Mixing them makes the first one too long to read and the second one lossy.

## Workflow

### 1. Write the session contract into the agent instructions

State explicitly, near the top of the agent instructions file:

1. At session start, **fetch the remote first** (`git fetch`, then compare your branch with its upstream), then read the project memory, the current sprint file, the latest session-log entries and the readiness blockers. Memory read from a stale checkout describes someone else's past.
2. Before ending, update the project memory, append to the session log, fetch again, commit and push.

Agents follow what is written in their instruction file; an unwritten convention is not followed reliably.

### 2. Record facts with evidence, label hypotheses

Every claim in memory files should cite a commit SHA, a file, a command result or an owner decision. Targets nobody has measured yet (latency budgets, payload sizes) are written as **hypotheses** until a test records them. Use a fixed status vocabulary for resources — AVAILABLE (with evidence) / MISSING / UNKNOWN / BLOCKED / NOT NEEDED — and never let UNKNOWN pass for AVAILABLE. Record names of credentials and env vars, never values.

### 3. Give modules stable IDs and generate the registry

If the system has modules, give each a manifest (`id`, `name`, `version`, `status`, `provides`, `consumes`) and generate the registry document from the manifests plus a "planned" list. Reserve IDs up front so commits and docs can reference modules before their code exists. The generator should validate: required keys, ID format, allowed statuses, duplicate IDs, and `consumes` entries that point to unknown modules. Give it a `--check` mode that fails when the committed registry differs from a fresh render.

When writing a decision record or a lane brief, **copy module IDs from the manifests** (search them by path), not from memory: a wrong ID in a decision record travels into vectors, commit scopes and lane paths.

### 4. Add the doc checks to CI

Run all of these in one `docs:check` command, locally and in CI:

- **Markdown lint** (e.g. markdownlint) with a committed config. Exclude vendored and archived files you do not own.
- **Offline relative-link check** — every relative link in tracked Markdown resolves to a file. Fast and deterministic; external URLs are a separate, optional check. Template: [`templates/check-links.mjs`](templates/check-links.mjs).
- **Generated-file staleness** — every generator's `--check` mode (registry, design tokens, API schemas…).
- **Doc drift** — if a module's source changed relative to the base branch, the same change set must touch that module's README/changelog, a changeset entry or the docs folder. Template: [`templates/doc-drift.mjs`](templates/doc-drift.mjs). It needs a base ref and full git history in CI.

Before trusting a new guard, prove it can fail: run it once against a deliberately bad change (in a throwaway worktree or branch) and record the expected non-zero exit. A guard that has never failed may be checking nothing.

When a guard has no input yet (for example doc drift before the default branch exists), have it print SKIPPED and report it as SKIPPED — not PASS.

### 5. Keep docs in the same commit as the code they describe

When implementation contradicts a doc written earlier (a library swapped, a value adjusted), fix the doc in the same commit. Reviewers then see the code and its explanation together, and the drift guard has nothing to catch.

### 6. Commit and push after every coherent unit of work

Sessions can end without warning. Small pushed commits with conventional, ID-scoped messages (`feat(<module-id>): …`, `docs(adr): …`) mean the next session loses at most one step, and the session log can cite exact SHAs.

### 7. When a check fails, fix the cause

If the link check fails because a referenced file does not exist yet, create the file (even as a skeleton) or remove the link; do not add an ignore rule or weaken the check to go green. Record notable caught failures in the sprint's test evidence — they are the evidence that the checks earn their keep.

### 8. Timebox iterations and split them truthfully

When the owner sets a short timebox per iteration (the origin used at most 30 minutes of agent work per sprint), write the rule into the roadmap and apply it mechanically:

- A planned iteration too large for one timebox is split into lettered parts (S1 → S1a + S1b), each with its own record, goal and acceptance criteria. Split along a dependency seam (the origin split UI shell from protocol research and spec), not by percentage.
- Record actual start and end times in each record's header, so iteration length is evidence rather than a feeling.
- Items blocked on someone else roll over **with their status** (BLOCKED, with the reason and the owner action), not silently.
- Close each part with its own test evidence and retro; the retro's "change next" line feeds the next part's plan.

### 9. Update every section of the memory, not just the top

At session or iteration end, walk the whole project-memory file: header, current state, decisions, **open questions** and **next actions**. Remove questions the owner has answered and replace finished next actions. A memory whose "current state" is fresh but whose "next actions" are two iterations old sends the next session to work that is already done.

Walk the readiness matrix the same way: its header date, every row whose "recommended action" has happened, and every AVAILABLE whose evidence is only "the tool exists". When a runtime observation contradicts a row (a log tool that returns nothing, a deployment target that differs from the plan), change the row in the same commit as the observation.

### 10. Automate what the rule did not hold

If the same drift recurs after it was written down as a rule, stop relying on the rule. Add a check: [`templates/memory-staleness.mjs`](templates/memory-staleness.mjs) (dependency-free, read-only, `--self-test`) flags a memory or readiness file whose "Last updated" date is older than the newest session-log entry, and iteration records older than the newest *K* that are still not closed or have an empty Retro. Start it with `--warn-only` in `docs:check`; make it blocking once the backlog of findings is cleared. An iteration legitimately waiting on someone else should say so in its status and still get a retro for the part that is done — or close and move the waiting item into a readiness row.

## Pitfalls

- **Partial memory update.** Appending the latest result to "current state" and leaving open questions and next actions untouched. Review those sections explicitly (step 9) and automate the dated parts (step 10).
- **AVAILABLE because a tool exists.** A capability listed as available because an integration offers it ("runtime logs") is UNKNOWN until a call returns real data.
- **Memory file as diary.** If the project memory grows past a screen or two, move history to the session log.
- **Hand-edited generated docs.** Mark them "GENERATED — do not edit" and let `--check` catch edits.
- **Linting vendored docs.** Third-party files will fail your style rules; exclude them rather than reformatting them (which breaks upstream diffs).
- **Unverifiable claims.** "Tests pass" without the command, exit code and counts is not evidence.
- **Inserting into an empty list section.** Appending the first entry under an empty `## Log` heading without blank lines before the next heading fails markdown lint (MD022/MD032). Start every list section with a placeholder line or a first dated entry when the record is created.
- **A claim that its own cited output contradicts.** "No other instance exists (grep)" while the grep listed one. Re-read the output you cite before writing the sentence; when you correct it, say "Correction:" in place rather than deleting the wrong line.
- **Pointers to records that do not exist.** "Recorded as a deviation" or "CI: checked in the next entry" needs the entry. Write the entry first, then the pointer.
- **A correct date over stale rows.** A same-day "Last updated" passes a date check while rows still say UNKNOWN for something measured that day; walk rows whose status contradicts the latest iteration's evidence.
- **Final numbers only in the memory file.** The post-review gate count and the closing CI run id belong in the iteration's test evidence; the memory file summarizes and points there.

## Evidence from origin project

Javi's Dog, Sprint 0 (2026-10-20), single cloud session. Confidence **medium**: the files and checks were set up and verified once; their benefit over many sessions is not yet observed (one session at G0).

- Session contract and docs rules: `CLAUDE.md` §0 and §5 (`d3ff6fa`).
- Memory, readiness, discovery, ADR-0001/0002 (`7a501a3`): `docs/memory/PROJECT_MEMORY.md`, `docs/agent-ops/READINESS_MATRIX.md` (status vocabulary; performance targets labelled hypotheses), `docs/adr/0001-modular-monolith.md`.
- Checks (`d011b8d`): `scripts/check-links.mjs`, `scripts/doc-drift.mjs`, `scripts/modules-registry.mjs` (`--check`), `.markdownlint-cli2.jsonc`, `.github/workflows/ci.yml` (`fetch-depth: 0`, `DOC_DRIFT_BASE`).
- Recorded results (`docs/sprints/SPRINT-00.md`, Test evidence): `pnpm docs:check` exit 0 — markdownlint 0 issues, 26 files link-checked, registry 17 modules, doc-drift SKIPPED (no `main` yet). Doc-drift negative probe in a throwaway worktree exited 1 as designed; positive case passed against `7a501a3`.
- Caught failure: the first `docs:check` after adding `guru/README.md` failed on two broken links; fixed by creating the files, not by weakening the check (`docs/sprints/SPRINT-00.md`).
- Same-commit doc fixes: `d011b8d` updated the brand guide and provenance when the font strategy changed (`next/font` → self-hosted npm package), and turned an emphasis-as-heading line (the pattern markdownlint rule MD036 rejects) into a real heading.
- Retro: the session worker restarted mid-sprint; pushing after each coherent step prevented loss (`docs/sprints/SPRINT-00.md`, Retro).

### Update at G1 (Sprints 1a and 1b, 2026-10-20)

- Timebox rule: owner decision recorded in `docs/explanation/roadmap.md` (`57890b3`) — sprints at most 30 minutes of agent work, oversized sprints split into S1a, S1b…, unfinished items rolled over and recorded truthfully.
- Applied once: `docs/sprints/SPRINT-01a.md` (18:51 → 19:00 UTC, about 9 minutes) and `docs/sprints/SPRINT-01b.md` (19:00 → 19:08 UTC, about 8 minutes), each with backlog, test evidence and retro; the S0 hosting item rolled over as **BLOCKED** with the owner action (`docs/sprints/SPRINT-00.md`, `57890b3`; `SPRINT-01a.md` Backlog 5). The S1a retro's "change next" (keep the spec small, vectors executable) was applied in S1b.
- Partial memory update (verified by reading `docs/memory/PROJECT_MEMORY.md` at `a789674`): "Current state" lists S1a and S1b as done, but "Next actions" still reads "Close S0 … S1: build …", and "Open questions" still asks the owner to confirm D1, which the owner accepted in `57890b3` (`docs/agent-ops/READINESS_MATRIX.md`, D1 row).
- G0 hypotheses still open: no cross-session handoff has happened yet (S0, S1a and S1b ran in one session; `SESSION_LOG.md` has one entry); doc drift is still SKIPPED because no `main` branch exists (`SPRINT-01a.md` Test evidence).
- Hypothesis: that a 30-minute timebox improves quality or throughput. Two short iterations closed with green checks (GitHub Actions CI succeeded on all four window commits); there is no comparison with longer iterations.

### Update at G2-prep (Sprints 2a–2c, 2026-10-22)

- Partial memory update **recurred** (now observed at two checkpoints, so the pitfall is verified repeatedly). At `2d6b87d`, `docs/memory/PROJECT_MEMORY.md` says "Last updated: 2026-10-20" although its content is from 2026-10-22; "Current state" still says S2b would include "project UI, welcome email" (moved to S2c); "Open questions" still lists the GitHub OAuth callback registration, which real production sign-ins resolved (`docs/agent-ops/READINESS_MATRIX.md`, GitHub SSO row). "Current state" has grown into a per-sprint diary.
- Readiness matrix drift: header "Last updated: 2026-10-20" while rows carry 2026-10-22 evidence; the Secrets row still recommends "prove with the first production sign-in (S2b)" after it happened; the Observability row says runtime logs are "AVAILABLE once deployed" because the platform integration has log tools, while the S2b retro records that those logs returned nothing for the failed sign-in (`docs/sprints/SPRINT-02b.md`, Retro).
- Cross-session handoff (open since G0): a second session continued the plan after Session 1, and a worker restart mid-S2a lost no work on disk (`docs/memory/SESSION_LOG.md`). The log does not record how the new session resumed or whether it had to re-derive anything, so the benefit is still a hypothesis.
- Timebox split applied a second time: S2 → S2a, S2b, S2c, each with its own record, evidence and retro; S2b split again when sign-in filled the box (`docs/sprints/SPRINT-02b.md`, Decisions).
- Possible check (proposal, untested): fail `docs:check` when the project-memory "Last updated" date is older than the newest session-log entry date.

### Update at G2 (Sprints 3a–3f, 2026-10-23 → 2026-10-28)

- Drift **recurred a third time** despite step 9 (verified by reading at G2, HEAD `37c6dce`): `docs/agent-ops/READINESS_MATRIX.md` header "Last updated: 2026-10-22" while its newest rows carry 2026-10-28 evidence; its "Readiness decision" still says S3 "can start" and needs a retention ADR (ADR-0008 accepted 2026-10-23); the "Retention purge schedule" row is still "MISSING (S3b) … Do in S3b" although the purge route shipped in S3b and only the owner's secret is pending. `docs/memory/PROJECT_MEMORY.md` header calls S3f "not started" although S3f was merged (`2e7d23b`), and "Current state" still carries the Sprint 0 line "No auth or ingest yet". `docs/sprints/SPRINT-03b.md` (IN PROGRESS) and `SPRINT-03c.md` (BUILT) have empty Retro sections although four later iterations exist.
- New template verified at G2: `memory-staleness.mjs --self-test` → "self-test PASS", exit 0; on the origin repository it reports 5 findings (the readiness date; S3b and S3c status and empty retros), exit 1. It does not catch content drift inside a correctly dated file (the PROJECT_MEMORY lines above); that still needs the step 9 walk.
- Team log section adopted in the iteration template (`3ed0ba0`) and used in S3d–S3f; it recorded fetch results, merges, mid-flight corrections and review outcomes that the G2 checkpoint relied on.
- Cross-session handoff (open since G0) now observed in both directions: the owner's desktop session and a cloud session alternated on one branch. The handoff **failed** once — the cloud session planned from a stale checkout and duplicated an iteration (see `orchestrated-agent-team-lanes`). Memory files cannot help a session that has not fetched them; "fetch, then read memory" belongs at the top of the session contract.

### Update at G3 (Sprints 4a–4c, 2026-10-28)

- Lint slip: "the empty-`## Log` blank-line slip recurred (third time)" (`docs/sprints/SPRINT-04a.md` Retro; caught before push — all S4 runs green). S4b and S4c records were created with a first dated Log entry ("Sprint start …"); no recurrence is recorded after that.
- Final numbers: the post-review full-gate counts (776, 888, 1105 tests) appear only in `docs/memory/PROJECT_MEMORY.md`; the sprint files' Test evidence stops at the pre-review gate (759, 865, 1037) and records run ids only for the early pushes (finding G3-F2).
- Staleness check re-run read-only at G3 (`memory-staleness.mjs --log SESSION_LOG.md --dated READINESS_MATRIX.md --dated PROJECT_MEMORY.md --iterations docs/sprints`): 6 findings — S3b and S3c still unclosed with empty retros (G2-F4 still open), S3e and S4a "BUILT" with newer iterations. The check is still not in the origin's `docs:check`. Content drift it cannot see: `PROJECT_MEMORY.md` "Current state" still carries the Sprint 0 line "No auth or ingest yet" (G2-F3, partly fixed); the readiness "Retention purge schedule" row still says "30 days" after the month-keeping change.

### Update at G4 (Sprints 5a–5c, 2026-10-28/29)

- Corrected claim, kept visible: the S5b log first said "No other eager fs promise exists in the workspace (grep)"; the same grep had found a second instance. The entry now reads "**Correction:** the same grep also found the identical pattern … The first version of this entry wrongly said there were no others" (`ce3f3f7`, `docs/sprints/SPRINT-05b.md` Log).
- Dangling pointers (G4 findings): `SPRINT-05c.md` retro says the exceeded timebox was "recorded as a deviation" — its Decisions and deviations section has no such entry; its Log ends "CI: checked in the next entry" with no next entry (Guru read run 40975219061: success); `SPRINT-05a.md` Log still says "CI run 40718637866: in progress" (it succeeded).
- Staleness check re-run read-only at G4: 7 findings (S3b, S3c, S3e, S4a–S4c, S5a "not closed" with newer iterations), exit 1; still not in the origin's `docs:check` (G2 proposal 5 open). `SPRINT-05a.md` is "ACTIVE" with an empty retro although all items but the owner-deferred cutover are done.
- Content drift a date check missed: `READINESS_MATRIX.md` is dated 2026-10-29 (same day as the newest log entry) but its header still says "(S5b …)", its "Readiness decision" still describes S5a in progress and S3, and the Performance row is UNKNOWN although the production load test recorded p95 1 529 ms that day. `PROJECT_MEMORY.md` next actions 1, 2 and 6 describe done work (load test "after cutover", `CRON_SECRET`, "Guru G3 then S5 planning"), and "No auth or ingest yet" is still there — the fourth checkpoint in a row.

### Update at ad-hoc-self-report (Sprint 5d, 2026-10-30)

- Wrong module IDs in a decision record: "The ADR named the wrong module IDs (JD-M12, JD-M13)"; corrected by the lane that owned the code (ADR-0017 *Changes* "Module labels corrected"); the first vector commit still says "JD-M12 reader" (`1f40a78`). Retro action: "Check module IDs against `module.json` when writing an ADR."
- Final counts again only in the memory files: the session log says "full gate: 2200 tests"; the sprint's Test evidence table ends at the 1 997-test run after T1, T2, T4 (G3-F2 pattern, Guru finding SR-F6).
- Two red CI runs in the window are in no memory file (see `diagnose-red-ci-from-history`, update S5d).
- The sprint record closes with "Guru checkpoint: —" — the pointer is filled after this checkpoint, not before.
