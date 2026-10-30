import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { encodeRecoveryKey, generateProjectSecret } from '@javis-dog/crypto';

/** A fresh recovery key and every spelling a leak could take (ADR-0018, TEST_PLAN D0 M8). */
export const makeRecoveryKey = async () => {
  const secret = generateProjectSecret();
  const key = await encodeRecoveryKey(secret);
  const compact = key.slice('JDK1-'.length).replaceAll('-', '');
  const body = compact.slice(0, 52);
  return {
    secret: new Uint8Array(secret),
    key,
    /** Substrings that must never appear outside the credentials file. */
    sentinels: [
      key,
      key.toLowerCase(),
      compact,
      body,
      body.toLowerCase(),
      Buffer.from(secret).toString('hex'),
      Buffer.from(secret).toString('hex').toUpperCase(),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
    ],
  };
};

/** Every regular file under `dir` (recursive), as [path relative to dir, text]. */
export const filesUnder = async (dir: string): Promise<Array<[string, string]>> => {
  const out: Array<[string, string]> = [];
  const walk = async (current: string) => {
    for (const name of await readdir(current).catch(() => [] as string[])) {
      const path = join(current, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) out.push([relative(dir, path), await readFile(path, 'utf8')]);
    }
  };
  await walk(dir);
  return out;
};

/** The sentinels found in `text` (empty when none leaked). */
export const leaks = (text: string, sentinels: string[]) =>
  sentinels.filter((s) => text.includes(s));
