// Decrypting a thread's identity in the browser (ADR-0018 §8). Client-side only. The reader
// (JD-M07) passes the newest `x.javi.thread.identity` event as opaque data; this turns it into
// one of the label states. Never throws.
import { decryptL2 } from '@javis-dog/crypto';
import { THREAD_IDENTITY_TYPE, type EncryptedObject } from '@javis-dog/realtime';

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

/**
 * The row a thread identity is displayed in (review M1): the row's own thread and project slug.
 * The AAD of a thread row is built from these and the constant identity type, never from the
 * server-supplied identity object, so a ciphertext moved to another row (or a canary passed as
 * an identity) cannot decrypt there.
 */
export interface ThreadRow {
  threadRef: string;
  projectSlug: string;
}

export type IdentityView =
  | { kind: 'none' }
  | { kind: 'names'; repo: string | null; branch: string | null; kid: string }
  | { kind: 'no-key'; kid: string }
  | { kind: 'other-kid' }
  | { kind: 'unverifiable' };

const VALID_KID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** The canary's JGR extension type (ADR-0018 §5). Only a project-level check decrypts it. */
const CANARY_TYPE = 'x.javi.collector.installed';

/**
 * Bidi controls (ALM, LRM, RLM, LRE…RLO, LRI…PDI) and other C0/C1 control characters. Names
 * are rendered as text only; removing these keeps a name from reordering the row around it.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

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
 * The first state of a thread row (review M1), the same on the server and in the browser. An
 * identity object whose thread, type or project slug differs from the row it is shown in is
 * `unverifiable` and is never decrypted.
 */
export const initialThreadView = (identity: L2EventRef | null, row: ThreadRow): IdentityView => {
  const initial = initialIdentityView(identity);
  if (initial.kind !== 'no-key' || !identity) return initial;
  if (
    identity.threadRef !== row.threadRef ||
    identity.type !== THREAD_IDENTITY_TYPE ||
    identity.projectSlug !== row.projectSlug
  ) {
    return { kind: 'unverifiable' };
  }
  return initial;
};

interface Aad {
  eventId: string;
  slug: string;
  producerId: string;
  threadRef: string;
  type: string;
}

const decryptView = async (
  enc: EncryptedObject,
  kid: string,
  keysByKid: ReadonlyMap<string, CryptoKey>,
  aad: Aad,
): Promise<IdentityView> => {
  const result = await decryptL2(keysByKid, enc, aad);
  if (!result.ok) {
    if (result.reason === 'no-key') return { kind: 'no-key', kid };
    if (result.reason === 'other-kid') return { kind: 'other-kid' };
    return { kind: 'unverifiable' };
  }
  const p = result.payload;
  // G8: either name may be absent; a canary payload shows nothing.
  if ('canary' in p) return { kind: 'names', repo: null, branch: null, kid };
  const repo = p.repo !== undefined ? cleanName(p.repo) : '';
  const branch = p.branch !== undefined ? cleanName(p.branch) : '';
  return { kind: 'names', repo: repo || null, branch: branch || null, kid };
};

/**
 * Decrypts a thread row's identity with the project's keys (review M1). The AAD is the row's
 * own `threadRef` and project slug and the constant `x.javi.thread.identity` type; only the
 * event id and producer id come from the event. `no-key` (no key for this project),
 * `other-kid` (keys, none with this kid), `unverifiable` (an identity object that does not
 * belong to this row, the right kid but GCM fails, a payload that is not v1, a malformed
 * object, or an encrypted object on an event that is not L2).
 */
export const resolveThreadIdentity = async (
  identity: L2EventRef | null,
  keysByKid: ReadonlyMap<string, CryptoKey>,
  row: ThreadRow,
): Promise<IdentityView> => {
  const initial = initialThreadView(identity, row);
  if (initial.kind !== 'no-key' || !identity?.encrypted) return initial;
  return decryptView(identity.encrypted, initial.kid, keysByKid, {
    eventId: identity.eventId,
    slug: row.projectSlug,
    producerId: identity.producerId,
    threadRef: row.threadRef,
    type: THREAD_IDENTITY_TYPE,
  });
};

/**
 * The project-level check of ADR-0018 §9 ("the canary or any L2 event of the project with the
 * right AAD"), for the project label only: an identity event or the canary, decrypted with the
 * event's own thread and type. The slug is always the project's own. Any other type is
 * `unverifiable`. Never used for a thread row: rows use `resolveThreadIdentity`.
 */
export const resolveProjectEvent = async (
  event: L2EventRef | null,
  keysByKid: ReadonlyMap<string, CryptoKey>,
  projectSlug: string,
): Promise<IdentityView> => {
  const initial = initialIdentityView(event);
  if (initial.kind !== 'no-key' || !event?.encrypted) return initial;
  if (event.type !== THREAD_IDENTITY_TYPE && event.type !== CANARY_TYPE) {
    return { kind: 'unverifiable' };
  }
  return decryptView(event.encrypted, initial.kid, keysByKid, {
    eventId: event.eventId,
    slug: projectSlug,
    producerId: event.producerId,
    threadRef: event.threadRef,
    type: event.type,
  });
};
