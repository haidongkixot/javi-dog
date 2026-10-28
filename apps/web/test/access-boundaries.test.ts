import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createEventRepository, events, schema, type NewEvent } from '@javis-dog/event-store';
import { users, workspaceMembers } from '@javis-dog/identity';
import { createProjectRepository, INGEST_TOKEN_PREFIX } from '@javis-dog/projects';
import { createBudgetRepository } from '@javis-dog/resilience';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// apps/web has no PGlite/drizzle dependency of its own and this lane may not add one, so the
// in-process Postgres is taken from JD-M06's dev dependencies (same copies JD-M06 tests use).
import { PGlite } from '../../../packages/event-store/node_modules/@electric-sql/pglite/dist/index.js';
import { drizzle } from '../../../packages/event-store/node_modules/drizzle-orm/pglite/index.js';
import { migrate } from '../../../packages/event-store/node_modules/drizzle-orm/pglite/migrator.js';

// S5a R5 — independent access-boundary suite (TEST_PLAN §S5a). Expected behaviour comes from
// ADR-0005/0006/0008/0009/0012/0013/0014 text, not from the implementation. Real SQL on PGlite
// with the committed migrations; only the session (Better Auth cookie lookup), Next.js request
// APIs and the Neon client factory are replaced. Screenshot budget 0.

// ---------------------------------------------------------------------------------------------
// Harness: one PGlite database, a fake session, Next.js request APIs.
// ---------------------------------------------------------------------------------------------

type Session = { userId: string; activeWorkspaceId: string | null };
const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as Session | null,
  // What the browser sent; the session lookup ignores it, the app must ignore it too.
  requestHeaders: {} as Record<string, string>,
}));
const getSession = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
);

vi.mock('@/lib/auth', () => ({
  getDb: () => state.db,
  getAuth: () => (state.db ? { api: { getSession } } : null),
  signInProviders: () => [],
  resetAuthForTests: () => {},
}));
vi.mock('@javis-dog/event-store', async (orig) => ({
  ...(await orig<typeof import('@javis-dog/event-store')>()),
  // The Neon HTTP client factory → the test database (routes build their own handle from env).
  createDb: () => state.db,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(state.requestHeaders),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ notFound, redirect }));

const { getViewer } = await import('@/lib/viewer');
const actions = await import('@/app/projects/actions');
const { dashboardDeps, loadDashboard } = await import('@/lib/dashboard');
const { analyticsDeps, loadUsage } = await import('@/lib/analytics');
const { budgetDeps, loadBudget, loadBudgets } = await import('@/lib/budgets');
const { resetIngestForTests } = await import('@/lib/ingest');
const ingestRoute = await import('@/app/api/v1/events/route');
const snapshotRoute = await import('@/app/api/dashboard/snapshot/route');
const cronRoute = await import('@/app/api/cron/purge-events/route');
const healthRoute = await import('@/app/api/health/route');
const { HEALTH_ENV_NAMES } = await import('@/lib/health');

let client: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: resolve(process.cwd(), '../../packages/event-store/migrations'),
  });
  state.db = db;
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Two tenants. Everything of B carries a "Bravo"/"bravo" marker so any leak is detectable.
// ---------------------------------------------------------------------------------------------

interface World {
  A: string;
  B: string;
  PA: { id: string; slug: string };
  PB: { id: string; slug: string };
  ownerA: string;
  adminA: string;
  memberA: string;
  ownerB: string;
  tokenA: string;
  tokenAId: string;
  tokenB: string;
  tokenBId: string;
  tokenBPrefix: string;
  revokedA: string;
}
let w: World;

const DAY = 86_400_000;

const seedUser = async (name: string, email: string) => {
  const [u] = await db.insert(users).values({ name, email, emailVerified: true }).returning();
  return u!.id;
};
const member = (workspaceId: string, userId: string, role: 'owner' | 'admin' | 'member') =>
  db.insert(workspaceMembers).values({ organizationId: workspaceId, userId, role });

