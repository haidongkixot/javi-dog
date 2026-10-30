import { describe, expect, it } from 'vitest';
import { EncryptedPayload } from '@javis-dog/jgr-spec';
import {
  buildAad,
  decodeL2Payload,
  decryptL2,
  deriveProjectKeys,
  encodeL2Payload,
  encryptL2,
  L2_PAYLOAD_BYTES,
  type AadContext,
  type EncryptedL2,
} from '../src/index.ts';

const secret = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const context: AadContext = {
  eventId: '01jbz4xq80000000000000001a',
  slug: 'demo-app',
  producerId: 'prod_claude-code_7f3a',
  threadRef: 'sess_2b9c',
  type: 'x.javi.thread.identity',
};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('buildAad', () => {
  it('is the UTF-8 of jgr|v1|<canonical event_id>|<slug>|<producer>|<thread>|<type>|<kid>|L2', () => {
    expect(text(buildAad({ ...context, kid: 'ABCDEFGH' }))).toBe(
      'jgr|v1|01JBZ4XQ80000000000000001A|demo-app|prod_claude-code_7f3a|sess_2b9c|x.javi.thread.identity|ABCDEFGH|L2',
    );
  });

  it('canonicalises a UUID event_id to lower case', () => {
    const aad = buildAad({
      ...context,
      eventId: '0192F5A0-0000-7000-8000-00000000ABCD',
      kid: 'ABCDEFGH',
    });
    expect(text(aad)).toContain('|0192f5a0-0000-7000-8000-00000000abcd|');
  });

  it('rejects a part that contains "|" or is empty', () => {
    const parts = ['eventId', 'slug', 'producerId', 'threadRef', 'type', 'kid'] as const;
    for (const part of parts) {
      const base = { ...context, kid: 'ABCDEFGH' };
      expect(() => buildAad({ ...base, [part]: 'a|b' }), part).toThrow(TypeError);
      expect(() => buildAad({ ...base, [part]: '' }), part).toThrow(TypeError);
    }
  });
});

describe('encodeL2Payload', () => {
  it('writes {"v":1,…} JSON padded with spaces to exactly 256 bytes', () => {
    const bytes = encodeL2Payload({ repo: 'javi-dog', branch: 'main' });
    expect(bytes).toHaveLength(L2_PAYLOAD_BYTES);
    expect(text(bytes).trimEnd()).toBe('{"v":1,"repo":"javi-dog","branch":"main"}');
    expect(text(bytes)).toMatch(/^\{[^ ]*\} *$/);
  });

  it('omits absent fields and writes the canary', () => {
    expect(text(encodeL2Payload({})).trimEnd()).toBe('{"v":1}');
    expect(text(encodeL2Payload({ branch: 'main' })).trimEnd()).toBe('{"v":1,"branch":"main"}');
    expect(text(encodeL2Payload({ canary: true })).trimEnd()).toBe('{"v":1,"canary":true}');
    expect(encodeL2Payload({ canary: true })).toHaveLength(256);
  });

  it('is always exactly 256 bytes, whatever the names', () => {
    const samples = [
      '',
      'a',
      'x'.repeat(99),
      'x'.repeat(100),
      'x'.repeat(101),
      'y'.repeat(5000),
      '"\\'.repeat(80),
      '\u0000\u0001\u001f'.repeat(40),
      'é'.repeat(150),
      '日本語'.repeat(60),
      '😀'.repeat(150),
      '\ud800'.repeat(120),
      'a😀'.repeat(70),
    ];
    for (const repo of samples) {
      for (const branch of samples) {
        const bytes = encodeL2Payload({ repo, branch });
        expect(bytes.length).toBe(256);
        expect(() => JSON.parse(text(bytes)) as unknown).not.toThrow();
      }
    }
  });

  // G6: per field, the longest prefix of ≤ 100 code points whose JSON-escaped UTF-8 length
  // (without quotes) is ≤ 113 bytes.
  it('cuts ASCII names to 100 code points', () => {
    const ascii = decodeL2Payload(
      encodeL2Payload({ repo: 'r'.repeat(150), branch: 'b'.repeat(150) }),
    );
    expect(ascii).toEqual({ v: 1, repo: 'r'.repeat(100), branch: 'b'.repeat(100) });
  });

  it('cuts multi-byte names at 113 escaped bytes, never splitting an astral character', () => {
    // 4 bytes each: 28 × 4 = 112 ≤ 113 < 116.
    expect(decodeL2Payload(encodeL2Payload({ repo: '😀'.repeat(120) }))).toEqual({
      v: 1,
      repo: '😀'.repeat(28),
    });
    // 2 bytes each: 56 × 2 = 112; both fields are cut on their own.
    expect(
      decodeL2Payload(encodeL2Payload({ repo: 'é'.repeat(100), branch: 'é'.repeat(100) })),
    ).toEqual({ v: 1, repo: 'é'.repeat(56), branch: 'é'.repeat(56) });
    // 99 + 4 = 103 bytes and 100 code points: the code-point limit cuts "tail".
    expect(decodeL2Payload(encodeL2Payload({ repo: `${'a'.repeat(99)}😀tail` }))).toEqual({
      v: 1,
      repo: `${'a'.repeat(99)}😀`,
    });
    // 55 × 2 + 4 = 114 > 113: the astral character is dropped whole.
    expect(decodeL2Payload(encodeL2Payload({ branch: `${'é'.repeat(55)}😀` }))).toEqual({
      v: 1,
      branch: 'é'.repeat(55),
    });
  });

  it('counts JSON escapes in the 113-byte budget', () => {
    // '"' escapes to 2 bytes, U+0000 to 6 bytes (\u0000).
    expect(decodeL2Payload(encodeL2Payload({ repo: '"'.repeat(80) }))).toEqual({
      v: 1,
      repo: '"'.repeat(56),
    });
    expect(decodeL2Payload(encodeL2Payload({ repo: '\u0000'.repeat(40) }))).toEqual({
      v: 1,
      repo: '\u0000'.repeat(18),
    });
  });

  it('NFC-normalises names', () => {
    expect(decodeL2Payload(encodeL2Payload({ branch: 'café' }))).toEqual({
      v: 1,
      branch: 'café',
    });
  });
});

