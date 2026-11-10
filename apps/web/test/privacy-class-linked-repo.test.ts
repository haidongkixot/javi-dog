import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { schema } from '@javis-dog/event-store';
import { createGithubRepository } from '@javis-dog/github-bridge';
import { accounts, users, workspaceMembers } from '@javis-dog/identity';
import { createProjectRepository } from '@javis-dog/projects';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// apps/web takes PGlite and drizzle from its dev dependencies (same copies JD-M06 tests use).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// S5h H2 — raising the privacy class of a project with a linked GitHub repository (TEST_PLAN
// §S5h row 3; ADR-0019 Changes "S5h decisions", ADR-0018 §7). Raising L0 → L1/L2 or L1 → L2
// while a repository is linked needs an explicit confirmation checked on the server: without it
// the action answers `needsConfirm` with the repository name and changes nothing. Lowering never
// asks; a project without a linked repository behaves as before. Real SQL on PGlite with every
// committed migration; only the session lookup and Next.js request APIs are replaced. Repository
// links are written through JD-M10 (`applyInstallationChange`, `claimInstallation`,
// `linkRepository`), the path the GitHub actions take. Screenshot budget 0.

type Session = { userId: string; activeWorkspaceId: string | null };
const state = vi.hoisted(() => ({ db: null as unknown, session: null as Session | null }));
const getSession = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

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
vi.mock('next/cache', () => ({ revalidatePath }));

const { changePrivacyClassAction } = await import('@/app/projects/actions');

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

// GitHub numeric ids (obviously fake).
const GH = { ownerA: 1001, ownerB: 2002 };
const INST = { A: 601, B: 602 } as const;
const REPO = { ALPHA: 9101, SECOND: 9102, THIRD: 9103, FOURTH: 9104, SPARE: 9105, BRAVO: 9201 };

interface World {
  A: string;
  B: string;
  ownerA: string;
  adminA: string;
  memberA: string;
  ownerB: string;
  /** L0, linked to ana/alpha-repo. */
  linkedL0: string;
  /** L0, nothing linked. */
  plainL0: string;
  /** L1, linked to ana/second-repo. */
  linkedL1: string;
  /** L2, linked to ana/third-repo. */
  linkedL2: string;
  /** L0, linked to ana/fourth-repo and ana/spare-repo. */
  twoLinks: string;
  /** Workspace B, L0, linked to bea/bravo-repo. */
  foreign: string;
}
let w: World;

const seedUser = async (name: string, email: string, githubId?: number) => {
  const [u] = await db.insert(users).values({ name, email, emailVerified: true }).returning();
  if (githubId !== undefined) {
    await db
      .insert(accounts)
      .values({ userId: u!.id, accountId: String(githubId), providerId: 'github' });
  }
  return u!.id;
};

const installation = (installationId: number, accountId: number, repos: Array<[number, string]>) =>
  createGithubRepository(db).applyInstallationChange({
    op: 'upsert',
    installation: { installationId, accountId, accountType: 'User' },
    suspended: null,
    upsertRepositories: repos.map(([repoId, fullName]) => ({ repoId, fullName })),
    removeRepositoryIds: [],
  });

const linkDirect = async (workspaceId: string, repoId: number, projectId: string, by: string) =>
  expect(
    await createGithubRepository(db).linkRepository({ workspaceId, repoId, projectId, userId: by }),
  ).toBe('linked');

