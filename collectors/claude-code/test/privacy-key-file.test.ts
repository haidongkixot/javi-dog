import { chmod, chown, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_FILE_MODE_WARNING, KEY_FILE_OWNER_WARNING, readKeyFile } from '../src/privacy.ts';
import { leaks, makeRecoveryKey } from './privacy-fixtures.ts';

// Security review L8 (S5f): `--privacy-key-file` warns (fixed text, never the key) when the
// file is open to group or other users, or owned by someone else, and still reads it.
const posix = process.platform !== 'win32';
const isRoot = posix && process.getuid?.() === 0;

let root: string;
let fixture: Awaited<ReturnType<typeof makeRecoveryKey>>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'javi-key-file-'));
  fixture = await makeRecoveryKey();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
const keyFile = async (mode: number) => {
  const path = join(root, `key-${n++}.txt`);
  await writeFile(path, `${fixture.key}\n`);
  await chmod(path, mode); // explicit: writeFile's mode is subject to the umask
  return path;
};

describe.runIf(posix)('readKeyFile permission warnings', () => {
  it('the warning texts are fixed and name no key', () => {
    expect(KEY_FILE_MODE_WARNING).toBe(
      'Warning: other users can read or change the key file (its group or other permission bits are set). Restrict it to yourself with chmod 600.',
    );
    expect(KEY_FILE_OWNER_WARNING).toBe(
      'Warning: the key file belongs to another user. Use a key file that you own.',
    );
  });

  const octal = (modes: number[]) => modes.map((m) => [m.toString(8), m] as const);

  it.each(octal([0o600, 0o400, 0o700]))('mode %s: no warning', async (_label, mode) => {
    const read = await readKeyFile(await keyFile(mode));
    expect(read).toEqual({ ok: true, text: fixture.key, warnings: [] });
  });

  it.each(octal([0o644, 0o640, 0o604, 0o660, 0o606, 0o610, 0o601, 0o777]))(
    'mode %s: warns and still reads the key',
    async (_label, mode) => {
      const read = await readKeyFile(await keyFile(mode));
      expect(read).toEqual({ ok: true, text: fixture.key, warnings: [KEY_FILE_MODE_WARNING] });
      expect(leaks(JSON.stringify(read.ok && read.warnings), fixture.sentinels)).toEqual([]);
    },
  );

  it.runIf(isRoot)('owned by another user: warns and still reads the key', async () => {
    const path = await keyFile(0o600);
    await chown(path, 4242, 4242);
    const read = await readKeyFile(path);
    expect(read).toEqual({ ok: true, text: fixture.key, warnings: [KEY_FILE_OWNER_WARNING] });
  });

  it.runIf(isRoot)('another owner and a broad mode: both warnings', async () => {
    const path = await keyFile(0o644);
    await chown(path, 4242, 4242);
    const read = await readKeyFile(path);
    expect(read.ok && read.warnings).toEqual([KEY_FILE_MODE_WARNING, KEY_FILE_OWNER_WARNING]);
  });
});
