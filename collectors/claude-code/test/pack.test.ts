import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileSpool } from '@javis-dog/jgr-sdk';
import { COLLECTOR_VERSION, createState } from '../src/index.ts';
import { npmInvocation, quoteWinArg } from '../scripts/npm.mjs';

// S3f P1–P3 process layer (TEST_PLAN §S3f): the real bundle, the real tarball installed by npm
// offline into a temp prefix, and the hook command exactly as init registered it. Everything is
// written under one temp dir: build output (--out), npm cache and logs, JAVI_HOME,
// JAVI_CLAUDE_HOME. The endpoint is a local server answering 401, so nothing leaves this
// machine and the spool is kept (no retries).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = (
  JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const TOKEN = `jd_it_${'K'.repeat(43)}`;
const WIN = process.platform === 'win32';

let temp: string;
let out: string;
let bundle: string;
let tarball: string;
let prefix: string;
let home: string;
let claudeHome: string;
let projectDir: string;
let server: Server;
let endpoint: string;
let requests = 0;
let repoDistBefore: number | null;
let repoDistAfter: number | null;

type Run = { code: number | null; stdout: string; stderr: string };

const run = (
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string; shell?: boolean } = {},
) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? ROOT,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(opts.stdin ?? '');
  });

/**
 * npm without the npm_* variables a pnpm/vitest parent may pass down, with its cache, logs and
 * update check pointed at the temp dir: test runs never write to the real ~/.npm.
 */
const npmEnv = () => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toLowerCase().startsWith('npm_')) env[k] = v;
  }
  return {
    ...env,
    npm_config_cache: join(temp, 'npm-cache'),
    npm_config_logs_dir: join(temp, 'npm-logs'),
    npm_config_update_notifier: 'false',
  };
};

const javiEnv = (extra: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  JAVI_HOME: home,
  JAVI_CLAUDE_HOME: claudeHome,
  ...extra,
});

const bin = () => join(prefix, 'node_modules', '.bin', WIN ? 'javi.cmd' : 'javi');

/** Runs the installed bin; on Windows javi.cmd needs a shell, so every argument is quoted. */
const runBin = (args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) =>
  WIN
    ? run(quoteWinArg(bin()), args.map(quoteWinArg), { ...opts, shell: true })
    : run(bin(), args, opts);

const mtime = (path: string) =>
  stat(path).then(
    (s) => s.mtimeMs,
    () => null,
  );

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

const initArgs = (dir: string) => [
  'init',
  '--project',
  'web-app',
  '--dir',
  dir,
  '--endpoint',
  endpoint,
  '--no-verify',
];

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'javi-pack-'));
  out = join(temp, 'dist');
  bundle = join(out, 'javi.mjs');
  tarball = join(out, `javis-dog-javi-${VERSION}.tgz`);
  prefix = join(temp, 'prefix');
  home = join(temp, 'javi-home');
  claudeHome = join(temp, 'claude-home');
  projectDir = await mkdtemp(join(temp, 'project-'));
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`;

  // Build once into the temp dir: pack.mjs builds the bundle, then packs it. The repo's dist/
  // (turbo cache, a parallel `build`) must stay untouched.
  repoDistBefore = await mtime(join(ROOT, 'dist', 'javi.mjs'));
  const packed = await run(process.execPath, [join(ROOT, 'scripts', 'pack.mjs'), '--out', out], {
    env: npmEnv(),
  });
  expect(packed.code, packed.stderr).toBe(0);
  repoDistAfter = await mtime(join(ROOT, 'dist', 'javi.mjs'));
  const npm = npmInvocation([
    'install',
    '--offline',
    '--no-audit',
    '--no-fund',
    '--prefix',
    prefix,
    tarball,
  ]);
  const installed = await run(npm.command, npm.args, {
    cwd: temp,
    env: npmEnv(),
    shell: npm.shell,
  });
  expect(installed.code, installed.stderr).toBe(0);
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
});

describe('javi bundle (P1)', () => {
  it('has exactly one shebang, first, and imports nothing but node: builtins', async () => {
    const text = await readFile(bundle, 'utf8');
    const lines = text.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env node');
    expect(lines.slice(1).filter((l) => l.startsWith('#!'))).toEqual([]);
    const specifiers = [
      ...text.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...text.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
    if (!WIN) expect((await stat(bundle)).mode & 0o111).not.toBe(0);
  });

  it('is built into --out only: the repo dist/ is untouched', () => {
    expect(repoDistAfter).toBe(repoDistBefore);
  });

  it('packs with npm logs in the temp dir, not in ~/.npm', async () => {
    expect((await readdir(join(temp, 'npm-logs'))).length).toBeGreaterThan(0);
  });
});

describe('javi tarball (P2)', () => {
  it('installs offline and the symlinked bin runs main', async () => {
    if (!WIN) expect((await lstat(bin())).isSymbolicLink()).toBe(true);
    const result = await runBin(['status', '--project', 'nope'], { env: javiEnv() });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('Project nope: not configured');
  });

  it('runs main under NODE_OPTIONS=--preserve-symlinks-main too', async () => {
    const result = await runBin(['status', '--project', 'nope'], {
      env: javiEnv({ NODE_OPTIONS: '--preserve-symlinks-main' }),
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toContain('Project nope: not configured');
  });

  it('ships the licence of every bundled third-party package (zod at least)', async () => {
    const pkgDir = join(prefix, 'node_modules', 'javis-dog-javi');
    const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as {
      files: string[];
      dependencies?: unknown;
    };
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES.md');
    expect(manifest.dependencies).toBeUndefined();
    expect((await readdir(pkgDir)).sort()).toEqual([
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'javi.mjs',
      'package.json',
    ]);
    const notices = await readFile(join(pkgDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    // zod as the workspace resolves it (a dependency of @javis-dog/jgr-spec).
    const fromSpec = createRequire(join(ROOT, '..', '..', 'packages', 'jgr-spec', 'package.json'));
    const zodPkg = fromSpec.resolve('zod/package.json');
    const zod = JSON.parse(await readFile(zodPkg, 'utf8')) as { version: string };
    const zodLicence = await readFile(join(dirname(zodPkg), 'LICENSE'), 'utf8');
    expect(notices).toContain(`## zod@${zod.version}`);
    expect(notices).toContain(zodLicence.trim());
    expect(notices).not.toContain('@javis-dog/');
  });
});

