import { deriveProjectKeys, generateProjectSecret } from '@javis-dog/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBroadcastSignOutChannel } from '@/lib/privacy/browser';
import {
  createKeyStore,
  type KeyPersistence,
  type SignOutChannel,
  type StoredKey,
} from '@/lib/privacy/key-store';

// ADR-0018 §8, TEST_PLAN §S5f browser row: memory by default, the device store only after an
// explicit "remember", and every clearing path (forget, sign-out, session end, another tab).
// jsdom and Node have no IndexedDB, so the device store is an in-memory fake behind the same
// interface; the real IndexedDB adapter (`createIdbPersistence`) is an owner browser run.
// WebCrypto here is Node's engine.

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

const fakePersistence = () => {
  const rows = new Map<string, StoredKey>();
  const id = (projectId: string, kid: string) => `${projectId}|${kid}`;
  const p: KeyPersistence & { rows: Map<string, StoredKey> } = {
    rows,
    load: vi.fn(async () => [...rows.values()]),
    save: vi.fn(async (k: StoredKey) => {
      rows.set(id(k.projectId, k.kid), k);
    }),
    remove: vi.fn(async (projectId: string, kid?: string) => {
      for (const [key, k] of rows)
        if (k.projectId === projectId && (kid === undefined || k.kid === kid)) rows.delete(key);
    }),
    clear: vi.fn(async () => rows.clear()),
  };
  return p;
};

const fakeChannel = () => {
  let listener: (() => void) | null = null;
  const c: SignOutChannel & { deliver(): void } = {
    post: vi.fn(),
    listen: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    deliver: () => listener?.(),
  };
  return c;
};

const keys = async (slug = 'web-app') => deriveProjectKeys(generateProjectSecret(), slug);

describe('key store — memory by default', () => {
  it('keeps keys per project in memory and never touches the device store unasked', async () => {
    const persistence = fakePersistence();
    const store = createKeyStore({ persistence, channel: null });
    const a = await keys();
    const b = await keys('other');
    const before = store.getVersion();
    store.add(P1, a.kid, a.l2Key);
    store.add(P2, b.kid, b.l2Key);
    expect(store.getVersion()).toBeGreaterThan(before);
    expect([...store.keysFor(P1).keys()]).toEqual([a.kid]);
    expect(store.keysFor(P1).get(a.kid)).toBe(a.l2Key);
    expect([...store.keysFor(P2).keys()]).toEqual([b.kid]);
    expect(store.list(P1)).toEqual([{ kid: a.kid, remembered: false }]);
    expect(persistence.save).not.toHaveBeenCalled();
    expect(persistence.rows.size).toBe(0);
  });

  it('holds several keys per project, matched by kid (rotation, ADR-0018 §10)', async () => {
    const store = createKeyStore({ persistence: null, channel: null });
    const [a, b] = [await keys(), await keys()];
    store.add(P1, a.kid, a.l2Key);
    store.add(P1, b.kid, b.l2Key);
    expect(store.keysFor(P1).size).toBe(2);
  });

  it('refuses a kid that is not 8 Crockford base32 characters', async () => {
    const store = createKeyStore({ persistence: null, channel: null });
    const a = await keys();
    expect(() => store.add(P1, 'abc', a.l2Key)).toThrow(TypeError);
  });

  it('cannot remember without a device store', async () => {
    const store = createKeyStore({ persistence: null, channel: null });
    const a = await keys();
    store.add(P1, a.kid, a.l2Key);
    expect(store.canRemember()).toBe(false);
    expect(await store.remember(P1, a.kid)).toBe(false);
  });
});

