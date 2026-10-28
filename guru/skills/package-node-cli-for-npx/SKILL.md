---
name: package-node-cli-for-npx
description: Ship a Node.js CLI written in TypeScript (often inside a monorepo) as one self-contained tarball that runs with `npx ./<name>.tgz` or `npm install --offline` — bundle to a single ESM file with the workspace packages inlined, keep only `node:` imports, generate a dependency-free private manifest, ship third-party licence notices for inlined code, detect "am I main?" through the real path because package-manager bins are symlinks, copy the CLI to a stable, versioned per-user path before registering it in hooks or another tool's config (the npx cache is temporary), keep generated `dist/` files out of repo-wide linters, and test it all at the process layer. Use when packaging a CLI, collector, agent helper or dev tool for npx/npm/pnpm dlx without publishing, when a CLI "does nothing" when run through `node_modules/.bin`, when Node refuses to run `.ts` files from `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), when a tool registers its own path in hooks, cron, shell profiles or editor settings, or when generated files break lint in CI.
metadata:
  version: "0.1.0"
  origin: "javis-dog G2"
  confidence: "medium (implemented, reviewed and process-tested once; two pitfalls re-probed at G2)"
---

# Package a Node CLI for npx

Running a TypeScript CLI from a repository checkout hides three packaging traps: Node's built-in type stripping does not apply under `node_modules`; package managers expose bins as symlinks, which breaks the common "is this file the entry point?" check; and `npx` installs into a cache that can disappear, so any path you register elsewhere must not point into it.

The rule: **ship one plain-JavaScript file, detect main by real path, register a stable copy, and test the installed package as a user would run it.**

## 1. Bundle to one file

