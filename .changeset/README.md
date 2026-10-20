# Changesets

Every change to a module's public contract (`src/index.ts` exports, HTTP routes, JGR schemas) needs a changeset:

```bash
pnpm changeset
```

Pick the affected `@javis-dog/*` packages and a SemVer bump; describe the change referencing the module ID (e.g. `JD-M13`). Changesets aggregates these into each package's `CHANGELOG.md`.
