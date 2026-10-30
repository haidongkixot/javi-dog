/**
 * Every byte-level choice of JD-M11 in one place (ADR-0018 §1, §2, §4 and the binding
 * byte-level rules G1–G12 recorded in its Changes), so independent known-answer vectors can
 * be reconciled against it. Changing any value here changes the
 * wire format: it needs a new version label (`JDK2`, `…/v2`) and an ADR update.
 */

/** Project secret length (ADR-0018 §1): 32 random bytes from `crypto.getRandomValues`. */
export const SECRET_BYTES = 32;

/**
 * G1: Crockford base32 alphabet (no I, L, O, U), RFC 4648 §6 bit order (MSB first, 5-bit
 * groups), last group zero-padded on the right, no `=`, upper case. Used for the key body,
 * the checksum and the kid. G2: no Crockford aliases on input — I, L, O and U are refused.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Recovery key: `JDK1-` + 52 body chars (the 32 bytes) + 4 checksum chars, in groups of 4. */
export const RECOVERY_KEY_PREFIX = 'JDK1';
export const RECOVERY_KEY_BODY_CHARS = 52;
/** First 4 base32 characters (= first 20 bits) of SHA-256 over the 32 secret bytes. */
export const RECOVERY_KEY_CHECKSUM_CHARS = 4;
export const RECOVERY_KEY_GROUP_CHARS = 4;
export const RECOVERY_KEY_SEPARATOR = '-';
/** G2: parsing removes only these characters (U+0020 and `-`), then upper-cases. */
export const RECOVERY_KEY_IGNORED = /[ -]/g;
/** Inputs longer than this are refused before any processing. */
export const RECOVERY_KEY_MAX_INPUT_CHARS = 512;

/** HKDF (RFC 5869) parameters (ADR-0018 §2). */
export const HKDF_HASH = 'SHA-256';
/** Empty salt: a zero-length byte string (RFC 5869 then uses HashLen zero bytes). */
export const HKDF_SALT: Uint8Array<ArrayBuffer> = new Uint8Array(0);
export const HKDF_INFO_KID = 'jgr/kid/v1';
export const HKDF_INFO_L2 = 'jgr/l2/aes-gcm/v1';
/** Followed by the field name: `jgr/l1/v1/repo`, `…/branch`, `…/cwd`, `…/file`. */
export const HKDF_INFO_L1_PREFIX = 'jgr/l1/v1/';
/** Separates the label from the project slug in every `info` string. */
export const HKDF_INFO_SLUG_SEPARATOR = '|';
/** `info` = UTF-8 bytes of `<label>|<slug>`; slugs are ASCII (see SLUG_PATTERN). */
export const hkdfInfo = (label: string, slug: string): string =>
  `${label}${HKDF_INFO_SLUG_SEPARATOR}${slug}`;

/**
 * G4: kid = Crockford base32 of 5 bytes of HKDF output = 8 characters (40 bits, no pad bits).
 * HKDF output is prefix-stable, so these are also the first 8 characters of a longer output.
 */
export const KID_HKDF_BYTES = 5;
export const KID_CHARS = 8;

/** L2 key: 32 bytes of HKDF output, imported as AES-256-GCM. */
export const L2_KEY_BITS = 256;
/**
 * G4: L1 keys are exactly 32 bytes of HKDF output each, imported as HMAC-SHA256 keys with an
 * explicit `length: 256` (WebCrypto's HMAC default is the 64-byte block size).
 */
export const L1_KEY_BITS = 256;

/** L1 identifier fields (ADR-0018 §2); each has its own key for domain separation. */
export const L1_FIELDS = ['repo', 'branch', 'cwd', 'file'] as const;
export type L1Field = (typeof L1_FIELDS)[number];
/** Wire prefix kept from JGR v0.1 (§7); the value is a keyed HMAC, not a plain hash. */
export const L1_HASH_PREFIX = 'sha256:';
/** Unicode normalisation applied to every L1 value and L2 name before UTF-8 encoding. */
export const NAME_NORMALIZATION = 'NFC';

/** AAD: UTF-8 of `jgr|v1|<event_id>|<slug>|<producer_id>|<thread_ref>|<type>|<kid>|L2`. */
export const AAD_PROTOCOL = 'jgr';
export const AAD_VERSION = 'v1';
export const AAD_CLASS = 'L2';
export const AAD_SEPARATOR = '|';

/** L2 ciphertext object (JGR §7). */
export const L2_ALG = 'A256GCM';
export const IV_BYTES = 12;
/** 12 bytes = 16 base64url characters, unpadded. */
export const IV_BASE64URL_CHARS = 16;
export const TAG_BYTES = 16;
/** `ciphertext` = base64url (RFC 4648 §5, no padding) of C ‖ T, T = 128-bit tag. */
export const TAG_BITS = TAG_BYTES * 8;
/** Inputs longer than this are refused before decoding (4 KiB plaintext + tag, base64url). */
export const CIPHERTEXT_MAX_CHARS = Math.ceil(((4096 + TAG_BYTES) * 4) / 3);

/** L2 payload v1 (ADR-0018 §4): JSON, padded with spaces to exactly 256 bytes. */
export const L2_PAYLOAD_VERSION = 1;
export const L2_PAYLOAD_BYTES = 256;
export const L2_NAME_MAX_CODE_POINTS = 100;
/**
 * G6: each name is cut to the longest prefix of at most 100 code points whose JSON-escaped
 * UTF-8 length (without the quotes) is at most 113 bytes: 2 × 113 + 29 bytes of JSON frame
 * (`{"v":1,"repo":"","branch":""}`) = 255 < 256.
 */
export const L2_NAME_MAX_JSON_BYTES = 113;
export const L2_PAD_BYTE = 0x20;

/**
 * Project slugs accepted in `info` strings: JGR opaque refs (spec §3) — ASCII letters,
 * digits, `_`, `:` and `-`, 1–128 characters. This excludes `|`.
 */
export const SLUG_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;
