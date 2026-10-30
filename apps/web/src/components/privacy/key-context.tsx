'use client';

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { browserKeyStore } from '@/lib/privacy/browser';
import type { KeyStore } from '@/lib/privacy/key-store';

// The tab's key store (ADR-0018 §8). Components read it from context when a provider is present
// (tests pass an in-memory store) and otherwise use the browser singleton. On the server there is
// no store: keys never exist there.

const KeyStoreContext = createContext<KeyStore | null>(null);

export function KeyStoreProvider({ store, children }: { store: KeyStore; children: ReactNode }) {
  return <KeyStoreContext.Provider value={store}>{children}</KeyStoreContext.Provider>;
}

const noop = () => () => {};

/** The key store and a version that changes with its keys; `null` during server rendering. */
export function useKeyStore(): { store: KeyStore | null; version: number } {
  const provided = useContext(KeyStoreContext);
  const store = provided ?? (typeof window === 'undefined' ? null : browserKeyStore());
  const version = useSyncExternalStore(
    store ? store.subscribe : noop,
    () => store?.getVersion() ?? 0,
    () => 0,
  );
  useEffect(() => {
    // Remembered keys (IndexedDB) load once per tab, after the explicit "remember" choice.
    void store?.hydrate();
  }, [store]);
  return { store, version };
}
