import { readdirSync, readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptL2,
  deriveProjectKeys,
  encodeRecoveryKey,
  encryptL2,
  generateProjectSecret,
  l1Hash,
  parseRecoveryKey,
} from '../src/index.ts';

// JD-M11 must run unchanged in browsers (ADR-0018). Two checks complement the ESLint rule in
// eslint.config.mjs: a static scan of src, and a run with a crypto global that exposes only
// the WebCrypto surface (subtle + getRandomValues).
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, stripComments(readFileSync(srcDir + f, 'utf8'))] as const);

describe('src uses web-platform APIs only', () => {
  it('has source files to scan', () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  it.each(sources)('%s imports only relative files and @javis-dog/jgr-spec', (_file, code) => {
    const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    for (const specifier of specifiers) {
      expect(
        specifier?.startsWith('./') || specifier === '@javis-dog/jgr-spec',
        `${specifier}`,
      ).toBe(true);
    }
  });

  it.each(sources)('%s uses no Node-only globals', (_file, code) => {
    expect(code).not.toMatch(/\bBuffer\b|\bprocess\b|\brequire\s*\(|\b__dirname\b/);
  });
});

describe('runs with only crypto.subtle and crypto.getRandomValues', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips key, hashes and L2', async () => {
    const minimal = Object.freeze({
      subtle: webcrypto.subtle,
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
        webcrypto.getRandomValues(array as never) as T,
    });
    vi.stubGlobal('crypto', minimal);
    expect(Object.keys(globalThis.crypto)).toEqual(['subtle', 'getRandomValues']);

    const secret = generateProjectSecret();
    const parsed = await parseRecoveryKey(await encodeRecoveryKey(secret));
    expect(parsed).toEqual({ ok: true, secret });
    const keys = await deriveProjectKeys(secret, 'demo-app');
    expect(await l1Hash(keys.l1Keys, 'repo', 'javi-dog')).toMatch(/^sha256:[0-9a-f]{64}$/);
    const context = {
      eventId: '01JBZ4XQ80000000000000001A',
      slug: 'demo-app',
      producerId: 'prod_x',
      threadRef: 'sess_x',
      type: 'x.javi.thread.identity',
    };
    const encrypted = await encryptL2(keys.l2Key, keys.kid, context, { repo: 'r', branch: 'b' });
    expect(await decryptL2(new Map([[keys.kid, keys.l2Key]]), encrypted, context)).toEqual({
      ok: true,
      payload: { v: 1, repo: 'r', branch: 'b' },
    });
  });
});