let seq = 0;
const row = (
  scope: { workspaceId: string; projectId: string },
  over: Partial<NewEvent> & { type: string },
): NewEvent => {
  seq += 1;
  return {
    ...scope,
    producerId: 'prod_test',
    eventId: randomUUID(),
    threadRef: 'alpha_thread',
    sequence: seq,
    status: null,
    privacyClass: 'L0',
    occurredAt: new Date(),
    receivedAt: new Date(),
    ...over,
  };
};

const seed = async (): Promise<World> => {
  const projects = createProjectRepository(db);
  const A = (await projects.createWorkspace({ name: 'Alpha workspace' })).id;
  const B = (await projects.createWorkspace({ name: 'Bravo Hidden Workspace' })).id;
  const ownerA = await seedUser('Ana Owner', 'ana@alpha.test');
  const adminA = await seedUser('Adi Admin', 'adi@alpha.test');
  const memberA = await seedUser('Max Member', 'max@alpha.test');
  const ownerB = await seedUser('Bravo Owner', 'owner@bravo-hidden.test');
  await member(A, ownerA, 'owner');
  await member(A, adminA, 'admin');
  await member(A, memberA, 'member');
  await member(B, ownerB, 'owner');

  const pa = await projects.createProject(A, { name: 'Alpha app', platforms: ['claude-code'] });
  const pb = await projects.createProject(B, {
    name: 'Bravo Hidden Project',
    description: 'Bravo confidential description',
    platforms: ['claude-code'],
  });
  const ta = await projects.issueToken(A, pa.id, 'alpha-laptop');
  const tb = await projects.issueToken(B, pb.id, 'bravo-laptop-token');
  const revoked = await projects.issueToken(A, pa.id, 'alpha-old');
  await projects.revokeToken(A, revoked.record.id);

  await createBudgetRepository(db).setBudget(B, pb.id, 50, ownerB);

  const sa = { workspaceId: A, projectId: pa.id };
  const sb = { workspaceId: B, projectId: pb.id };
  await createEventRepository(db).insertEvents([
    row(sa, { type: 'heartbeat', status: 'working' }),
    row(sa, { type: 'usage.reported', usageDelta: { input_tokens: 11, cost_usd: 0.01 } }),
    row(sb, {
      type: 'heartbeat',
      status: 'waiting',
      threadRef: 'bravo_thread_secret',
      agentRef: 'bravo_agent_secret',
      attributes: { tool_name: 'BravoSecretTool' },
    }),
    row(sb, {
      type: 'usage.reported',
      threadRef: 'bravo_thread_secret',
      usageDelta: { input_tokens: 777_777, output_tokens: 5, cost_usd: 12.34 },
    }),
    row(sb, { type: 'task.completed', threadRef: 'bravo_thread_secret' }),
  ]);

  return {
    A,
    B,
    PA: { id: pa.id, slug: pa.slug },
    PB: { id: pb.id, slug: pb.slug },
    ownerA,
    adminA,
    memberA,
    ownerB,
    tokenA: ta.token,
    tokenAId: ta.record.id,
    tokenB: tb.token,
    tokenBId: tb.record.id,
    tokenBPrefix: tb.record.displayPrefix,
    revokedA: revoked.token,
  };
};

/** Anything that identifies tenant B. */
const bMarkers = () => [
  w.B,
  w.PB.id,
  w.PB.slug,
  w.ownerB,
  w.tokenB,
  w.tokenBId,
  w.tokenBPrefix,
  'bravo',
  '777777',
  '777,777',
  '12.34',
];
const expectNothingOfB = (value: unknown) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value ?? null)).toLowerCase();
  for (const marker of bMarkers()) expect(text).not.toContain(marker.toLowerCase());
};

const signInAs = (userId: string | null, activeWorkspaceId: string | null = null) => {
  state.session = userId ? { userId, activeWorkspaceId } : null;
};

