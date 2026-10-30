// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  decryptL2,
  deriveProjectKeys,
  encodeRecoveryKey,
  encryptL2,
  generateProjectSecret,
  parseRecoveryKey,
} from '../src/index.ts';

// A browser-like environment (jsdom: window, document, TextEncoder). WebCrypto here is still
// Node's engine — jsdom has no SubtleCrypto of its own — so this proves the module loads and
// runs with browser globals, not that a browser engine accepts it (TEST_PLAN §S5f).
describe('jsdom environment', () => {
  it('has browser globals and a WebCrypto subtle', () => {
    expect(typeof window).toBe('object');
    expect(typeof document.createElement).toBe('function');
    expect(typeof globalThis.crypto.subtle.deriveKey).toBe('function');
  });

  it('round-trips a recovery key and an L2 payload', async () => {
    const secret = generateProjectSecret();
    const parsed = await parseRecoveryKey((await encodeRecoveryKey(secret)).toLowerCase());
    expect(parsed).toEqual({ ok: true, secret });
    const keys = await deriveProjectKeys(secret, 'demo-app');
    const context = {
      eventId: '01JBZ4XQ80000000000000001A',
      slug: 'demo-app',
      producerId: 'prod_x',
      threadRef: 'sess_x',
      type: 'x.javi.collector.installed',
    };
    const encrypted = await encryptL2(keys.l2Key, keys.kid, context, { canary: true });
    expect(await decryptL2(new Map([[keys.kid, keys.l2Key]]), encrypted, context)).toEqual({
      ok: true,
      payload: { v: 1, canary: true },
    });
  });
});
