# Wisdom Log

Newest checkpoint first. Each entry: date · checkpoint · commit window · lessons (verified / hypothesis) · skills created/updated · proposals for the owner.

## 2026-10-28 · G2 — signal path end to end (Sprints 3a–3f) · Orcasus-PR checkpoint

G2 is an Orcasus-PR checkpoint (`CLAUDE.md` §7). The PR below is a **proposal for owner review only**; Guru opened no PR and touched no other repository.

- **Window:** `8fd567c^..4c0577f` — 49 commits from `8fd567c` (S3a ingress, owner's desktop session) through S3b (`07dfa99`), S3c (`fe604d1`, `5cc8ac0`), the S3d hardening and reconciliation (`3ed0ba0`…`4386501`), S3e (`9fc1d23`…`92a9244`) and S3f (`11f2e93`…`f7390b7`, `37c6dce`, review fixes `978a668`/`1a79b7e`, record `4c0577f` = HEAD at the end of the G2 read; the orchestrator committed in parallel with this checkpoint). Also read: the superseded local branch `backup/s3a-parallel` (6 commits, never pushed; merge-base `520ab666`).
- **Records read:** `docs/sprints/SPRINT-03a.md`…`SPRINT-03f.md`; ADR-0008…0011 incl. *Changes*; `docs/memory/SESSION_LOG.md` (2026-10-23 → 2026-10-28) and `PROJECT_MEMORY.md`; `docs/agent-ops/TEAM.md`, `TEST_PLAN.md` §S3a–§S3f, `READINESS_MATRIX.md`, `ORCASUS_AGENT_OPERATING_CONTRACT.md` (roles); `docs/jgr/conformance/http/README.md`, `otlp/README.md`; `docs/how-to/run-database-migrations.md`; code at the cited lines in `collectors/claude-code/src/{receiver,cli,otlp,usage}.ts`, `scripts/{build,pack}.mjs`, `test/{process,usage-process,pack}.test.ts`, `packages/event-store/src/events.ts`, `packages/jgr-spec/src/{validate,schema}.ts`, `.github/workflows/ci.yml`, `.markdownlint-cli2.jsonc`.
- **Re-runs by Guru:** none of the project suites. Read-only probes: `gh run list` plus the Actions jobs/annotations API for every red run in the window; `git merge-base` of the superseded line; markdownlint (repository rules) on `d45cc4c`'s `SPRINT-03f.md` → MD022 + MD032; Node 22.22.0 type stripping inside/outside `node_modules`; naive vs. real-path main detection through a symlink; re-fetch of `code.claude.com/docs/en/monitoring-usage.md` (HTTP 200; lines 69, 131, 153, 583); the new scripts (results under *Script verification*).

### Verified lessons

1. **Two sessions pushing one branch duplicated an iteration; fetching before planning is the fix.** The cloud session planned and built S3a from `520ab666` while the owner's desktop session had already pushed `be1c1fc`, `8fd567c`…`5cc8ac0` and applied migration 0002 to the development database. Nothing of the parallel line was pushed or applied (its migration failed on the first statement); it was kept on `backup/s3a-parallel`. Owner: reconciliation A, one pushing session. Retro: "a full sprint of duplicate work". The rule ("`git fetch` before planning and before every push") is in `TEAM.md` and was logged at the S3d and S3e starts. Ports re-derived, not replayed (`3ed0ba0`; HTTP vectors reused the format, no expectations). (`SESSION_LOG.md` 2026-10-27/28; `SPRINT-03d.md` Context, Team log, Retro.)
2. **The baseline's CI history, not its latest run, showed the failure was pre-existing.** `process.test.ts` "detached flusher delivers" failed on `fe604d1` (run 39875014031), passed on `5cc8ac0`, failed again on `98c7974` (run 40612408695). Diagnosed without re-runs: ordering race (fake receiver records before answering; flusher writes its result after reading the answer); reproduced with a 500 ms late answer; fixed the wait, kept a 200 ms delay, product unchanged (`1bb95e9`, run 40612946751 green). Retro: check the baseline's CI history.
3. **Primary-source research before design changed the architecture.** Researcher: Claude Code ignores OTel exporter variables in repository settings files; orchestrator re-fetched lines 69 and 131 and confirmed; owner moved to an opt-in user-level setting (ADR-0011 Status and fact 1; readiness row "OTel exporter config scope"). Guru re-fetched at G2: both lines unchanged. Same loop in S3c changed the hook design (exec form, async, notification matcher; ADR-0010). Third iteration with research-driven, traceable design changes (S1b, S3c, S3e).
4. **Independent QA vectors plus a separately written runner plus mutation checks found a defect in the brief and proved detection.** HTTP: 43 vectors from ADR-0008 text, 20 ambiguities; runner 45 tests green; mutation 415 → 400 failed exactly vectors 32–34. OTLP: 40 vectors / 46 steps, 20 ambiguities; runner 41 tests green; Host check off → exactly vector 09; random ids → exactly 39–40. Ambiguity A3 (brief "non-OTLP object → 400" vs. OTLP "ignore unknown fields; empty request succeeds") → parser fix `ecc2c2c` before the dependent lane wrote its test. (`SPRINT-03d.md`, `SPRINT-03e.md` Test evidence; conformance READMEs.)
5. **Adversarial review with probes found defects the unit tests missed; fixes landed red-first.** S3d Reviewer: 2 major, 11 minor (incl. two clock bugs m3/m4 "the audit missed"), re-ran 379 tests. S3e Reviewer: 3 majors reproduced with probes (silent `usage off` success on an unreadable file; pid-only liveness → lost usage or SIGTERM to a reused pid; foreign program on the port receives identity data); 24 new tests red against the old code (24 FAIL / 251 PASS), then 275 green twice (`95a4b5a`, `bff04fe`). S3f Reviewer: 2 majors (silent half-done `init` when the self-copy fails; one shared copy → last `init` wins incl. downgrade), 6 minor; red first 9 FAIL / 3 PASS, then 294 collector tests twice (`978a668`, `1a79b7e`, `SPRINT-03f.md`). Three consecutive review rounds found majors the lanes' tests had missed.
6. **Localhost listener hardening** (bearer in constant time, Host allowlist, 415/413 caps with bounded gunzip, non-default port 4319, authenticated identity probe before any signal, visible port conflict with backoff, idle exit armed only by authenticated requests, 503 without state change): ADR-0011 Decision and *Changes*; `collectors/claude-code/src/receiver.ts` l. 17, 27, 142–160, 218, 298–302, 373, 380–382; vector 09 mutation.
7. **Packaging pitfalls:** Node refuses type stripping under `node_modules` (verified locally in S3e; Guru re-probe: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`); `.bin` symlinks break naive main detection (found before implementation; mutation → 2 of 3 pack tests fail; Guru re-probe naive `false` / real-path `true`); hooks registered at a stable `~/.javi/bin` copy (test deletes the install prefix); the generated `dist/pkg/README.md` failed repo-wide markdownlint → `**/dist/**` ignored (`ad0c058`, `d45cc4c`; `SPRINT-03f.md`). Review round added: versioned `~/.javi/bin/<version>/` copies made before credentials/hooks with a loud failure, rename retries on transient errors, `--preserve-symlinks-main`-tolerant main detection, path guard in the build, `THIRD_PARTY_NOTICES.md` for inlined code (`978a668`).
8. **A docs lint failure reached the branch and was never evaluated by CI.** `d45cc4c`'s `SPRINT-03f.md` fails the repository's markdownlint (MD022, MD032 — Guru run); `f7390b7` fixed it 18 s later, and CI concurrency (`cancel-in-progress: true`) cancelled `d45cc4c`'s run (40619965768), so that commit has no CI result. CI on `f7390b7` green (run 40619993961). Cause recorded by the orchestrator in `4c0577f`: "gate command did not stop on that step"; gate steps "chained with `&&` since" (`SPRINT-03f.md` Log, Deviations). The earlier command itself is not recorded.
9. **Ingest hardening rules** (canonical ids + DB check, tenant-scoped dedupe, signal on accepted-or-duplicate with forward-only DB-clock cap, 415 so producers keep data, > 100 events → 413, DB-clock rate window, sorted inserts, bounded purge) — tests, 43 vectors, production `smoke:live` 7/7 after deploy (`b710bee`, `048dad1`, `98c7974`; ADR-0008/0009 *Changes*). The audit that listed them is not recorded in the repository; only its findings (H1–H6) are.
10. **Constraint migration with a pre-check:** read-only count of non-canonical ids (0 of 0) run twice, the second immediately before `db:migrate`; refusal test on the embedded engine; fixtures with shorthand ids replaced, assertions unchanged (`READINESS_MATRIX.md` "Migration 0003"; `migrations.test.ts`; `SPRINT-03d.md`). A bundler resolving a migration-folder URL broke only the production build (S3a) → separate entry point.
11. **The health endpoint stayed the deployment check** in every iteration: 2 → 3 → 4 migrations observed, `CRON_SECRET: false` made the inactive purge visible (`SPRINT-03a/b/d/e.md`).
12. **An owner-reported run was checked, not assumed.** S3c: the owner reported running `javi init`; the agent found no collector state on that machine, recorded the server side as NOT VERIFIED and added a read-only `db:events` summary (`SPRINT-03c.md` Log). Still open.
13. **Retro actions carried forward:** S3a "ask for mutation-check permission up front" → mutation checks ran in S3d, S3e, S3f; S3d "test plan before lanes" → S3e and S3f plans written first (`TEST_PLAN.md`); S3d "check the baseline's CI history" → **not applied in S3e** (finding G2-F1).

### Findings by Guru at G2 (verified by probe or reading)

- **G2-F1 — Unrecorded intermittent CI failure.** `collectors/claude-code/test/usage-process.test.ts:120` (expects the first receiver's pid, receives `0`) failed on three docs-only commits — `474427c` (run 40617386527), `a632803` (run 40617962893), `92a9244` (run 40619197881, message "CI green on a3e4ce8") — and passed on `a3e4ce8`, `11f2e93`, `f7390b7`: 3 of 6 completed runs since the test was added in `37ac271`. Not in `SPRINT-03e.md` or `SPRINT-03f.md`. Root cause **not diagnosed**.
- **G2-F2 — A pushed commit without CI evaluation** (`d45cc4c`, lesson 8). Every push to this branch is a production deploy (`TEAM.md`). The S3f record (`4c0577f`) now logs the deviation; the cancellation side (`cancel-in-progress`) is not addressed.
- **G2-F3 — Memory and readiness drift, third recurrence** (after G1 lesson 9 and G2-prep F4). `READINESS_MATRIX.md`: header "Last updated: 2026-10-22"; "Readiness decision" still "S3 … can start; it needs a retention/partitioning ADR"; "Retention purge schedule" row "MISSING (S3b) … Do in S3b" although the route shipped in S3b (only `CRON_SECRET` pending). `PROJECT_MEMORY.md`: header "S3f … (not started)" although merged (`2e7d23b`); "Current state" still contains the S0 line "No auth or ingest yet".
- **G2-F4 — Iterations left open.** `SPRINT-03b.md` (IN PROGRESS) and `SPRINT-03c.md` (BUILT) have empty Retro sections; both wait on owner runtime steps.

### Hypotheses (unverified)

- The usage-process flake comes from the 1 500 ms test idle timeout (`IDLE_MS`, l. 17) elapsing while the second `node cli.ts receive` starts on a slow runner — consistent with pid `0` (the idle-exit record) at l. 120; not reproduced.
- The fetch rule prevents a recurrence — no second concurrent session has occurred since.
- Lanes are faster than one agent — no comparison.
- Translating OTLP locally is safer than a server edge — a design argument; no incident data either way.
- OTel `session.id` equals the hooks' `session_id` — docs silent (re-read at G2); the docs do say `/clear` replaces `session.id` (l. 583), so a real run should include `/clear`.
- Deterministic event ids dedupe *real* Claude Code export retries — tested with synthetic retries only.
- The memory-staleness check would have caught F3/F4 earlier — it flags them now; not yet run in the origin's CI.
- Carried: gap detection and stale derivation (S4); delivery p95 and event size (S5); release-age cooldown; redacted auth logger on a real failure; vectors keeping several implementations consistent.

### Rejected or not packaged

- **Windows checkout fixes** (`be1c1fc`, LF and `fileURLToPath`): just before the window, tool-specific; already in `SESSION_LOG.md`.
- **Neutral hook design** (ADR-0010): folded into `local-companion-process-hardening` §4 rather than a separate skill; its real-session behaviour is unverified.
- **Lesson 12 (owner-reported run)**: reinforces "report truthfully"; no new technique beyond `honest-empty-states` and `agent-second-memory` step 2.
- **Timebox splits** (S3 → S3a–S3f): a fourth application of `agent-second-memory` step 8; no new lesson.
- **Connection string pasted in chat again (S3a)**: handled as `prove-secrets-and-pii-minimization` §7 describes (temp file deleted, rotation recorded); no update.
- **Postgres fixed-window rate limit, 30-day retention, daily cron**: product choices, not lessons.

### Skills created and updated

| Skill | Version | Change | Confidence | Why |
|---|---|---|---|---|
| [`orchestrated-agent-team-lanes`](skills/orchestrated-agent-team-lanes/SKILL.md) | 0.1.0 | new (+ `templates/lane-brief.md`) | medium (pattern); high (fetch-before-planning) | Lessons 1, 5, 13 |
| [`independent-conformance-vectors`](skills/independent-conformance-vectors/SKILL.md) | 0.1.0 | new (+ `templates/suite-README.md`) | high (vectors + runner + mutation); medium (brief defects) | Lesson 4 |
| [`diagnose-red-ci-from-history`](skills/diagnose-red-ci-from-history/SKILL.md) | 0.1.0 | new (+ `scripts/gate.sh`, `scripts/ci-history.sh`) | medium | Lessons 2, 8; G2-F1, F2 |
| [`local-companion-process-hardening`](skills/local-companion-process-hardening/SKILL.md) | 0.1.0 | new | medium; low (real session) | Lessons 5, 6 |
| [`package-node-cli-for-npx`](skills/package-node-cli-for-npx/SKILL.md) | 0.1.0 | new | medium | Lesson 7 |
| [`primary-source-research-with-agents`](skills/primary-source-research-with-agents/SKILL.md) | 0.1.0 → 0.2.0 | ≥ 2 re-fetches by line as a team rule; "which config scope does the tool honour?" first; local runtime probes; defensive fallback + runtime-check row for undocumented facts; G2 evidence | medium → high (loop); medium (probes, fallbacks) | Lesson 3; third iteration with traceable changes |
| [`privacy-first-agent-telemetry-protocol`](skills/privacy-first-agent-telemetry-protocol/SKILL.md) | 0.1.1 → 0.2.0 | §4 canonical, tenant-scoped, deterministic ids; §7 rewritten (status codes as spool instructions, liveness on duplicates, DB clock, sorted inserts, bounded purge); §8 local translation by allowlist; 4 pitfalls; dated facts added to `references/envelope-checklist.md` | §7–8 low → medium | Lessons 4, 9 |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.2.1 → 0.3.0 | fetch-first session contract; team log in iteration records; step 10 + `templates/memory-staleness.mjs`; G2 evidence | medium | Lesson 1; G2-F3, F4 (third recurrence) |
| [`reviewed-schema-migrations`](skills/reviewed-schema-migrations/SKILL.md) | 0.1.0 → 0.2.0 | steps 7 (pre-check before constraints), 8 (half-applied recovery), 9 (migration assets out of app bundles); G2 evidence | medium | Lesson 10 |
| [`presence-only-health-endpoint`](skills/presence-only-health-endpoint/SKILL.md) | 0.1.0 → 0.1.1 | G2 evidence; migration-state observation → high | high / medium | Lesson 11 |

Catalog: Orcasus column narrowed to a focused first wave for this PR; earlier "yes" skills are now marked "later (G4)" with reasons below.

### Script verification at G2

- `diagnose-red-ci-from-history/scripts/gate.sh --self-test` → "self-test PASS", exit 0; `gate.sh true false "echo nope"` → "GATE FAIL at step 2/3", exit 1, step 3 not run; no arguments → usage, exit 2.
- `ci-history.sh claude/clever-goldberg-wlurty 16` → flags `474427c`, `a632803`, `92a9244` `FLAKE? (docs-only diff) failed: Run pnpm test`, `98c7974` `CODE`, `d45cc4c` `NOT EVALUATED`. First version mis-aligned columns for in-progress runs (empty tab field collapsed); fixed and re-run.
- `agent-second-memory/templates/memory-staleness.mjs --self-test` → PASS, exit 0; on the origin repository → 5 findings (G2-F3 readiness date; G2-F4 ×4), exit 1; no arguments → exit 2.

### Proposals for the owner

Project fixes (Guru does not edit project files; each is small and reversible):

1. **G2-F1** — diagnose `usage-process.test.ts:120` per Orcasus rule 8: reproduce by delaying the second `receive` past `IDLE_MS`, fix the wait, keep a delay; record runs 40617386527, 40617962893, 40619197881 in `SPRINT-03e.md` Test evidence. No re-runs or skips to get green.
2. **G2-F2** — the gate is now chained with `&&` (`SPRINT-03f.md`); write that into `TEAM.md`'s merge checklist ("run the chained gate after the last edit, including docs, before each push"). Owner decision: keep `cancel-in-progress` for the deploying branch, or not (trade-off: CI minutes vs. every production deploy having a CI result).
3. **G2-F3** — `READINESS_MATRIX.md`: header date, readiness-decision paragraph, retention row → "BUILT, inactive until `CRON_SECRET`". `PROJECT_MEMORY.md`: S3f status, remove the S0 "No auth or ingest yet" line, condense "Current state".
4. **G2-F4** — close S3b/S3c with retros for the built parts and move the owner-pending runtime checks to readiness rows (or mark the status "WAITING ON OWNER" with a retro).
5. Add `memory-staleness.mjs` to `docs:check` with `--warn-only` first (changes CI; owner decision).
6. Policy proposal (shared policy, owner review): add to `CLAUDE.md` §0/§6 "fetch before planning and before every push; one pushing session per branch" — today it lives only in `TEAM.md`.
7. First real run (S3c/S3e): include a `/clear` in the session to test `session.id` correlation; read matched vs. dropped in `javi status`.
8. Reminders (already recorded): B1-rotate (connection string pasted again in S3a), `CRON_SECRET`, ADR-0004 review, release-cooldown policy.

### Orcasus PR proposal (G2) — for owner review, not opened

**Target:** `haidongkixot/orcasus` (installed here as v1.2.1). **Scope:** four agent-operations skills, added as optional skills next to `project-discovery` and `efficient-testing`; no change to the operating contract text. Exact paths to follow the repository's layout (owner to confirm).

| Skill | Confidence | Orcasus rule it operationalizes | Why now |
|---|---|---|---|
| `orchestrated-agent-team-lanes` | medium; high (fetch rule) | "Role-specific expectations" (orchestrator, developer, QA, reviewer, secretary); stop conditions | Turns the contract's roles into agent mechanics (worktrees, declared paths, sole pusher, merge checklist); adds the one rule the contract lacks — one pushing session per branch, fetch before planning — learned from a costly incident |
| `independent-conformance-vectors` | high / medium | Rule 5 (plan tests, lowest reliable layer), rule 10 (truthful status vocabulary), QA role | Gives QA an independence rule and gives "tests detect regressions" an evidence form (mutation checks that fail exactly the expected vectors) |
| `diagnose-red-ci-from-history` | medium | Rule 8 (diagnose before retry), rule 10 | Concrete steps and two scripts for rule 8: read history, classify pre-existing/flaky, reproduce deterministically, fix the wait, fail-fast gate, precise "green on `<sha>`" |
| `primary-source-research-with-agents` | high (loop) | Rule 1 (discover before designing), rule 9 (verify resources at runtime), Researcher role | Verified in three iterations; the "which config scope does the tool honour?" question changed an architecture before code |

Deferred to G4: `agent-second-memory` (drift recurred three times; propose after `memory-staleness.mjs` has run in the origin's CI), `presence-only-health-endpoint`, `verify-dependencies-against-registry`, `vendoring-agent-skills`, `honest-empty-states`, `prove-secrets-and-pii-minimization` §3/§7. Not candidates: `accessible-brand-tokens`, `tenant-isolation-by-construction`, `reviewed-schema-migrations`, `privacy-first-agent-telemetry-protocol`, `local-companion-process-hardening`, `package-node-cli-for-npx` (product engineering, not agent operations).

Before opening (owner): (a) decide whether origin evidence may be public — if not, move each "Evidence from origin project" section to `references/origin-evidence.md` with repository paths removed and keep the confidence line; (b) check the skills against Orcasus precedence (no screenshot use; none found); (c) run the two scripts' self-tests on the target CI; (d) choose the version bump (suggested: minor, v1.3.0).

**Proposed title:** `Add agent-team, conformance-oracle, CI-diagnosis and primary-source research skills (from Javi's Dog G2)`

**Proposed body outline:**

1. *Summary* — four optional skills that operationalize roles and rules 1, 5, 8, 9, 10 of the contract; contract text unchanged.
2. *Why* — one paragraph per skill naming the incident or result behind it (parallel-session duplicate iteration; brief defect A3 and exact-vector mutation results; pre-existing red CI diagnosed without re-runs and an unrecorded flake found later; config-scope fact that changed an architecture).
3. *Contents* — files per skill (`SKILL.md`, `templates/lane-brief.md`, `templates/suite-README.md`, `scripts/gate.sh`, `scripts/ci-history.sh`).
4. *Evidence and confidence* — per skill, labelled high/medium with what is still a hypothesis (lane speed-up; fetch rule preventing recurrence; flake root cause).
5. *Compatibility* — no new dependencies (bash, `gh`, `git`, Node ≥ 18 only); no screenshot use; precedence unchanged.
6. *Testing* — `gate.sh --self-test`; `ci-history.sh` read-only run on a public repository; markdown lint.
7. *Out of scope* — deferred and domain skills listed above.
8. *Review asks* — role mapping wording; whether "one pushing session per branch" belongs in the contract's required workflow rather than a skill.

## 2026-10-22 · G2-prep — feature completion: data layer, identity, projects (Sprints 2a, 2b, 2c)

Not the G2 Orcasus-PR checkpoint (that is at S3, `docs/explanation/roadmap.md`). No PR opened or drafted; Orcasus candidates are listed as proposals only.

- **Window:** `a49af5e` (S2a plan) → `2d6b87d` (HEAD), 11 commits: `a49af5e`, `332e4fb`, `dc6ef61` (S2a data layer, tokens, `/api/health`), `ce143d0`, `9b6ea0b`, `9cdc766`, `26db144` (Vercel env and rebuild), `a55b415` (S2b sign-in), `24231a5` (`id_token` fix), `93cc254` (S2c projects, tokens, email), `2d6b87d` (S2c close).
- **Records read:** `docs/sprints/SPRINT-02a.md`, `SPRINT-02b.md`, `SPRINT-02c.md`; ADR-0005, 0006, 0007; `docs/agent-ops/READINESS_MATRIX.md`, `TEST_PLAN.md` (S2a–S2c sections); `docs/memory/PROJECT_MEMORY.md`, `SESSION_LOG.md` (2026-10-20/22 entries); `docs/how-to/run-database-migrations.md`; code in `packages/event-store`, `packages/projects`, `packages/identity`, `packages/notify`, `apps/web/src/lib`, `apps/web/src/app/api`, `apps/web/src/app/projects`, `apps/web/src/app/sign-in`; tests in `packages/event-store/test`, `packages/identity/test`, `apps/web/test/health.test.ts`; `.github/workflows/ci.yml` diff in `dc6ef61`.
- **Re-runs by Guru:** none of the project suites. Read-only probes: `gh run list` (CI succeeded on `26db144`, `a55b415`, `24231a5`, `93cc254`, `2d6b87d`); PGlite 0.5.8 `CASE` guard vs. `to_regclass`; Node 22.22.0 type stripping on a parameter property and an `enum`, and `tsc` 5.9.3 with and without `erasableSyntaxOnly`; the origin's redaction pattern (copied verbatim) against sample token formats; `npm view better-auth time` and `npm view @electric-sql/pglite time`; a grep of the installed pnpm 10.28 bundle for `minimumReleaseAge`; the new templates (below). A GitHub Advisory Database API query returned 403 in this sandbox and was not used.

### Verified lessons

1. **A presence-only health route became the agent's only view of the deployed configuration.** Env listing and env creation were 403 for the agent; `/api/health` (booleans for nine names, deployed commit and environment, DB state) showed three variables missing (`dc6ef61`), then — after the owner's change — the *old* build still reporting them missing because env changes had not reached a new build (`9b6ea0b`), then 200 with all nine set after a rebuild (`9cdc766`), then 2 migrations at S2b (`a55b415`). The platform's deployment list showed the branch builds as Production, so the plan's "Preview → dev database" assumption had no environment to apply to (Q5). Evidence: `SPRINT-02a.md` Log and Q5, `SESSION_LOG.md`, `READINESS_MATRIX.md` (`ce143d0`, `9b6ea0b`, `26db144`).
2. **Postgres resolves relation names before execution**, so a `CASE` guard around a possibly-missing migrations table still failed; split into an existence check and a count; caught by a PGlite test (`packages/event-store/src/client.ts`, `migrations.test.ts`, ADR-0005 *Changes*, `dc6ef61`). Reproduced at G2-prep on PGlite.
3. **Node's type stripping rejects non-erasable TypeScript** (a constructor parameter property broke the first smoke run) → `erasableSyntaxOnly` in `tsconfig.base.json` (`dc6ef61`, `SPRINT-02a.md` Log). Reproduced at G2-prep: runtime rejects the parameter property and an `enum`; `tsc` exits 0 without the flag, 2 with it (TS1294).
4. **Reviewing generated SQL found a tenancy hole**: a token could reference a project in another workspace (two independent FKs) → composite FK `(project_id, workspace_id) → projects(id, workspace_id)`, raw-SQL test expecting the constraint name (`packages/projects/src/db/tables.ts`, `repository.test.ts`, `dc6ef61`). Template reproduced at G2-prep on PGlite.
5. **The migration generator discovered tables only from named exports**; the identity tables, reachable only through an exported object, were silently skipped → named exports; the migration test asserts all nine tables (`SPRINT-02b.md` Log, `packages/event-store/src/schema.ts`, `a55b415`).
6. **A new workspace package with no tests made Vitest exit 1, and Turbo stopped every other package's tests** → real unit tests added, `passWithNoTests` deliberately not used (`SPRINT-02b.md` Log, `a55b415`).
7. **Reading the installed library first made the auth integration work on the first try**: Better Auth 1.7.7's installed source answered id generation, organization-to-`workspaces` mapping, the adapter's `transaction` switch, `encryptOAuthTokens`, IP tracking and telemetry (S2b), and `onAPIError.errorURL` / `logger.log` (S2c) (`SPRINT-02b.md` Log and Retro, `SPRINT-02c.md` Log). Version rule: newest 1.7.x older than two weeks, advisory DB checked (ADR-0006); the same rule picked PGlite 0.5.8. Publish dates re-checked at G2-prep match both pins.
8. **Row shapes after the first real sign-ins exposed a plain-text provider `id_token`** that the encryption flag does not cover; access/refresh tokens were hex ciphertext → hooks drop `id_token`, test red (exit 1) → green, existing value cleared (`SPRINT-02b.md`, `24231a5`, ADR-0006).
9. **The first real sign-in failed with zero evidence** (no rows; platform runtime logs returned nothing; cause never captured) → redacted structured auth logging and `errorURL` to `/sign-in?error=` (ADR-0007, `93cc254`). The change is verified by unit tests; its value on a real failure is a hypothesis (none since).
10. **A secret pasted in chat was handled without persisting it**: compared to the stored value by hash only, never written to the repository, recorded as exposed with rotation tied to B1; the agent's attempt to set it on the platform was 403 and the owner set it (`SESSION_LOG.md`, `9b6ea0b`; `PROJECT_MEMORY.md`).
11. **The authorization rule lives in one function** (`resolveWorkspace`: the session's active workspace only with a membership row; never from input) with a forged-id test; pages and actions use `getViewer()`; malformed or foreign ids are "not found" (`packages/identity/src/workspace.ts`, `apps/web/src/lib/viewer.ts`, `actions.ts`, `identity.test.ts`, `projects.test.tsx`, `93cc254`; `SPRINT-02c.md` Retro).
12. **Hash-only token storage was checked on the real database** after the owner issued and revoked a token in production: hash 64 hex, prefix 8, revoked, same workspace, 0 token rows containing the plaintext prefix (`SPRINT-02c.md` Test evidence, `2d6b87d`). The query itself is not recorded; it searched for the prefix only.
13. **Timebox splits held a second time**: S2 → S2a/S2b/S2c, each closed with its own evidence and retro (CI green on every code commit in the window).

### Findings by Guru at G2-prep (verified by probe or reading)

- **F1 — Redaction denylist gaps.** The auth log redactor (`packages/identity/src/auth.ts`) does not redact `ghr_…` (GitHub refresh tokens), `github_pat_…` or generic `sk_…` keys (probe). No such string is known to have reached a log.
- **F2 — Weaker-than-named hash-only test.** `repository.test.ts` asserts `Object.values(row)` does not contain the token — per-column equality; a token embedded in a longer value, or the secret without its prefix, would pass. The production check searched for the prefix only.
- **F3 — Disclosure copy behind the product.** After S2c shipped project creation, the global banner still says "projects, agents and providers are not connected yet" (`apps/web/src/app/layout.tsx` at `2d6b87d`).
- **F4 — Memory and readiness drift (recurrence of G1 lesson 9).** `PROJECT_MEMORY.md` header "Last updated: 2026-10-20"; "S2 split" line outdated; the GitHub OAuth callback open question already resolved. `READINESS_MATRIX.md` header dated 2026-10-20; Secrets row action already done; readiness-decision paragraph still about unblocking S2b; Observability row "AVAILABLE once deployed" contradicted by the S2b retro (runtime logs returned nothing).

### Hypotheses (unverified)

- The redacted auth logger will capture the next real sign-in failure — no failure observed since `93cc254`.
- The release-age cooldown prevents bad releases — applied twice, no incident to compare.
- Running the personal-workspace hook on every session "self-heals" a failed first attempt (ADR-0006) — no failed first attempt observed; simultaneous first sessions creating two workspaces was accepted, not tested.
- "Offline tests of the provider redirect caught config issues before any real sign-in" (S2b retro) — which issues is not recorded.
- Env changes reach only new builds on *other* platforms — observed once, on one platform.
- The single-resolver pattern keeps isolation as handlers multiply — few handlers exist.
- PGlite (Postgres 17) is close enough to Neon (Postgres 18) — only `uuidv7()` is known to be avoided.
- Carried from G1, still untested: dedupe, gaps, stale derivation, OTLP edge (S3); delivery and size targets (S5); user-trust effects of honest empty states; cross-session resumption benefit.

### Rejected or not packaged

- **Lesson 6 (no-test package aborts the workspace run)**: verified once, tool-specific (Vitest + Turborepo defaults), and no current skill fits; kept here. Revisit if more monorepo-hygiene lessons accumulate.
- **"Welcome email via REST, no SDK"**: a reasonable decision (ADR-0007) with no evidence of benefit beyond "no new dependency"; only its logging rule (status codes, never addresses; never blocks sign-in) is packaged.
- **"Env changes apply only to new builds" as a general rule**: packaged only as a check to perform (compare `deployment.commit`), not as a platform fact.
- **Claim that encrypted OAuth tokens are safe at rest**: not claimed; only their shape was checked (hex, no provider prefix), not the key management.

### Skills created and updated

| Skill | Version | Change | Confidence | Why |
|---|---|---|---|---|
| [`presence-only-health-endpoint`](skills/presence-only-health-endpoint/SKILL.md) | 0.1.0 | new (+ `templates/health-core.mjs` with `--self-test`, `references/db-ping.sql`) | high (observing deployed config); medium (DB ping) | Lessons 1–2 |
| [`tenant-isolation-by-construction`](skills/tenant-isolation-by-construction/SKILL.md) | 0.1.0 | new (+ `templates/composite-tenant-fk.sql`) | medium | Lessons 4, 11 |
| [`prove-secrets-and-pii-minimization`](skills/prove-secrets-and-pii-minimization/SKILL.md) | 0.1.0 | new (+ `templates/at-rest-checks.sql`) | medium | Lessons 8–10, 12; F1, F2 |
| [`reviewed-schema-migrations`](skills/reviewed-schema-migrations/SKILL.md) | 0.1.0 | new | medium | Lessons 4 (detection), 5; ADR-0005 workflow |
| [`verify-dependencies-against-registry`](skills/verify-dependencies-against-registry/SKILL.md) | 0.1.1 → 0.2.0 | steps 5 (release-age cooldown + advisories) and 8 (read installed types/source before designing), `erasableSyntaxOnly` in step 3, three pitfalls, G2-prep evidence | medium | Lessons 3, 7 |
| [`honest-empty-states`](skills/honest-empty-states/SKILL.md) | 0.1.0 → 0.2.0 | section 7 (per-deployment "not configured", real rows with missing signals, shown-once secrets, narrowing disclosure), pitfall "copy behind the product" | medium | S2b/S2c UI; F3 |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.2.0 → 0.2.1 | step 9 extended to the readiness matrix; pitfall "AVAILABLE because a tool exists"; G2-prep evidence | medium | Lesson 13; F4 |
| [`privacy-first-agent-telemetry-protocol`](skills/privacy-first-agent-telemetry-protocol/SKILL.md) | 0.1.0 → 0.1.1 | section 7 notes token storage now implemented, links the new skills; sections 7–8 stay low | medium / low | Lesson 12 |

Template verification at G2-prep: `health-core.mjs --self-test` → 6 PASS, exit 0; a scratch variant that echoes values instead of booleans → `FAIL: no value is echoed`, exit 1. `composite-tenant-fk.sql` on PGlite: same-tenant insert OK, cross-tenant insert rejected with `api_tokens_project_tenant_fk`, tenant delete cascades to 0 tokens. `at-rest-checks.sql` on PGlite with fake rows: the plaintext scan finds a token embedded in a name column by prefix and by secret part; hash, prefix and dropped-field counts as expected; `LIKE '%tok_%'` false-positive on "my tokens" where `strpos` returns 0. `pnpm docs:lint` and `pnpm docs:links` results are in the report to the orchestrator.

### Proposals for the owner

Project fixes (Guru does not edit project code; each is small and reversible):

1. F1 — `packages/identity/src/auth.ts`: extend the redactor to `ghr_` and `github_pat_` (and any other provider prefixes in use), and add those formats to the redaction unit test.
2. F2 — `packages/event-store/test/repository.test.ts`: assert that no column *contains* the token or its 43-character secret part (substring), and record the production check query (prefix **and** secret slice, `strpos` over `row::text`) in `docs/how-to/`.
3. F3 — `apps/web/src/app/layout.tsx`: banner copy such as "You can sign in and create projects; agents and providers are not connected yet."
4. F4 — `PROJECT_MEMORY.md`: header date, outdated S2 split line, remove the resolved OAuth-callback question, condense "Current state". `READINESS_MATRIX.md`: header date, Secrets row action, readiness-decision paragraph, and Observability row → UNKNOWN or PARTIAL with the S2b evidence (runtime logs returned nothing).
5. Decide whether the "newest release older than two weeks" rule becomes policy (an ADR-0002 amendment, optionally enforced with pnpm `minimumReleaseAge`). It changes install behavior, so it needs the owner.
6. Reminder (already recorded): the GitHub client secret pasted in chat and the database password remain exposed until rotated (B1-rotate).

Orcasus (proposal only — G2 PR checkpoint is at S3): candidates to assess with the owner are `agent-second-memory`, `vendoring-agent-skills`, `verify-dependencies-against-registry`, `primary-source-research-with-agents`, `honest-empty-states` (carried from G1), plus `presence-only-health-endpoint` (runtime verification of deployed resources by name and presence only — operationalizes "verify resources at runtime" and "names, never values") and sections 3 and 7 of `prove-secrets-and-pii-minimization` (proof by shape; pasted secrets). Not candidates: `tenant-isolation-by-construction`, `reviewed-schema-migrations` (product engineering, not agent operations), `privacy-first-agent-telemetry-protocol` (domain), `accessible-brand-tokens`. No change to `CLAUDE.md` or the Orcasus skills is proposed.

## 2026-10-20 · G1 — protocol decision, end of Sprints 1a and 1b

- **Window:** `6cfe703` (G0) → `a789674` (HEAD), 4 commits: `57890b3` (owner decisions, provisioning guide), `0235df1` (S1a shell, components, project schema), `77579d9` (JGR v0.1 schemas, validator, vectors, spec, ADR-0004), `a789674` (research notes, spec mappings and edge rules).
- **Records read:** `docs/sprints/SPRINT-01a.md`, `SPRINT-01b.md`, `docs/memory/PROJECT_MEMORY.md`, `SESSION_LOG.md`, ADR-0004, `docs/jgr/spec/v0.1.md`, `docs/jgr/research/2026-10-20-sources.md`, `docs/jgr/conformance/vectors/` (20 files), `packages/jgr-spec/**`, `packages/ui/src/components/**`, `apps/web/src/**`, `apps/web/test/**`, `packages/projects/**`, `docs/how-to/provision-external-services.md`, `docs/agent-ops/READINESS_MATRIX.md`, `docs/explanation/roadmap.md` diff.
- **Re-runs by Guru:** none of the project suites. Read-only probes only: `gh run list` (CI status); the origin's two guard regexes against sample strings in `node -e`; `validateEvent` from `packages/jgr-spec/src/index.ts` against three hand-built events; the new templates against origin vectors, the existing built HTML (`apps/web/.next`, built 18:59 UTC in S1a; `apps/web` unchanged since) and scratch negative fixtures.

### Verified lessons

1. **Privacy enforced as validation, not cleanup.** The envelope rejects unknown top-level fields and any attribute outside the L0 allowlist with stable codes; L1 identifiers must be `sha256:` hashes; L2 requires an encrypted blob (`packages/jgr-spec/src/validate.ts`, `77579d9`). 20 shared JSON vectors (7 valid, 13 invalid) run through a filename-prefix-checking runner; `pnpm --filter @javis-dog/jgr-spec test` exit 0, 27 passed (`SPRINT-01b.md`). CI succeeded on `77579d9` and `a789674`.
2. **The privacy boundary covered the attribute map but not the reference fields.** G1 probe: `validateEvent` accepted `thread_ref` = a file path and `agent_ref` = an email address, although spec §3 says refs are "never a path". Root cause in code: the shared `REF` pattern allows `/`, `.` and `@` (`packages/jgr-spec/src/schema.ts`).
3. **Spec cross-references drifted within one sprint.** Spec §3 (JGR-R11) says unknown top-level fields MUST be rejected; §11 says they are rejected only when the version is unrecognized. `validate.ts` cites "spec §7" for error codes, which live in §13. Found by reading at G1.
4. **Research produced traceable design changes.** The research note lists a URL per item, the blocked sites with GitHub/source fallbacks, NOT VERIFIED marks, an orchestrator spot-check of items 1a–1d, and a findings-to-decisions table; `a789674` applied six of those changes to spec and schema (`reasoning_tokens`, CloudEvents-aligned dedupe, identity/content drop at the OTLP edge, prompt-off setup, informative Idempotency-Key, v0.2 signing design). One researcher suggestion (build on the CloudEvents envelope) was declined with the rationale recorded (`SPRINT-01b.md`, Decisions).
5. **Honest empty states held in a tested shell.** `MetricCard` takes `string | null` and renders "No signal yet" with the meta line suppressed; global `DemoBanner` (`role="status"`); disabled "Create project" with `aria-describedby`; "Connection not verified yet" per integration; targets labelled "Design goals, not measured SLAs"; illustrative template numbers and toggles deliberately not ported (`0235df1`, `SPRINT-01a.md`). `pnpm test` exit 0, 62 passed; built-HTML assertions on all 5 routes; screenshots 0.
6. **Two guard tests were weaker than their names.** The Overview "no sample numbers" regex `/\d+(\.\d+)?\s?(K\/s|%|M)\b/` does not match `67%` or `67% capacity` (no word boundary after `%` before a space or end of text); the "no raw hex" regex misses `#7c5cff80` and `#ffff` and all functional color notations (G1 probe, Node 22.22.0). The G0 lesson "prove a guard can fail" was applied to doc checks but not to these tests. The component-level test does catch a fabricated `67% capacity`, so no fake value is known to have shipped.
7. **Copy can run ahead of the spec.** The integrations directory describes the custom API as a "Signed event ingestion endpoint" (`apps/web/src/app/integrations/page.tsx`, `0235df1`), while spec v0.1 has bearer tokens only and signing planned for v0.2 (§8, `a789674`). The row's status pill says "Spec in progress", which limits the overclaim; the description does not.
8. **Timebox split worked once and was recorded truthfully.** Owner rule (≤ 30 min per sprint, split oversized sprints) in `docs/explanation/roadmap.md` (`57890b3`); S1a about 9 min, S1b about 8 min, each with its own backlog, evidence and retro; the hosting item rolled over as BLOCKED with the owner action. The S1a retro action (keep the spec small, vectors executable) was applied in S1b.
9. **Project memory was updated only partially.** At `a789674`, `PROJECT_MEMORY.md` "Current state" is current but "Next actions" still describes closing S0 and starting S1, and "Open questions" still lists D1 as pending although D1 was accepted in `57890b3`.
10. **The type-check gate caught a tool-config option the test runner ignored** (`SPRINT-01a.md`, Log and Retro). At G1, `packages/ui/tsconfig.json` does not include its `vitest.config.ts`, so that package's runner config is outside the gate.
11. **Fixture IDs were validated against the protocol's own format.** Placeholder ULIDs containing `I`/`O` (excluded by Crockford base32) were found and fixed before tests ran (`SPRINT-01b.md`, Log).

### Hypotheses (unverified)

- Shared conformance vectors keep several implementations consistent — only one implementation exists (collectors and gateway arrive in S3).
- Reject-not-strip teaches producers to fix violations — no producer exists yet.
- Deltas plus (`producer_id`, `event_id`) dedupe prevent inflated counters; sequence gaps surface signal loss; receiver-derived stale works with a 3 × heartbeat window — specified, not implemented.
- The OTLP edge drops identity and content from misconfigured tools — specified (§12), tests owed in S3.
- Delivery p95 < 2 s and events < 4 KB — targets, not measured (S5).
- Parallel research shortened S1b — the retro's assessment; no comparison exists.
- A 30-minute timebox improves quality or throughput — two data points, no comparison.
- Honest empty states improve user trust — no users yet.
- Carried from G0, still untested: cross-session resumption from memory files (S0–S1b ran in one session; `SESSION_LOG.md` has one entry); doc-drift guard in real use (still SKIPPED, no `main`); Node engine minimum failure mode; 4.6:1 contrast margin; theme-scoped tokens for a dark theme. D1 is no longer pending (accepted in `57890b3`).

### Skills created and updated

| Skill | Version | Change | Confidence | Why |
|---|---|---|---|---|
| [`privacy-first-agent-telemetry-protocol`](skills/privacy-first-agent-telemetry-protocol/SKILL.md) | 0.1.0 | new (+ `references/envelope-checklist.md`, `templates/run-vectors.mjs`, `templates/vector.example.json`) | medium (envelope, vectors) / low (delivery, edge) | Lessons 1–3, 11 |
| [`honest-empty-states`](skills/honest-empty-states/SKILL.md) | 0.1.0 | new (+ `templates/honesty-guards.mjs` with self-test probes) | medium | Lessons 5–7 |
| [`primary-source-research-with-agents`](skills/primary-source-research-with-agents/SKILL.md) | 0.1.0 | new (+ `templates/research-brief-and-note.md`) | medium | Lesson 4 |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.1.0 → 0.2.0 | added steps 8 (timeboxed splits) and 9 (update every memory section), pitfall "partial memory update", sprint template header fields, G1 evidence | medium | Lessons 8–9; timebox folded in here rather than a separate skill because the evidence is one split |
| [`verify-dependencies-against-registry`](skills/verify-dependencies-against-registry/SKILL.md) | 0.1.0 → 0.1.1 | added pitfall "tool configs outside the type check" and G1 evidence | medium | Lesson 10 |

Template verification at G1: `run-vectors.mjs` on the origin vectors with the origin validator → "20 vectors, 0 failures", exit 0; on a scratch set (wrong expected code, path-shaped ref, no valid file) → 3 failures, exit 1. `honesty-guards.mjs --self-test` PASS; `html` scan of 7 built pages → 1 false positive ("03 Token" from a numbered rule list), fixed by making word units case-sensitive and adding a must-not-match probe, then 0 findings; `colors` scan of `apps/web/src` and `packages/ui/src/components` → 0 findings; scratch negative fixtures → findings, exit 1.

### Proposals for the owner

Project fixes (Guru does not edit project code; each is a small, reversible change for the implementer):

1. `apps/web/test/shell.test.tsx` — replace the trailing `\b` in the sample-number regex (for example with `(?![\w])`) and add probe strings such as `67%` and `67% capacity`.
2. `apps/web/test/brand-static.test.ts` — also catch 4/8-digit hex and `rgb()`/`hsl()`/`oklch()` literals; add must-match probes.
3. JD-M01 — give `producer_id`, `thread_ref` and `agent_ref` an opaque shape that cannot carry `/`, `.`, `@` or spaces, and add invalid vectors for a path-shaped and an email-shaped ref. A breaking change to a draft (allowed before v1.0); worth an ADR-0004 note.
4. Spec v0.1 — reconcile §3 (JGR-R11) with §11 on unknown fields, with vectors for both sides; fix the "spec §7" comment in `validate.ts` (codes are in §13).
5. Integrations copy — "Signed event ingestion endpoint" → for example "Event ingestion endpoint (request signing planned for v0.2)".
6. `PROJECT_MEMORY.md` — refresh "Next actions" and remove D1 from "Open questions"; add the S1a/S1b entry to `SESSION_LOG.md` at session end.
7. `packages/ui/tsconfig.json` — include `vitest.config.ts` so the runner config is type-checked like the app's.
8. ADR-0004 is marked Accepted with the owner as a decider; no separate owner-acceptance record was found in the window. Please confirm or record it.

Orcasus: G1 is not an Orcasus-PR checkpoint; no PR is proposed. Candidates to reassess at G2: `agent-second-memory`, `vendoring-agent-skills`, `verify-dependencies-against-registry` (from G0), plus `primary-source-research-with-agents` (complements "discover before designing" and evidence labelling) and `honest-empty-states` (UI form of "no mock masquerading" and "report truthfully"; its guard self-test practice generalizes beyond UI). `privacy-first-agent-telemetry-protocol` is a domain skill and not an Orcasus candidate; raise its delivery/edge sections from low to medium once the S3 gateway and OTLP translator tests exist.

## 2026-10-20 · G0 — end of Sprint 0 "Discovery & readiness"

- **Window:** `d3ff6fa` (root) → `07ccacc` (HEAD), 6 commits.
- **Records read:** `docs/sprints/SPRINT-00.md`, `docs/memory/PROJECT_MEMORY.md`, `docs/memory/SESSION_LOG.md`, `docs/agent-ops/READINESS_MATRIX.md`, `DISCOVERY_SUMMARY.md`, `TEST_PLAN.md`, ADR-0001…0003, `docs/brand/BRAND_GUIDE.md` §3, `docs/feasibility/FEASIBILITY.md`, `.claude/skills/SOURCES.md`, `CLAUDE.md`, `scripts/*.mjs`, `packages/ui/src/*.ts`, `packages/ui/test/*.ts`.
- **Re-runs by Guru:** none of the project suites. Two cheap read-only checks: `npm view` of three packages (results below) and a local run of the new `references/contrast.mjs` helper against the origin token values.

### Verified lessons

1. **Measure contrast before building a design system.** The brand prototype's secondary text (4.00:1), all five status-pill texts (3.21–4.08:1) and white on the primary color (4.43:1) fail WCAG AA — found before any component existed (`docs/brand/BRAND_GUIDE.md` §3, `f89e605`). Fix kept the brand hues exact and moved only text tokens and one button background (ADR-0003; `packages/ui/src/tokens.ts`, `d011b8d`), enforced by a parameterized AA test over declared text pairs (`packages/ui/test/contrast.test.ts`; `pnpm test` exit 0, 29 tests). Generated CSS is guarded by `tokens:check` in `docs:check` (exit 0).
2. **Smallest same-hue lightness step reproduces the adjusted tokens.** At G0, an HSL-lightness search (step 0.005, target 4.6:1 on every background) reproduced all eight adjusted values in `tokens.ts`. This verifies consistency of the method with the values, not which tool produced them originally (not recorded).
3. **Doc checks catch real problems when they are allowed to fail.** The link check failed on two broken links after `guru/README.md` was added; fixed by creating the files, not weakening the check. The doc-drift guard was proven with a negative probe (exit 1) and a positive case against `7a501a3` (`docs/sprints/SPRINT-00.md`, Test evidence). Doc drift is correctly reported as SKIPPED while no `main` branch exists.
4. **Docs were corrected in the same commit as the code that changed them.** `d011b8d` updated the brand guide, provenance and ADR-0002 when the font strategy moved from a build-time download to a self-hosted npm package.
5. **Frequent pushes protected work from an abrupt session end.** The session worker restarted mid-sprint; pushing after each coherent step prevented loss (`docs/sprints/SPRINT-00.md`, Retro).
6. **Skill review caught real conflicts before install.** `frontend-design` was declined (pushes a new visual direction and screenshot self-critique; conflicts with the fixed brand and screenshot budget 0); `writing-plans` was declined (depends on its family of skills, mandates per-step TDD); a runtime-fetched rules file was replaced by a pinned copy (`.claude/skills/SOURCES.md`, `web-design-guidelines/SKILL.md`, `509faa5`). Precedence with a worked example is in `CLAUDE.md` §1 (`d3ff6fa`).
7. **Registry checks changed two stack choices.** `next-auth@5` is beta-only → Better Auth 1.7 for the security-critical auth module; `typescript-eslint` peer range `<6.1.0` → TypeScript 5.9 pinned although 7 is `latest` (ADR-0002, `DISCOVERY_SUMMARY.md` findings 2–3). Re-checked at G0 with `npm view`: `typescript-eslint@8.72.0` peer `typescript` `>=4.8.4 <6.1.0`; `typescript` `latest` 7.0.2; `next-auth` `latest` 4.24.15, `beta` 5.0.0-beta.32.
8. **Explicit resource status prevents false readiness.** The readiness matrix keeps the database as UNKNOWN (integration listing returned 403) rather than assuming it, and records env var names only (`docs/agent-ops/READINESS_MATRIX.md`, `7a501a3`).

### Hypotheses (unverified)

- The project-memory + session-log pair will let a fresh session resume with little re-discovery. Only one session exists at G0; test at the first session handoff (S1).
- The doc-drift guard will prevent docs from lagging code once `main` exists; so far it has only run on a probe.
- The Node `>=22.18` engine minimum will surface a clear failure for contributors on older runtimes (review-focus risk in `SPRINT-00.md`; never observed).
- A 4.6:1 target (vs. the 4.5:1 threshold) protects against rounding when tokens are converted between formats. The margin was used; its necessity was not tested.
- Theme-scoped tokens will make a dark theme a role-map addition without component changes. Only one theme exists (decision D2).
- Owner acceptance of the AA-adjusted tokens (D1) is still pending; the visual delta being "acceptable" is unconfirmed.

### Skills created

| Skill | Version | Confidence | Purpose |
|---|---|---|---|
| [`accessible-brand-tokens`](skills/accessible-brand-tokens/SKILL.md) | 0.1.0 | medium | Brand kit → accessible, theme-scoped tokens with contrast test and generated outputs (includes a dependency-free `references/contrast.mjs`) |
| [`agent-second-memory`](skills/agent-second-memory/SKILL.md) | 0.1.0 | medium | Repository memory files and CI doc checks for multi-session agent work (templates: memory files, link check, doc drift) |
| [`vendoring-agent-skills`](skills/vendoring-agent-skills/SKILL.md) | 0.1.0 | medium | Review, pin, record and rank third-party agent skills (template: `SOURCES.md`) |
| [`verify-dependencies-against-registry`](skills/verify-dependencies-against-registry/SKILL.md) | 0.1.0 | medium | Stack pinning against live registry data with deviations recorded in an ADR |

No existing skills were updated (catalog was empty).

### Proposals for the owner

- G0 is not an Orcasus-PR checkpoint; no PR is proposed.
- Future Orcasus candidates (reassess at G2 once each has been reused at least once more): `agent-second-memory` (fits the Orcasus "records" practice), `vendoring-agent-skills` (complements rule precedence), `verify-dependencies-against-registry` (a natural addendum to `project-discovery`). `accessible-brand-tokens` is a domain skill and fits a design-system library better than Orcasus.
- Record evidence that would raise confidence: note the scan commands used when reviewing vendored scripts; log the first cross-session handoff in `SESSION_LOG.md` with what the new session had to re-discover; record the first real doc-drift failure in CI.
- Answer D1 so the token decision can move from default to accepted.
