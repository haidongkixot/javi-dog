// Sentinel search for "the key never reaches the server" (ADR-0018 §1, TEST_PLAN §S5f, D0 M8):
// the decoded key bytes as hex and the base32 body are searched as substrings, including
// overlapping windows, so a partial or reformatted leak is caught too, not only the full key.
import { CROCKFORD_ALPHABET } from '@javis-dog/crypto';

/** 32 fixed, recognisable bytes (not all zero, so they cannot hide in padding). */
export const SENTINEL_SECRET = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);

const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const toBase32 = (bytes: Uint8Array) => {
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

const toBase64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/=+$/, '');
const toBase64Url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

export const SENTINEL_HEX = toHex(SENTINEL_SECRET);
export const SENTINEL_BODY = toBase32(SENTINEL_SECRET);

const windows = (s: string, size: number) =>
  Array.from({ length: Math.max(0, s.length - size + 1) }, (_, i) => s.slice(i, i + size));

// 16 hex chars = 8 bytes; 13 base32 chars = 65 bits; 11 base64 chars = 66 bits. Long enough
// that a match is never chance, short enough that a quarter of the key is caught.
const HEX_WINDOWS = windows(SENTINEL_HEX, 16);
const BODY_WINDOWS = windows(SENTINEL_BODY, 13);
const B64_WINDOWS = [
  ...windows(toBase64(SENTINEL_SECRET), 11),
  ...windows(toBase64Url(SENTINEL_SECRET), 11),
];

/** Every way the sentinel key (or a quarter of it) could appear in `haystack`. */
export const findSentinel = (haystack: string): string[] => {
  const lower = haystack.toLowerCase();
  // Base32 parsing ignores case, spaces and dashes: search the same normalised form.
  const compact = haystack.replace(/[\s-]/g, '').toUpperCase();
  const hits: string[] = [];
  for (const w of HEX_WINDOWS) if (lower.includes(w)) hits.push(`hex:${w}`);
  for (const w of BODY_WINDOWS) if (compact.includes(w)) hits.push(`base32:${w}`);
  for (const w of B64_WINDOWS) if (haystack.includes(w)) hits.push(`base64:${w}`);
  return hits;
};
