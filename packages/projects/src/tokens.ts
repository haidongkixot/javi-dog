// Ingest tokens (ADR-0005): `jd_it_` + 32 random bytes as base64url (43 chars).
// Only the SHA-256 hash is stored; the plaintext is shown once at issue time.

export const INGEST_TOKEN_PREFIX = 'jd_it_';
const TOKEN = /^jd_it_([A-Za-z0-9_-]{43})$/;
const SECRET_BYTES = 32;
const DISPLAY_LENGTH = 8;

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** A new random token. Never log or persist the return value. */
export const generateIngestToken = (): string => {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return INGEST_TOKEN_PREFIX + toBase64Url(bytes);
};

/** Returns the secret part of a well-formed token, or `null` (no trimming, no guessing). */
export const parseIngestToken = (raw: unknown): { secret: string } | null => {
  if (typeof raw !== 'string') return null;
  const match = TOKEN.exec(raw);
  if (!match?.[1]) return null;
  // 43 chars carry 258 bits; only the canonical encoding (low 2 bits zero) is accepted.
  if (toBase64Url(Buffer.from(match[1], 'base64url')) !== match[1]) return null;
  return { secret: match[1] };
};

/** Lowercase SHA-256 hex of the full token string. */
export const hashIngestToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('hex');
};

/** Non-secret label shown in the UI so users can tell tokens apart. */
export const displayPrefix = (token: string): string =>
  token.slice(INGEST_TOKEN_PREFIX.length, INGEST_TOKEN_PREFIX.length + DISPLAY_LENGTH);