describe('javi init from the bundle (P3)', () => {
  it('installs a versioned copy, and its hook works after the install prefix is gone', async () => {
    expect(COLLECTOR_VERSION).toBe(VERSION);
    const versionDir = join(home, 'bin', VERSION);
    const stable = join(versionDir, 'javi.mjs');
    const init = () => runBin(initArgs(projectDir), { env: javiEnv({ JAVI_INGEST_TOKEN: TOKEN }) });
    const first = await init();
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain(`javi ${VERSION} installed in ${stable}.`);
    const { ino } = await stat(stable);
    // Re-init with the same bundle: the byte-identical copy is kept, nothing is left behind.
    const second = await init();
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain(`javi ${VERSION} already installed in ${stable}.`);
    expect((await stat(stable)).ino).toBe(ino);
    expect(await readdir(join(home, 'bin'))).toEqual([VERSION]);
    expect(await readdir(versionDir)).toEqual(['javi.mjs']);
    expect(await readFile(stable)).toEqual(await readFile(bundle));
    if (!WIN) {
      expect((await stat(stable)).mode & 0o777).toBe(0o755);
      expect((await stat(join(home, 'bin'))).mode & 0o777).toBe(0o700);
      expect((await stat(versionDir)).mode & 0o777).toBe(0o700);
    }

    const settings = JSON.parse(
      await readFile(join(projectDir, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>> };
    const hook = settings.hooks.SessionStart![0]!.hooks[0]!;
    expect(hook.args[0]).toBe(stable);
    expect(hook.args[0]!.replace(/\\/g, '/').endsWith(`/bin/${VERSION}/javi.mjs`)).toBe(true);

    // The npx cache (here: the install prefix) disappears; the registered hook must still work.
    await rm(prefix, { recursive: true, force: true });
    const result = await run(hook.command, hook.args, {
      cwd: projectDir,
      env: javiEnv(),
      stdin: JSON.stringify({
        session_id: 'sess-pack',
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
    });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    const state = createState(home);
    expect(await createFileSpool(state.spoolDir('web-app')).count()).toBe(1);
    // The detached flush, spawned from the stable copy, reached the local endpoint (401 keeps
    // the spool). Waiting for it also keeps afterAll from racing its writes.
    await waitFor(async () => (await state.lastFlush('web-app')) !== null);
    expect(await state.lastFlush('web-app')).toMatchObject({ status: 'unauthorized' });
    expect(requests).toBeGreaterThan(0);
    expect(await createFileSpool(state.spoolDir('web-app')).count()).toBe(1);
  });

  it('fails loudly before saving the token or hooks when the copy cannot be installed', async () => {
    const brokenHome = join(temp, 'javi-home-broken');
    const target = join(brokenHome, 'bin', VERSION, 'javi.mjs');
    await mkdir(target, { recursive: true }); // a directory where the copy must go
    const dir = await mkdtemp(join(temp, 'project-broken-'));
    const result = await run(process.execPath, [bundle, ...initArgs(dir)], {
      env: javiEnv({ JAVI_HOME: brokenHome, JAVI_INGEST_TOKEN: TOKEN }),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(target);
    expect(result.stderr).not.toContain(TOKEN.slice(6));
    await expect(stat(join(brokenHome, 'credentials.json'))).rejects.toThrow();
    await expect(stat(join(dir, '.claude', 'settings.local.json'))).rejects.toThrow();
    // The temp copy is cleaned up: only the blocking directory is left.
    expect(await readdir(join(brokenHome, 'bin', VERSION))).toEqual(['javi.mjs']);
  });
});
