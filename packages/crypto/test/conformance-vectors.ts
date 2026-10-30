// Loading, typing and shared adapters for the privacy conformance vectors
// (docs/jgr/conformance/privacy/, ADR-0018). Test-only: Node built-ins are allowed here.
import { readdirSync, readFileSync } from 'node:fs';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
import {
  AAD_CLASS,
  AAD_PROTOCOL,
  AAD_SEPARATOR,
  AAD_VERSION,
  deriveProjectKeys,
  type AadContext,
  type DecryptL2Failure,
  type L2PayloadInput,
  type ProjectKeys,
} from '../src/index.ts';
import { validateAgainstSchema } from './conformance-schema.ts';

export const SUITE_DIR = new URL('../../../docs/jgr/conformance/privacy/', import.meta.url);

// ---------------------------------------------------------------------------------------
// Vector shapes (README "Vector file format"); files are checked against schema.json first.

export type KeyRef = { secret: 'S1' | 'S2' | 'S3' | 'S4'; secretHex: string; slug: string };
export type Encrypted = { alg: string; kid: string; iv: string; ciphertext: string };
export type VectorEvent = {
  event_id: string;
  project_slug: string;
  producer_id: string;
  thread_ref: string;
  type: string;
  privacy_class: string;
  encrypted: Encrypted;
};
export type PayloadObject = { v: 1; repo?: string; branch?: string; canary?: true };
export type Reason =
  | 'prefix'
  | 'character'
  | 'length'
  | 'noncanonical'
  | 'checksum'
  | 'aad_part_pipe'
  | 'no_key'
  | 'kid_mismatch'
  | 'auth_failed'
  | 'iv_length'
  | 'encoding'
  | 'alg';

type Head = { id: string; kind: string; description: string; ambiguities: string[] };
type Case<T> = { label: string; note: string } & T;

export type RecoveryKeyFormatVector = Head & {
  cases: Case<{
    secretHex: string;
    expect: { body: string; checksum: string; sha256Hex: string; recoveryKey: string };
  }>[];
};
export type RecoveryKeyParseVector = Head & {
  cases: Case<{
    input: string;
    expect: { ok: boolean; secretHex: string | null; reason: Reason | null };
  }>[];
};
type PerField<T> = { repo: T; branch: T; cwd: T; file: T };
export type DeriveVector = Head & {
  cases: Case<{
    secretHex: string;
    slug: string;
    expect: {
      info: { kid: string; l2: string; l1: PerField<string> };
      kidOkm5Hex: string;
      kid: string;
      l2KeyHex: string;
      l1KeyHex: PerField<string>;
    };
  }>[];
};
export type L1HashVector = Head & {
  plainSha256: Record<string, string> | null;
  cases: Case<{
    secretHex: string;
    slug: string;
    field: 'repo' | 'branch' | 'cwd' | 'file';
    value: string;
    valueUtf8Hex: string;
    expect: { nfcUtf8Hex: string; hash: string };
  }>[];
};
export type AadInput = {
  event_id: string;
  project_slug: string;
  producer_id: string;
  thread_ref: string;
  type: string;
  kid: string;
  privacy_class: string;
};
export type AadVector = Head & {
  cases: Case<{
    input: AadInput;
    expect: { ok: boolean; aadUtf8: string | null; aadHex: string | null; reason: Reason | null };
  }>[];
};
export type PayloadVector = Head & {
  cases: Case<{
    input: { repo: string | null; branch: string | null; canary: boolean };
    expect: {
      payload: PayloadObject;
      json: string;
      jsonByteLength: number;
      paddedByteLength: number;
      paddedSha256Hex: string;
      paddedHex: string;
    };
  }>[];
};
export type AesGcmVector = Head & {
  cases: Case<{
    key: KeyRef;
    l2KeyHex: string;
    ivHex: string;
    plaintextHex: string;
    aadUtf8: string;
    expect: { ciphertextAndTagHex: string; tagHex: string; event: VectorEvent };
  }>[];
};
export type DecryptCase = Case<{
  layer: 'envelope' | 'aead';
  deviceKeys: KeyRef[];
  event: VectorEvent | null;
  aead: { l2KeyHex: string; ivHex: string; ciphertextAndTagHex: string; aadUtf8: string } | null;
  expect: {
    ok: boolean;
    payload: PayloadObject | null;
    aadUtf8: string | null;
    reason: Reason | null;
  };
}>;
export type DecryptVector = Head & { cases: DecryptCase[] };
export type LabelState = 'no-key' | 'other-kid' | 'failed' | 'decrypted';
export type LabelVector = Head & {
  cases: Case<{
    deviceKeys: KeyRef[];
    event: VectorEvent;
    expect: { state: LabelState; threadText: string };
  }>[];
};
export type LabelStep = {
  action: 'open' | 'decrypt' | 'reload';
  note: string;
  deviceKeys: KeyRef[];
  event: VectorEvent | null;
  expect: { projectLabel: string };
};
export type LabelSequenceVector = Head & {
  project: { slug: string; privacyClass: 'L2'; kid: string };
  sequences: { label: string; steps: LabelStep[] }[];
};

