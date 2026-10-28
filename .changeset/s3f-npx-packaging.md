---
'@javis-dog/collector-claude-code': minor
---

S3f packaging: `pnpm build` produces a self-contained `dist/javi.mjs`; `pnpm pack:cli` produces a dependency-free, private `javis-dog-javi-<version>.tgz` that runs with `npx ./javis-dog-javi-<version>.tgz`; `javi init` from the bundle installs a stable copy under `~/.javi/bin` and registers hooks there; the CLI entry check follows the `node_modules/.bin` symlink.
