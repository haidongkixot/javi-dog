// L2 payload v1, AAD and AES-256-GCM (ADR-0018 §4, §8).
import { canonicalEventId } from '@javis-dog/jgr-spec';
import {
  AAD_CLASS,
  AAD_PROTOCOL,
  AAD_SEPARATOR,
  AAD_VERSION,
  CIPHERTEXT_MAX_CHARS,
  IV_BASE64URL_CHARS,
  IV_BYTES,
  L2_ALG,
  L2_NAME_MAX_CODE_POINTS,
  L2_PAD_BYTE,
  L2_PAYLOAD_BYTES,
  L2_PAYLOAD_VERSION,
  NAME_NORMALIZATION,
  TAG_BITS,
  TAG_BYTES,
} from './constants.ts';
import { fromBase64Url, fromUtf8, toBase64Url, utf8, type Bytes } from './encoding.ts';

/** Every part of the AAD (ADR-0018 §4). */
export type AadParts = Readonly<{
  /** JGR `event_id`; canonicalised with `canonicalEventId()` (JD-M01). */
  eventId: string;
  /** Project slug, never the project UUID. */
  slug: string;
  producerId: string;
  threadRef: string;
  /** JGR event `type`, e.g. `x.javi.thread.identity`. */
  type: string;
  kid: string;
}>;

/** The AAD parts that come from the event; the kid comes from the key or the ciphertext. */
export type AadContext = Omit<AadParts, 'kid'>;

/** What a producer encrypts (ADR-0018 §4, §5). */
export type L2PayloadInput =
  Readonly<{ repo?: string | undefined; branch?: string | undefined }> | Readonly<{ canary: true }>;

/** A decrypted L2 payload v1. Unknown keys are dropped. */
export type L2Payload = { v: 1; repo?: string; branch?: string } | { v: 1; canary: true };

/** JGR `encrypted` object (spec §7). */
export type EncryptedL2 = {
  alg: typeof L2_ALG;
  kid: string;
  /** base64url of 12 random bytes: 16 characters. */
  iv: string;
  /** base64url of the ciphertext followed by the 16-byte GCM tag. */
  ciphertext: string;
};

/**
 * - `no-key`: no key is loaded at all;
 * - `other-kid`: keys are loaded, none has this kid;
 * - `unverifiable`: a key with this kid is loaded but GCM authentication fails (changed or
 *   damaged data, or an AAD that does not match: another event, thread, type, project,
 *   producer or kid);
 * - `malformed`: the encrypted object, the AAD context or the decrypted payload has the
 *   wrong shape.
 */
export type DecryptL2Failure = 'no-key' | 'other-kid' | 'unverifiable' | 'malformed';
export type DecryptL2Result =
  { ok: true; payload: L2Payload } | { ok: false; reason: DecryptL2Failure };

const AAD_PART_NAMES = ['eventId', 'slug', 'producerId', 'threadRef', 'type', 'kid'] as const;

/**
 * UTF-8 bytes of `jgr|v1|<canonical event_id>|<slug>|<producer_id>|<thread_ref>|<type>|<kid>|L2`.
 * Throws a TypeError (naming the part, not its value) when a part is missing, empty or
 * contains `|`.
 */
export const buildAad = (parts: AadParts): Bytes => {
  for (const name of AAD_PART_NAMES) {
    const value: unknown = parts?.[name];
    if (typeof value !== 'string' || value.length === 0 || value.includes(AAD_SEPARATOR)) {
      throw new TypeError(
        `AAD part ${name} must be a non-empty string without "${AAD_SEPARATOR}".`,
      );
    }
  }
  return utf8(
    [
      AAD_PROTOCOL,
      AAD_VERSION,
      canonicalEventId(parts.eventId),
      parts.slug,
      parts.producerId,
      parts.threadRef,
      parts.type,
      parts.kid,
      AAD_CLASS,
    ].join(AAD_SEPARATOR),
  );
};

const codePoints = (value: string): string[] =>
  Array.from(value.normalize(NAME_NORMALIZATION)).slice(0, L2_NAME_MAX_CODE_POINTS);

const jsonBytes = (value: string): number => utf8(JSON.stringify(value)).length;

const optionalName = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`L2 ${field} must be a string.`);
  return codePoints(value);
};

/**
 * L2 payload v1: `{"v":1,"repo":…,"branch":…}` (absent fields omitted) or
 * `{"v":1,"canary":true}`, padded with spaces to exactly 256 bytes. Names are
 * NFC-normalised and cut to 100 code points; if the JSON is still above 256 bytes
 * (multi-byte characters or escapes), whole code points are removed from the end of the
 * name whose JSON string is longer in bytes (branch on a tie) until it fits.
 */