describe('key store — remember on this device (explicit)', () => {
  it('stores the non-extractable key (never a secret) only on remember()', async () => {
    const persistence = fakePersistence();
    const store = createKeyStore({ persistence, channel: null });
    store.setUser('user-1');
    const a = await keys();
    store.add(P1, a.kid, a.l2Key);
    expect(await store.remember(P1, a.kid)).toBe(true);
    expect(persistence.save).toHaveBeenCalledExactlyOnceWith({
      projectId: P1,
      kid: a.kid,
      l2Key: a.l2Key,
      userId: 'user-1',
    });
    expect(a.l2Key.extractable).toBe(false);
    expect(store.list(P1)).toEqual([{ kid: a.kid, remembered: true }]);
  });

  it('reports false when the browser refuses to store', async () => {
    const persistence = fakePersistence();
    vi.mocked(persistence.save).mockRejectedValueOnce(new Error('QuotaExceeded'));
    const store = createKeyStore({ persistence, channel: null });
    store.setUser('user-1');
    const a = await keys();
    store.add(P1, a.kid, a.l2Key);
    expect(await store.remember(P1, a.kid)).toBe(false);
    expect(store.list(P1)).toEqual([{ kid: a.kid, remembered: false }]);
  });

  it('a new tab loads remembered keys (hydrate) and marks them remembered', async () => {
    const persistence = fakePersistence();
    const first = createKeyStore({ persistence, channel: null });
    first.setUser('user-1');
    const a = await keys();
    first.add(P1, a.kid, a.l2Key);
    expect(await first.remember(P1, a.kid)).toBe(true);

    const second = createKeyStore({ persistence, channel: null });
    expect(second.keysFor(P1).size).toBe(0);
    second.setUser('user-1');
    await second.hydrate();
    expect(second.list(P1)).toEqual([{ kid: a.kid, remembered: true }]);
    expect(second.keysFor(P1).get(a.kid)).toBe(a.l2Key);
  });

  it('skips stored rows that are not non-extractable secret keys', async () => {
    const persistence = fakePersistence();
    persistence.rows.set('x', {
      projectId: P1,
      kid: 'ABCDEFGH',
      l2Key: {} as CryptoKey,
      userId: 'user-1',
    });
    persistence.rows.set('y', {
      projectId: P1,
      kid: 'bad',
      l2Key: (await keys()).l2Key,
      userId: 'user-1',
    });
    const store = createKeyStore({ persistence, channel: null });
    store.setUser('user-1');
    await store.hydrate();
    expect(persistence.load).toHaveBeenCalledOnce();
    expect(store.list(P1)).toEqual([]);
  });

  it('a hydration that started before a sign-out does not bring keys back', async () => {
    const persistence = fakePersistence();
    const a = await keys();
    const row = { projectId: P1, kid: a.kid, l2Key: a.l2Key, userId: 'user-1' };
    persistence.rows.set('a', row);
    let release!: (rows: StoredKey[]) => void;
    vi.mocked(persistence.load).mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = createKeyStore({ persistence, channel: null });
    store.setUser('user-1');
    const loading = store.hydrate();
    expect(persistence.load).toHaveBeenCalledOnce();
    await store.clearAll('sign-out');
    release([row]);
    await loading;
    expect(store.list(P1)).toEqual([]);
  });
});

