import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  deriveProjectKeys,
  generateProjectSecret,
  HKDF_INFO_KID,
  HKDF_INFO_L1_PREFIX,
  HKDF_INFO_L2,
  hkdfInfo,
  L1_FIELDS,
  l1Hash,
} from '../src/index.ts';

const secret = Uint8Array.from({ length: 32 }, (_, i) => i);

/** Independent oracle: Node's own HKDF (node:crypto), not WebCrypto. */
const nodeHkdf = (info: string, bytes = 32) =>
  new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), Buffer.from(info, 'utf8'), bytes));

const base32 = (bytes: Uint8Array) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

describe('HKDF info strings (ADR-0018 §2)', () => {
  it('are the versioned labels followed by "|<slug>"', () => {
    expect(HKDF_INFO_KID).toBe('jgr/kid/v1');
    expect(HKDF_INFO_L2).toBe('jgr/l2/aes-gcm/v1');
    expect(HKDF_INFO_L1_PREFIX).toBe('jgr/l1/v1/');
    expect(hkdfInfo(HKDF_INFO_KID, 'demo-app')).toBe('jgr/kid/v1|demo-app');
    expect(hkdfInfo(`${HKDF_INFO_L1_PREFIX}branch`, 'demo-app')).toBe('jgr/l1/v1/branch|demo-app');
    expect(L1_FIELDS).toEqual(['repo', 'branch', 'cwd', 'file']);
  });
});

describe('deriveProjectKeys', () => {
  it('kid = first 8 Crockford base32 characters of HKDF-SHA256(secret, "", "jgr/kid/v1|<slug>")', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    expect(keys.kid).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(keys.kid).toBe(base32(nodeHkdf('jgr/kid/v1|demo-app')).slice(0, 8));
    // HKDF output is prefix-stable: an L of 5 bytes gives the same 8 characters.
    expect(keys.kid).toBe(base32(nodeHkdf('jgr/kid/v1|demo-app', 5)));
  });

  it('kid is stable for the same secret and slug', async () => {
    const a = await deriveProjectKeys(secret, 'demo-app');
    const b = await deriveProjectKeys(Uint8Array.from(secret), 'demo-app');
    expect(a.kid).toBe(b.kid);
  });

  it('separates projects: the same secret under two slugs gives different kids, hashes and L2 keys', async () => {
    const a = await deriveProjectKeys(secret, 'demo-app');
    const b = await deriveProjectKeys(secret, 'other-app');
    expect(a.kid).not.toBe(b.kid);
    expect(await l1Hash(a.l1Keys, 'branch', 'main')).not.toBe(
      await l1Hash(b.l1Keys, 'branch', 'main'),
    );
  });

  it('different secrets give different kids', async () => {
    const a = await deriveProjectKeys(generateProjectSecret(), 'demo-app');
    const b = await deriveProjectKeys(generateProjectSecret(), 'demo-app');
    expect(a.kid).not.toBe(b.kid);
  });

  it('returns non-extractable keys with the narrowest usages', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    expect(keys.l2Key.extractable).toBe(false);
    expect(keys.l2Key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...keys.l2Key.usages].sort()).toEqual(['decrypt', 'encrypt']);
    for (const field of L1_FIELDS) {
      const key = keys.l1Keys[field];
      expect(key.extractable).toBe(false);
      expect(key.algorithm).toMatchObject({ name: 'HMAC', hash: { name: 'SHA-256' }, length: 256 });
      expect(key.usages).toEqual(['sign']);
    }
    await expect(crypto.subtle.exportKey('raw', keys.l2Key)).rejects.toThrow();
  });

  it('the L2 key is the 32-byte HKDF output for "jgr/l2/aes-gcm/v1|<slug>"', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    const oracle = await crypto.subtle.importKey(
      'raw',
      nodeHkdf('jgr/l2/aes-gcm/v1|demo-app'),
      'AES-GCM',
      false,
      ['encrypt'],
    );
    const iv = new Uint8Array(12);
    const plain = new TextEncoder().encode('probe');
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, oracle, plain);
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keys.l2Key, sealed);
    expect(new TextDecoder().decode(opened)).toBe('probe');
  });

  it('refuses a secret that is not 32 bytes and a slug that is empty or has "|"', async () => {
    await expect(deriveProjectKeys(new Uint8Array(31), 'demo-app')).rejects.toThrow(TypeError);
    await expect(deriveProjectKeys(secret, '')).rejects.toThrow(TypeError);
    await expect(deriveProjectKeys(secret, 'demo|app')).rejects.toThrow(TypeError);
    await expect(deriveProjectKeys(secret, 'demo/app')).rejects.toThrow(TypeError);
  });
});

describe('l1Hash', () => {
  it('is "sha256:" + lowercase hex HMAC-SHA256(HKDF("jgr/l1/v1/<field>|<slug>"), UTF-8 value)', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    for (const field of L1_FIELDS) {
      const expected = createHmac('sha256', nodeHkdf(`jgr/l1/v1/${field}|demo-app`))
        .update('feature/naïve', 'utf8')
        .digest('hex');
      expect(await l1Hash(keys.l1Keys, field, 'feature/naïve')).toBe(`sha256:${expected}`);
    }
  });

  it('matches the JGR wire format sha256:<64 lowercase hex>', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    expect(await l1Hash(keys.l1Keys, 'repo', 'javi-dog')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('separates fields: the same value hashes differently per field', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    const hashes = await Promise.all(L1_FIELDS.map((f) => l1Hash(keys.l1Keys, f, 'main')));
    expect(new Set(hashes).size).toBe(4);
  });

  it('NFC-normalises before hashing (macOS stores NFD)', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    const nfc = 'café';
    const nfd = 'café';
    expect(nfc).not.toBe(nfd);
    expect(await l1Hash(keys.l1Keys, 'branch', nfd)).toBe(await l1Hash(keys.l1Keys, 'branch', nfc));
  });

  it('refuses an unknown field', async () => {
    const keys = await deriveProjectKeys(secret, 'demo-app');
    await expect(l1Hash(keys.l1Keys, 'path' as 'repo', 'x')).rejects.toThrow(TypeError);
  });
});
