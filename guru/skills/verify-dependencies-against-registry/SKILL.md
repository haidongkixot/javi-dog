---
name: verify-dependencies-against-registry
description: Choose and pin a dependency stack against the live package registry and the installed code instead of memory or a plan draft — check release channels (latest vs beta/rc), peer-dependency and engine ranges between tools (linters, type checkers, compilers, framework plugins), avoid pre-release versions for security-critical modules, apply a release-age cooldown plus an advisory check before pinning, read the installed package's type definitions and source before designing an integration, keep code runnable by a runtime's built-in type stripping, pin exact versions, and record deviations with revisit triggers in an ADR. Use when scaffolding a new project or monorepo, writing a technology-stack ADR, adding or upgrading a major dependency, choosing or integrating an auth/crypto/payments library, mapping a library's data model onto existing tables, when a plan names a library version or option you have not checked, when scripts run TypeScript directly through Node's built-in type stripping, or when installs fail with peer-dependency or engine conflicts.
metadata:
  version: "0.2.1"
  origin: "javis-dog G0; updated G1, G2-prep, G4"
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

If scripts run through **Node's built-in type stripping**, the runtime only erases type annotations; TypeScript syntax that generates code — constructor parameter properties (`constructor(readonly code: string)`), `enum`, runtime `namespace` — is a syntax error at run time, while a normal type check accepts it. Turn on the compiler option that rejects such syntax (`erasableSyntaxOnly`, TypeScript 5.8+) in the shared base config so the type check fails first.

### 4. Choose stable for security-critical modules

If the intended library for a security-critical concern is only available as a pre-release, prefer a stable alternative with the required features, and hide it behind your own module interface so the choice stays reversible. Pre-releases are fine for low-risk tooling when you accept the churn — say so explicitly.

### 5. Apply a release-age cooldown and check advisories

Within the chosen line, pin the **newest release older than a fixed age** (the origin used two weeks), not the newest release, and query the ecosystem's advisory database for both the version you pin and the newest one before you decide. Record the rule, the publish dates and the advisory result in the ADR or iteration record.

- Publish dates: `npm view <pkg> time --json` (PyPI JSON has `upload_time` per file).
- Advisories: `npm audit` against a lockfile that contains the candidate, or the GitHub Advisory Database for the package and version.
- To enforce the age automatically with pnpm, the `minimumReleaseAge` setting (minutes) exists in pnpm 10.28 (seen in its source at G2-prep; not exercised in the origin).

The origin's rationale for the cooldown is not recorded. The usual argument — broken or malicious releases are often found and yanked within days — is a hypothesis here; no prevented incident was observed.

### 6. Prefer hermetic builds

Avoid dependencies that download assets at build time (fonts, binaries, schemas) when an installable package provides the same thing. A build that needs the network fails in sandboxed CI and is harder to reproduce.

### 7. Pin and lock

Pin exact versions in manifests for tools that affect output (compiler, linter, formatter, test runner) and commit the lockfile. Install with the frozen-lockfile mode in CI so the registry check you did is the one CI uses.

### 8. Read the installed package before designing the integration

Docs, blog posts and model memory describe *some* version. After installing the pinned version, read its shipped type definitions (`.d.ts`, `.d.mts`, `.pyi`) and, where those are thin, its source, and answer the integration questions from them before writing the design:

- **Identifiers:** how ids are generated and whether you can choose the format (UUID vs. random string) to match existing tables.
- **Data model mapping:** whether the library's models and field names can be mapped onto tables you already have (model-name and field-name options), so you do not create a parallel copy of an existing entity.
- **Driver capabilities:** whether its database adapter needs interactive transactions, and whether your driver (for example an HTTP-based serverless driver) supports them; most adapters have a switch.
- **Security flags and their coverage:** which fields an "encrypt tokens" or "hash secrets" option actually covers. Treat uncovered fields as stored in plain text until a row check proves otherwise (see the `prove-secrets-and-pii-minimization` skill).
- **Hooks:** logger, error redirect and database hooks you will need for logging, error pages and minimization.
- **Telemetry:** whether it phones home, and how to turn it off.

Write the answers, with the version they apply to, into the decision record. They become the checklist for the next upgrade.

### 9. Record it in the stack ADR

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
- **Tool configs outside the type check.** A new major of a tool can drop a config option that the tool itself then ignores without an error. Include tool config files (`*.config.ts` or equivalent) in the type-check scope so a removed option fails a gate instead of silently doing nothing.
- **Type check passes, runtime stripping fails.** Non-erasable TypeScript syntax type-checks but crashes when run through Node's type stripping; enable `erasableSyntaxOnly`.
- **Newest-release reflex.** Pinning a release published yesterday skips the window in which broken releases are usually found; apply the cooldown rule.
- **Designing from the docs site.** Option names and defaults drift between minor versions; read the installed types.

## Evidence from origin project

Javi's Dog, Sprint 0 (2026-10-20), extended in Sprints 1a–2b. Confidence **medium**: one stack decision with two concrete catches, plus a cooldown rule applied twice, one installed-source reading and one type-stripping catch — each verified, none repeated across projects.

