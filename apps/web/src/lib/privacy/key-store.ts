// Browser key store for L2 reading (ADR-0018 §8). Client-side only: nothing here is ever sent to
// the server, logged or rendered. Keys are non-extractable `CryptoKey`s derived in the browser
// by `deriveProjectKeys`; the recovery key text and secret bytes are never kept here.
//
// - Memory by default, per tab.
// - "Remember on this device" persists the non-extractable keys through a `KeyPersistence`
//   (IndexedDB in browsers, an in-memory fake in tests) — only after an explicit choice.
// - "Forget on this device", the sign-out button, a 401 from the dashboard snapshot and a
//   sign-out in another tab (`SignOutChannel`, a BroadcastChannel in browsers) clear keys.

/** What is remembered: the non-extractable AES-GCM key, never the secret. */
export interface StoredKey {
  projectId: string;
  kid: string;
  l2Key: CryptoKey;
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
  /** Whether remembered keys can be stored on this device at all. */
  canRemember(): boolean;
  add(projectId: string, kid: string, l2Key: CryptoKey): void;
  /** Persists a loaded key (explicit consent). Resolves false when it could not be stored. */
  remember(projectId: string, kid: string): Promise<boolean>;
  /** "Forget on this device": memory and device storage, this project only. */
  forgetProject(projectId: string): Promise<void>;
  /** Every key of every project, memory and device storage. Broadcasts unless `other-tab`. */
  clearAll(reason: ClearReason): Promise<void>;
  /** Loads remembered keys once (called by the components on mount). */
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
}: {
  persistence: KeyPersistence | null;
  channel: SignOutChannel | null;
  deviceClearTimeoutMs?: number;
}): KeyStore => {
  const projects = new Map<string, Map<string, Entry>>();
  const listeners = new Set<() => void>();
  let version = 0;
  let hydration: Promise<void> | null = null;
  // Bumped by every clear: a hydration that started before it must not resurrect keys.
  let epoch = 0;

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
    canRemember: () => persistence !== null,
    add(projectId, kid, l2Key) {
      if (!VALID_KID.test(kid)) throw new TypeError('A kid is 8 Crockford base32 characters.');
      const existing = projects.get(projectId)?.get(kid);
      put(projectId, kid, { l2Key, remembered: existing?.remembered ?? false });
      emit();
    },
    async remember(projectId, kid) {
      const entry = projects.get(projectId)?.get(kid);
      if (!entry || !persistence) return false;
      try {
        await persistence.save({ projectId, kid, l2Key: entry.l2Key });
      } catch {
        return false;
      }
      // Cleared meanwhile: undo the write rather than keep a key the user just forgot.
      if (projects.get(projectId)?.get(kid) !== entry) {
        await quietly(() => persistence.remove(projectId, kid));
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
      if (reason !== 'other-tab') channel?.post();
      // The tab that signed out clears the shared device storage; another tab only its memory
      // (the storage is the same, so clearing it again is harmless but not needed).
      if (persistence && reason !== 'other-tab') {
        await quicklyAndQuietly(() => persistence.clear());
      }
    },
    hydrate() {
      if (!persistence) return Promise.resolve();
      hydration ??= (async () => {
        const started = epoch;
        let stored: StoredKey[] = [];
        try {
          stored = await persistence.load();
        } catch {
          return;
        }
        if (started !== epoch) return;
        let added = false;
        for (const k of stored) {
          if (!k || typeof k.projectId !== 'string' || !VALID_KID.test(k.kid)) continue;
          if (!isSecretKey(k.l2Key)) continue;
          if (projects.get(k.projectId)?.has(k.kid)) {
            projects.get(k.projectId)!.get(k.kid)!.remembered = true;
          } else put(k.projectId, k.kid, { l2Key: k.l2Key, remembered: true });
          added = true;
        }
        if (added) emit();
      })();
      return hydration;
    },
    dispose: () => unlisten(),
  };

  const unlisten = channel ? channel.listen(() => void store.clearAll('other-tab')) : () => {};
  return store;
};
