// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createEventRepository, schema, type NewEvent } from '@javis-dog/event-store';
import { users, workspaceMembers } from '@javis-dog/identity';
import { createProjectRepository } from '@javis-dog/projects';
import { createBudgetRepository } from '@javis-dog/resilience';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// apps/web has no PGlite/drizzle dependency of its own and this lane may not add one, so the
// in-process Postgres is taken from JD-M06's dev dependencies (same copies JD-M06 tests use).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// S5a R5 — access boundaries of the server pages (TEST_PLAN §S5a): /, /agents, /projects and
// /projects/[id] rendered from real SQL on PGlite with two workspaces. Only the session lookup
// and Next.js request APIs are replaced. DOM text assertions only; screenshot budget 0.

type Session = { userId: string; activeWorkspaceId: string | null };
const state = vi.hoisted(() => ({ db: null as unknown, session: null as Session | null }));
const getSession = vi.hoisted(() => vi.fn());
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
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound,
  redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const { default: OverviewPage } = await import('@/app/page');
const { default: AgentsPage } = await import('@/app/agents/page');
const { default: ProjectsPage } = await import('@/app/projects/page');
const { default: ProjectPage } = await import('@/app/projects/[id]/page');

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

interface World {
  A: string;
  B: string;
  PA: { id: string; slug: string };
  PB: { id: string; slug: string };
  ownerA: string;
  memberA: string;
  ownerB: string;
  tokenBPrefix: string;
}
let w: World;

const seedUser = async (name: string, email: string) => {
  const [u] = await db.insert(users).values({ name, email, emailVerified: true }).returning();
  return u!.id;
};

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
  const memberA = await seedUser('Max Member', 'max@alpha.test');
  const ownerB = await seedUser('Bravo Owner', 'owner@bravo-hidden.test');
  await db.insert(workspaceMembers).values([
    { organizationId: A, userId: ownerA, role: 'owner' },
    { organizationId: A, userId: memberA, role: 'member' },
    { organizationId: B, userId: ownerB, role: 'owner' },
  ]);
  const pa = await projects.createProject(A, { name: 'Alpha app', platforms: ['claude-code'] });
  const pb = await projects.createProject(B, {
    name: 'Bravo Hidden Project',
    description: 'Bravo confidential description',
    platforms: ['claude-code'],
  });
  await projects.issueToken(A, pa.id, 'alpha-laptop');
  const tb = await projects.issueToken(B, pb.id, 'bravo-laptop-token');
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
      attributes: { tool_name: 'BravoSecretTool' },
    }),
    row(sb, {
      type: 'usage.reported',
      threadRef: 'bravo_thread_secret',
      usageDelta: { input_tokens: 777_777, output_tokens: 5, cost_usd: 12.34 },
    }),
  ]);
  return {
    A,
    B,
    PA: { id: pa.id, slug: pa.slug },
    PB: { id: pb.id, slug: pb.slug },
    ownerA,
    memberA,
    ownerB,
    tokenBPrefix: tb.record.displayPrefix,
  };
};