// ---------------------------------------------------------------------------------------
// Loading and schema validation (done at collection time, asserted per file and per case).

export type LoadedVector = { file: string; data: unknown; schemaErrors: string[] };

const parseJson = (url: URL): unknown => JSON.parse(readFileSync(url, 'utf8'));

export const schema = parseJson(new URL('schema.json', SUITE_DIR)) as Record<string, unknown>;

export const vectorFiles: string[] = readdirSync(SUITE_DIR)
  .filter((name) => /^[KEP]\d{2}-.+\.json$/.test(name))
  .sort();

export const loaded: ReadonlyMap<string, LoadedVector> = new Map(
  vectorFiles.map((file) => {
    const data = parseJson(new URL(file, SUITE_DIR));
    return [file.slice(0, 3), { file, data, schemaErrors: validateAgainstSchema(schema, data) }];
  }),
);

/** The vector with this id, typed by the caller (the schema check is asserted separately). */
export const vector = <T>(id: string): T & { file: string; schemaErrors: string[] } => {
  const entry = loaded.get(id);
  if (entry === undefined) throw new Error(`Vector ${id} is missing from ${SUITE_DIR.pathname}`);
  return Object.assign({}, entry.data as T, { file: entry.file, schemaErrors: entry.schemaErrors });
};

// ---------------------------------------------------------------------------------------
// Byte helpers (Node, test side only).

export const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(hex, 'hex'));
export const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
export const utf8Hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
/** base64url without padding (RFC 4648 §5), as Node writes it. */
export const hexToBase64Url = (hex: string): string =>
  Buffer.from(hex, 'hex').toString('base64url');
export const base64UrlToHex = (text: string): string =>
  Buffer.from(text, 'base64url').toString('hex');

/** Independent oracle for key bytes: Node's HMAC-SHA256 (OpenSSL), not WebCrypto. */
export const nodeHmacHex = (keyHex: string, value: string): string =>
  createHmac('sha256', Buffer.from(keyHex, 'hex')).update(value, 'utf8').digest('hex');

/** Independent oracle for key bytes: Node's AES-256-GCM (OpenSSL), returns C ‖ T in hex. */
export const nodeAesGcmHex = (keyHex: string, ivHex: string, aad: Uint8Array, pt: Uint8Array) => {
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(ivHex, 'hex'),
  );
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]).toString('hex');
};

// ---------------------------------------------------------------------------------------
// Adapters from vector fields to the JD-M11 public API.

const keyCache = new Map<string, Promise<ProjectKeys>>();

/** deriveProjectKeys(secretHex bytes, slug), memoised per (secret, slug). */
export const deriveFromHex = (secretHex: string, slug: string): Promise<ProjectKeys> => {
  const cacheKey = `${secretHex}|${slug}`;
  let keys = keyCache.get(cacheKey);
  if (keys === undefined) {
    keys = deriveProjectKeys(hexToBytes(secretHex), slug);
    keyCache.set(cacheKey, keys);
  }
  return keys;
};

/**
 * The tab's key store: deviceKeys → Map<kid, l2Key>, in the vector's order. Keys are derived
 * by JD-M11 from secretHex and slug (README: never read derived keys from the file).
 */