const seed = async (): Promise<World> => {
  const projects = createProjectRepository(db);
  const A = (await projects.createWorkspace({ name: 'Alpha workspace' })).id;
  const B = (await projects.createWorkspace({ name: 'Bravo workspace' })).id;
  const ownerA = await seedUser('Ana Owner', 'ana@alpha.test', GH.ownerA);
  const adminA = await seedUser('Adi Admin', 'adi@alpha.test');
  const memberA = await seedUser('Max Member', 'max@alpha.test');
  const ownerB = await seedUser('Bea Owner', 'bea@bravo.test', GH.ownerB);
  await db.insert(workspaceMembers).values([
    { organizationId: A, userId: ownerA, role: 'owner' },
    { organizationId: A, userId: adminA, role: 'admin' },
    { organizationId: A, userId: memberA, role: 'member' },
    { organizationId: B, userId: ownerB, role: 'owner' },
  ]);
  const make = async (ws: string, name: string, cls: 'L0' | 'L1' | 'L2') => {
    const p = await projects.createProject(ws, { name, platforms: ['claude-code'] });
    if (cls !== 'L0') await projects.setPrivacyClass(ws, p.id, cls);
    return p.id;
  };
  const linkedL0 = await make(A, 'Alpha linked', 'L0');
  const plainL0 = await make(A, 'Alpha plain', 'L0');
  const linkedL1 = await make(A, 'Alpha hashed', 'L1');
  const linkedL2 = await make(A, 'Alpha sealed', 'L2');
  const twoLinks = await make(A, 'Alpha two links', 'L0');
  const foreign = await make(B, 'Bravo linked', 'L0');

  await installation(INST.A, GH.ownerA, [
    [REPO.ALPHA, 'ana/alpha-repo'],
    [REPO.SECOND, 'ana/second-repo'],
    [REPO.THIRD, 'ana/third-repo'],
    [REPO.FOURTH, 'ana/fourth-repo'],
    [REPO.SPARE, 'ana/spare-repo'],
  ]);
  await installation(INST.B, GH.ownerB, [[REPO.BRAVO, 'bea/bravo-repo']]);
  const gh = createGithubRepository(db);
  expect(
    await gh.claimInstallation({
      workspaceId: A,
      installationId: INST.A,
      githubAccountId: GH.ownerA,
    }),
  ).toBe('claimed');
  expect(
    await gh.claimInstallation({
      workspaceId: B,
      installationId: INST.B,
      githubAccountId: GH.ownerB,
    }),
  ).toBe('claimed');
  // Links are made while the project is at its class; an L1/L2 link was confirmed in the UI.
  await linkDirect(A, REPO.ALPHA, linkedL0, ownerA);
  await linkDirect(A, REPO.SECOND, linkedL1, ownerA);
  await linkDirect(A, REPO.THIRD, linkedL2, ownerA);
  await linkDirect(A, REPO.FOURTH, twoLinks, ownerA);
  await linkDirect(A, REPO.SPARE, twoLinks, ownerA);
  await linkDirect(B, REPO.BRAVO, foreign, ownerB);
  return {
    A,
    B,
    ownerA,
    adminA,
    memberA,
    ownerB,
    linkedL0,
    plainL0,
    linkedL1,
    linkedL2,
    twoLinks,
    foreign,
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

const classOf = async (projectId: string) => {
  const { rows } = await client.query<{ privacy_class: string }>(
    'select privacy_class from projects where id = $1',
    [projectId],
  );
  return rows[0]?.privacy_class ?? null;
};

const CONFIRM = { confirmLinkedRepo: true } as const;
const NOT_FOUND = { error: 'Project not found.' };
const NOT_ALLOWED = {
  error: 'Only workspace owners and admins can change the privacy class.',
};
const SIGNED_OUT = { error: 'Your session ended. Sign in again to continue.' };

beforeEach(async () => {
  await client.exec(
    'truncate github_deliveries, github_installations, github_repositories, workspaces, users cascade',
  );
  w = await seed();
  signInAs(w.ownerA, w.A);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('raising with a linked repository needs a server-side confirmation', () => {
  it.each([
    ['L0 → L2', () => w.linkedL0, 'L2', 'L0', 'ana/alpha-repo'],
    ['L0 → L1', () => w.linkedL0, 'L1', 'L0', 'ana/alpha-repo'],
    ['L1 → L2', () => w.linkedL1, 'L2', 'L1', 'ana/second-repo'],
  ] as const)(
    '%s without the confirmation: needsConfirm with the name, class unchanged',
    async (_, project, to, from, name) => {
      expect(await changePrivacyClassAction(project(), to)).toEqual({
        needsConfirm: true,
        repository: name,
        repositories: [name],
        // A caller that ignores `needsConfirm` still shows why nothing changed.
        error: `This project is linked to GitHub repository ${name}, and Javi’s Dog keeps knowing that name under ${to}. Confirm to turn on ${to}.`,
      });
      expect(await classOf(project())).toBe(from);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['L0 → L2', () => w.linkedL0, 'L2'],
    ['L0 → L1', () => w.linkedL0, 'L1'],
    ['L1 → L2', () => w.linkedL1, 'L2'],
  ] as const)('%s with the confirmation: the class changes', async (_, project, to) => {
    expect(await changePrivacyClassAction(project(), to, CONFIRM)).toEqual({ privacyClass: to });
    expect(await classOf(project())).toBe(to);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${project()}`);
  });

  it('the admin is asked the same way', async () => {
    signInAs(w.adminA, w.A);
    expect(await changePrivacyClassAction(w.linkedL0, 'L2')).toMatchObject({
      needsConfirm: true,
      repository: 'ana/alpha-repo',
    });
    expect(await classOf(w.linkedL0)).toBe('L0');
    expect(await changePrivacyClassAction(w.linkedL0, 'L2', CONFIRM)).toEqual({
      privacyClass: 'L2',
    });
  });

  it('names every linked repository, in name order', async () => {
    expect(await changePrivacyClassAction(w.twoLinks, 'L1')).toEqual({
      needsConfirm: true,
      repository: 'ana/fourth-repo',
      repositories: ['ana/fourth-repo', 'ana/spare-repo'],
      error:
        'This project is linked to GitHub repositories ana/fourth-repo, ana/spare-repo, and Javi’s Dog keeps knowing those names under L1. Confirm to turn on L1.',
    });
    expect(await classOf(w.twoLinks)).toBe('L0');
  });

  it.each([
    ['a string', { confirmLinkedRepo: 'yes' }],
    ['a number', { confirmLinkedRepo: 1 }],
    ['false', { confirmLinkedRepo: false }],
    ['another key', { confirm: true }],
    ['a recovery-key-like string', 'JDK1-AAAA'],
    ['null', null],
  ])('only `confirmLinkedRepo: true` confirms (%s does not)', async (_, options) => {
    const call = changePrivacyClassAction as (...a: unknown[]) => Promise<unknown>;
    expect(await call(w.linkedL0, 'L2', options)).toMatchObject({ needsConfirm: true });
    expect(await classOf(w.linkedL0)).toBe('L0');
  });

  it('follows the current link: asks once a repository is linked, not after it is unlinked', async () => {
    expect(await changePrivacyClassAction(w.plainL0, 'L2')).toEqual({ privacyClass: 'L2' });
    expect(await changePrivacyClassAction(w.plainL0, 'L0')).toEqual({ privacyClass: 'L0' });
    await createGithubRepository(db).unlinkRepository(w.A, REPO.ALPHA);
    await linkDirect(w.A, REPO.ALPHA, w.plainL0, w.ownerA);
    expect(await changePrivacyClassAction(w.plainL0, 'L2')).toMatchObject({
      needsConfirm: true,
      repository: 'ana/alpha-repo',
    });
    // The old project lost its link: raising it asks nothing now.
    expect(await changePrivacyClassAction(w.linkedL0, 'L2')).toEqual({ privacyClass: 'L2' });
  });
});

describe('everything else behaves as before', () => {
  it('raising a project without a linked repository changes it without asking', async () => {
    expect(await changePrivacyClassAction(w.plainL0, 'L1')).toEqual({ privacyClass: 'L1' });
    expect(await classOf(w.plainL0)).toBe('L1');
    expect(await changePrivacyClassAction(w.plainL0, 'L2')).toEqual({ privacyClass: 'L2' });
    expect(await classOf(w.plainL0)).toBe('L2');
  });

  it.each([
    ['L2 → L1', () => w.linkedL2, 'L1'],
    ['L2 → L0', () => w.linkedL2, 'L0'],
    ['L1 → L0', () => w.linkedL1, 'L0'],
  ] as const)('lowering %s with a linked repository never asks', async (_, project, to) => {
    expect(await changePrivacyClassAction(project(), to)).toEqual({ privacyClass: to });
    expect(await classOf(project())).toBe(to);
  });

  it('setting the class it already has never asks', async () => {
    expect(await changePrivacyClassAction(w.linkedL1, 'L1')).toEqual({ privacyClass: 'L1' });
    expect(await changePrivacyClassAction(w.linkedL2, 'L2')).toEqual({ privacyClass: 'L2' });
  });

  it.each([
    ['member', (): string | null => w.memberA, NOT_ALLOWED],
    ['anonymous', (): string | null => null, SIGNED_OUT],
  ] as const)('%s is refused, with or without the confirmation', async (_, user, refusal) => {
    signInAs(user(), w.A);
    expect(await changePrivacyClassAction(w.linkedL0, 'L2')).toEqual(refusal);
    expect(await changePrivacyClassAction(w.linkedL0, 'L2', CONFIRM)).toEqual(refusal);
    expect(await changePrivacyClassAction(w.plainL0, 'L2')).toEqual(refusal);
    expect(await classOf(w.linkedL0)).toBe('L0');
    expect(await classOf(w.plainL0)).toBe('L0');
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('another workspace’s project reads as not found and never shows its repository', async () => {
    const answers = [
      await changePrivacyClassAction(w.foreign, 'L2'),
      await changePrivacyClassAction(w.foreign, 'L2', CONFIRM),
      await changePrivacyClassAction(w.foreign, 'L1'),
    ];
    expect(answers).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    expect(JSON.stringify(answers)).not.toContain('bravo');
    expect(await classOf(w.foreign)).toBe('L0');
    // Its own owner is asked, with its own repository name.
    signInAs(w.ownerB, w.B);
    expect(await changePrivacyClassAction(w.foreign, 'L2')).toMatchObject({
      needsConfirm: true,
      repository: 'bea/bravo-repo',
      repositories: ['bea/bravo-repo'],
    });
  });

  it('logs nothing on any of these paths', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((l) =>
      vi.spyOn(console, l).mockImplementation(() => {}),
    );
    await changePrivacyClassAction(w.linkedL0, 'L2');
    await changePrivacyClassAction(w.linkedL0, 'L2', CONFIRM);
    await changePrivacyClassAction(w.linkedL2, 'L0');
    await changePrivacyClassAction(w.foreign, 'L2');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    for (const s of spies) s.mockRestore();
  });
});
