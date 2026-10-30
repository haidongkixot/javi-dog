// Browser key store for L2 reading (ADR-0018 §8). Client-side only: nothing here is ever sent to
// the server, logged or rendered. Keys are non-extractable `CryptoKey`s derived in the browser
// by `deriveProjectKeys`; the recovery key text and secret bytes are never kept here.
//
// - Memory by default, per tab.
// - "Remember on this device" persists the non-extractable keys through a `KeyPersistence`
//   (IndexedDB in browsers, an in-memory fake in tests) — only after an explicit choice, and
//   only while the release gate is on (`remember-gate.ts`, review L1, ADR-0018 §11). With the
//   gate off the device store is used for one thing only: deleting rows left by earlier builds.
// - "Forget on this device", the sign-out button, a 401 from the dashboard snapshot, a page that
//   renders signed-out and a sign-out in another tab (`SignOutChannel`, a BroadcastChannel in
//   browsers) clear keys.
// - Remembered keys belong to the signed-in user (review M2): each row carries the user id, and
//   rows of another user (or with none) are deleted on load, never used.
import { REMEMBER_ON_DEVICE_ENABLED } from './remember-gate';

/** What is remembered: the non-extractable AES-GCM key, never the secret, and whose it is. */
export interface StoredKey {
  projectId: string;
  kid: string;
  l2Key: CryptoKey;
  /** The signed-in user who chose to remember it (review M2). */
  userId: string;
}

/** Device storage for remembered keys. The browser implementation is `idb.ts`. */
export interface KeyPersistence {
  load(): Promise<StoredKey[]>;
  save(key: StoredKey): Promise<void>;
  /** Removes one key, or every key of the project when `kid` is omitted. */
  remove(projectId: string, kid?: string): Promise<void>;
  clear(): Promise<void>;
}

/** Cross-tab sign-out notice. Carries no data besides "signed out". */
export interface SignOutChannel {
  post(): void;
  /** Returns an unsubscribe function. */
  listen(onSignOut: () => void): () => void;
}

export type ClearReason = 'sign-out' | 'session-ended' | 'other-tab';

export interface LoadedKeyInfo {
  kid: string;
  remembered: boolean;
}

interface Entry {
  l2Key: CryptoKey;
  remembered: boolean;
}

export interface KeyStore {
  subscribe(listener: () => void): () => void;
  /** Changes whenever keys change; use with `useSyncExternalStore`. */
  getVersion(): number;
  /** The project's keys by `kid`, as `decryptL2` takes them. */
  keysFor(projectId: string): ReadonlyMap<string, CryptoKey>;
  list(projectId: string): LoadedKeyInfo[];
  /** Whether "Remember on this device" is released at all (review L1, ADR-0018 §11). */
  rememberOffered(): boolean;
  /** Whether remembered keys can be stored on this device: released and a device store. */
  canRemember(): boolean;
  add(projectId: string, kid: string, l2Key: CryptoKey): void;
  /**
   * Persists a loaded key for the signed-in user (explicit consent). Resolves false when it could
   * not be stored, or while the user is unknown.
   */
  remember(projectId: string, kid: string): Promise<boolean>;
  /** "Forget on this device": memory and device storage, this project only. */
  forgetProject(projectId: string): Promise<void>;
  /**
   * Every key of every project, memory and device storage, and the user binding. Broadcasts
   * unless `other-tab`.
   */
  clearAll(reason: ClearReason): Promise<void>;
  /**
   * The signed-in user from the session (review M2), or null. A different user forgets the keys
   * in memory; the new user's remembered keys load.
   */
  setUser(userId: string | null): void;
  /**
   * Loads the signed-in user's remembered keys once per user (called by the components on mount
   * and by `setUser`). Rows of another user, or without a user id, are deleted and never loaded.
   * Does nothing while the user is unknown.
   */
  hydrate(): Promise<void>;
  /** Stops listening to other tabs (tests). */
  dispose(): void;
}

const VALID_KID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const isSecretKey = (value: unknown): value is CryptoKey =>
  typeof value === 'object' &&
  value !== null &&
  (value as CryptoKey).type === 'secret' &&
  (value as CryptoKey).extractable === false;

/**
 * Review L6: how long signing out waits for the device store to clear. Memory is cleared before
 * the wait; a device store that hangs (a blocked IndexedDB open) must never block signing out.
 */
export const DEVICE_CLEAR_TIMEOUT_MS = 1_500;

