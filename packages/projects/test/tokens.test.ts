import { describe, expect, it } from 'vitest';
import {
  displayPrefix,
  generateIngestToken,
  hashIngestToken,
  INGEST_TOKEN_PREFIX,
  parseIngestToken,
} from '../src/index.ts';

describe('ingest tokens', () => {
  it('has the jd_it_ prefix and 32 bytes of base64url entropy', () => {
    const token = generateIngestToken();
    expect(token).toMatch(/^jd_it_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token.slice(INGEST_TOKEN_PREFIX.length), 'base64url')).toHaveLength(32);
  });

  it('does not repeat across 1000 generations', () => {
    const seen = new Set(Array.from({ length: 1000 }, generateIngestToken));
    expect(seen.size).toBe(1000);
  });

  it('round-trips through parseIngestToken', () => {
    const token = generateIngestToken();
    expect(parseIngestToken(token)).toEqual({ secret: token.slice(6) });
  });

  it.each([
    ['empty', ''],
    ['not a string', 42],
    ['null', null],
    ['leading space', ` ${'A'.repeat(43)}`],
    ['trailing newline', `jd_it_${'A'.repeat(43)}\n`],
    ['wrong prefix', `ghp_${'A'.repeat(43)}`],
    ['too short', `jd_it_${'A'.repeat(42)}`],
    ['too long', `jd_it_${'A'.repeat(44)}`],
    ['standard base64 chars', `jd_it_${'A'.repeat(42)}+`],
    ['non-canonical last char', `jd_it_${'A'.repeat(42)}B`],
  ])('rejects %s', (_label, raw) => {
    expect(parseIngestToken(raw)).toBeNull();
  });

  it('hashes with SHA-256 (known vector)', async () => {
    // sha256("abc") from FIPS 180-2.
    expect(await hashIngestToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('never exposes the secret beyond an 8-char display prefix', () => {
    const token = generateIngestToken();
    expect(displayPrefix(token)).toBe(token.slice(6, 14));
  });
});