describe('decodeL2Payload', () => {
  it('returns null for anything that is not a v1 payload', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(decodeL2Payload(enc('not json'))).toBeNull();
    expect(decodeL2Payload(enc('{"v":2,"repo":"x"}'))).toBeNull();
    expect(decodeL2Payload(enc('{"v":1,"repo":5}'))).toBeNull();
    expect(decodeL2Payload(enc('{"v":1,"canary":false}'))).toBeNull();
    expect(decodeL2Payload(enc('[1]'))).toBeNull();
    expect(decodeL2Payload(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe('encryptL2 / decryptL2', () => {
  const setup = async () => {
    const keys = await deriveProjectKeys(secret, context.slug);
    const encrypted = await encryptL2(keys.l2Key, keys.kid, context, {
      repo: 'javi-dog',
      branch: 'main',
    });
    return { keys, encrypted, byKid: new Map([[keys.kid, keys.l2Key]]) };
  };

  it('round-trips and produces a JGR-valid encrypted object', async () => {
    const { keys, encrypted, byKid } = await setup();
    expect(encrypted.alg).toBe('A256GCM');
    expect(encrypted.kid).toBe(keys.kid);
    expect(encrypted.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // 256 bytes of plaintext + 16-byte tag = 272 bytes = 363 base64url characters.
    expect(encrypted.ciphertext).toMatch(/^[A-Za-z0-9_-]{363}$/);
    expect(EncryptedPayload.safeParse(encrypted).success).toBe(true);
    expect(await decryptL2(byKid, encrypted, context)).toEqual({
      ok: true,
      payload: { v: 1, repo: 'javi-dog', branch: 'main' },
    });
  });

  it('round-trips the canary', async () => {
    const { keys, byKid } = await setup();
    const canary = await encryptL2(keys.l2Key, keys.kid, context, { canary: true });
    expect(await decryptL2(byKid, canary, context)).toEqual({
      ok: true,
      payload: { v: 1, canary: true },
    });
  });

  it('uses a fresh random iv for every event', async () => {
    const { keys } = await setup();
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ivs.add((await encryptL2(keys.l2Key, keys.kid, context, { branch: 'main' })).iv);
    }
    expect(ivs.size).toBe(50);
  });

  it('accepts the same event_id in another case (canonical form in the AAD)', async () => {
    const { encrypted, byKid } = await setup();
    const upper = { ...context, eventId: context.eventId.toUpperCase() };
    expect(await decryptL2(byKid, encrypted, upper)).toMatchObject({ ok: true });
  });

  it('fails as "unverifiable" when any AAD part changes', async () => {
    const { encrypted, byKid } = await setup();
    const changes: Partial<AadContext>[] = [
      { eventId: '01JBZ4XQ80000000000000001B' },
      { slug: 'other-app' },
      { producerId: 'prod_other' },
      { threadRef: 'sess_other' },
      { type: 'session.started' },
    ];
    for (const change of changes) {
      expect(
        await decryptL2(byKid, encrypted, { ...context, ...change }),
        JSON.stringify(change),
      ).toEqual({
        ok: false,
        reason: 'unverifiable',
      });
    }
  });

  it('fails as "unverifiable" when the kid label in the AAD differs from the one used to encrypt', async () => {
    const { keys, byKid } = await setup();
    // Encrypted with the right key but a different kid label: the AAD carries the kid.
    const relabelled = await encryptL2(keys.l2Key, 'ZZZZZZZZ', context, { branch: 'main' });
    const moved = { ...relabelled, kid: keys.kid };
    expect(await decryptL2(byKid, moved, context)).toEqual({ ok: false, reason: 'unverifiable' });
  });

  it('fails as "unverifiable" when the ciphertext, tag or iv is changed', async () => {
    const { encrypted, byKid } = await setup();
    const flip = (s: string, i: number) =>
      s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    for (const i of [0, 100, 340, 361]) {
      const changed: EncryptedL2 = { ...encrypted, ciphertext: flip(encrypted.ciphertext, i) };
      expect(await decryptL2(byKid, changed, context)).toEqual({
        ok: false,
        reason: 'unverifiable',
      });
    }
    const otherIv: EncryptedL2 = { ...encrypted, iv: flip(encrypted.iv, 0) };
    expect(await decryptL2(byKid, otherIv, context)).toEqual({ ok: false, reason: 'unverifiable' });
  });

  it('fails as "unverifiable" with the same kid but another key', async () => {
    const { keys, encrypted } = await setup();
    const other = await deriveProjectKeys(new Uint8Array(32), context.slug);
    const wrong = new Map([[keys.kid, other.l2Key]]);
    expect(await decryptL2(wrong, encrypted, context)).toEqual({
      ok: false,
      reason: 'unverifiable',
    });
  });

  it('reports "no-key" with no keys at all and "other-kid" when only other kids are present', async () => {
    const { encrypted } = await setup();
    expect(await decryptL2(new Map(), encrypted, context)).toEqual({ ok: false, reason: 'no-key' });
    const other = await deriveProjectKeys(new Uint8Array(32), context.slug);
    expect(await decryptL2(new Map([[other.kid, other.l2Key]]), encrypted, context)).toEqual({
      ok: false,
      reason: 'other-kid',
    });
  });

  it('does not resolve kids through the prototype chain', async () => {
    const { encrypted, byKid } = await setup();
    for (const kid of ['constructor', '__proto__', 'toString']) {
      expect(await decryptL2(byKid, { ...encrypted, kid }, context)).toEqual({
        ok: false,
        reason: 'other-kid',
      });
    }
  });

  it('reports "malformed" for a bad shape and never throws', async () => {
    const { encrypted, byKid } = await setup();
    const bad: unknown[] = [
      null,
      undefined,
      'string',
      42,
      [],
      {},
      { ...encrypted, alg: 'A128GCM' },
      { ...encrypted, kid: '' },
      { ...encrypted, kid: 'a|b' },
      { ...encrypted, kid: 7 },
      { ...encrypted, iv: encrypted.iv.slice(1) },
      { ...encrypted, iv: `${encrypted.iv}A` },
      { ...encrypted, iv: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { ...encrypted, iv: 'AAAAAAAAAAAAAAA=' },
      { ...encrypted, iv: 'AAAAAAAAAAAAAAA+' },
      { ...encrypted, ciphertext: '' },
      { ...encrypted, ciphertext: 'AAAA' },
      { ...encrypted, ciphertext: `${encrypted.ciphertext}!` },
      { ...encrypted, ciphertext: 'A'.repeat(21) },
      { ...encrypted, extra: true },
    ];
    for (const value of bad) {
      expect(await decryptL2(byKid, value, context), JSON.stringify(value)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
    expect(await decryptL2(byKid, encrypted, { ...context, threadRef: 'a|b' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(await decryptL2(null as never, encrypted, context)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('reports "unverifiable" for an authentic ciphertext whose plaintext is not a v1 payload (G10)', async () => {
    const { keys, byKid } = await setup();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = buildAad({ ...context, kid: keys.kid });
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        keys.l2Key,
        new TextEncoder().encode('{"v":9}'),
      ),
    );
    const b64 = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const forged = { alg: 'A256GCM', kid: keys.kid, iv: b64(iv), ciphertext: b64(sealed) };
    expect(await decryptL2(byKid, forged, context)).toEqual({ ok: false, reason: 'unverifiable' });
  });

  it('test seam: a fixed IV gives a deterministic ciphertext that still round-trips', async () => {
    const { keys, byKid } = await setup();
    const iv = Uint8Array.from({ length: 12 }, (_, i) => i);
    const seam = { unsafeFixedIvForTests: iv };
    const a = await encryptL2(keys.l2Key, keys.kid, context, { branch: 'main' }, seam);
    const b = await encryptL2(keys.l2Key, keys.kid, context, { branch: 'main' }, seam);
    expect(a).toEqual(b);
    expect(a.iv).toBe('AAECAwQFBgcICQoL');
    expect(await decryptL2(byKid, a, context)).toEqual({
      ok: true,
      payload: { v: 1, branch: 'main' },
    });
    const badIv = { unsafeFixedIvForTests: new Uint8Array(16) };
    await expect(
      encryptL2(keys.l2Key, keys.kid, context, { branch: 'main' }, badIv),
    ).rejects.toThrow(TypeError);
  });

  it('refuses to encrypt with an AAD part that contains "|"', async () => {
    const { keys } = await setup();
    await expect(
      encryptL2(keys.l2Key, keys.kid, { ...context, slug: 'a|b' }, { branch: 'main' }),
    ).rejects.toThrow(TypeError);
  });
});