export const createKeyStore = ({
  persistence,
  channel,
  deviceClearTimeoutMs = DEVICE_CLEAR_TIMEOUT_MS,
  rememberEnabled = REMEMBER_ON_DEVICE_ENABLED,
}: {
  persistence: KeyPersistence | null;
  channel: SignOutChannel | null;
  deviceClearTimeoutMs?: number;
  /** Tests only: forces the release gate (review L1). The app always uses the default. */
  rememberEnabled?: boolean;
}): KeyStore => {
  // Gate off: the device store is never written or read, only cleared (see `hydrate`).
  const remembering = rememberEnabled ? persistence : null;
  let purge: Promise<void> | null = null;
  const projects = new Map<string, Map<string, Entry>>();
  const listeners = new Set<() => void>();
  let version = 0;
  let hydration: Promise<void> | null = null;
  // Bumped by every clear: a hydration that started before it must not resurrect keys.
  let epoch = 0;
  // The signed-in user (review M2); null until the session is known and after any clear.
  let user: string | null = null;

  const emit = () => {
    version += 1;
    for (const l of [...listeners]) l();
  };

  const put = (projectId: string, kid: string, entry: Entry) => {
    let keys = projects.get(projectId);
    if (!keys) projects.set(projectId, (keys = new Map()));
    keys.set(kid, entry);
  };

  const clearMemory = () => {
    epoch += 1;
    const had = projects.size > 0;
    projects.clear();
    if (had) emit();
  };

  const quietly = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      // Device storage can be unavailable (private mode, blocked site data): memory still clears.
    }
  };

  /** `quietly`, but never waits longer than `deviceClearTimeoutMs` (review L6). */
  const quicklyAndQuietly = async (work: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deviceClearTimeoutMs);
    });
    try {
      await Promise.race([quietly(work), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const store: KeyStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    keysFor(projectId) {
      const keys = projects.get(projectId);
      return new Map([...(keys ?? [])].map(([kid, e]) => [kid, e.l2Key]));
    },
    list(projectId) {
      return [...(projects.get(projectId) ?? [])]
        .map(([kid, e]) => ({ kid, remembered: e.remembered }))
        .sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
    },
    rememberOffered: () => rememberEnabled,
    canRemember: () => remembering !== null,
    add(projectId, kid, l2Key) {
      if (!VALID_KID.test(kid)) throw new TypeError('A kid is 8 Crockford base32 characters.');
      const existing = projects.get(projectId)?.get(kid);
      put(projectId, kid, { l2Key, remembered: existing?.remembered ?? false });
      emit();
    },
    async remember(projectId, kid) {
      const entry = projects.get(projectId)?.get(kid);
      const userId = user;
      const device = remembering;
      if (!entry || !device || userId === null) return false;
      try {
        await device.save({ projectId, kid, l2Key: entry.l2Key, userId });
      } catch {
        return false;
      }
      // Cleared (or another user) meanwhile: undo the write rather than keep a forgotten key.
      if (projects.get(projectId)?.get(kid) !== entry || user !== userId) {
        await quietly(() => device.remove(projectId, kid));
        return false;
      }
      entry.remembered = true;
      emit();
      return true;
    },
    async forgetProject(projectId) {
      if (projects.delete(projectId)) emit();
      if (persistence) await quietly(() => persistence.remove(projectId));
    },
    async clearAll(reason) {
      clearMemory();
      user = null;
      hydration = null;
      if (reason !== 'other-tab') channel?.post();
      // The tab that signed out clears the shared device storage; another tab only its memory
      // (the storage is the same, so clearing it again is harmless but not needed).
      if (persistence && reason !== 'other-tab') {
        await quicklyAndQuietly(() => persistence.clear());
      }
    },
    setUser(userId) {
      if (userId === user) return;
      // Keys in memory belong to whoever was signed in: another user never inherits them.
      if (user !== null) clearMemory();
      user = userId;
      hydration = null;
      if (userId !== null) void store.hydrate();
    },
    hydrate() {
      // Gate off (review L1): nothing is loaded; rows an earlier build stored are deleted once.
      if (persistence && !remembering) {
        purge ??= quietly(() => persistence.clear());
        return purge;
      }
      const userId = user;
      const device = remembering;
      if (!device || userId === null) return Promise.resolve();
      hydration ??= (async () => {
        const started = epoch;
        let stored: StoredKey[] = [];
        try {
          stored = await device.load();
        } catch {
          return;
        }
        if (started !== epoch || user !== userId) return;
        let added = false;
        const foreign: Array<[string, string]> = [];
        for (const k of stored) {
          if (!k || typeof k.projectId !== 'string' || typeof k.kid !== 'string') continue;
          // Another user's key, or a row stored before rows carried a user (review M2).
          if (k.userId !== userId) {
            foreign.push([k.projectId, k.kid]);
            continue;
          }
          if (!VALID_KID.test(k.kid) || !isSecretKey(k.l2Key)) continue;
          if (projects.get(k.projectId)?.has(k.kid)) {
            projects.get(k.projectId)!.get(k.kid)!.remembered = true;
          } else put(k.projectId, k.kid, { l2Key: k.l2Key, remembered: true });
          added = true;
        }
        if (added) emit();
        for (const [projectId, kid] of foreign) {
          await quietly(() => device.remove(projectId, kid));
        }
      })();
      return hydration;
    },
    dispose: () => unlisten(),
  };

  const unlisten = channel ? channel.listen(() => void store.clearAll('other-tab')) : () => {};
  return store;
};
