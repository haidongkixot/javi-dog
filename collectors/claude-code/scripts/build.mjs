// Bundles the `javi` CLI into one self-contained ESM file: <out>/javi.mjs (JD-C01, S3f P1).
// Node refuses to strip TypeScript types under node_modules and the @javis-dog/* packages are
// not published, so the tarball ships this single file: workspace packages and zod inlined,
// only `node:` builtins left as imports. No sourcemap (it would carry machine paths).
//   node scripts/build.mjs [--out <dir>]     (default: dist/ in this package)
import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(ROOT, '..', '..');
const SHEBANG = '#!/usr/bin/env node';

/** `--out <dir>` (resolved against the working directory), else this package's dist/. */
export const outDir = (argv = process.argv.slice(2)) => {
  const i = argv.indexOf('--out');
  if (i < 0) return join(ROOT, 'dist');
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error('--out needs a directory.');
  return resolve(value);
};

/** package.json and COLLECTOR_VERSION (the version javi reports and installs under) agree. */
export const packageVersion = async () => {
  const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const mapping = await readFile(join(ROOT, 'src', 'mapping.ts'), 'utf8');
  const collector = /export const COLLECTOR_VERSION = '([^']+)';/.exec(mapping)?.[1];
  if (collector !== version) {
    throw new Error(
      `COLLECTOR_VERSION (${collector ?? 'missing'}) in src/mapping.ts must equal the package.json version (${version}).`,
    );
  }
  return version;
};

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

/** The spellings a machine path can take in bundled source (native, `/`, JSON-escaped `\`). */
const spellings = (path) => {
  if (!path || parse(path).root === path) return [];
  return [...new Set([path, path.replace(/\\/g, '/'), path.replace(/\\/g, '\\\\')])];
};

export const buildBundle = async ({ out = join(ROOT, 'dist') } = {}) => {
  const bundle = join(out, 'javi.mjs');
  const version = await packageVersion();
  await mkdir(out, { recursive: true });
  const started = Date.now();
  const { metafile } = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/cli.ts'],
    outfile: bundle,
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
    metafile: true,
  });

  const text = await readFile(bundle, 'utf8');
  const lines = text.split('\n');
  // A bundle that fails a check is removed, so it cannot be packed or copied by mistake.
  const reject = async (message) => {
    await rm(bundle, { force: true });
    throw new Error(`${bundle}: ${message}`);
  };
  if (lines[0] !== SHEBANG || lines.slice(1).some((l) => l.startsWith('#!'))) {
    await reject(`expected exactly one "${SHEBANG}" line, at the top.`);
  }
  for (const [what, path] of [
    ['the package path', ROOT],
    ['the repository path', REPO_ROOT],
    ['the home directory', homedir()],
  ]) {
    if (spellings(path).some((s) => text.includes(s))) {
      await reject(`contains a machine path (${what}).`);
    }
  }
  await chmod(bundle, 0o755);
  const { size } = await stat(bundle);
  return { path: bundle, size, ms: Date.now() - started, metafile, version };
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { path, size, ms } = await buildBundle({ out: outDir() });
  console.log(`Built ${path}: ${(size / 1024).toFixed(1)} KiB in ${ms} ms`);
}
