import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installSelf, installTarget } from '../src/cli.ts';

// S3f review finding 1/2/8: `javi init` copies the running bundle to a versioned path. Unit
// layer with an injected rename, so Windows' transient EPERM/EBUSY can be simulated on Linux.
const WIN = process.platform === 'win32';
let temp: string;
let source: string;

const failing = (codes: string[]) => {
  const calls: string[] = [];
  const fn = async (from: string, to: string) => {
    const code = codes[calls.length];
    calls.push(code ?? 'ok');
    if (code) throw Object.assign(new Error(code), { code });
    await rename(from, to);
  };
  return { fn, calls };
};

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'javi-install-'));
  source = join(temp, 'javi.mjs');
  await writeFile(source, '#!/usr/bin/env node\nconsole.log("v1");\n');
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('installSelf', () => {
  it('copies to <home>/bin/<version>/javi.mjs and skips a byte-identical copy', async () => {
    const home = join(temp, 'home');
    const first = await installSelf(home, source, '0.1.0');
    expect(first).toEqual({ path: join(home, 'bin', '0.1.0', 'javi.mjs'), copied: true });
    expect(installTarget(home, '0.1.0')).toBe(first.path);
    expect(await readFile(first.path, 'utf8')).toContain('v1');
    if (!WIN) {
      expect((await stat(first.path)).mode & 0o777).toBe(0o755);
      expect((await stat(join(home, 'bin'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, 'bin', '0.1.0'))).mode & 0o777).toBe(0o700);
    }
    const { ino } = await stat(first.path);
    const rename = failing([]);
    expect(await installSelf(home, source, '0.1.0', { rename: rename.fn })).toEqual({
      path: first.path,
      copied: false,
    });
    expect(rename.calls).toEqual([]);
    expect((await stat(first.path)).ino).toBe(ino);

    // A different bundle under the same version replaces the copy.
    await writeFile(source, '#!/usr/bin/env node\nconsole.log("v2");\n');
    expect((await installSelf(home, source, '0.1.0')).copied).toBe(true);
    expect(await readFile(first.path, 'utf8')).toContain('v2');
    expect(await readdir(join(home, 'bin', '0.1.0'))).toEqual(['javi.mjs']);
  });

  it('retries a rename refused by a scanner (EPERM/EBUSY/EACCES), then succeeds', async () => {
    const home = join(temp, 'home');
    const rename = failing(['EBUSY', 'EPERM', 'EACCES']);
    const result = await installSelf(home, source, '0.1.0', { rename: rename.fn, retryDelayMs: 1 });
    expect(result.copied).toBe(true);
    expect(rename.calls).toEqual(['EBUSY', 'EPERM', 'EACCES', 'ok']);
    expect(await readdir(join(home, 'bin', '0.1.0'))).toEqual(['javi.mjs']);
  });

  it('gives up after 5 retries and removes its temp copy', async () => {
    const home = join(temp, 'home');
    const rename = failing(Array(10).fill('EPERM'));
    await expect(
      installSelf(home, source, '0.1.0', { rename: rename.fn, retryDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(rename.calls).toHaveLength(6);
    expect(await readdir(join(home, 'bin', '0.1.0'))).toEqual([]);
  });

  it('does not retry other errors', async () => {
    const home = join(temp, 'home');
    const rename = failing(['EISDIR', 'EISDIR']);
    await expect(
      installSelf(home, source, '0.1.0', { rename: rename.fn, retryDelayMs: 1 }),
    ).rejects.toMatchObject({ code: 'EISDIR' });
    expect(rename.calls).toEqual(['EISDIR']);
    expect(await readdir(join(home, 'bin', '0.1.0'))).toEqual([]);
  });
});