export const encodeL2Payload = (input: L2PayloadInput): Bytes => {
  let json: string;
  if (input !== null && typeof input === 'object' && 'canary' in input) {
    if (input.canary !== true || 'repo' in input || 'branch' in input) {
      throw new TypeError('An L2 canary is exactly { canary: true }.');
    }
    json = JSON.stringify({ v: L2_PAYLOAD_VERSION, canary: true });
  } else {
    if (input === null || typeof input !== 'object')
      throw new TypeError('L2 payload is an object.');
    const repo = optionalName(input.repo, 'repo');
    const branch = optionalName(input.branch, 'branch');
    const serialise = () =>
      JSON.stringify({
        v: L2_PAYLOAD_VERSION,
        ...(repo ? { repo: repo.join('') } : {}),
        ...(branch ? { branch: branch.join('') } : {}),
      });
    json = serialise();
    while (utf8(json).length > L2_PAYLOAD_BYTES) {
      const repoBytes = repo ? jsonBytes(repo.join('')) : -1;
      const branchBytes = branch ? jsonBytes(branch.join('')) : -1;
      if (branch && branchBytes >= repoBytes) branch.pop();
      else repo?.pop();
      json = serialise();
    }
  }
  const out = new Uint8Array(L2_PAYLOAD_BYTES).fill(L2_PAD_BYTE);
  out.set(utf8(json));
  return out;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parses a decrypted payload; `null` unless it is a v1 payload with well-typed fields. */
export const decodeL2Payload = (bytes: Uint8Array): L2Payload | null => {
  const text = fromUtf8(bytes);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.v !== L2_PAYLOAD_VERSION) return null;
  if ('canary' in value) {
    return value.canary === true && !('repo' in value) && !('branch' in value)
      ? { v: 1, canary: true }
      : null;
  }
  const { repo, branch } = value;
  if (repo !== undefined && typeof repo !== 'string') return null;
  if (branch !== undefined && typeof branch !== 'string') return null;
  return {
    v: 1,
    ...(repo !== undefined ? { repo } : {}),
    ...(branch !== undefined ? { branch } : {}),
  };
};

/**
 * Encrypts an L2 payload with AES-256-GCM: a fresh 12-byte random IV, the AAD of
 * `buildAad({ ...context, kid })`, and the 256-byte padded payload. Throws a TypeError for
 * an invalid AAD part or payload.
 */
export const encryptL2 = async (
  l2Key: CryptoKey,
  kid: string,
  context: AadContext,
  payload: L2PayloadInput,
): Promise<EncryptedL2> => {
  const additionalData = buildAad({ ...context, kid });
  const plaintext = encodeL2Payload(payload);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: TAG_BITS },
    l2Key,
    plaintext,
  );
  return {
    alg: L2_ALG,
    kid,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(sealed)),
  };
};

type Parsed = { kid: string; iv: Bytes; ciphertext: Bytes };

const parseEncrypted = (value: unknown): Parsed | null => {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'alg,ciphertext,iv,kid') return null;
  const { alg, kid, iv, ciphertext } = value;
  if (alg !== L2_ALG) return null;
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 64) return null;
  if (kid.includes(AAD_SEPARATOR)) return null;
  if (typeof iv !== 'string' || iv.length !== IV_BASE64URL_CHARS) return null;
  if (typeof ciphertext !== 'string' || ciphertext.length > CIPHERTEXT_MAX_CHARS) return null;
  const ivBytes = fromBase64Url(iv);
  const ctBytes = fromBase64Url(ciphertext);
  if (ivBytes?.length !== IV_BYTES || ctBytes === null || ctBytes.length < TAG_BYTES) return null;
  return { kid, iv: ivBytes, ciphertext: ctBytes };
};

const isKeyMap = (value: unknown): value is ReadonlyMap<string, CryptoKey> =>
  value instanceof Map ||
  (value !== null &&
    typeof value === 'object' &&
    typeof (value as Map<string, CryptoKey>).get === 'function' &&
    typeof (value as Map<string, CryptoKey>).size === 'number');

/**
 * Decrypts a JGR `encrypted` object with the key whose kid it names. Never throws: every
 * failure is a typed result (see DecryptL2Failure). `keysByKid` is a Map, so kids never
 * resolve through an object's prototype chain.
 */
export const decryptL2 = async (
  keysByKid: ReadonlyMap<string, CryptoKey>,
  encrypted: unknown,
  context: AadContext,
): Promise<DecryptL2Result> => {
  try {
    if (!isKeyMap(keysByKid)) return { ok: false, reason: 'malformed' };
    const parsed = parseEncrypted(encrypted);
    if (parsed === null) return { ok: false, reason: 'malformed' };
    let additionalData: Bytes;
    try {
      additionalData = buildAad({ ...context, kid: parsed.kid });
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const key = keysByKid.get(parsed.kid);
    if (key === undefined) {
      return { ok: false, reason: keysByKid.size > 0 ? 'other-kid' : 'no-key' };
    }
    let plaintext: ArrayBuffer;
    try {
      plaintext = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: parsed.iv, additionalData, tagLength: TAG_BITS },
        key,
        parsed.ciphertext,
      );
    } catch {
      return { ok: false, reason: 'unverifiable' };
    }
    const payload = decodeL2Payload(new Uint8Array(plaintext));
    return payload === null ? { ok: false, reason: 'malformed' } : { ok: true, payload };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
};
