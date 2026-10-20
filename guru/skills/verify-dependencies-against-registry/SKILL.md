---
name: verify-dependencies-against-registry
description: Choose and pin a dependency stack against the live package registry instead of memory or a plan draft — check release channels (latest vs beta/rc), peer-dependency and engine ranges between tools (linters, type checkers, compilers, framework plugins), avoid pre-release versions for security-critical modules, pin exact versions, and record deviations with revisit triggers in an ADR. Use when scaffolding a new project or monorepo, writing a technology-stack ADR, adding or upgrading a major dependency, choosing an auth/crypto/payments library, when a plan names a library version you have not checked, or when installs fail with peer-dependency or engine conflicts.
metadata:
  version: "0.1.0"
  origin: "javis-dog G0"
  confidence: medium
---

# Verify dependencies against the live registry

Plans, tutorials and model knowledge name libraries and versions that were true at some point. The registry is the only thing that says what is true today: which line is stable, which is still beta, and which tools actually accept each other. A stack chosen from memory tends to fail in two ways — it builds on a pre-release where stability matters, or it combines versions whose peer ranges exclude each other.

The habit: **before a version goes into a manifest or an ADR, ask the registry, and write down what it said and when.**

## Workflow

### 1. List the decisions, not just the packages

For each concern (framework, language/compiler, lint, test runner, auth, database client, ORM, email, styling), write the candidate library and the version line you intend. Mark the ones that are **security-critical** (authentication, sessions, cryptography, payments, input parsing at trust boundaries) — the bar for those is higher.

### 2. Query release channels

For each candidate, read the registry's release channels and recent versions. Look for:

- **Is the intended major on the stable channel?** A version that is only published under a `beta`, `rc`, `next` or `canary` tag is a pre-release, whatever the docs' front page says.
- **How old is the line, and when was it last published?** Very fresh majors and long-silent packages are both worth a note.

| Ecosystem | Release channels / versions | Peer, engine and runtime constraints |
|---|---|---|
| npm / pnpm / yarn | `npm view <pkg> dist-tags --json` | `npm view <pkg>@<ver> peerDependencies engines --json` |
| PyPI | `https://pypi.org/pypi/<pkg>/json` (`info.version`, `releases`) | same JSON: `info.requires_python`, `info.requires_dist` |
| Go modules | `go list -m -versions <module>` | `go.mod` `go` directive of the module |
| crates.io | `cargo info <crate>` (recent cargo) or `cargo search <crate>` | `rust-version` in the crate's manifest |
| RubyGems | `gem list <gem> --remote --all` | `gem specification <gem> -r` (`required_ruby_version`, dependencies) |

### 3. Check the cross-tool ranges

The common breakages are between tools that wrap each other: a linter plugin and the compiler it parses with, a framework and its official plugins, a test runner and its transformer, a type-definition package and the runtime. For each pair, read the peer or engine range of the *wrapping* tool and pick a version of the wrapped tool inside it. The newest compiler is the wrong choice if your linter's parser does not support it yet; pin the compiler to the newest version inside the range and note when to revisit.

Also check the runtime: if a script relies on a runtime feature introduced in a specific minor version (for example, running TypeScript directly), declare that minimum in the project's engine field and version file, and make CI read the same file.

### 4. Choose stable for security-critical modules

If the intended library for a security-critical concern is only available as a pre-release, prefer a stable alternative with the required features, and hide it behind your own module interface so the choice stays reversible. Pre-releases are fine for low-risk tooling when you accept the churn — say so explicitly.

### 5. Prefer hermetic builds

Avoid dependencies that download assets at build time (fonts, binaries, schemas) when an installable package provides the same thing. A build that needs the network fails in sandboxed CI and is harder to reproduce.

### 6. Pin and lock

Pin exact versions in manifests for tools that affect output (compiler, linter, formatter, test runner) and commit the lockfile. Install with the frozen-lockfile mode in CI so the registry check you did is the one CI uses.

### 7. Record it in the stack ADR

In the technology-stack decision record:

- State the verification: "versions verified against the `<registry>` on `<date>`".
- One row per concern: choice, version line, note.
- A **deviation** subsection for every place the stack differs from the plan or the obvious default, with the registry evidence (e.g. "`<lib>@5` is only published as `5.0.0-beta.N`; `latest` is 4.x").
- **Revisit triggers**: "re-evaluate compiler 7 when the linter's parser supports it", "adopt ORM 1.0 at stable".

Why record it: the next person (or agent) will read the plan, see the newer version and "upgrade" it. The ADR is what stops a silent regression into the incompatibility you already avoided.

## Pitfalls

- **Trusting the docs site's version banner.** Docs often lead the stable channel by months.
- **Installing first, reading peer warnings later.** Some package managers only warn; the breakage shows up at lint or build time.
- **Floating ranges for toolchain packages.** A caret range on the compiler lets a fresh install pull a version your linter rejects.
- **Unrecorded checks.** A registry query that is not written down will be redone, or worse, contradicted from memory.

## Evidence from origin project

Javi's Dog, Sprint 0 (2026-10-20). Confidence **medium**: one stack decision, two concrete catches, re-checked against the registry at G0.

- ADR: `docs/adr/0002-technology-stack.md` (`7a501a3`) — "versions verified against the npm registry on 2026-10-20"; auth deviation (plan draft named Auth.js v5; `next-auth@5` only published as `5.0.0-beta.32`, `latest` 4.24; Better Auth 1.7 chosen, hidden behind the identity module's contract); TypeScript 5.9 pinned because `typescript-eslint` supports `<6.1`; revisit triggers for TypeScript 7 and Drizzle 1.0.
- Discovery findings 2 and 3: `docs/agent-ops/DISCOVERY_SUMMARY.md` (`7a501a3`).
- Pins: root `package.json` (`d011b8d`) — `typescript` 5.9.3, `typescript-eslint` 8.72.0, `engines.node` `>=22.18`, `packageManager` pnpm 10.28.0; `.nvmrc` 22; CI installs with `--frozen-lockfile` and reads `.nvmrc`.
- Hermetic build: the font moved from a build-time Google Fonts download to a self-hosted npm package (`d011b8d`; ADR-0002 row "Font").
- Recorded outcome: lint, typecheck, test and build exit 0 on a fresh run (`docs/sprints/SPRINT-00.md`, Test evidence); retro credits registry pinning with avoiding a beta auth library and a TypeScript/ESLint incompatibility.
- Re-check at G0 (2026-10-20, read-only `npm view`): `typescript-eslint@8.72.0` peer `typescript` is `>=4.8.4 <6.1.0`; `typescript` `latest` is 7.0.2; `next-auth` `latest` is 4.24.15 and `beta` is 5.0.0-beta.32 — consistent with the ADR.
- Hypothesis (not yet observed): the Node minimum (`>=22.18`, needed for TypeScript type-stripping in token scripts) will catch contributors on older runtimes; listed as a review-focus risk in `docs/sprints/SPRINT-00.md`.