- ADR: `docs/adr/0002-technology-stack.md` (`7a501a3`) — "versions verified against the npm registry on 2026-10-20"; auth deviation (plan draft named Auth.js v5; `next-auth@5` only published as `5.0.0-beta.32`, `latest` 4.24; Better Auth 1.7 chosen, hidden behind the identity module's contract); TypeScript 5.9 pinned because `typescript-eslint` supports `<6.1`; revisit triggers for TypeScript 7 and Drizzle 1.0.
- Discovery findings 2 and 3: `docs/agent-ops/DISCOVERY_SUMMARY.md` (`7a501a3`).
- Pins: root `package.json` (`d011b8d`) — `typescript` 5.9.3, `typescript-eslint` 8.72.0, `engines.node` `>=22.18`, `packageManager` pnpm 10.28.0; `.nvmrc` 22; CI installs with `--frozen-lockfile` and reads `.nvmrc`.
- Hermetic build: the font moved from a build-time Google Fonts download to a self-hosted npm package (`d011b8d`; ADR-0002 row "Font").
- Recorded outcome: lint, typecheck, test and build exit 0 on a fresh run (`docs/sprints/SPRINT-00.md`, Test evidence); retro credits registry pinning with avoiding a beta auth library and a TypeScript/ESLint incompatibility.
- Re-check at G0 (2026-10-20, read-only `npm view`): `typescript-eslint@8.72.0` peer `typescript` is `>=4.8.4 <6.1.0`; `typescript` `latest` is 7.0.2; `next-auth` `latest` is 4.24.15 and `beta` is 5.0.0-beta.32 — consistent with the ADR.
- Hypothesis (not yet observed): the Node minimum (`>=22.18`, needed for TypeScript type-stripping in token scripts) will catch contributors on older runtimes; listed as a review-focus risk in `docs/sprints/SPRINT-00.md`.
- G1 update (2026-10-20): in Sprint 1a the test runner's config contained an `esbuild.jsx` option the runner's current major no longer accepts; the test run did not fail, the workspace type check did, and the option was removed (`docs/sprints/SPRINT-01a.md`, Log and Retro, `0235df1`). Which config file held the option is not recorded. At G1, `apps/web/tsconfig.json` includes root `*.ts` files (so its `vitest.config.ts` is type-checked), while `packages/ui/tsconfig.json` includes only `src`, `scripts` and `test` — the same mistake in the UI package's runner config would not be caught. Verified once.
- G2-prep update (2026-10-22, Sprints 2a–2b):
  - Cooldown and advisories: Better Auth pinned to 1.7.7, "newest 1.7.x older than two weeks", npm advisory DB with no entries for 1.7.7 or the newest 1.7.12 (ADR-0006; `docs/sprints/SPRINT-02b.md`); `@electric-sql/pglite` 0.5.8 by the same rule (`docs/sprints/SPRINT-02a.md`). Re-checked at G2-prep with `npm view <pkg> time --json`: Better Auth 1.7.7 was published 2026-09-30 and 1.7.8 on 2026-10-14 (8 days before the pin); PGlite 0.5.8 on 2026-08-26 and 0.5.9 on 2026-10-12 — both pins match the rule. Applied twice; no prevented incident observed.
  - Installed-source reading: the S2b log records reading Better Auth 1.7.7's installed source for id generation (`uuid`), organization schema mapping, the drizzle adapter `transaction` switch, `encryptOAuthTokens`, IP tracking and telemetry; S2c confirmed `onAPIError.errorURL` and `logger.log` the same way. The mapping of the library's organization model onto an existing `workspaces` table worked on the first try (`SPRINT-02b.md` Retro; `packages/identity/src/auth.ts`, `a55b415`). The same reading did not reveal that the encryption flag leaves the OIDC `id_token` in plain text; a row check after the first real sign-in did (`24231a5`).
  - Type stripping: the first smoke run of a migration script failed because Node's type stripping rejected a constructor parameter property; `erasableSyntaxOnly` was enabled workspace-wide (`tsconfig.base.json`, `dc6ef61`; `SPRINT-02a.md` Log; ADR-0005 *Changes*). Reproduced at G2-prep with Node 22.22.0 and TypeScript 5.9.3: the runtime rejects a parameter property and an `enum`; `tsc --noEmit` exits 0 without the flag and 2 with it (TS1294).
- G4 update (2026-10-29, Sprint 5c): a TOML parser (smol-toml 1.9.1, BSD-3-Clause, no dependencies, exact pin) was added to the CLI after an owner decision ("Add a TOML parser") at the design review, with its licence in the bundle's third-party notices (`docs/adr/0016-gemini-and-codex-collectors.md` *Changes* D0 H6; `2a1131d`; `docs/sprints/SPRINT-05c.md` Team log). No registry or advisory check is recorded. Guru's read-only `npm view` at G4: 1.9.1 is `latest`, published 2026-10-09 (20 days before adoption, so it passes a two-week cooldown), licence BSD-3-Clause; advisory check NOT RUN. The sprint's own constraint line still says "No new external package" — record the exception where the constraint is written, in the same commit as the lockfile change.
