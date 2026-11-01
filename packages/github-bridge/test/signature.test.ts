import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature } from '../src/index.ts';

// TEST_PLAN §S5g rows "Signature" and "D0: timingSafeEqual only on equal-length buffers".

const enc = new TextEncoder();
const sign = (secret: string, body: Uint8Array) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyGithubSignature', () => {
  it('reproduces GitHub’s documented test vector', () => {
    const body = enc.encode('Hello, World!');
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(verifyGithubSignature(body, header, ["It's a Secret to Everybody"])).toBe('ok');
  });

  it('accepts the current or the previous secret, and only those', () => {
    const body = enc.encode('{"action":"completed"}');
    expect(verifyGithubSignature(body, sign('new', body), ['new', 'old'])).toBe('ok');
    expect(verifyGithubSignature(body, sign('old', body), ['new', 'old'])).toBe('ok');
    expect(verifyGithubSignature(body, sign('other', body), ['new', 'old'])).toBe('mismatch');
  });

  it('signs the raw bytes, never decoded text', () => {
    // Invalid UTF-8: decoding and re-encoding changes the bytes, so the HMAC must differ.
    const raw = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const reencoded = enc.encode(new TextDecoder().decode(raw));
    expect(verifyGithubSignature(raw, sign('k', raw), ['k'])).toBe('ok');
    expect(verifyGithubSignature(raw, sign('k', reencoded), ['k'])).toBe('mismatch');
  });

  it('detects a changed body', () => {
    const body = enc.encode('{"a":1}');
    expect(verifyGithubSignature(enc.encode('{"a":2}'), sign('k', body), ['k'])).toBe('mismatch');
  });

  it('reports a missing header', () => {
    const body = enc.encode('x');
    expect(verifyGithubSignature(body, null, ['k'])).toBe('missing');
    expect(verifyGithubSignature(body, '', ['k'])).toBe('missing');
  });

  it.each([
    ['sha1 scheme', `sha1=${'a'.repeat(40)}`],
    ['upper-case hex', `sha256=${'A'.repeat(64)}`],
    ['63 hex digits (other length)', `sha256=${'a'.repeat(63)}`],
    ['65 hex digits (other length)', `sha256=${'a'.repeat(65)}`],
    ['no prefix', 'a'.repeat(64)],
    ['whitespace', ` sha256=${'a'.repeat(64)}`],
    ['two signatures', `sha256=${'a'.repeat(64)},sha256=${'b'.repeat(64)}`],
    ['non-hex', `sha256=${'g'.repeat(64)}`],
  ])('reports %s as malformed without throwing', (_name, header) => {
    expect(() => verifyGithubSignature(enc.encode('x'), header, ['k'])).not.toThrow();
    expect(verifyGithubSignature(enc.encode('x'), header, ['k'])).toBe('malformed');
  });

  it('fails closed without a usable secret', () => {
    const body = enc.encode('x');
    expect(verifyGithubSignature(body, sign('', body), [])).toBe('mismatch');
    expect(verifyGithubSignature(body, sign('', body), [''])).toBe('mismatch');
  });
});