describe('review M2 — remembered keys belong to the signed-in user', () => {
  it('user A remembers, user B hydrates: nothing is loaded and A’s row is deleted', async () => {
    const persistence = fakePersistence();
    const tabA = createKeyStore({ persistence, channel: null });
    tabA.setUser('user-a');
    const a = await keys();
    tabA.add(P1, a.kid, a.l2Key);
    expect(await tabA.remember(P1, a.kid)).toBe(true);
    expect([...persistence.rows.values()].map((r) => r.userId)).toEqual(['user-a']);

    const tabB = createKeyStore({ persistence, channel: null });
    tabB.setUser('user-b');
    await tabB.hydrate();
    expect(tabB.list(P1)).toEqual([]);
    expect(tabB.keysFor(P1).size).toBe(0);
    expect(persistence.rows.size).toBe(0);
  });

  it('the same user loads their remembered keys', async () => {
    const persistence = fakePersistence();
    const first = createKeyStore({ persistence, channel: null });
    first.setUser('user-a');
    const a = await keys();
    first.add(P1, a.kid, a.l2Key);
    await first.remember(P1, a.kid);
    const second = createKeyStore({ persistence, channel: null });
    second.setUser('user-a');
    await second.hydrate();
    expect(second.list(P1)).toEqual([{ kid: a.kid, remembered: true }]);
  });

  it('rows without a user id (stored before this rule) are never loaded and are deleted', async () => {
    const persistence = fakePersistence();
    const a = await keys();
    persistence.rows.set('legacy', { projectId: P1, kid: a.kid, l2Key: a.l2Key } as StoredKey);
    const store = createKeyStore({ persistence, channel: null });
    store.setUser('user-a');
    await store.hydrate();
    expect(store.list(P1)).toEqual([]);
    expect(persistence.rows.size).toBe(0);
  });

  it('nothing is loaded or remembered while the user is unknown', async () => {
    const persistence = fakePersistence();
    const a = await keys();
    persistence.rows.set('a', { projectId: P1, kid: a.kid, l2Key: a.l2Key, userId: 'user-a' });
    const store = createKeyStore({ persistence, channel: null });
    await store.hydrate();
    expect(persistence.load).not.toHaveBeenCalled();
    store.add(P2, a.kid, a.l2Key);
    expect(await store.remember(P2, a.kid)).toBe(false);
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it('another user signing in to this tab forgets the previous user’s keys in memory', async () => {
    const store = createKeyStore({ persistence: fakePersistence(), channel: null });
    store.setUser('user-a');
    const a = await keys();
    store.add(P1, a.kid, a.l2Key);
    store.setUser('user-b');
    expect(store.keysFor(P1).size).toBe(0);
  });
});

describe('key store — clearing paths', () => {
  it('"Forget on this device" removes the project’s keys from memory and the device only', async () => {
    const persistence = fakePersistence();
    const store = createKeyStore({ persistence, channel: null });
    store.setUser('user-1');
    const [a, b] = [await keys(), await keys('other')];
    store.add(P1, a.kid, a.l2Key);
    store.add(P2, b.kid, b.l2Key);
    expect(await store.remember(P1, a.kid)).toBe(true);
    expect(await store.remember(P2, b.kid)).toBe(true);
    await store.forgetProject(P1);
    expect(store.keysFor(P1).size).toBe(0);
    expect(store.keysFor(P2).size).toBe(1);
    expect(persistence.remove).toHaveBeenCalledWith(P1);
    expect([...persistence.rows.values()].map((r) => r.projectId)).toEqual([P2]);
  });

  it.each(['sign-out', 'session-ended'] as const)(
    '%s clears memory and the device store and tells other tabs',
    async (reason) => {
      const persistence = fakePersistence();
      const channel = fakeChannel();
      const store = createKeyStore({ persistence, channel });
      store.setUser('user-1');
      const a = await keys();
      store.add(P1, a.kid, a.l2Key);
      expect(await store.remember(P1, a.kid)).toBe(true);
      expect(persistence.rows.size).toBe(1);
      await store.clearAll(reason);
      expect(store.keysFor(P1).size).toBe(0);
      expect(persistence.clear).toHaveBeenCalledOnce();
      expect(persistence.rows.size).toBe(0);
      expect(channel.post).toHaveBeenCalledOnce();
    },
  );

  it('a sign-out in another tab clears this tab’s memory without echoing', async () => {
    const channel = fakeChannel();
    const store = createKeyStore({ persistence: fakePersistence(), channel });
    const a = await keys();
    store.add(P1, a.kid, a.l2Key);
    const seen = vi.fn();
    store.subscribe(seen);
    channel.deliver();
    await Promise.resolve();
    expect(store.keysFor(P1).size).toBe(0);
    expect(seen).toHaveBeenCalled();
    expect(channel.post).not.toHaveBeenCalled();
    store.dispose();
  });

  it('review L6: a device store that never settles cannot block signing out (1.5 s bound)', async () => {
    const a = await keys();
    vi.useFakeTimers();
    try {
      const persistence = fakePersistence();
      vi.mocked(persistence.clear).mockReturnValue(new Promise<void>(() => {}));
      const store = createKeyStore({ persistence, channel: null });
      store.add(P1, a.kid, a.l2Key);
      let settled = false;
      const clearing = store.clearAll('sign-out').then(() => {
        settled = true;
      });
      // Memory is cleared at once; only the wait for the device store is bounded.
      expect(store.keysFor(P1).size).toBe(0);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await clearing;
      expect(persistence.clear).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears memory even when the device store throws', async () => {
    const persistence = fakePersistence();
    vi.mocked(persistence.clear).mockRejectedValueOnce(new Error('blocked'));
    const store = createKeyStore({ persistence, channel: null });
    const a = await keys();
    store.add(P1, a.kid, a.l2Key);
    await expect(store.clearAll('sign-out')).resolves.toBeUndefined();
    expect(store.keysFor(P1).size).toBe(0);
  });
});

describe('BroadcastChannel sign-out notice (Node’s BroadcastChannel)', () => {
  const opened: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const c of opened.splice(0)) c.close();
  });

  it('delivers "signed out" to another channel of the same name and nothing else', async () => {
    const sender = createBroadcastSignOutChannel();
    const receiver = createBroadcastSignOutChannel();
    opened.push(sender, receiver);
    const heard = new Promise<void>((resolve) => receiver.listen(resolve));
    sender.post();
    await expect(heard).resolves.toBeUndefined();
  });

  it('a store in another tab clears its keys when the first tab signs out', async () => {
    const tabA = createBroadcastSignOutChannel();
    const tabB = createBroadcastSignOutChannel();
    opened.push(tabA, tabB);
    const storeA = createKeyStore({ persistence: null, channel: tabA });
    const storeB = createKeyStore({ persistence: null, channel: tabB });
    const a = await keys();
    storeB.add(P1, a.kid, a.l2Key);
    const cleared = new Promise<void>((resolve) => storeB.subscribe(resolve));
    await storeA.clearAll('sign-out');
    await cleared;
    expect(storeB.keysFor(P1).size).toBe(0);
    storeA.dispose();
    storeB.dispose();
  });
});
