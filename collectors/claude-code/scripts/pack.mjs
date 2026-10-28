// Packs the bundled `javi` CLI into dist/javis-dog-javi-<version>.tgz (JD-C01, S3f P2).
// Owner decision 2026-10-28: no npm publish, a tarball only. The package has no dependencies,
// so `npx ./javis-dog-javi-<version>.tgz …` installs without registry access.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkgDir = join(dist, 'pkg');

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const NAME = 'javis-dog-javi';

const README = `# javi — Javi's Dog collector for Claude Code

\`javi\` sends Claude Code lifecycle, tool and attention signals to Javi's Dog as operational
metadata only: never prompts, tool inputs or outputs, file paths or transcripts.

This tarball is one self-contained file (Node.js 22 or newer, no dependencies).

Create an ingest token on the project page in Javi's Dog, then in your project directory:

\`\`\`sh
JAVI_INGEST_TOKEN='<paste token>' npx ./${NAME}-${version}.tgz init --project <project-slug>
\`\`\`

\`init\` copies javi to \`~/.javi/bin/javi.mjs\` and points the project's Claude Code hooks there,
so they keep working after the npx cache is cleared.

Commands, what is sent and how to opt in to token usage: see \`collectors/claude-code/README.md\`
in the Javi's Dog repository, <https://github.com/haidongkixot/javi-dog>.
`;

const manifest = {
  name: NAME,
  version,
  description: "Javi's Dog collector for Claude Code: the javi CLI and its command hooks",
  type: 'module',
  bin: { javi: 'javi.mjs' },
  files: ['javi.mjs', 'README.md'],
  engines: { node: '>=22' },
  license: 'UNLICENSED',
  private: true,
};

const { size } = await buildBundle();
await rm(pkgDir, { recursive: true, force: true });
await mkdir(pkgDir, { recursive: true });
await copyFile(join(dist, 'javi.mjs'), join(pkgDir, 'javi.mjs'));
await writeFile(join(pkgDir, 'README.md'), README);
await writeFile(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const tarball = join(dist, `${NAME}-${version}.tgz`);
await rm(tarball, { force: true });
execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', dist], {
  cwd: pkgDir,
  stdio: ['ignore', 'ignore', 'inherit'],
  shell: process.platform === 'win32',
});
await readFile(tarball).catch(() => {
  throw new Error(`npm pack did not produce ${tarball}`);
});
console.log(`Bundle: ${(size / 1024).toFixed(1)} KiB`);
console.log(`Packed ${tarball}`);