const signInAs = (userId: string | null, activeWorkspaceId: string | null = null) => {
  state.session = userId ? { userId, activeWorkspaceId } : null;
};
getSession.mockImplementation(async () => {
  if (!state.session) return null;
  const now = new Date();
  return {
    session: {
      id: randomUUID(),
      token: 'session-token',
      userId: state.session.userId,
      activeOrganizationId: state.session.activeWorkspaceId,
      expiresAt: new Date(now.getTime() + 86_400_000),
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

/** Rendered HTML (text + attributes such as hrefs), or the navigation error a page threw. */
const renderPage = async (page: () => Promise<ReactElement>) => {
  try {
    const { container } = render(await page());
    return { html: container.innerHTML, thrown: null as string | null };
  } catch (error) {
    return { html: '', thrown: error instanceof Error ? error.message : String(error) };
  }
};
const expectNothingOfB = (html: string) => {
  const text = html.toLowerCase();
  for (const marker of [
    w.B,
    w.PB.id,
    w.PB.slug,
    w.tokenBPrefix,
    'bravo',
    '777777',
    '777,777',
    '12.34',
  ]) {
    expect(text).not.toContain(marker.toLowerCase());
  }
};
const projectPage = (id: string) => () => ProjectPage({ params: Promise.resolve({ id }) });
const UNKNOWN = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

beforeEach(async () => {
  await client.exec('truncate workspaces, users, ingest_rate_windows cascade');
  w = await seed();
  signInAs(null);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('pages — signed out', () => {
  it.each([
    ['/', () => OverviewPage()],
    ['/agents', () => AgentsPage()],
    ['/projects', () => ProjectsPage()],
  ])('%s renders no workspace data', async (_path, page) => {
    const { html } = await renderPage(page);
    expectNothingOfB(html);
    expect(html).not.toContain(w.PA.id);
    expect(html.toLowerCase()).not.toContain('alpha app');
  });

  it('/projects/[id] answers the same for an existing and an unknown id (no existence oracle)', async () => {
    // spec-silent: a signed-out visitor must not learn whether a project id exists.
    expect(await renderPage(projectPage(w.PB.id))).toEqual(await renderPage(projectPage(UNKNOWN)));
  });

  it('/projects/[id] of an existing project renders none of it', async () => {
    const { html } = await renderPage(projectPage(w.PA.id));
    expect(html).not.toContain(w.PA.id);
    expect(html.toLowerCase()).not.toContain('alpha app');
    expect(html.toLowerCase()).not.toContain('alpha-laptop');
  });
});

describe('pages — workspace A viewer', () => {
  beforeEach(() => signInAs(w.ownerA, w.A));

  it('positive control: B’s owner sees B’s project page (so the leak checks can fail)', async () => {
    signInAs(w.ownerB, w.B);
    const { html, thrown } = await renderPage(projectPage(w.PB.id));
    expect(thrown).toBeNull();
    expect(html.toLowerCase()).toContain('bravo hidden project');
  });

  it('/projects/[id] with B’s project id is not found, exactly like an unknown id', async () => {
    const foreign = await renderPage(projectPage(w.PB.id));
    const unknown = await renderPage(projectPage(UNKNOWN));
    expect(foreign.thrown).toBe('NEXT_NOT_FOUND');
    expect(foreign).toEqual(unknown);
  });

  it('/projects/[id] of A’s own project shows A and nothing of B', async () => {
    const { html, thrown } = await renderPage(projectPage(w.PA.id));
    expect(thrown).toBeNull();
    expect(html.toLowerCase()).toContain('alpha app');
    expectNothingOfB(html);
  });

  it.each([
    ['/', () => OverviewPage()],
    ['/agents', () => AgentsPage()],
    ['/projects', () => ProjectsPage()],
  ])('%s shows nothing of B', async (_path, page) => {
    const { html, thrown } = await renderPage(page);
    expect(thrown).toBeNull();
    expectNothingOfB(html);
  });

  it('/projects lists A’s project', async () => {
    const { html } = await renderPage(() => ProjectsPage());
    expect(html.toLowerCase()).toContain('alpha app');
  });

  it('a session whose active workspace is B (no membership) renders nothing of B', async () => {
    signInAs(w.ownerA, w.B);
    for (const page of [
      () => OverviewPage(),
      () => AgentsPage(),
      () => ProjectsPage(),
      projectPage(w.PB.id),
    ]) {
      expectNothingOfB((await renderPage(page)).html);
    }
    expect((await renderPage(projectPage(w.PB.id))).thrown).toBe('NEXT_NOT_FOUND');
  });
});

describe('/projects/[id] budget card by role (ADR-0014: members see it read-only)', () => {
  const budgetRegion = () => screen.getByRole('region', { name: 'Monthly budget' });

  it('an owner gets the budget form', async () => {
    signInAs(w.ownerA, w.A);
    const { thrown } = await renderPage(projectPage(w.PA.id));
    expect(thrown).toBeNull();
    expect(budgetRegion().querySelectorAll('form, input').length).toBeGreaterThan(0);
  });

  it('a member gets no form, input or submit control', async () => {
    signInAs(w.memberA, w.A);
    const { thrown } = await renderPage(projectPage(w.PA.id));
    expect(thrown).toBeNull();
    expect(budgetRegion().querySelectorAll('form, input, button[type="submit"]')).toHaveLength(0);
  });
});