- Bundle the entry with a bundler (the origin used esbuild, already in its lockfile): `platform: node`, `format: esm`, a Node target matching your engines field, workspace packages and runtime dependencies inlined.
- Rewrite bare built-in imports to the `node:` prefix (a small resolver plugin), so a scan can assert "nothing but `node:` imports".
- Keep exactly one shebang (`#!/usr/bin/env node`) as the first line; some bundlers keep the entry's hashbang, so check you do not add a second.
- Consider leaving it unminified: reviewers can read what a privacy-sensitive tool does (the origin's bundle: about 740 KiB unminified, about 136 kB as a tarball).
- Make the build deterministic and fast enough to run in CI on every push.
- Make the build **fail** when the bundle contains the package directory, repository or home path (bundlers can inline absolute paths), and when the version constant compiled into the CLI differs from the manifest version.
- Bundling inlines third-party code, so its licences must ship with it: generate a `THIRD_PARTY_NOTICES` file from the bundler's metafile (every bundled package and its licence text) and fail the pack step when a bundled package has no licence file.

Why a bundle: Node (22.x) refuses type stripping for files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a package that ships `.ts` sources cannot run from an install even if it runs from your checkout.

## 2. Generate a minimal, private manifest

Generate the package manifest in `dist/pkg/`: `name`, `version`, `type: module`, `bin`, `engines`, the files list, **no dependencies**, and `private: true` if you do not intend to publish (npm refuses to publish private packages; a dry-run publish does not exercise that guard, so do not cite it as a test). Pack with `npm pack --ignore-scripts` from that directory into a tarball named after the version.

## 3. Detect main through the real path

```js
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { resolve } from 'node:path';

const isMain = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  const candidates = [resolve(entry)]; // matches under --preserve-symlinks-main
  try { candidates.push(realpathSync(entry)); } catch { /* argv[1] is not a path */ }
  return candidates.some((p) => pathToFileURL(p).href === import.meta.url);
};
if (isMain()) await main(process.argv.slice(2));
```

`import.meta.url` is the real file; `process.argv[1]` is the `.bin` symlink. Comparing them directly makes the CLI exit 0 having done nothing. Accept the resolved `argv[1]` too: with `--preserve-symlinks-main`, `import.meta.url` keeps the symlink path.

## 4. Register a stable copy, never the cache path

If the CLI writes its own path into hooks, another tool's settings, cron or a shell profile, first copy itself to a per-user location and register that path:

- **Versioned:** `~/.<tool>/bin/<version>/<tool>.mjs` (directories 0700), so each project keeps the version it was set up with and an older tarball cannot replace the copy other projects use. Keep a byte-identical existing copy as it is.
- **Atomic:** write a uniquely named temp file, then rename; retry the rename a few times with backoff on transient errors (`EPERM`, `EBUSY`, `EACCES` — typical when another process or a scanner holds the file on Windows); always remove the temp file on failure.
- **Loud, and first:** copy *before* saving credentials or registering hooks; if the copy fails, print one line naming the target path and exit non-zero. Setup is interactive — unlike the hooks it installs, it must not fail silently.
- Print the installed version. A checkout-based setup can keep registering the source entry as before.

## 5. Keep generated files out of repo-wide checks

Tests or builds that write `dist/pkg/README.md` (or any generated file) before your docs linter runs will make the linter fail in CI if its glob is `**/*.md`. Ignore `**/dist/**` in linters, and make generated docs lint-clean anyway.

## 6. Test at the process layer

| Requirement | Test |
|---|---|
| Self-contained bundle | Build, then assert line 1 is the shebang, it appears once, and every `import`/dynamic `import()` specifier starts with `node:` |
| Installs offline, bin runs through the symlink | `npm install --offline --prefix <temp> <tarball>`, run `<temp>/node_modules/.bin/<tool>` (`.cmd` on Windows) and assert it did real work (a known message and exit code) |
| Hooks survive cache removal | Run setup from the installed bundle with a temporary home, delete the install prefix, run the registered hook command, assert exit 0 and the expected side effect |
| Checkout use unchanged | Existing CLI tests |

When spawning `npm` from a test runner started by another package manager, strip inherited `npm_*` environment variables and keep the npm cache and logs in the test's temporary directory, so the parent's settings do not leak in and nothing is written outside it. Build into a temporary output directory (`--out <dir>`) rather than the package's own `dist/`. On Windows, `npm` is a `.cmd` shim: invoke npm's JavaScript entry with `node`, or quote carefully through a shell.

Mutation check: restore the naive `argv[1]` comparison and expect the symlink test to fail.

Before release, inspect the tarball: file list, no machine paths, no secret patterns, no bare imports.

## Pitfalls

- **Testing only from the checkout.** Every trap above is invisible there.
- **`argv[1] === fileURLToPath(import.meta.url)`.** False under `.bin` symlinks.
- **Registering `process.argv[1]` or `import.meta.url` in hooks.** Points into a cache.
- **Lint globs over build output.** CI fails after a test generated a file.
- **One unversioned stable copy.** A re-run from an older tarball silently downgrades every project.
- **Bundled code without its licences.**

## Evidence from origin project

Javi's Dog, Sprint 3f (2026-10-28), a Claude Code collector CLI in a pnpm/Turborepo monorepo, Node 22. Confidence **medium**: implemented and tested once; two pitfalls independently re-probed at G2.

- Type stripping: the orchestrator verified locally that Node refuses type stripping under `node_modules` before planning (`docs/sprints/SPRINT-03e.md` team log). G2 re-probe on Node 22.22.0: the same `.ts` file runs outside `node_modules` and fails inside it with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
- Symlinked bins: found before implementation and added to acceptance (`docs/sprints/SPRINT-03f.md` team log); first fix in `ad0c058` (real-path comparison in `collectors/claude-code/src/cli.ts`). Mutation: the old detection → 2 of 3 pack tests FAIL (276 PASS / 2 FAIL, exit 1). G2 re-probe: through a symlink, naive comparison `false`, real-path comparison `true`.
- Stable copy (first version, `ad0c058`): `~/.javi/bin/javi.mjs` via temp file + rename; the test deletes the install prefix and runs the registered hook (`collectors/claude-code/test/pack.test.ts`).
- Bundle and tarball: `collectors/claude-code/scripts/build.mjs` (esbuild, `node:` rewrite, unminified), `scripts/pack.mjs` (`bin`, no dependencies, `private: true` in `d45cc4c`); 742.6 KiB bundle, 135.8 kB tarball, 3 files; inspection found no machine paths, secret patterns or bare imports (`SPRINT-03f.md` Test evidence).
- Lint: `docs:check` failed on the generated `dist/pkg/README.md` → markdownlint ignores `**/dist/**` (`.markdownlint-cli2.jsonc`, `d45cc4c`).
- Gate after merge: 631 tests, all steps exit 0 (`SPRINT-03f.md`). CI on `f7390b7` green (run 40619993961).
- Review round (`SPRINT-03f.md` team log, `4c0577f`): 2 majors — a silent half-done setup when the copy fails, and one shared copy where the last setup wins including downgrades — 6 minor; the Reviewer also verified deterministic builds, offline install, a real `npx --offline` setup, and 18 parallel setups + 45 hook runs on Linux. Fixes written red-first: 9 FAIL / 3 PASS against the old code, then 294 collector tests green twice.
- Review fixes (`978a668`, merged `1a79b7e`): versioned `bin/<version>/` copy made before saving the token or registering hooks, loud failure with one stderr line and exit 1, byte-identical copies kept, rename retried 5 times on `EPERM`/`EBUSY`/`EACCES`, temp always removed (`collectors/claude-code/src/cli.ts`, `installSelf`, l. 121–162); main detection accepts `realpath` or `resolve` of `argv[1]` (l. 555–567); build checks version equality and rejects bundles containing package, repository or home paths; `THIRD_PARTY_NOTICES.md` from the esbuild metafile, failing without a licence file; npm via its JS entry or a quoted shell on Windows (marked UNVERIFIED on Windows in the commit); tests build into a temp dir and leave the user's npm log directory untouched (11 → 11 files) (`test/install-self.test.ts`, `test/pack-scripts.test.ts`).
- Not verified: install through `npx` from a real user machine, Windows `.cmd`/npm invocation outside the test, and the owner's first real run.
