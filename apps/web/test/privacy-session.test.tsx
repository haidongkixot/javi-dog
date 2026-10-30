// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { deriveProjectKeys, generateProjectSecret } from '@javis-dog/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyPersistence, KeyStore, StoredKey } from '@/lib/privacy/key-store';

// Review M2 (ADR-0018 §8 "Clearing"): remembered keys follow the signed-in user, and every page
// that renders signed-out forgets every key in this browser (memory and device). The device
// store is an in-memory fake behind the `KeyPersistence` interface (jsdom has no IndexedDB).
// Screenshot budget 0.

const session = vi.hoisted(() => ({
  value: { data: null, isPending: false, error: null } as {
    data: { user: { id: string; name: string; email: string } } | null;
    isPending: boolean;
    error: unknown;
  },
}));
vi.mock('@/lib/auth-client', () => ({
  authClient: { useSession: () => session.value, signOut: vi.fn(async () => {}) },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/',
}));

const { KeyStoreProvider } = await import('@/components/privacy/key-context');
const { SignInPrompt } = await import('@/components/sign-in-prompt');
const { AccountMenu } = await import('@/components/account-menu');
const { createKeyStore } = await import('@/lib/privacy/key-store');
const { markChecked, newestChecked } = await import('@/lib/privacy/checked');
const { forgetKeysOnSignOut } = await import('@/lib/privacy/browser');
/** Review L1: remembering ships off; these tests force the gate on to test the logic. */
const REMEMBER_ON = { rememberEnabled: true } as const;

const P1 = '11111111-1111-4111-8111-111111111111';

const fakePersistence = () => {
  const rows = new Map<string, StoredKey>();
  const p: KeyPersistence & { rows: Map<string, StoredKey> } = {
    rows,
    load: vi.fn(async () => [...rows.values()]),
    save: vi.fn(async (k: StoredKey) => void rows.set(`${k.projectId}|${k.kid}`, k)),
    remove: vi.fn(async (projectId: string, kid?: string) => {
      for (const [key, k] of rows)
        if (k.projectId === projectId && (kid === undefined || k.kid === kid)) rows.delete(key);
    }),
    clear: vi.fn(async () => rows.clear()),
  };
  return p;
};

let stores: KeyStore[] = [];
/** A store holding one key in memory and the same key remembered for `user-a`. */
const storeWithKeys = async () => {
  const persistence = fakePersistence();
  const store = createKeyStore({ persistence, channel: null, ...REMEMBER_ON });
  stores.push(store);
  const k = await deriveProjectKeys(generateProjectSecret(), 'web-app');
  store.setUser('user-a');
  store.add(P1, k.kid, k.l2Key);
  expect(await store.remember(P1, k.kid)).toBe(true);
  expect(persistence.rows.size).toBe(1);
  return { store, persistence, kid: k.kid };
};

const signedIn = (id: string) => ({
  data: { user: { id, name: 'Hai', email: 'h@example.test' } },
  isPending: false,
  error: null,
});

beforeEach(() => {
  session.value = signedIn('user-a');
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  for (const s of stores) s.dispose();
  stores = [];
  vi.unstubAllEnvs();
});

describe('review L5 — the per-project "checked" flags are cleared with the keys', () => {
  const KID = '0Q12NAV3';
  const AT = '2026-10-30T12:00:00.000Z';

  it('a signed-out page clears every project’s flag', async () => {
    markChecked(P1, KID, AT);
    markChecked('another-project', KID, AT);
    const { store } = await storeWithKeys();
    render(
      <KeyStoreProvider store={store}>
        <SignInPrompt what="this project" />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(newestChecked(P1)).toBeNull());
    expect(newestChecked('another-project')).toBeNull();
  });

  it('the sign-out path clears every project’s flag and leaves other storage alone', async () => {
    markChecked(P1, KID, AT);
    localStorage.setItem('unrelated', 'kept');
    const { store } = await storeWithKeys();
    await forgetKeysOnSignOut('sign-out', store);
    expect(newestChecked(P1)).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('kept');
  });
});

describe('a page that renders signed-out forgets every key (memory and device)', () => {
  it('SignInPrompt', async () => {
    const { store, persistence } = await storeWithKeys();
    render(
      <KeyStoreProvider store={store}>
        <SignInPrompt what="this project" />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(store.list(P1)).toEqual([]));
    await waitFor(() => expect(persistence.rows.size).toBe(0));
    expect(persistence.clear).toHaveBeenCalled();
  });

  it('/sign-in', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { store, persistence } = await storeWithKeys();
    const { default: SignInPage } = await import('@/app/sign-in/page');
    render(
      <KeyStoreProvider store={store}>
        {await SignInPage({ searchParams: Promise.resolve({}) })}
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(store.list(P1)).toEqual([]));
    await waitFor(() => expect(persistence.rows.size).toBe(0));
  });
});

describe('the account menu binds keys to the session user', () => {
  it('signed in as the same user: remembered keys load', async () => {
    const { persistence, kid } = await storeWithKeys();
    const tab = createKeyStore({ persistence, channel: null, ...REMEMBER_ON });
    stores.push(tab);
    render(
      <KeyStoreProvider store={tab}>
        <AccountMenu />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(tab.list(P1)).toEqual([{ kid, remembered: true }]));
  });

  it('signed in as another user: nothing loads and the other user’s row is deleted', async () => {
    const { persistence } = await storeWithKeys();
    session.value = signedIn('user-b');
    const tab = createKeyStore({ persistence, channel: null, ...REMEMBER_ON });
    stores.push(tab);
    render(
      <KeyStoreProvider store={tab}>
        <AccountMenu />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(persistence.rows.size).toBe(0));
    expect(tab.list(P1)).toEqual([]);
  });

  it('no session (checked, no error): every key is forgotten', async () => {
    const { store, persistence } = await storeWithKeys();
    session.value = { data: null, isPending: false, error: null };
    render(
      <KeyStoreProvider store={store}>
        <AccountMenu />
      </KeyStoreProvider>,
    );
    await waitFor(() => expect(store.list(P1)).toEqual([]));
    await waitFor(() => expect(persistence.rows.size).toBe(0));
  });

  it('a session check that failed (network error) or is still pending forgets nothing', async () => {
    const { store, persistence, kid } = await storeWithKeys();
    session.value = { data: null, isPending: false, error: new Error('offline') };
    const { rerender } = render(
      <KeyStoreProvider store={store}>
        <AccountMenu />
      </KeyStoreProvider>,
    );
    session.value = { data: null, isPending: true, error: null };
    rerender(
      <KeyStoreProvider store={store}>
        <AccountMenu />
      </KeyStoreProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(store.list(P1)).toEqual([{ kid, remembered: true }]);
    expect(persistence.rows.size).toBe(1);
  });
});
