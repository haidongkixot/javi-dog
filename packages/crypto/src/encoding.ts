// Byte encodings used by JD-M11. Web-platform only (TextEncoder/TextDecoder), no Buffer.
import { CROCKFORD_ALIASES, CROCKFORD_ALPHABET } from './constants.ts';

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (text: string): Bytes => encoder.encode(text);

/** Strict UTF-8 decoding; `null` for invalid sequences. */
export const fromUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
};

/** Copies into a fresh ArrayBuffer-backed array (what WebCrypto's BufferSource expects). */
export const copyBytes = (bytes: Uint8Array): Bytes => {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
};

export const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
};

/** Crockford base32, MSB-first; a final partial group is padded with zero bits. */
export const toBase32 = (bytes: Uint8Array): string => {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
};

const BASE32_VALUES = new Map<string, number>([
  ...[...CROCKFORD_ALPHABET].map((c, i) => [c, i] as const),
  ...Object.entries(CROCKFORD_ALIASES).map(
    ([alias, target]) => [alias, CROCKFORD_ALPHABET.indexOf(target)] as const,
  ),
]);

/** Replaces Crockford aliases by their canonical characters; `null` if a character is invalid. */
export const canonicalBase32 = (text: string): string | null => {
  let out = '';
  for (const char of text) {
    const value = BASE32_VALUES.get(char);
    if (value === undefined) return null;
    out += CROCKFORD_ALPHABET[value];
  }
  return out;
};

export type Base32Decode =
  { ok: true; bytes: Bytes } | { ok: false; reason: 'character' | 'padding' };

/**
 * Decodes upper-case Crockford base32 (aliases I, L → 1 and O → 0 accepted) into `length`
 * bytes. The input must be exactly ceil(length·8/5) characters (checked by the caller) and
 * the pad bits must be zero, so every byte string has exactly one accepted spelling
 * (aliases aside).
 */
export const fromBase32 = (text: string, length: number): Base32Decode => {
  const out = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = BASE32_VALUES.get(char);
    if (value === undefined) return { ok: false, reason: 'character' };
    buffer = ((buffer << 5) | value) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index < length) out[index] = (buffer >>> bits) & 0xff;
      index += 1;
    }
  }
  if (index !== length || (buffer & ((1 << bits) - 1)) !== 0)
    return { ok: false, reason: 'padding' };
  return { ok: true, bytes: out };
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_VALUES = new Map([...B64URL].map((c, i) => [c, i] as const));

/** base64url (RFC 4648 §5) without padding. */
export const toBase64Url = (bytes: Uint8Array): string => {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[n >>> 18]! + B64URL[(n >>> 12) & 63]! + B64URL[(n >>> 6) & 63]!;
  }
  return out;
};

/**
 * Strict base64url decoding: URL-safe alphabet only, no `=` padding, no whitespace, a valid
 * length and zero pad bits. `null` for anything else.
 */
export const fromBase64Url = (text: string): Bytes | null => {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = B64URL_VALUES.get(char);
    if (value === undefined) return null;
    buffer = ((buffer << 6) | value) & 0x3fff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >>> bits) & 0xff;
      index += 1;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
};
