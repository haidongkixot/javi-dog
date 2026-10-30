// Decrypting a thread's identity in the browser (ADR-0018 §8). Client-side only. The reader
// (JD-M07) passes the newest `x.javi.thread.identity` event as opaque data; this turns it into
// one of the label states. Never throws.
import { decryptL2 } from '@javis-dog/crypto';
import type { EncryptedObject } from '@javis-dog/realtime';

/**
 * An event with an L2 ciphertext and its AAD parts, as the reader passes it (a `ThreadIdentity`
 * is one; the canary `x.javi.collector.installed` has the same shape). Opaque server data.
 */
export interface L2EventRef {
  eventId: string;
  producerId: string;
  threadRef: string;
  type: string;
  projectSlug: string;
  privacyClass: string;
  encrypted: EncryptedObject | null;
}

export type IdentityView =
  | { kind: 'none' }
  | { kind: 'names'; repo: string | null; branch: string | null; kid: string }
  | { kind: 'no-key'; kid: string }
  | { kind: 'other-kid' }
  | { kind: 'unverifiable' };

const VALID_KID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Bidi controls (ALM, LRM, RLM, LRE…RLO, LRI…PDI) and other C0/C1 control characters. Names
 * are rendered as text only; removing these keeps a name from reordering the row around it.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export const cleanName = (value: string): string => value.replace(UNSAFE, '');

/** The state before (or without) decryption, the same on the server and in the browser. */
export const initialIdentityView = (identity: L2EventRef | null): IdentityView => {
  const enc = identity?.encrypted;
  if (!enc) return { kind: 'none' };
  // The AAD always ends in the class constant `L2` (JD-M11 `buildAad`): only an event stored as
  // L2 is ever decrypted. A ciphertext on an event of another class is not trusted.
  if (!VALID_KID.test(enc.kid) || identity.privacyClass !== 'L2') return { kind: 'unverifiable' };
  return { kind: 'no-key', kid: enc.kid };
};

/**
 * Decrypts with the project's keys. `no-key` (no key for this project), `other-kid` (keys, none
 * with this kid), `unverifiable` (the right kid but GCM fails, a payload that is not v1, a
 * malformed object, or an encrypted object on an event that is not L2).
 */
export const resolveIdentity = async (
  identity: L2EventRef | null,
  keysByKid: ReadonlyMap<string, CryptoKey>,
): Promise<IdentityView> => {
  const initial = initialIdentityView(identity);
  if (initial.kind !== 'no-key' || !identity) return initial;
  const result = await decryptL2(keysByKid, identity.encrypted, {
    eventId: identity.eventId,
    slug: identity.projectSlug,
    producerId: identity.producerId,
    threadRef: identity.threadRef,
    type: identity.type,
  });
  if (!result.ok) {
    if (result.reason === 'no-key') return initial;
    if (result.reason === 'other-kid') return { kind: 'other-kid' };
    return { kind: 'unverifiable' };
  }
  const p = result.payload;
  // G8: either name may be absent; a canary on an identity event shows nothing.
  if ('canary' in p) return { kind: 'names', repo: null, branch: null, kid: initial.kid };
  const repo = p.repo !== undefined ? cleanName(p.repo) : '';
  const branch = p.branch !== undefined ? cleanName(p.branch) : '';
  return { kind: 'names', repo: repo || null, branch: branch || null, kid: initial.kid };
};
