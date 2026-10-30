import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  encodeRecoveryKey,
  generateProjectSecret,
  parseRecoveryKey,
  RECOVERY_KEY_PREFIX,
} from '../src/index.ts';

// A fixed secret keeps the exhaustive substitution test deterministic.
const fixed = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const strip = (key: string) => key.replace(/-/g, '');

describe('generateProjectSecret', () => {
  it('returns 32 random bytes, different on every call', () => {
    const a = generateProjectSecret();
    const b = generateProjectSecret();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });
});

describe('encodeRecoveryKey', () => {
  it('writes JDK1- then 52 Crockford base32 characters and a 4-character checksum in groups of 4', async () => {
    const key = await encodeRecoveryKey(fixed);
    expect(key).toMatch(/^JDK1(-[0-9A-HJKMNP-TV-Z]{4}){14}$/);
    expect(strip(key).slice(RECOVERY_KEY_PREFIX.length)).toHaveLength(56);
  });

  it('checksum is the first 4 base32 characters of SHA-256 over the 32 bytes', async () => {
    const key = await encodeRecoveryKey(fixed);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', fixed));
    // First 20 bits of the digest, MSB first.
    const bits = (digest[0]! << 12) | (digest[1]! << 4) | (digest[2]! >> 4);
    const expected = [15, 10, 5, 0].map((s) => CROCKFORD_ALPHABET[(bits >> s) & 31]).join('');
    expect(key.slice(-4)).toBe(expected);
  });

  it('encodes MSB first: all-zero bytes give zeros, all-one bytes give Z… with zero pad bits', async () => {
    const zeros = strip(await encodeRecoveryKey(new Uint8Array(32))).slice(4, 56);
    expect(zeros).toBe('0'.repeat(52));
    const ones = strip(await encodeRecoveryKey(new Uint8Array(32).fill(0xff))).slice(4, 56);
    // 256 one-bits = 51 full characters + 1 bit followed by four zero pad bits (0b10000 = G).
    expect(ones).toBe('Z'.repeat(51) + 'G');
  });

  it('refuses a secret that is not 32 bytes, without echoing it', async () => {
    const short = Uint8Array.from([1, 2, 3]);
    const error = await encodeRecoveryKey(short).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/32 bytes/);
    expect(String(error)).not.toMatch(/1,2,3|010203/);
  });
});

describe('parseRecoveryKey', () => {
  it('round-trips random secrets', async () => {
    for (let i = 0; i < 25; i += 1) {
      const secret = generateProjectSecret();
      const result = await parseRecoveryKey(await encodeRecoveryKey(secret));
      expect(result).toEqual({ ok: true, secret });
    }
  });

  it('ignores case, spaces, line breaks and dashes', async () => {
    const key = await encodeRecoveryKey(fixed);
    const variants = [
      key.toLowerCase(),
      strip(key),
      key.replace(/-/g, ' '),
      `  ${key.replace(/-/g, '\n')}  `,
      key.replace(/-/g, '--'),
      strip(key).replace(/(.{7})/g, '$1 - '),
    ];
    for (const variant of variants) {
      expect(await parseRecoveryKey(variant)).toEqual({ ok: true, secret: fixed });
    }
  });

  it('accepts the Crockford aliases I and L for 1 and O for 0', async () => {
    const key = await encodeRecoveryKey(fixed);
    const body = strip(key).slice(4);
    expect(body).toMatch(/[01]/); // the fixed secret has at least one 0 or 1 to alias
    const aliased = `JDK1${body.replace(/1/g, 'l').replace(/0/g, 'O')}`;
    expect(await parseRecoveryKey(aliased)).toEqual({ ok: true, secret: fixed });
    const aliasedI = `JDK1${body.replace(/1/g, 'I').replace(/0/g, 'o')}`;
    expect(await parseRecoveryKey(aliasedI)).toEqual({ ok: true, secret: fixed });
  });

  it('detects every single-character substitution in the body and the checksum', async () => {
    const body = strip(await encodeRecoveryKey(fixed)).slice(4);
    let tried = 0;
    for (let position = 0; position < body.length; position += 1) {
      for (const replacement of CROCKFORD_ALPHABET) {
        if (replacement === body[position]) continue;
        const mutated = `JDK1${body.slice(0, position)}${replacement}${body.slice(position + 1)}`;
        const result = await parseRecoveryKey(mutated);
        expect(result.ok, `position ${position} -> ${replacement}`).toBe(false);
        tried += 1;
      }
    }
    expect(tried).toBe(56 * 31);
  });

  it('reports a checksum mismatch as reason "checksum"', async () => {
    const body = strip(await encodeRecoveryKey(fixed)).slice(4);
    const last = body.at(-1) === '0' ? '1' : '0';
    const result = await parseRecoveryKey(`JDK1${body.slice(0, -1)}${last}`);
    expect(result).toMatchObject({ ok: false, reason: 'checksum' });
  });

  it('reports non-zero pad bits in the last body character as reason "character"', async () => {
    const body = strip(await encodeRecoveryKey(fixed)).slice(4);
    // Body position 51 holds 1 data bit and 4 pad bits; only 0 and G are canonical there.
    const nonCanonical = `JDK1${body.slice(0, 51)}H${body.slice(52)}`;
    expect(await parseRecoveryKey(nonCanonical)).toMatchObject({ ok: false, reason: 'character' });
  });

  it('returns typed errors for empty input, a wrong prefix, a wrong length and bad characters', async () => {
    const key = await encodeRecoveryKey(fixed);
    const body = strip(key).slice(4);
    expect(await parseRecoveryKey('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(await parseRecoveryKey(' - ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(await parseRecoveryKey(`JDK2${body}`)).toMatchObject({ ok: false, reason: 'prefix' });
    expect(await parseRecoveryKey(body)).toMatchObject({ ok: false, reason: 'prefix' });
    expect(await parseRecoveryKey(`JDK1${body.slice(1)}`)).toMatchObject({
      ok: false,
      reason: 'length',
    });
    expect(await parseRecoveryKey(`JDK1${body}0`)).toMatchObject({ ok: false, reason: 'length' });
    expect(await parseRecoveryKey(`JDK1U${body.slice(1)}`)).toMatchObject({
      ok: false,
      reason: 'character',
    });
    expect(await parseRecoveryKey(`JDK1*${body.slice(1)}`)).toMatchObject({
      ok: false,
      reason: 'character',
    });
    expect(await parseRecoveryKey(`${key}x`.repeat(50))).toMatchObject({
      ok: false,
      reason: 'length',
    });
  });

  it('never throws and never repeats the input in an error', async () => {
    const key = await encodeRecoveryKey(fixed);
    const body = strip(key).slice(4);
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      {},
      `JDK1${body.slice(0, -1)}X`,
      `JDK1${body.slice(2)}`,
      `JDK9${body}`,
      `JDK1U${body.slice(1)}`,
    ];
    for (const input of inputs) {
      const result = await parseRecoveryKey(input as string);
      expect(result.ok).toBe(false);
      const text = JSON.stringify(result);
      expect(text).not.toContain(body.slice(0, 8));
      expect(text).not.toContain(body.slice(-8));
    }
  });
});
