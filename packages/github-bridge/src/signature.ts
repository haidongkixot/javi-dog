import { createHmac, timingSafeEqual } from 'node:crypto';

/** Result of the webhook signature check (ADR-0019 §3.3, D0 L1). The route answers 401 for all but `ok`. */
export type SignatureResult = 'ok' | 'missing' | 'malformed' | 'mismatch';

/** `X-Hub-Signature-256`: exactly `sha256=` and 64 lower-case hex digits (D0 L1). */
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/;

/**
 * Checks GitHub's `X-Hub-Signature-256` header: HMAC-SHA256 over the **raw body bytes** (never
 * decoded text), tried against each secret in order (current, then previous during a rotation).
 *
 * - `missing`: no header, or an empty one;
 * - `malformed`: anything but `sha256=` + 64 lower-case hex;
 * - `mismatch`: no secret matches, or no non-empty secret was given (fail closed);
 * - `ok`: one secret matches.
 *
 * The header is decoded to 32 bytes and compared with `timingSafeEqual` on equal-length buffers
 * only, so a length difference can never throw.
 */
export const verifyGithubSignature = (
  rawBody: Uint8Array,
  header: string | null,
  secrets: readonly string[],
): SignatureResult => {
  if (header === null || header === '') return 'missing';
  const hex = SIGNATURE_HEADER.exec(header)?.[1];
  if (!hex) return 'malformed';
  const given = Buffer.from(hex, 'hex');
  let matched = false;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    // Both are SHA-256 digests (32 bytes); the length check documents the precondition.
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched ? 'ok' : 'mismatch';
};
