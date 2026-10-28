# Sprint 03f — `npx` packaging of `javi` + Guru G2

- Dates: 2026-10-28 (timebox 30 min) · Status: **CLOSED** 2026-10-28 (CI green on `488bde9`, run 40622140903); Windows behaviour UNVERIFIED
- Goal: `javi` runs from one self-contained tarball (`npx ./javis-dog-javi-<version>.tgz init …`), and hooks keep working after the `npx` cache is gone; then the G2 Guru checkpoint closes S3.
- Modules touched: JD-C01, docs, `guru/`
- Readiness gate: owner decision 2026-10-28 "Bundle + tarball" (no npm publish); esbuild is already in the lockfile (no new external package)
- Test plan: `docs/agent-ops/TEST_PLAN.md` §S3f

## Global constraints

- No npm publish, no registry access needed at install time (the tarball has no dependencies).
- The bundle contains no secrets and no machine paths; screenshot budget 0.
- Repository-checkout use (`node collectors/claude-code/src/cli.ts`) keeps working unchanged.

## Backlog

| # | Task | Module | Interfaces (consumes → produces) | Acceptance criteria | Status |
|---|---|---|---|---|---|
| P1 | Bundle | JD-C01 | `pnpm --filter @javis-dog/collector-claude-code build` → `dist/javi.mjs` | One ESM file with a `#!/usr/bin/env node` line; workspace packages and `zod` inlined; Node ≥ 22; no `node_modules` needed at runtime | Done |
| P2 | Tarball | JD-C01 | `pack:cli` → `dist/pkg/` manifest (`bin: { javi }`, no dependencies) → `javis-dog-javi-<version>.tgz` | Installs offline from the tarball; `javi` bin runs through the `node_modules/.bin` symlink (main detection uses the real path) | Done |
| P3 | Stable install path | JD-C01 | `javi init` from a bundle → copies itself to `~/.javi/bin/<version>/javi.mjs` (0700 dir; versioned after review) and registers hooks there | Hooks never point into an `npx` cache; re-init replaces the copy atomically; repo-checkout init unchanged | Done |
| G2 | Guru checkpoint | `guru/` | S3a–S3f history → skills / wisdom log | Per `CLAUDE.md` §7; Orcasus PR proposal written, not opened | Done |

## Review focus

- `npx` runs the bin through a symlink → the CLI must still run (`main` detection) — P2 test.
- The `npx` cache is cleared after `init` → hooks still run (`~/.javi/bin`) — P3 test.
- The tarball installs without network (no dependencies) — P2 test.

## Team

Roster per `docs/agent-ops/TEAM.md`.

| Role | Agent | Lane / paths |
|---|---|---|
| Orchestrator + Secretary | main session | plan, `package.json`/lockfile, `.gitignore`, docs, merge, push |
| Developer | general-purpose, worktree | P1–P3: `collectors/claude-code/{scripts/**,src/cli.ts,test/pack.test.ts,README.md}` |
| Reviewer | general-purpose, read-only | packaging diff |
| Guru | `javi-guru` | G2 |

Team log, newest first:

- 2026-10-28 — Orchestrator — G2 findings acted on: (F1) CI red on three S3e docs pushes, `usage-process.test.ts:120`. Hypothesis "idle timer vs start-up" first NOT reproduced at 300 ms, then reproduced at 60 ms (same assertion, same shape); a second path (probe timeout → false port conflict, our own receiver marked foreign → 10 min back-off) fixed in `receive` (live recorded pid on the port = ours), red-first test. Test redesigned: SIGTERM instead of idle in the two-instance case; idle case 4 s. Mutation (60 ms idle) now passes; 3 forced parallel repo runs 648/648. (F2) CI `cancel-in-progress` only for pull requests now. (F3/F4) readiness header, purge row, decision paragraph and PROJECT_MEMORY refreshed.
- 2026-10-28 — Guru — G2: 8 suggested lessons verified, 2 new findings (F1 flaky CI not recorded; F2 cancelled run left a pushed deploy unevaluated) + stale memory (F3/F4); 5 new skills, 5 updated; Orcasus PR proposal (4 optional skills) — proposal only.
- 2026-10-28 — Orchestrator — Merged review fixes (`1a79b7e`, declared paths only). Fixed in own files: S3f changeset, `module.json` provides, em dash in `package.json` (my JSON rewrite had escaped it).
- 2026-10-28 — Developer — Review fixes 1–9: copy before credentials/hooks with a clear error and rename retry; versioned `~/.javi/bin/<version>/`; dual main detection; npm cache/logs/notifier in temp dirs (`~/.npm/_logs` 11 → 11); `--out` dirs; Windows npm invocation without unquoted shell args (UNVERIFIED on Windows); `THIRD_PARTY_NOTICES.md` from the esbuild metafile (zod 4.6.7); path guard incl. repo root and home. Red first: 9 FAIL / 3 PASS. 294 tests ×2.
- 2026-10-28 — Reviewer — 2 major (silent half-done `init` when the copy fails; one shared copy → last `init` wins incl. downgrade), 6 minor, nits; verified determinism, offline install, real `npx --offline` init, 18 parallel inits + 45 hooks on Linux.
- 2026-10-28 — Orchestrator — Merged P1–P3 (`2e7d23b`). Inspected the tarball: 3 files, no dependencies, one shebang, only `node:` imports, no machine paths or secret patterns. Set the generated manifest to `private: true` (owner: no npm publish; `npm publish --dry-run` does not exercise that guard — documented npm behaviour, not tested). `docs:check` failed on the generated `dist/pkg/README.md` (CI would too: `pack.test.ts` creates it before `docs:check`) → markdownlint ignores `**/dist/**`, README link made lint-clean.
- 2026-10-28 — Developer — P1–P3; mutation: old main detection → 2 of 3 pack tests FAIL; bundle 742.6 KiB unminified (readable for privacy review), tarball 135.8 kB, deterministic build (~85 ms).
- 2026-10-28 — Orchestrator — Found before implementation: `cli.ts` main detection compares `import.meta.url` with `argv[1]`, which is a symlink under `npx` → the CLI would do nothing. Added to P2 acceptance. Verified earlier: Node refuses type stripping under `node_modules` (a bundle is required).

