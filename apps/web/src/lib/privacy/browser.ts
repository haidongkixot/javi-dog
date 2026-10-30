// Browser wiring of the key store (ADR-0018 §8): IndexedDB for "Remember on this device" and a
// BroadcastChannel for sign-out in another tab. One store per tab, created on first use. jsdom
// has no IndexedDB, so the IndexedDB adapter is exercised only in a real browser (owner run,
// TEST_PLAN §S5f); the store logic is unit-tested with an in-memory fake.
import { clearChecked } from './checked';
import {
  createKeyStore,
  type KeyPersistence,
  type KeyStore,
  type SignOutChannel,
  type StoredKey,
} from './key-store';

const DB_NAME = 'javis-dog-privacy-keys';
const DB_VERSION = 1;
const STORE = 'keys';
const CHANNEL = 'javis-dog-privacy';
const SIGNED_OUT = 'signed-out';

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/**
 * IndexedDB holds the non-extractable `CryptoKey` objects (structured clone), never the secret.
 * Each row is a `StoredKey` and carries the signed-in user's id (review M2); the key store drops
 * and deletes rows of another user, or rows without one, when it loads them.
 */
export const createIdbPersistence = (idb: IDBFactory): KeyPersistence => {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) {
          r.result.createObjectStore(STORE, { keyPath: ['projectId', 'kid'] });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        opening = null;
        reject(r.error ?? new Error('IndexedDB open failed'));
      };
    });
    return opening;
  };
  const run = async (mode: IDBTransactionMode, work: (s: IDBObjectStore) => void) => {
    const tx = (await open()).transaction(STORE, mode);
    work(tx.objectStore(STORE));
    await done(tx);
  };
  return {
    async load() {
      const tx = (await open()).transaction(STORE, 'readonly');
      return (await request(tx.objectStore(STORE).getAll())) as StoredKey[];
    },
    save: (key) => run('readwrite', (s) => s.put(key)),
    remove: (projectId, kid) =>
      run('readwrite', (s) => {
        if (kid !== undefined) {
          s.delete([projectId, kid]);
          return;
        }
        s.delete(IDBKeyRange.bound([projectId, ''], [projectId, '\uffff']));
      }),
    clear: () => run('readwrite', (s) => s.clear()),
  };
};

export const createBroadcastSignOutChannel = (): SignOutChannel & { close(): void } => {
  const channel = new BroadcastChannel(CHANNEL);
  // Node (tests, never the server path) keeps a process alive for an open channel.
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  return {
    close: () => channel.close(),
    post: () => channel.postMessage(SIGNED_OUT),
    listen(onSignOut) {
      const handler = (e: MessageEvent) => {
        if (e.data === SIGNED_OUT) onSignOut();
      };
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
  };
};

let singleton: KeyStore | null = null;

/** This tab's key store. Throws on the server: keys exist only in the browser. */
export const browserKeyStore = (): KeyStore => {
  if (typeof window === 'undefined') throw new Error('The key store exists only in the browser.');
  singleton ??= createKeyStore({
    persistence:
      typeof indexedDB === 'undefined' || typeof IDBKeyRange === 'undefined'
        ? null
        : createIdbPersistence(indexedDB),
    channel: typeof BroadcastChannel === 'undefined' ? null : createBroadcastSignOutChannel(),
  });
  return singleton;
};

/**
 * Sign-out button, session end (401) and any page that renders signed-out: forget every key in
 * this tab and on this device, and tell other tabs. `store` is the tab's store (the browser
 * singleton unless a provider passes another). Never throws and never waits long (review L6).
 */
export const forgetKeysOnSignOut = async (
  reason: 'sign-out' | 'session-ended',
  store?: KeyStore | null,
) => {
  try {
    if (typeof window === 'undefined') return;
    // Review L5: the "checked" flags (localStorage, shared by every tab) go with the keys.
    clearChecked();
    await (store ?? browserKeyStore()).clearAll(reason);
  } catch {
    // Clearing must never block signing out.
  }
};