// Better Auth's `api.getSession` result shape: `{ session, user }` or null.
getSession.mockImplementation(async () => {
  if (!state.session) return null;
  const now = new Date();
  return {
    session: {
      id: randomUUID(),
      token: 'session-token',
      userId: state.session.userId,
      activeOrganizationId: state.session.activeWorkspaceId,
      expiresAt: new Date(now.getTime() + DAY),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    user: {
      id: state.session.userId,
      name: 'Signed-in user',
      email: 'signed-in@alpha.test',
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    },
  };
});

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

const tokensOf = (workspaceId: string, projectId: string) =>
  createProjectRepository(db).listTokens(workspaceId, projectId);
const budgetOf = async (workspaceId: string, projectId: string) =>
  (await createBudgetRepository(db).status(workspaceId, projectId))?.limitUsd ?? null;
const projectCount = async (workspaceId: string) =>
  (await createProjectRepository(db).listProjects(workspaceId)).length;
const eventCount = async (projectId: string) =>
  (await db.select({ projectId: events.projectId }).from(events)).filter(
    (e) => e.projectId === projectId,
  ).length;

beforeEach(async () => {
  await client.exec('truncate workspaces, users, ingest_rate_windows cascade');
  w = await seed();
  state.requestHeaders = {};
  signInAs(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetIngestForTests();
});

// ---------------------------------------------------------------------------------------------
// Workspace selection: session + membership only (ADR-0006, ADR-0012).
// ---------------------------------------------------------------------------------------------

describe('getViewer — workspace from session + membership (ADR-0006)', () => {
  it('is null when signed out', async () => {
    expect(await getViewer()).toBeNull();
  });

  it('resolves the active workspace the user belongs to, with the stored role', async () => {
    signInAs(w.memberA, w.A);
    const viewer = await getViewer();
    expect(viewer?.workspaceId).toBe(w.A);
    expect(viewer?.role).toBe('member');
  });

  it('never selects a workspace the user is not a member of, even when the session names it', async () => {
    // ADR-0006: "derive it from the session's active workspace and a membership check, never
    // from client input alone". An active workspace id without a membership must not stick.
    signInAs(w.ownerA, w.B);
    const viewer = await getViewer();
    expect(viewer?.workspaceId).not.toBe(w.B);
    // spec-silent: fall back to an own workspace or refuse; either way it is one of the user's.
    if (viewer) expect(viewer.workspaceId).toBe(w.A);
    expectNothingOfB({ workspaceId: viewer?.workspaceId, role: viewer?.role });
  });

  it('ignores workspace hints in request headers', async () => {
    signInAs(w.ownerA, w.A);
    state.requestHeaders = { 'x-workspace-id': w.B, cookie: `active_workspace=${w.B}` };
    expect((await getViewer())?.workspaceId).toBe(w.A);
  });
});

// ---------------------------------------------------------------------------------------------
// Server actions (app/projects/actions.ts).
// ---------------------------------------------------------------------------------------------

describe('server actions — signed out', () => {
  it('every action refuses and writes nothing', async () => {
    await createBudgetRepository(db).setBudget(w.A, w.PA.id, 20, w.ownerA);

    const created = await actions.createProjectAction(
      {},
      form({ name: 'Sneaky project', platforms: 'claude-code' }),
    );
    expect(created.createdId).toBeUndefined();
    expect(created.errors?.form).toBeTruthy();

    const issued = await actions.issueTokenAction(w.PA.id, {}, form({ name: 'x' }));
    expect(issued.token).toBeUndefined();
    expect(issued.error).toBeTruthy();

    await actions.revokeTokenAction(w.PA.id, form({ tokenId: w.tokenAId }));

    const set = await actions.setBudgetAction({}, form({ projectId: w.PA.id, limitUsd: '99' }));
    expect(set.saved).toBeUndefined();
    expect(set.errors?.form).toBeTruthy();
    const cleared = await actions.clearBudgetAction({}, form({ projectId: w.PA.id }));
    expect(cleared.saved).toBeUndefined();
    expect(cleared.errors?.form).toBeTruthy();

    expect(await projectCount(w.A)).toBe(1);
    expect(await projectCount(w.B)).toBe(1);
    const tokens = await tokensOf(w.A, w.PA.id);
    expect(tokens.filter((t) => t.revokedAt === null)).toHaveLength(1);
    expect(tokens.find((t) => t.id === w.tokenAId)?.revokedAt).toBeNull();
    expect(await budgetOf(w.A, w.PA.id)).toBe(20);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('server actions — workspace A user against workspace B ids', () => {
  const unknownId = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

  beforeEach(() => signInAs(w.ownerA, w.A));

  it('issueTokenAction on B’s project: refused like an unknown id, no token minted in B', async () => {
    const foreign = await actions.issueTokenAction(w.PB.id, {}, form({ name: 'steal' }));
    const unknown = await actions.issueTokenAction(unknownId, {}, form({ name: 'steal' }));
    expect(foreign.token).toBeUndefined();
    expect(foreign).toEqual(unknown);
    expectNothingOfB(foreign);
    expect(await tokensOf(w.B, w.PB.id)).toHaveLength(1);
  });

  it('revokeTokenAction with B’s token id (under A’s or B’s project id) leaves it active', async () => {
    await actions.revokeTokenAction(w.PA.id, form({ tokenId: w.tokenBId }));
    await actions.revokeTokenAction(w.PB.id, form({ tokenId: w.tokenBId }));
    const [tb] = await tokensOf(w.B, w.PB.id);
    expect(tb?.id).toBe(w.tokenBId);
    expect(tb?.revokedAt).toBeNull();
  });

  it('revokeTokenAction ignores a projectId of B in the form', async () => {
    await actions.revokeTokenAction(
      w.PA.id,
      form({ tokenId: w.tokenBId, projectId: w.PB.id, workspaceId: w.B }),
    );
    expect((await tokensOf(w.B, w.PB.id))[0]?.revokedAt).toBeNull();
  });

  it('setBudgetAction on B’s project: refused like an unknown id, B’s budget unchanged', async () => {
    const foreign = await actions.setBudgetAction(
      {},
      form({ projectId: w.PB.id, limitUsd: '1', workspaceId: w.B }),
    );
    const unknown = await actions.setBudgetAction(
      {},
      form({ projectId: unknownId, limitUsd: '1', workspaceId: w.B }),
    );
    expect(foreign.saved).toBeUndefined();
    expect(foreign).toEqual(unknown);
    expectNothingOfB(foreign);
    expect(await budgetOf(w.B, w.PB.id)).toBe(50);
  });

  it('clearBudgetAction on B’s project: B’s budget unchanged, no confirmation, like an unknown id', async () => {
    const foreign = await actions.clearBudgetAction({}, form({ projectId: w.PB.id }));
    const unknown = await actions.clearBudgetAction({}, form({ projectId: unknownId }));
    expect(await budgetOf(w.B, w.PB.id)).toBe(50);
    expect(foreign).toEqual(unknown);
    expectNothingOfB(foreign);
    // spec-silent: ADR-0014 lets owners/admins clear *their* projects' budgets; confirming
    // "cleared" for a project outside the workspace would be a false statement.
    expect(foreign.saved).not.toBe('cleared');
  });

  it('createProjectAction ignores a workspaceId in the form', async () => {
    const res = await actions.createProjectAction(
      {},
      form({ name: 'Smuggled project', platforms: 'claude-code', workspaceId: w.B }),
    );
    expect(res.createdId).toBeTruthy();
    expect(await projectCount(w.B)).toBe(1);
    const inA = await createProjectRepository(db).listProjects(w.A);
    expect(inA.map((p) => p.id)).toContain(res.createdId);
  });

  it('a session whose active workspace is B (no membership) cannot write into B', async () => {
    signInAs(w.ownerA, w.B);
    await actions.createProjectAction(
      {},
      form({ name: 'Via active workspace', platforms: 'claude-code' }),
    );
    const issued = await actions.issueTokenAction(w.PB.id, {}, form({ name: 'steal' }));
    await actions.revokeTokenAction(w.PB.id, form({ tokenId: w.tokenBId }));
    const set = await actions.setBudgetAction({}, form({ projectId: w.PB.id, limitUsd: '1' }));
    await actions.clearBudgetAction({}, form({ projectId: w.PB.id }));

    expect(issued.token).toBeUndefined();
    expect(set.saved).toBeUndefined();
    expect(await projectCount(w.B)).toBe(1);
    expect(await tokensOf(w.B, w.PB.id)).toHaveLength(1);
    expect((await tokensOf(w.B, w.PB.id))[0]?.revokedAt).toBeNull();
    expect(await budgetOf(w.B, w.PB.id)).toBe(50);
  });
});

describe('server actions — budget roles (ADR-0014: owners and admins only)', () => {
  it('a member can neither set nor clear a budget', async () => {
    await createBudgetRepository(db).setBudget(w.A, w.PA.id, 20, w.ownerA);
    signInAs(w.memberA, w.A);
    const set = await actions.setBudgetAction({}, form({ projectId: w.PA.id, limitUsd: '99' }));
    const cleared = await actions.clearBudgetAction({}, form({ projectId: w.PA.id }));
    expect(set.saved).toBeUndefined();
    expect(set.errors?.form).toBeTruthy();
    expect(cleared.saved).toBeUndefined();
    expect(cleared.errors?.form).toBeTruthy();
    expect(await budgetOf(w.A, w.PA.id)).toBe(20);
  });

  it('a member cannot elevate via a role field in the form', async () => {
    signInAs(w.memberA, w.A);
    const set = await actions.setBudgetAction(
      {},
      form({ projectId: w.PA.id, limitUsd: '99', role: 'owner' }),
    );
    expect(set.saved).toBeUndefined();
    expect(await budgetOf(w.A, w.PA.id)).toBeNull();
  });

  it.each(['ownerA', 'adminA'] as const)('%s can set and clear', async (who) => {
    signInAs(w[who], w.A);
    expect(
      await actions.setBudgetAction({}, form({ projectId: w.PA.id, limitUsd: '12.50' })),
    ).toEqual({ saved: 'set' });
    expect(await budgetOf(w.A, w.PA.id)).toBe(12.5);
    expect(await actions.clearBudgetAction({}, form({ projectId: w.PA.id }))).toEqual({
      saved: 'cleared',
    });
    expect(await budgetOf(w.A, w.PA.id)).toBeNull();
  });

  it('B’s owner has no role in A', async () => {
    signInAs(w.ownerB, w.A);
    const set = await actions.setBudgetAction({}, form({ projectId: w.PA.id, limitUsd: '5' }));
    expect(set.saved).toBeUndefined();
    expect(await budgetOf(w.A, w.PA.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Page data loaders with their production wiring (lib/dashboard, lib/analytics, lib/budgets).
// ---------------------------------------------------------------------------------------------

describe('data loaders — signed out', () => {
  it('every loader answers signed_out and returns no data', async () => {
    const loads = [
      await loadDashboard(dashboardDeps),
      await loadUsage(analyticsDeps),
      await loadUsage(analyticsDeps, { projectId: w.PA.id }),
      await loadBudget(budgetDeps, w.PA.id),
      await loadBudgets(budgetDeps),
    ];
    for (const load of loads) expect(load).toEqual({ kind: 'signed_out' });
  });
});

describe('data loaders — workspace A viewer', () => {
  const unknownId = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
  const strip = (v: unknown) =>
    JSON.parse(JSON.stringify(v).replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"-"'));

  beforeEach(() => signInAs(w.ownerA, w.A));

  it('positive control: B’s owner does see B’s markers (so the leak checks can fail)', async () => {
    signInAs(w.ownerB, w.B);
    const text = JSON.stringify([
      await loadDashboard(dashboardDeps),
      await loadUsage(analyticsDeps, { projectId: w.PB.id }),
      await loadBudget(budgetDeps, w.PB.id),
    ]);
    expect(text).toContain(w.PB.id);
    expect(text).toContain('bravo_thread_secret');
    expect(text).toContain('777777');
    expect(() => expectNothingOfB(text)).toThrow();
  });

  it('dashboard snapshot shows A and nothing of B', async () => {
    const load = await loadDashboard(dashboardDeps);
    expect(load.kind).toBe('ready');
    expect(JSON.stringify(load)).toContain(w.PA.id);
    expectNothingOfB(load);
  });

  it('usage with B’s project id yields nothing of B, same as an unknown id (ADR-0013)', async () => {
    const foreign = await loadUsage(analyticsDeps, { projectId: w.PB.id });
    const unknown = await loadUsage(analyticsDeps, { projectId: unknownId });
    expect(foreign.kind).toBe('ready');
    if (foreign.kind === 'ready') {
      expect(foreign.usage.totals.inputTokens).toBe(0);
      expect(foreign.usage.totals.reports).toBe(0);
    }
    expectNothingOfB(foreign);
    expect(strip(foreign)).toEqual(strip(unknown));
  });

  it('usage ignores a smuggled workspaceId', async () => {
    const load = await loadUsage(analyticsDeps, { workspaceId: w.B } as never);
    expect(load.kind).toBe('ready');
    if (load.kind === 'ready') expect(load.usage.totals.inputTokens).toBe(11);
    expectNothingOfB(load);
  });

  it('budget of B’s project is not readable, same as an unknown id', async () => {
    const foreign = await loadBudget(budgetDeps, w.PB.id);
    const unknown = await loadBudget(budgetDeps, unknownId);
    expect(foreign.kind).not.toBe('ready');
    expect(foreign).toEqual(unknown);
    expectNothingOfB(foreign);
  });

  it('budget list holds only A’s projects', async () => {
    await createBudgetRepository(db).setBudget(w.A, w.PA.id, 20, w.ownerA);
    const load = await loadBudgets(budgetDeps);
    expect(load.kind).toBe('ready');
    if (load.kind === 'ready') expect(load.statuses.map((s) => s.projectId)).toEqual([w.PA.id]);
    expectNothingOfB(load);
  });

  it('a session whose active workspace is B (no membership) reads nothing of B', async () => {
    signInAs(w.ownerA, w.B);
    expectNothingOfB(await loadDashboard(dashboardDeps));
    expectNothingOfB(await loadUsage(analyticsDeps));
    expectNothingOfB(await loadUsage(analyticsDeps, { projectId: w.PB.id }));
    expectNothingOfB(await loadBudget(budgetDeps, w.PB.id));
    expectNothingOfB(await loadBudgets(budgetDeps));
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/dashboard/snapshot (ADR-0012).
// ---------------------------------------------------------------------------------------------

describe('GET /api/dashboard/snapshot', () => {
  const GET = snapshotRoute.GET as unknown as (request: Request) => Promise<Response>;
  const url = (q = '') => new Request(`https://jd.test/api/dashboard/snapshot${q}`);

  it('answers 401 with no data and no-store when signed out', async () => {
    const res = await GET(url(`?workspaceId=${w.A}`));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('takes the workspace from the session, never from query or headers', async () => {
    signInAs(w.ownerA, w.A);
    state.requestHeaders = { 'x-workspace-id': w.B };
    const res = await GET(url(`?workspaceId=${w.B}&workspace=${w.B}&projectId=${w.PB.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).toContain(w.PA.id);
    expectNothingOfB(text);
  });

  it('a session whose active workspace is B (no membership) gets nothing of B', async () => {
    signInAs(w.ownerA, w.B);
    const res = await GET(url());
    expect([200, 401]).toContain(res.status);
    expectNothingOfB(await res.text());
  });
});

// ---------------------------------------------------------------------------------------------
// POST /api/v1/events (ADR-0005 tokens, ADR-0008 transport + tenant rules).
// ---------------------------------------------------------------------------------------------

describe('POST /api/v1/events', () => {
  let n = 0;
  const ulid = () => `01JBZ4XQ80${String(++n).padStart(16, '0')}`;
  const heartbeat = (projectRef: string, eventId = ulid()) => ({
    jgr: '0.1',
    event_id: eventId,
    producer_id: 'prod_claude-code_7f3a',
    project_ref: projectRef,
    thread_ref: 's_0123456789abcdef0123456789abcdef',
    sequence: n,
    type: 'heartbeat',
    status: 'working',
    occurred_at: new Date(Date.now() - 30_000).toISOString(),
  });
  const post = (authorization: string | null, body: unknown) =>
    ingestRoute.POST(
      new Request('https://jd.test/api/v1/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === null ? {} : { authorization }),
        },
        body: JSON.stringify(body),
      }),
    );
  const totalEvents = async () => (await db.select({ id: events.id }).from(events)).length;

  beforeEach(() => vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@test.invalid/db'));

  it('missing, malformed, unknown and revoked bearers all get the same 401 and store nothing', async () => {
    const before = await totalEvents();
    const unknown = `${INGEST_TOKEN_PREFIX}${'A'.repeat(43)}`;
    const cases: Array<[string, string | null]> = [
      ['missing', null],
      ['empty', ''],
      ['wrong scheme', `Basic ${w.tokenA}`],
      ['bare token', w.tokenA],
      ['malformed', 'Bearer not-a-token'],
      ['unknown', `Bearer ${unknown}`],
      ['revoked', `Bearer ${w.revokedA}`],
    ];
    const seen: string[] = [];
    for (const [label, header] of cases) {
      const res = await post(header, { events: [heartbeat(w.PA.slug)] });
      expect(res.status, label).toBe(401);
      expect(res.headers.get('www-authenticate'), label).toMatch(/^Bearer(\s.*)?$/);
      seen.push(await res.text());
    }
    // "no detail about which": every 401 body is byte-identical (conformance group events-401).
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).not.toMatch(/revoked|unknown|malformed|expired|missing/i);
    expect(await totalEvents()).toBe(before);
  });

  it('a token of project A cannot write into project B (project_mismatch), by slug or id', async () => {
    const bBefore = await eventCount(w.PB.id);
    for (const ref of [w.PB.slug, w.PB.id]) {
      const res = await post(`Bearer ${w.tokenA}`, { events: [heartbeat(ref)] });
      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        accepted: number;
        rejected: Array<{ issues: Array<{ code: string }> }>;
      };
      expect(body.accepted).toBe(0);
      expect(body.rejected[0]?.issues.map((i) => i.code)).toContain('project_mismatch');
    }
    expect(await eventCount(w.PB.id)).toBe(bBefore);
  });

  it('a mismatch on B’s project reads exactly like a mismatch on a project that does not exist', async () => {
    const id = ulid();
    const foreign = await (
      await post(`Bearer ${w.tokenA}`, { events: [heartbeat(w.PB.slug, id)] })
    ).text();
    await client.exec('truncate ingest_rate_windows');
    const unknown = await (
      await post(`Bearer ${w.tokenA}`, { events: [heartbeat('no-such-project', id)] })
    ).text();
    expect(foreign).toBe(unknown);
    expectNothingOfB(foreign);
  });

  it('the token fixes the project: a valid batch from A’s token lands in A only', async () => {
    const bBefore = await eventCount(w.PB.id);
    const res = await post(`Bearer ${w.tokenA}`, { events: [heartbeat(w.PA.slug)] });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
    expect(await eventCount(w.PB.id)).toBe(bBefore);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/cron/purge-events (ADR-0008, ADR-0009, S3d H3).
// ---------------------------------------------------------------------------------------------

describe('GET /api/cron/purge-events', () => {
  const SECRET = 'cron-secret-for-access-tests-0123456789abcdef';
  const call = (authorization: string | null, q = '') =>
    cronRoute.GET(
      new Request(`https://jd.test/api/cron/purge-events${q}`, {
        headers: authorization === null ? {} : { authorization },
      }),
    );
  const seedExpired = async () => {
    const old = new Date(Date.now() - 45 * DAY);
    await createEventRepository(db).insertEvents([
      row({ workspaceId: w.B, projectId: w.PB.id }, { type: 'heartbeat', receivedAt: old }),
    ]);
  };
  const totalEvents = async () => (await db.select({ id: events.id }).from(events)).length;
  const badHeaders: Array<string | null> = [
    null,
    '',
    'Bearer',
    'Bearer ',
    'Bearer wrong-secret',
    SECRET,
    `Basic ${SECRET}`,
    `Bearer ${SECRET}x`,
  ];

  it('with CRON_SECRET set and no database, a bad Authorization gets 401 before not_configured', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', '');
    for (const header of badHeaders) {
      const res = await call(header);
      expect(res.status, String(header)).toBe(401);
      expect(await res.text()).not.toMatch(/not_configured|database/i);
    }
    const ok = await call(`Bearer ${SECRET}`);
    expect(ok.status).toBe(503);
    expect(await ok.json()).toEqual({ error: 'not_configured' });
  });

  it('with a database, a bad Authorization gets 401 and deletes nothing', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@test.invalid/db');
    await seedExpired();
    const before = await totalEvents();
    for (const header of badHeaders) expect((await call(header)).status).toBe(401);
    // spec-silent: the secret is accepted only in the Authorization header.
    expect((await call(null, `?secret=${SECRET}&CRON_SECRET=${SECRET}`)).status).toBe(401);
    expect(await totalEvents()).toBe(before);
  });

  it('the right secret purges and answers counts only (no tenant data)', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@test.invalid/db');
    await seedExpired();
    const before = await totalEvents();
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['batches', 'complete', 'cutoff', 'deleted']);
    expect(body.deleted).toBe(1);
    expect(await totalEvents()).toBe(before - 1);
    expectNothingOfB(body);
  });

  it('without CRON_SECRET it answers 503 not_configured and deletes nothing (ADR-0009)', async () => {
    vi.stubEnv('CRON_SECRET', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pw@test.invalid/db');
    await seedExpired();
    const before = await totalEvents();
    for (const header of [null, 'Bearer ', 'Bearer undefined']) {
      const res = await call(header);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not_configured' });
    }
    expect(await totalEvents()).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/health — presence only (S2a Q2).
// ---------------------------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('reports env var presence as booleans and never a value or tenant data', async () => {
    for (const name of HEALTH_ENV_NAMES) vi.stubEnv(name, `VALUE_OF_${name}_s3cr3t`);
    vi.stubEnv('DATABASE_URL', 'postgresql://user:hunter2@ep-secret.test/db');
    const res = await healthRoute.GET();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain('s3cr3t');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ep-secret');
    const body = JSON.parse(text) as { env: Record<string, unknown> };
    expect(Object.keys(body.env).sort()).toEqual([...HEALTH_ENV_NAMES].sort());
    for (const v of Object.values(body.env)) expect(v).toBe(true);
    expectNothingOfB(text);
    expect(text).not.toContain(w.A);
    expect(text.toLowerCase()).not.toContain('alpha');
  });
});
