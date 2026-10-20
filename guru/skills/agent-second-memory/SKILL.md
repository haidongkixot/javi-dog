---
name: agent-second-memory
description: Bootstrap and maintain a repository's "second memory" so coding agents (and humans) can resume work across sessions without re-deriving context — project memory, append-only session log, sprint records, ADRs, a readiness matrix, a generated module registry, and CI checks for markdown lint, broken links, stale generated docs and doc drift. Use when starting a new repository or project with AI agents, when agents keep losing context between sessions, when asked to set up docs-as-code, ADRs, handoff notes, a project log or "memory", when docs drift from code, or before a long multi-session build.
metadata:
  version: "0.1.0"
  origin: "javis-dog G0"
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
| `docs/sprints/SPRINT-NN.md` (+ a template) | One per iteration | Goal, backlog with acceptance criteria, log with SHAs, test evidence, retro |
| `docs/adr/NNNN-*.md` | One per decision, MADR format | Context, options, decision, consequences; deviations from plans |
| Readiness matrix | Updated when resources change | Every external resource with status and evidence; blockers with options |
| Generated registry (modules, services, packages) | Generated, never hand-edited | Inventory with stable IDs, derived from per-module manifests |

Why two memory files: the project memory answers "what is true now?" and must stay small enough to read every time; the session log answers "how did we get here?" and may grow. Mixing them makes the first one too long to read and the second one lossy.

## Workflow

### 1. Write the session contract into the agent instructions

State explicitly, near the top of the agent instructions file:

1. At session start, read the project memory, the current sprint file, the latest session-log entries and the readiness blockers.
2. Before ending, update the project memory, append to the session log, commit and push.

Agents follow what is written in their instruction file; an unwritten convention is not followed reliably.

### 2. Record facts with evidence, label hypotheses

Every claim in memory files should cite a commit SHA, a file, a command result or an owner decision. Targets nobody has measured yet (latency budgets, payload sizes) are written as **hypotheses** until a test records them. Use a fixed status vocabulary for resources — AVAILABLE (with evidence) / MISSING / UNKNOWN / BLOCKED / NOT NEEDED — and never let UNKNOWN pass for AVAILABLE. Record names of credentials and env vars, never values.

### 3. Give modules stable IDs and generate the registry

If the system has modules, give each a manifest (`id`, `name`, `version`, `status`, `provides`, `consumes`) and generate the registry document from the manifests plus a "planned" list. Reserve IDs up front so commits and docs can reference modules before their code exists. The generator should validate: required keys, ID format, allowed statuses, duplicate IDs, and `consumes` entries that point to unknown modules. Give it a `--check` mode that fails when the committed registry differs from a fresh render.

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

## Pitfalls

- **Memory file as diary.** If the project memory grows past a screen or two, move history to the session log.
- **Hand-edited generated docs.** Mark them "GENERATED — do not edit" and let `--check` catch edits.
- **Linting vendored docs.** Third-party files will fail your style rules; exclude them rather than reformatting them (which breaks upstream diffs).
- **Unverifiable claims.** "Tests pass" without the command, exit code and counts is not evidence.

## Evidence from origin project

Javi's Dog, Sprint 0 (2026-10-20), single cloud session. Confidence **medium**: the files and checks were set up and verified once; their benefit over many sessions is not yet observed (one session at G0).

- Session contract and docs rules: `CLAUDE.md` §0 and §5 (`d3ff6fa`).
- Memory, readiness, discovery, ADR-0001/0002 (`7a501a3`): `docs/memory/PROJECT_MEMORY.md`, `docs/agent-ops/READINESS_MATRIX.md` (status vocabulary; performance targets labelled hypotheses), `docs/adr/0001-modular-monolith.md`.
- Checks (`d011b8d`): `scripts/check-links.mjs`, `scripts/doc-drift.mjs`, `scripts/modules-registry.mjs` (`--check`), `.markdownlint-cli2.jsonc`, `.github/workflows/ci.yml` (`fetch-depth: 0`, `DOC_DRIFT_BASE`).
- Recorded results (`docs/sprints/SPRINT-00.md`, Test evidence): `pnpm docs:check` exit 0 — markdownlint 0 issues, 26 files link-checked, registry 17 modules, doc-drift SKIPPED (no `main` yet). Doc-drift negative probe in a throwaway worktree exited 1 as designed; positive case passed against `7a501a3`.
- Caught failure: the first `docs:check` after adding `guru/README.md` failed on two broken links; fixed by creating the files, not by weakening the check (`docs/sprints/SPRINT-00.md`).
- Same-commit doc fixes: `d011b8d` updated the brand guide and provenance when the font strategy changed (`next/font` → self-hosted npm package), and turned an emphasis-as-heading line (the pattern markdownlint rule MD036 rejects) into a real heading.
- Retro: the session worker restarted mid-sprint; pushing after each coherent step prevented loss (`docs/sprints/SPRINT-00.md`, Retro).
