// Project secret and recovery key (ADR-0018 §1).
import {
  RECOVERY_KEY_BODY_CHARS,
  RECOVERY_KEY_CHECKSUM_CHARS,
  RECOVERY_KEY_GROUP_CHARS,
  RECOVERY_KEY_MAX_INPUT_CHARS,
  RECOVERY_KEY_PREFIX,
  RECOVERY_KEY_SEPARATOR,
  SECRET_BYTES,
} from './constants.ts';
import { canonicalBase32, copyBytes, fromBase32, toBase32, type Bytes } from './encoding.ts';

/** Why a recovery key was refused. Messages are fixed and never contain the input. */
export type RecoveryKeyError = 'empty' | 'prefix' | 'length' | 'character' | 'checksum';

export const RECOVERY_KEY_ERROR_MESSAGES: Readonly<Record<RecoveryKeyError, string>> = {
  empty: 'No recovery key was entered.',
  prefix: `A recovery key starts with ${RECOVERY_KEY_PREFIX}-.`,
  length: 'This recovery key has the wrong number of characters.',
  character: 'This recovery key contains a character that is not allowed.',
  checksum: 'This recovery key has a typo: its checksum does not match.',
};

export type ParseRecoveryKeyResult =
  { ok: true; secret: Bytes } | { ok: false; reason: RecoveryKeyError; message: string };

const fail = (reason: RecoveryKeyError): ParseRecoveryKeyResult => ({
  ok: false,
  reason,
  message: RECOVERY_KEY_ERROR_MESSAGES[reason],
});

const assertSecret = (secret: Uint8Array): void => {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) {
    throw new TypeError(`A project secret is exactly ${SECRET_BYTES} bytes.`);
  }
};

const checksumOf = async (secret: Uint8Array): Promise<string> => {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', copyBytes(secret)),
  );
  return toBase32(digest).slice(0, RECOVERY_KEY_CHECKSUM_CHARS);
};

/** 32 random bytes from the platform CSPRNG (`crypto.getRandomValues`). */
export const generateProjectSecret = (): Bytes =>
  globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));

/**
 * `JDK1-XXXX-…-XXXX`: the 32 bytes as 52 Crockford base32 characters followed by a
 * 4-character checksum (first 4 base32 characters of SHA-256 over the bytes), in groups of 4.
 * Throws a TypeError (without the input) if the secret is not 32 bytes.
 */
export const encodeRecoveryKey = async (secret: Uint8Array): Promise<string> => {
  assertSecret(secret);
  const chars = toBase32(secret) + (await checksumOf(secret));
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += RECOVERY_KEY_GROUP_CHARS) {
    groups.push(chars.slice(i, i + RECOVERY_KEY_GROUP_CHARS));
  }
  return [RECOVERY_KEY_PREFIX, ...groups].join(RECOVERY_KEY_SEPARATOR);
};

/**
 * Parses a recovery key typed or pasted by a person. Ignores case, whitespace and dashes;
 * accepts the Crockford aliases I and L for 1 and O for 0 (body and checksum only, not the
 * `JDK1` prefix). Never throws; errors are typed and never echo the input.
 */
export const parseRecoveryKey = async (text: string): Promise<ParseRecoveryKeyResult> => {
  if (typeof text !== 'string') return fail('empty');
  if (text.length > RECOVERY_KEY_MAX_INPUT_CHARS) return fail('length');
  const compact = text.replace(/[\s-]+/g, '').toUpperCase();
  if (compact.length === 0) return fail('empty');
  if (!compact.startsWith(RECOVERY_KEY_PREFIX)) return fail('prefix');
  const rest = compact.slice(RECOVERY_KEY_PREFIX.length);
  if (rest.length !== RECOVERY_KEY_BODY_CHARS + RECOVERY_KEY_CHECKSUM_CHARS) return fail('length');

  const decoded = fromBase32(rest.slice(0, RECOVERY_KEY_BODY_CHARS), SECRET_BYTES);
  // Non-zero pad bits in the last body character are a typo as well; report it as a character.
  if (!decoded.ok) return fail('character');
  const typed = canonicalBase32(rest.slice(RECOVERY_KEY_BODY_CHARS));
  if (typed === null) return fail('character');
  if (typed !== (await checksumOf(decoded.bytes))) return fail('checksum');
  return { ok: true, secret: decoded.bytes };
};
