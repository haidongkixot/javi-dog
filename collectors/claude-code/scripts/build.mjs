// Bundles the `javi` CLI into one self-contained ESM file: dist/javi.mjs (JD-C01, S3f P1).
// Node refuses to strip TypeScript types under node_modules and the @javis-dog/* packages are
// not published, so the tarball ships this single file: workspace packages and zod inlined,
// only `node:` builtins left as imports. No sourcemap (it would carry machine paths).
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const BUNDLE = join(root, 'dist', 'javi.mjs');
const SHEBANG = '#!/usr/bin/env node';

/** Rewrites bare builtin imports (`fs`) to `node:fs`, so the bundle only names `node:` ids. */
const nodePrefix = {
  name: 'node-prefix',
  setup(b) {
    const bare = new Set(builtinModules.filter((m) => !m.startsWith('node:')));
    b.onResolve({ filter: /^[a-z_/]+$/ }, (args) =>
      bare.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined,
    );
  },
};

export const buildBundle = async () => {
  await mkdir(dirname(BUNDLE), { recursive: true });
  const started = Date.now();
  await build({
    absWorkingDir: root,
    entryPoints: ['src/cli.ts'],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // esbuild keeps the entry's hashbang (cli.ts has one); checked below, never duplicated.
    define: { __JAVI_BUNDLED__: 'true' },
    plugins: [nodePrefix],
    sourcemap: false,
    minify: false,
    legalComments: 'eof',
    charset: 'utf8',
    logLevel: 'warning',
  });

  const text = await readFile(BUNDLE, 'utf8');
  const lines = text.split('\n');
  if (lines[0] !== SHEBANG || lines.slice(1).some((l) => l.startsWith('#!'))) {
    throw new Error(`${BUNDLE}: expected exactly one "${SHEBANG}" line, at the top.`);
  }
  if (text.includes(root)) throw new Error(`${BUNDLE} contains a machine path.`);
  await chmod(BUNDLE, 0o755);
  const { size } = await stat(BUNDLE);
  return { path: BUNDLE, size, ms: Date.now() - started };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { size, ms } = await buildBundle();
  console.log(`Built dist/javi.mjs: ${(size / 1024).toFixed(1)} KiB in ${ms} ms`);
}
