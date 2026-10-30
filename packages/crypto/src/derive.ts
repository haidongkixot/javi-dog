// HKDF-SHA256 derivations per project (ADR-0018 §2) and L1 keyed hashes (ADR-0018 §3).
import {
  HKDF_HASH,
  HKDF_INFO_KID,
  HKDF_INFO_L1_PREFIX,
  HKDF_INFO_L2,
  HKDF_SALT,
  hkdfInfo,
  KID_CHARS,
  KID_HKDF_BYTES,
  L1_FIELDS,
  L1_HASH_PREFIX,
  L1_KEY_BITS,
  L2_KEY_BITS,
  NAME_NORMALIZATION,
  SECRET_BYTES,
  SLUG_PATTERN,
  type L1Field,
} from './constants.ts';
import { copyBytes, toBase32, toHex, utf8 } from './encoding.ts';

/** One non-extractable HMAC-SHA256 key per L1 field. */
export type L1Keys = Readonly<Record<L1Field, CryptoKey>>;

export type ProjectKeys = Readonly<{
  /** 8 Crockford base32 characters; names the key in `encrypted.kid` and in the UI. */
  kid: string;
  /** Non-extractable AES-256-GCM key, usages `encrypt` and `decrypt`. */
  l2Key: CryptoKey;
  l1Keys: L1Keys;
}>;

const subtle = () => globalThis.crypto.subtle;

const hkdfParams = (label: string, slug: string): HkdfParams => ({
  name: 'HKDF',
  hash: HKDF_HASH,
  salt: HKDF_SALT,
  info: utf8(hkdfInfo(label, slug)),
});

const isL1Field = (field: unknown): field is L1Field =>
  typeof field === 'string' && (L1_FIELDS as readonly string[]).includes(field);

/**
 * Derives the project's kid, L2 key and L1 keys from the 32-byte secret and the project
 * slug (never the project UUID, ADR-0018 §4). The secret is imported as a non-extractable
 * HKDF key; the derived keys are non-extractable too. Throws a TypeError for a secret that
 * is not 32 bytes or a slug outside SLUG_PATTERN.
 */
export const deriveProjectKeys = async (secret: Uint8Array, slug: string): Promise<ProjectKeys> => {
  if (!(secret instanceof Uint8Array) || secret.length !== SECRET_BYTES) {
    throw new TypeError(`A project secret is exactly ${SECRET_BYTES} bytes.`);
  }
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
    throw new TypeError('A project slug is 1–128 characters: letters, digits, _, : and -.');
  }
  const ikm = await subtle().importKey('raw', copyBytes(secret), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ]);

  const kidBits = await subtle().deriveBits(
    hkdfParams(HKDF_INFO_KID, slug),
    ikm,
    KID_HKDF_BYTES * 8,
  );
  const kid = toBase32(new Uint8Array(kidBits)).slice(0, KID_CHARS);

  const l2Key = await subtle().deriveKey(
    hkdfParams(HKDF_INFO_L2, slug),
    ikm,
    { name: 'AES-GCM', length: L2_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );

  const entries = await Promise.all(
    L1_FIELDS.map(
      async (field) =>
        [
          field,
          await subtle().deriveKey(
            hkdfParams(`${HKDF_INFO_L1_PREFIX}${field}`, slug),
            ikm,
            { name: 'HMAC', hash: 'SHA-256', length: L1_KEY_BITS },
            false,
            ['sign'],
          ),
        ] as const,
    ),
  );
  const l1Keys = Object.freeze(Object.fromEntries(entries)) as L1Keys;

  return Object.freeze({ kid, l2Key, l1Keys });
};

/**
 * L1 identifier hash: `sha256:` + 64 lowercase hex characters of HMAC-SHA256(field key,
 * UTF-8 of the NFC-normalised value). Throws a TypeError for an unknown field or a
 * non-string value.
 */
export const l1Hash = async (l1Keys: L1Keys, field: L1Field, value: string): Promise<string> => {
  if (!isL1Field(field)) throw new TypeError(`L1 fields are ${L1_FIELDS.join(', ')}.`);
  if (typeof value !== 'string') throw new TypeError('An L1 value is a string.');
  const key = l1Keys[field];
  const mac = await subtle().sign('HMAC', key, utf8(value.normalize(NAME_NORMALIZATION)));
  return `${L1_HASH_PREFIX}${toHex(new Uint8Array(mac))}`;
};