## Log

- 2026-10-28 — CI **PASS** on `4c0577f` (40621503840) and `488bde9` (40622140903); production `/api/health` ok on `488bde9`. Sprint closed.
- 2026-10-28 — CI **PASS** on `f7390b7` (run 40619993961); run 40619965768 on `d45cc4c` (pushed with a failing `docs:check` — gate command did not stop on that step) was cancelled by the newer push. Gate steps are chained with `&&` since.
- 2026-10-28 — P1–P3 merged; gate 631 tests; pushing for CI.

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| `pnpm --filter @javis-dog/collector-claude-code test` (Developer, 2 runs) | 0 | ~11 s | 278 | 0 | 0 | 0 | 0 | `test/pack.test.ts` 3 |
| Mutation: old `argv[1]` main detection | 1 | — | 276 | 2 | 0 | 0 | 0 | symlinked bin did nothing; restored |
| Tarball inspection (`tar tzf`, path/secret grep, bare-import grep) | 0 | — | 3 files, 0 hits | 0 | 0 | 0 | 0 | — |
| Review fixes: new tests against the old code (red first) | 1 | — | 3 | 9 | 0 | 0 | 0 | — |
| Repro: idle 60 ms, old two-instance test | 1 | — | 0 | 1 | 1 | 0 | 0 | `expected +0 to be <pid>` at :120, as in CI |
| New test: probe timeout + live recorded pid (red first) | 1 | — | 0 | 1 | 16 | 0 | 0 | false `portConflict` recorded |
| After fix: same mutation (idle 60 ms) | 0 | — | 1 | 0 | 1 | 0 | 0 | no idle dependence |
| `pnpm test --force` ×3 (turbo parallel) | 0 | — | 648 ×3 | 0 | 0 | 0 | 0 | — |
| Full gate `format:check` / `lint` / `typecheck` / `test` / `build` / `docs:check` | 0 | — | 631 tests | 0 | 0 | 0 | 0 | after the `dist/` markdownlint fix |

## Decisions and deviations

- Owner: bundle + tarball, no npm publish; generated manifest `private: true`.
- Bundle left unminified so the shipped code stays reviewable for privacy.
- Deviation: `d45cc4c` was pushed with a failing `docs:check` (gate command not chained); fixed by `f7390b7` within minutes; CI on `d45cc4c` was cancelled, never green.
- CI concurrency: branch pushes are no longer cancelled (Guru G2-F2); pull requests still are.
- Proposal to owner (G2): add the fetch/one-pusher rule to `CLAUDE.md` (today only in TEAM.md).
- UNVERIFIED: Windows behaviour (npm invocation, quoting, rename retry under AV, `.cmd` shim) — needs the owner's Windows machine.

## Retro

- Went well: reviewer probes and red-first fixes; the packaging trap (`npx` symlinked bin) was caught at planning; Guru G2 audited CI history and found what the sprint records missed.
- Hurt: three red CI runs on docs pushes went unnoticed — CI was only checked on code pushes; one push went out with a failing `docs:check` because the gate command was not chained.
- Change next sprint: check CI on **every** push before reporting; gate commands chained with `&&`; record each CI run id in the sprint log.

## Guru checkpoint

G2 — see `guru/WISDOM_LOG.md`.
