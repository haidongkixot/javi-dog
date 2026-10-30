import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDashboardReader, THREAD_IDENTITY_TYPE, type ThreadState } from '../src/index.ts';
import { ago, freshDb, MIN, SEC, seeder, type Scope } from './helpers.ts';

// ADR-0018 §5 and §8, TEST_PLAN §S5f reader row: per thread, the newest `x.javi.thread.identity`
// event as opaque data (hashes, the `encrypted` object and its AAD parts). The identity event is
// a signal for freshness but never a status, a task, the last type or an activity item. Real
// migrations on PGlite; the clock is pinned. The browser-side round trip (reader → decryptL2)
// is in apps/web/test/privacy-reader-roundtrip.test.ts, which has the DOM types WebCrypto needs.
const NOW = new Date('2026-10-30T12:00:00.000Z');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const ENC = {
  alg: 'A256GCM',
  kid: 'ABCDEFGH',
  iv: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'Y2lwaGVydGV4dC1ieXRlcy1vcGFxdWU',
};

let ctx: Awaited<ReturnType<typeof freshDb>>;
let seed: ReturnType<typeof seeder>;
let reader: ReturnType<typeof createDashboardReader>;

beforeAll(async () => {
  ctx = await freshDb();
  seed = seeder(ctx.db);
  reader = createDashboardReader(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
});

const project = async (slug = 'web-app') => {
  const ws = await seed.workspace(`Team ${slug}`);
  return seed.project(ws, 'Web App', slug);
};
const snap = (s: Scope) => reader.snapshot(s.workspaceId, { now: NOW });
const threadOf = (threads: ThreadState[], ref: string) => {
  const t = threads.find((x) => x.threadRef === ref);
  if (!t) throw new Error(`thread ${ref} missing`);
  return t;
};

const identity = (
  p: Scope,
  over: { threadRef?: string; receivedAt: Date; eventId?: string } & Record<string, unknown>,
) =>
  seed.event(p, {
    type: THREAD_IDENTITY_TYPE,
    privacyClass: 'L2',
    attributes: { repo_hash: HASH_A, branch_hash: HASH_B, cwd_hash: HASH_C },
    encrypted: ENC,
    ...over,
  });

describe('thread identity — opaque fields', () => {
  it('returns the newest identity event with its AAD parts, hashes and ciphertext', async () => {
    const p = await project();
    const older = randomUUID();
    const newer = randomUUID();
    await seed.event(p, { type: 'session.started', receivedAt: ago(NOW, 5 * MIN) });
    await identity(p, {
      eventId: older,
      receivedAt: ago(NOW, 5 * MIN - SEC),
      attributes: { repo_hash: HASH_C, branch_hash: HASH_C },
      encrypted: { ...ENC, kid: 'OLDKID00' },
    });
    await seed.event(p, { type: 'heartbeat', status: 'working', receivedAt: ago(NOW, 2 * MIN) });
    // The newest one has no branch: the older branch_hash must not leak through.
    await identity(p, {
      eventId: newer,
      producerId: 'prod_laptop',
      receivedAt: ago(NOW, 2 * MIN - SEC),
      attributes: { repo_hash: HASH_A },
    });

    const t = threadOf((await snap(p)).threads, 'cc_thread_1');
    expect(t.identity).toEqual({
      eventId: newer,
      producerId: 'prod_laptop',
      threadRef: 'cc_thread_1',
      type: 'x.javi.thread.identity',
      projectSlug: 'web-app',
      privacyClass: 'L2',
      at: ago(NOW, 2 * MIN - SEC).toISOString(),
      repoHash: HASH_A,
      branchHash: null,
      cwdHash: null,
      encrypted: ENC,
    });
  });

  it('returns hashes without ciphertext for an L1 identity event', async () => {
    const p = await project();
    await identity(p, { receivedAt: ago(NOW, MIN), privacyClass: 'L1', encrypted: null });
    const t = threadOf((await snap(p)).threads, 'cc_thread_1');
    expect(t.identity).toMatchObject({
      privacyClass: 'L1',
      repoHash: HASH_A,
      branchHash: HASH_B,
      cwdHash: HASH_C,
      encrypted: null,
    });
  });

  it('is null for a thread without identity events', async () => {
    const p = await project();
    await seed.event(p, { type: 'heartbeat', status: 'working', receivedAt: ago(NOW, MIN) });
    expect(threadOf((await snap(p)).threads, 'cc_thread_1').identity).toBeNull();
  });

  it('drops hashes that are not sha256:<64 hex> and an encrypted value of another shape', async () => {
    const p = await project();
    await identity(p, {
      receivedAt: ago(NOW, MIN),
      attributes: { repo_hash: 'main', branch_hash: `sha256:${'A'.repeat(64)}`, cwd_hash: 7 },
      encrypted: { alg: 'A256GCM', kid: 'ABCDEFGH', iv: 1, ciphertext: 'x' },
    });
    expect(threadOf((await snap(p)).threads, 'cc_thread_1').identity).toMatchObject({
      repoHash: null,
      branchHash: null,
      cwdHash: null,
      encrypted: null,
    });
  });

  it('keeps identities per thread and per project', async () => {
    const a = await project('alpha');
    const b = await seed.project(a.workspaceId, 'Beta', 'beta');
    await identity(a, { threadRef: 'cc_x', receivedAt: ago(NOW, MIN) });
    await identity(a, {
      threadRef: 'cc_y',
      receivedAt: ago(NOW, MIN),
      attributes: { repo_hash: HASH_B },
    });
    await identity(b, {
      threadRef: 'cc_x',
      receivedAt: ago(NOW, MIN),
      attributes: { repo_hash: HASH_C },
    });
    const threads = (await snap(a)).threads;
    const pick = (slug: string, ref: string) =>
      threads.find((t) => t.projectSlug === slug && t.threadRef === ref)?.identity;
    expect(pick('alpha', 'cc_x')).toMatchObject({ projectSlug: 'alpha', repoHash: HASH_A });
    expect(pick('alpha', 'cc_y')).toMatchObject({ projectSlug: 'alpha', repoHash: HASH_B });
    expect(pick('beta', 'cc_x')).toMatchObject({ projectSlug: 'beta', repoHash: HASH_C });
  });

  it('never returns another workspace’s identity', async () => {
    const mine = await project('mine');
    const other = await project('other');
    await identity(other, { receivedAt: ago(NOW, MIN) });
    const s = await snap(mine);
    expect(s.threads).toEqual([]);
  });
});

describe('thread identity — never a status, task or activity item', () => {
  it('keeps the status and last type of the status event it follows, but counts as a signal', async () => {
    const p = await project();
    await seed.event(p, { type: 'session.started', receivedAt: ago(NOW, 10 * MIN) });
    await seed.event(p, { type: 'heartbeat', status: 'working', receivedAt: ago(NOW, 4 * MIN) });
    await identity(p, { receivedAt: ago(NOW, 2 * MIN) });

    const s = await snap(p);
    const t = threadOf(s.threads, 'cc_thread_1');
    expect(t.status).toBe('working');
    expect(t.lastType).toBe('heartbeat');
    // Freshness: the identity event is the newest signal (2 min ago, inside the 3 min window).
    expect(t.lastSignalAt).toBe(ago(NOW, 2 * MIN).toISOString());
    expect(t.freshness).toBe('fresh');
    expect(t.tasksCompleted).toBe(0);
    expect(s.activity.map((a) => a.type)).toEqual(['heartbeat', 'session.started']);
  });

  it('ignores a status on an identity event', async () => {
    const p = await project();
    await seed.event(p, { type: 'heartbeat', status: 'idle', receivedAt: ago(NOW, 3 * MIN) });
    await identity(p, { receivedAt: ago(NOW, MIN), status: 'failed' });
    const t = threadOf((await snap(p)).threads, 'cc_thread_1');
    expect(t.status).toBe('idle');
    expect(t.attention).toBe(false);
  });

  it('does not clear an agent’s self-report', async () => {
    const p = await project();
    await seed.event(p, {
      type: 'heartbeat',
      status: 'blocked',
      attributes: { tool_name: 'javi_report', error_code: 'blocked.ci_failing' },
      receivedAt: ago(NOW, 2 * MIN),
    });
    await identity(p, { receivedAt: ago(NOW, MIN) });
    const t = threadOf((await snap(p)).threads, 'cc_thread_1');
    expect(t).toMatchObject({
      status: 'blocked',
      statusSource: 'agent',
      statusReason: 'ci_failing',
      needsAttention: true,
    });
  });

  it('keeps an ended thread ended when an identity event arrives after session.ended', async () => {
    const p = await project();
    await seed.event(p, { type: 'session.ended', receivedAt: ago(NOW, 2 * MIN) });
    await identity(p, { receivedAt: ago(NOW, MIN) });
    const t = threadOf((await snap(p)).threads, 'cc_thread_1');
    expect(t.lastType).toBe('session.ended');
    expect(t.freshness).toBe('ended');
  });

  it('a thread with only an identity event has no status and the identity type as last type', async () => {
    const p = await project();
    await identity(p, { receivedAt: ago(NOW, MIN) });
    const s = await snap(p);
    const t = threadOf(s.threads, 'cc_thread_1');
    expect(t).toMatchObject({ status: null, lastType: THREAD_IDENTITY_TYPE, freshness: 'fresh' });
    expect(s.activity).toEqual([]);
    expect(s.overview.agentsWorking.value).toBe(0);
  });

  it('identity events do not push activity out of the feed limit', async () => {
    const p = await project();
    await seed.event(p, { type: 'heartbeat', status: 'working', receivedAt: ago(NOW, 30 * MIN) });
    for (let i = 0; i < 30; i += 1) await identity(p, { receivedAt: ago(NOW, (29 - i) * SEC) });
    const s = await snap(p);
    expect(s.activity.map((a) => a.type)).toEqual(['heartbeat']);
  });
});
