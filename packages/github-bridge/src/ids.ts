import { createHash } from 'node:crypto';

/**
 * Fixed UUIDv5 namespace for GitHub-derived event ids (ADR-0019 §5, D0 H2). Chosen once at random
 * on 2026-11-01 (S5g); never change it, or redelivered bodies would get new event ids and dedupe
 * would break.
 */
export const GITHUB_EVENT_ID_NAMESPACE = 'a12f7c76-a99e-4db8-8b03-f0b8638b36da';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Lower-case hex SHA-256 of bytes or UTF-8 text (the delivery body hash, D0 H2). */
export const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

/** True for a lower-case 64-hex SHA-256 digest. */
export const isSha256Hex = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_HEX.test(value);

/** RFC 9562 UUIDv5 (SHA-1, name-based), lower case. */
export const uuidV5 = (namespace: string, name: string): string => {
  if (!UUID.test(namespace)) throw new RangeError('namespace must be a UUID.');
  const ns = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** `event_id` of the `index`-th event mapped from a delivery body: UUIDv5 of `<bodySha256>:<index>`. */
export const deliveryEventId = (bodySha256: string, index: number): string => {
  if (!isSha256Hex(bodySha256)) throw new RangeError('bodySha256 must be 64 lower-case hex.');
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('index must be ≥ 0.');
  return uuidV5(GITHUB_EVENT_ID_NAMESPACE, `${bodySha256}:${index}`);
};

/** `producer_id` of every bridge event: `gh-app_<installation_id>` (reserved at ingest, D0 M2). */
export const githubProducerId = (installationId: number): string => `gh-app_${installationId}`;

/** `gh_` + the first 32 hex characters of SHA-256 over the thread key (opaque, not L1). */
const threadRef = (key: string) => `gh_${sha256Hex(key).slice(0, 32)}`;

/** One thread per workflow-run attempt (D0 M3): `run|<run_id>|<run_attempt>`. */
export const runThreadRef = (runId: number, runAttempt: number) =>
  threadRef(`run|${runId}|${runAttempt}`);

/** One thread per check suite (D0 M3): `suite|<check_suite.id>`. */
export const suiteThreadRef = (suiteId: number) => threadRef(`suite|${suiteId}`);

/** One thread per pull request: `pr|<repo_id>|<number>`. */
export const prThreadRef = (repoId: number, number: number) => threadRef(`pr|${repoId}|${number}`);
