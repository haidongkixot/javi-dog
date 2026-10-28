---
name: orchestrated-agent-team-lanes
description: Run a multi-agent coding team safely — one orchestrator session that alone pushes, merges and owns shared files; Developer and QA lanes in isolated worktrees with declared, non-overlapping paths; an independent QA oracle; a read-only adversarial Reviewer that reproduces findings with probes; fixes landed with red-first tests; and a "git fetch before planning and before every push" rule that prevents two sessions from building the same thing on one branch. Includes a delegated-prompt template, a merge checklist and a recovery playbook for when parallel sessions have already diverged. Use when launching subagents or parallel agents on one repository, when several Claude Code / Codex / Cursor sessions (desktop, cloud, CI) can push to the same branch, when a branch auto-deploys to production, when merging agent worktrees, when a session discovers someone else already pushed the work it planned, or when asked to set up "roles", "lanes", "an agent team", a reviewer agent or a QA agent.
metadata:
  version: "0.1.0"
  origin: "javis-dog G2"
  confidence: "medium (team pattern, used in three iterations); high (fetch-before-planning as the fix for duplicate work: one incident, rule applied twice since)"
---

# Orchestrated agent team lanes

Parallel agents make a sprint faster until two of them touch the same file, or two *sessions* push to the same branch without knowing about each other. The second failure is the expensive one: the origin project lost a full iteration when a cloud session planned and built work that a desktop session had already pushed to the same branch, because the cloud session never fetched.

The rule: **one session pushes; it fetches before it plans and before it pushes; every other agent works in a declared lane and hands back a diff.**

## Forces

- **Throughput vs. coherence.** More lanes finish more work; every shared file (lockfile, registry, memory files, migrations) becomes a merge conflict or a silent overwrite.
- **Independence vs. context.** A QA agent that reads the implementation writes tests that agree with it; one that reads only the contract can disagree, which is the point.
- **Review depth vs. speed.** A reviewer who reads the diff finds style issues; one who runs probes against the claims finds defects.
- **Auto-deploy.** If every push to the working branch deploys production, "push" is a release action and needs a single owner.

## 1. Fix the roles and the one-pusher rule in a committed file

Write a short team file (roles, rules, merge checklist) and reference it from every iteration record. Map roles to agents:

| Role | Agent | Limits |
|---|---|---|
| Orchestrator + secretary | The main session | Sole owner of shared files, migrations against real databases, merges, pushes and the team log |
| Architect | Read-only planning agent | Drafts decisions and interfaces; never finalizes a design that rests on an UNKNOWN resource |
| Researcher | General agent | Primary sources only; the orchestrator re-fetches at least two decisive facts (see `primary-source-research-with-agents`) |
| Developer | General agent in an isolated worktree | One declared slice; returns needed shared-file edits as a list; never pushes |
| QA | General agent in an isolated worktree | Writes vectors from contract text only (see `independent-conformance-vectors`) |
| Reviewer | Read-only agent, adversarial brief | Verifies evidence and readiness records, not only the diff; reproduces findings with probes |

Rules that held in the origin:

- **One pushing session per branch.** Other sessions (another machine, a cloud worker) use their own branches.
- **`git fetch` before planning and before every push**, and log the result ("origin at `<sha>`, nothing new") in the iteration's team log.
- Parallel lanes only when their declared paths do not overlap; at most one lane per wave adds a database migration.
- Every delegated prompt names the readiness facts it relies on; a lane that finds one false stops and reports.

## 2. Plan before launching lanes

Write the iteration's test plan before any lane starts (the origin's Reviewer flagged a plan written after implementation as a deviation; the next two iterations wrote it first). Then give each lane a brief from [`templates/lane-brief.md`](templates/lane-brief.md): goal, acceptance rows from the test plan, allowed paths, interface signatures it consumes, forbidden actions ("do not push, do not edit shared files, do not touch migrations"), and the evidence format to return.

**Write interface stubs first.** If a lane depends on a signature another lane (or the orchestrator) is changing, commit the stub before launching. In the origin, a Developer lane's typecheck failures depended only on the orchestrator's new store signatures and resolved at merge; the next iteration listed "interface stubs" as an orchestrator task up front.

**Correct lanes mid-flight, in time.** When a contract question is decided while lanes run (in the origin, QA found that the brief contradicted the wire-format spec), message the affected lane before it writes the dependent test, and log the correction.

## 3. Merge with a checklist, in the main tree

1. The diff touches only the lane's declared paths.
2. The lockfile adds no external package without owner approval.
3. Re-run the full gate (format, lint, typecheck, tests, build, migration drift, docs) and record exit codes and counts — a lane's own green run is not evidence for the merged tree.
4. Secret scan of the diff (patterns for your token formats and connection strings).
5. Changelog/README for contract changes; generated registries consistent.
6. Reviewer findings closed or logged as deviations.
7. Readiness records and test evidence updated.
8. Merge (`--no-ff` keeps the lane visible), one install, one push.

## 4. Review adversarially, fix red-first

