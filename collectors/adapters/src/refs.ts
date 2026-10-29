import { createHmac } from 'node:crypto';

/**
 * Keyed hash with the per-installation salt → opaque ref matching JGR's REF pattern. Same
 * scheme as JD-C01's `opaqueRef` (HMAC-SHA-256, first 32 hex chars), kept local so JD-C02 does
 * not import JD-C01. Module-internal (not part of the public `index.ts` contract).
 */
export const opaqueRef = (prefix: string, value: string, salt: string) =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;