export const deviceKeyMap = async (deviceKeys: KeyRef[]): Promise<Map<string, CryptoKey>> => {
  const map = new Map<string, CryptoKey>();
  for (const ref of deviceKeys) {
    const keys = await deriveFromHex(ref.secretHex, ref.slug);
    map.set(keys.kid, keys.l2Key);
  }
  return map;
};

/** Event envelope → JD-M11 AadContext (the kid comes from `encrypted`). */
export const contextOf = (event: {
  event_id: string;
  project_slug: string;
  producer_id: string;
  thread_ref: string;
  type: string;
}): AadContext => ({
  eventId: event.event_id,
  slug: event.project_slug,
  producerId: event.producer_id,
  threadRef: event.thread_ref,
  type: event.type,
});

/** Payload vector input → L2PayloadInput: `null` means absent (the key is left out). */
export const payloadInputOf = (input: {
  repo: string | null;
  branch: string | null;
  canary: boolean;
}): L2PayloadInput => {
  if (input.canary) return { canary: true };
  return {
    ...(input.repo !== null ? { repo: input.repo } : {}),
    ...(input.branch !== null ? { branch: input.branch } : {}),
  };
};

/**
 * Mapping from the README's informative failure categories to JD-M11's DecryptL2Failure.
 * The README never compares `reason`; this runner asserts the mapping for decryption because
 * ADR-0018 Changes G9/G10 bind the thread states to it ("no key in the tab", "one or more
 * keys with none matching", "Can't verify"), and a refusal for the wrong cause (for example
 * a 16-byte iv rejected only because authentication happens to fail) would otherwise pass.
 */
export const DECRYPT_REASON_MAP: Readonly<Record<string, DecryptL2Failure>> = {
  no_key: 'no-key',
  kid_mismatch: 'other-kid',
  auth_failed: 'unverifiable',
  iv_length: 'malformed',
  encoding: 'malformed',
  alg: 'malformed',
  aad_part_pipe: 'malformed',
};

/** P03 `state` → JD-M11 decryptL2 outcome. */
export const LABEL_STATE_MAP: Readonly<Record<LabelState, 'ok' | DecryptL2Failure>> = {
  'no-key': 'no-key',
  'other-kid': 'other-kid',
  failed: 'unverifiable',
  decrypted: 'ok',
};

const CANONICAL_EVENT_ID =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

/**
 * AEAD-layer cases (E06 `layer: aead`) give raw AAD bytes. JD-M11 exposes no raw AES-GCM
 * decryption: decryptL2 always builds `jgr|v1|<canonical event_id>|…|<kid>|L2` itself. A case
 * is runnable through decryptL2 only when its AAD has exactly that shape (decided from the
 * vector text alone, never from the implementation, so a mutation cannot turn a case into
 * NOT RUN); the runner then asserts that buildAad reproduces the vector's bytes before it
 * decrypts. Returns the parts, or the reason the case is NOT RUN.
 */
export const aeadPartsOf = (
  aadUtf8: string,
): { ok: true; kid: string; context: AadContext } | { ok: false; why: string } => {
  const parts = aadUtf8.split(AAD_SEPARATOR);
  if (parts.length !== 9) {
    return { ok: false, why: 'AAD does not have the 9 parts decryptL2 always builds' };
  }
  const [protocol, version, eventId, slug, producerId, threadRef, type, kid, cls] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (protocol !== AAD_PROTOCOL || version !== AAD_VERSION) {
    return { ok: false, why: `decryptL2 always writes "${AAD_PROTOCOL}|${AAD_VERSION}"` };
  }
  if (cls !== AAD_CLASS) return { ok: false, why: `decryptL2 always writes class "${AAD_CLASS}"` };
  if (!CANONICAL_EVENT_ID.test(eventId)) {
    return { ok: false, why: 'decryptL2 always canonicalises event_id (canonicalEventId)' };
  }
  return { ok: true, kid, context: { eventId, slug, producerId, threadRef, type } };
};

/** Imports raw L2 key bytes from an AEAD-layer case (the only place keys come from the file). */
export const importAeadKey = (l2KeyHex: string): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey('raw', hexToBytes(l2KeyHex), 'AES-GCM', false, ['decrypt']);

/** The two project labels of P04 (ADR-0018 §9); anything else is the checked label. */
export const UNCHECKED_PROJECT_LABEL = 'L2 set up. No encrypted event checked yet.';