Brief the Reviewer to attack the claims: security of new listeners and endpoints, privacy, data integrity, and whether the evidence supports what the iteration record says. Ask for severity (blocker/major/minor/nit) and for **a probe per major** — a command or test that shows the defect.

Fix majors with tests written first and run against the unfixed code. Record the red count, then the green count. A fix whose test never failed has not been shown to fix anything. Findings you decide not to fix go into the decision record's *Changes* section or the iteration's deviations with a reason — never silently dropped.

## 5. Recover when sessions have already diverged

If you discover that another session pushed the work you planned:

1. **Stop pushing.** Nothing from your line goes to the shared branch or a shared database yet.
2. **Preserve** your line on a local backup branch.
3. **Ask the owner to choose the baseline** (theirs, yours, or a merge) with the trade-offs; the origin chose the pushed line.
4. **Port, do not replay.** Re-derive the useful pieces against the baseline's contract (team rules, templates, how-tos, test-vector formats). Do not reuse expectations or code written against the superseded contract.
5. **Clear shared local state** the other run left (tool caches, temp directories) before the first baseline run; in the origin the first test run failed on a stale shared test-runner cache.
6. **Check the baseline's CI history**, not only its latest run (see `diagnose-red-ci-from-history`).
7. Name the single pusher in the team file.

## Pitfalls

- **Planning from a stale checkout.** The most expensive mistake here; it costs nothing to prevent.
- **"The lane was green."** Lanes run in their own worktree with their own base; only the merged tree's gate counts.
- **Reviewer as a style pass.** Without an adversarial brief and probes, reviewers repeat what the tests already say.
- **Fixes without a red run.** The test may not exercise the defect.
- **Two lanes, one migration folder.** Migration numbering and drift checks collide.

## Evidence from origin project

Javi's Dog, Sprints 3a–3f (2026-10-23 → 2026-10-28). Confidence **medium** for the team pattern (three iterations, one product, one orchestrator), **high** for fetch-before-planning as the fix for duplicate work (incident root cause visible in git; rule logged as applied at the next two sprint starts).

- Incident: the cloud session's superseded line forks at the G2-prep commit `520ab66`, while the owner's desktop session had already pushed `be1c1fc` and `8fd567c`…`5cc8ac0` (S3a–S3c, migration applied to the development database) to the same branch (`git merge-base`, CI run timestamps). Six superseded commits stayed on local `backup/s3a-parallel`, never pushed; its migration "failed on the first statement" and nothing was applied (`docs/memory/SESSION_LOG.md`, 2026-10-27/28). Retro: "cost a full sprint of duplicate work" (`docs/sprints/SPRINT-03d.md`).
- Owner decisions 2026-10-28: reconciliation A (pushed line = baseline), "this cloud session is the only pusher" (`SPRINT-03d.md` Context; `docs/agent-ops/TEAM.md` Rules).
- Ports, not replays: team file, iteration-template Team section, worktree ignores, migration-recovery how-to (`3ed0ba0`); HTTP vector *format* adapted from the superseded line, "none of its expectations were reused" (`docs/jgr/conformance/http/README.md`, Lineage). First baseline test run failed with `ENOTEMPTY` on a stale shared test cache; passed (313) after clearing it (`SPRINT-03d.md` Test evidence).
- Fetch logged: S3d start "origin at `5cc8ac0`, no new commits"; S3e start "origin at `4386501`, nothing new" (team logs in `SPRINT-03d.md`, `SPRINT-03e.md`).
- Lanes with declared paths merged without conflicts: S3d (Developer, QA; retro), S3e (`222f654`, `f8ced2c`, `3f34085`, `5e3730a`, `bff04fe`, each "declared paths only"), S3f (`2e7d23b`, `1a79b7e`). Gate re-run in the main tree after each merge (334 → 383 tests in S3d; 604 → 628 in S3e; 631 in S3f).
- Reviewer: S3d — no blockers, 2 major, 11 minor, 4 nits, re-ran 379 tests; found two clock bugs an earlier audit missed (retro). S3e — 3 majors reproduced with probes (silent success on an unreadable settings file; pid-only liveness → lost data or a signal to a reused pid; a foreign program on the port receives identity data); fixes with 24 new tests run red against the old code (24 FAIL / 251 PASS), then green (275, two runs) (`SPRINT-03e.md`, `95a4b5a`).
- S3f Reviewer: 2 majors (silent half-done setup; a shared install copy letting the last setup downgrade others), 6 minor; fixes red-first (9 FAIL / 3 PASS), then 294 collector tests green twice (`SPRINT-03f.md`, `978a668`, `1a79b7e`). Three review rounds in a row found majors that the lanes' own tests had not.
- Mid-flight correction: QA ambiguity A3 accepted and the receiver lane told before it wrote that test (`SPRINT-03e.md` team log, `ecc2c2c`).
- Test plan timing: written after implementation in S3d (logged deviation, `docs/agent-ops/TEST_PLAN.md` §S3d), before lanes in S3e and S3f.
- Not verified: that the pattern scales past one orchestrator, or that lanes are faster than one agent (no comparison).
