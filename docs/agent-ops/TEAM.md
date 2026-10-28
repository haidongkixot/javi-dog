# Agent team — roles, rules and merge checklist

> Adopted 2026-10-27 (owner decision, S3 planning); ported onto the owner's S3 line on 2026-10-28 (reconciliation option A). Maps the Orcasus contract roles (`ORCASUS_AGENT_OPERATING_CONTRACT.md` "Role expectations") onto Claude Code agents. Every sprint file has a `## Team` section (roster + Team log).

## Roster

| Role | Agent | Responsibilities and limits |
|---|---|---|
| Orchestrator + Team Secretary | Main session | Discovery delta, readiness rows, `/efficient-testing` test plan before implementation. Writes every delegated prompt with: discovery facts, test-plan rows, allowed paths, "do not push, do not edit shared files, do not touch migrations", evidence format. **Sole owner** of shared files (`docs/modules/planned.json`, `docs/modules/REGISTRY.md`, `apps/web/next.config.ts`, `apps/web/package.json`, `pnpm-lock.yaml`, memory files, sprint files), database migrations on Neon, pushes (each push to the working branch is a **production deploy**), smoke runs, and the Team log. |
| Architect | `Plan` subagent (read-only) | Drafts ADR text and interface signatures; the orchestrator writes the ADR. Never finalizes a design that rests on an UNKNOWN readiness item. |
| Researcher | `general-purpose` subagent | Primary sources only; marks anything unverified. The orchestrator spot-checks at least two facts by direct fetch and logs which. |
| Developer | `general-purpose` subagent with `isolation: worktree` | Implements one declared slice; lowest reliable test layer first; never substitutes a mock for a production capability; returns needed shared-file edits as a list instead of making them; never pushes. |
| QA | `general-purpose` subagent with `isolation: worktree` | Writes conformance vectors and test cases from spec/ADR text only — not from the implementation (independent oracle). States why any higher-cost test is needed. Screenshot budget 0 unless approved. |
| Reviewer | `general-purpose` subagent, read-only, adversarial brief (`code-review`, `security-review` skills for public endpoints) | Verifies the readiness matrix and test evidence, not only the diff. Findings are fixed or logged as deviations before merge. |
| Guru | `javi-guru` | Checkpoints per `CLAUDE.md` §7; proposals only, never opens PRs. |

## Rules

- **One pushing session per branch** (owner decision 2026-10-28: this cloud session). Every push to `claude/clever-goldberg-wlurty` is a production deploy; other sessions work on separate branches. The orchestrator runs `git fetch` before planning and before every push (lesson from the 2026-10-27 parallel S3a).

- Parallel lanes only when their paths do not overlap; only one lane per wave may add a migration.
- Lanes work in isolated worktrees and never push; the orchestrator merges.
- Every delegated prompt names the readiness facts it relies on; a lane that finds an assumption false stops and reports.

## Merge checklist (orchestrator, in the main tree)

1. Diff touches only the declared paths.
2. Lockfile adds no external package without owner approval.
3. Re-run `pnpm format:check`, `lint`, `typecheck`, `test`, `build`, the migration drift check and `docs:check`; record exit codes and counts.
4. Secret scan of the diff (`jd_it_[A-Za-z0-9_-]{43}`, `postgres(ql)?://…@`, `npg_`).
5. Changeset + README for contract changes; `module.json`, `planned.json`, registry consistent.
6. Reviewer findings closed or logged.
7. Readiness matrix and test evidence updated.
8. `git merge --no-ff` (or apply), one `pnpm install`, one push.
