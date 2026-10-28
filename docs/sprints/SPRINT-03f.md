# Sprint 03f — `npx` packaging of `javi` + Guru G2

- Dates: 2026-10-28 (timebox 30 min) · Status: **ACTIVE**
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
| P1 | Bundle | JD-C01 | `pnpm --filter @javis-dog/collector-claude-code build` → `dist/javi.mjs` | One ESM file with a `#!/usr/bin/env node` line; workspace packages and `zod` inlined; Node ≥ 22; no `node_modules` needed at runtime | Planned |
| P2 | Tarball | JD-C01 | `pack:cli` → `dist/pkg/` manifest (`bin: { javi }`, no dependencies) → `javis-dog-javi-<version>.tgz` | Installs offline from the tarball; `javi` bin runs through the `node_modules/.bin` symlink (main detection uses the real path) | Planned |
| P3 | Stable install path | JD-C01 | `javi init` from a bundle → copies itself to `~/.javi/bin/javi.mjs` (0700 dir) and registers hooks there | Hooks never point into an `npx` cache; re-init replaces the copy atomically; repo-checkout init unchanged | Planned |
| G2 | Guru checkpoint | `guru/` | S3a–S3f history → skills / wisdom log | Per `CLAUDE.md` §7; Orcasus PR proposal written, not opened | Planned |

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

- 2026-10-28 — Orchestrator — Found before implementation: `cli.ts` main detection compares `import.meta.url` with `argv[1]`, which is a symlink under `npx` → the CLI would do nothing. Added to P2 acceptance. Verified earlier: Node refuses type stripping under `node_modules` (a bundle is required).

## Log

## Test evidence

| Command | Exit | Duration | PASS | FAIL | SKIPPED | BLOCKED | NOT RUN | Artifacts |
|---|---:|---:|---:|---:|---:|---:|---:|---|

## Decisions and deviations

## Retro

## Guru checkpoint

G2 — see `guru/WISDOM_LOG.md`.
