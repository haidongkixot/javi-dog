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

// S5g — GitHub claim and link actions (TEST_PLAN §S5g rows "Claim" and "Link"; ADR-0019 §4,
// design review D0 H3, M5). Expected behaviour comes from the ADR text. Real SQL on PGlite with
// every committed migration; only the session lookup and Next.js request APIs are replaced.
// Installations are written through JD-M10's `applyInstallationChange`, the same path a signed
// `installation` delivery takes. Screenshot budget 0.

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

const actions = await import('@/app/integrations/github/actions');
const { CLAIM_MESSAGES, LINK_CONFIRM_REQUIRED } =
  await import('@/app/integrations/github/messages');
const { canManageProject } = await import('@/lib/permissions');

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
const GH = { ownerA: 1001, adminA: 1003, memberA: 1005, viewerA: 1006, ownerB: 2002, org: 7007 };
const INST = { A: 501, B: 502, ADMIN: 503, ORG: 504, MEMBER: 505, VIEWER: 506 } as const;
const REPO = { A1: 9001, A2: 9002, ADMIN: 9003, B: 9004, ORG: 9005, MEMBER: 9006 } as const;

interface World {
  A: string;
  B: string;
  C: string;
  NOGH: string;
  PA: string;
  PA2: string;
  PL1: string;
  PL2: string;
  PB: string;
  ownerA: string;
  adminA: string;
  memberA: string;
  viewerA: string;
  ownerB: string;
  noGithub: string;
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

const installation = (
  installationId: number,
  accountId: number,
  repos: Array<[number, string]>,
  accountType: 'User' | 'Organization' = 'User',
) =>
  createGithubRepository(db).applyInstallationChange({
    op: 'upsert',
    installation: { installationId, accountId, accountType },
    suspended: null,
    upsertRepositories: repos.map(([repoId, fullName]) => ({ repoId, fullName })),
    removeRepositoryIds: [],
  });

const seed = async (): Promise<World> => {
  const projects = createProjectRepository(db);
  const A = (await projects.createWorkspace({ name: 'Alpha workspace' })).id;
  const B = (await projects.createWorkspace({ name: 'Bravo workspace' })).id;
  const C = (await projects.createWorkspace({ name: 'Alpha second workspace' })).id;
  const NOGH = (await projects.createWorkspace({ name: 'No GitHub workspace' })).id;
  const ownerA = await seedUser('Ana Owner', 'ana@alpha.test', GH.ownerA);
  const adminA = await seedUser('Adi Admin', 'adi@alpha.test', GH.adminA);
  const memberA = await seedUser('Max Member', 'max@alpha.test', GH.memberA);
  const viewerA = await seedUser('Vic Viewer', 'vic@alpha.test', GH.viewerA);
  const ownerB = await seedUser('Bea Owner', 'bea@bravo.test', GH.ownerB);
  const noGithub = await seedUser('Nia Google', 'nia@nogh.test');
  // membershipLimit is 1 today: the admin, member and "viewer" rows exist at the logic level only.
  await db.insert(workspaceMembers).values([
    { organizationId: A, userId: ownerA, role: 'owner' },
    { organizationId: A, userId: adminA, role: 'admin' },
    { organizationId: A, userId: memberA, role: 'member' },
    { organizationId: A, userId: viewerA, role: 'viewer' },
    { organizationId: B, userId: ownerB, role: 'owner' },
    { organizationId: C, userId: ownerA, role: 'owner' },
    { organizationId: NOGH, userId: noGithub, role: 'owner' },
  ]);
  const pa = await projects.createProject(A, { name: 'Alpha app', platforms: ['claude-code'] });
  const pa2 = await projects.createProject(A, { name: 'Alpha docs', platforms: ['claude-code'] });
  const pl1 = await projects.createProject(A, { name: 'Alpha hashed', platforms: ['claude-code'] });
  const pl2 = await projects.createProject(A, { name: 'Alpha sealed', platforms: ['claude-code'] });
  await projects.setPrivacyClass(A, pl1.id, 'L1');
  await projects.setPrivacyClass(A, pl2.id, 'L2');
  const pb = await projects.createProject(B, { name: 'Bravo app', platforms: ['claude-code'] });

  await installation(INST.A, GH.ownerA, [
    [REPO.A1, 'ana/alpha-repo'],
    [REPO.A2, 'ana/second-repo'],
  ]);
  await installation(INST.B, GH.ownerB, [[REPO.B, 'bea/bravo-repo']]);
  await installation(INST.ADMIN, GH.adminA, [[REPO.ADMIN, 'adi/admin-repo']]);
  await installation(INST.ORG, GH.org, [[REPO.ORG, 'some-org/org-repo']], 'Organization');
  await installation(INST.MEMBER, GH.memberA, [[REPO.MEMBER, 'max/member-repo']]);
  await installation(INST.VIEWER, GH.viewerA, []);
  return {
    A,
    B,
    C,
    NOGH,
    PA: pa.id,
    PA2: pa2.id,
    PL1: pl1.id,
    PL2: pl2.id,
    PB: pb.id,
    ownerA,
    adminA,
    memberA,
    viewerA,
    ownerB,
    noGithub,
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

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

const claim = (installationId: number | string) =>
  actions.claimInstallationAction({}, form({ installationId: String(installationId) }));
const release = (installationId: number | string) =>
  actions.releaseInstallationAction({}, form({ installationId: String(installationId) }));
const link = (repoId: number | string, projectId: string, extra: Record<string, string> = {}) =>
  actions.linkRepositoryAction({}, form({ repoId: String(repoId), projectId, ...extra }));
const unlink = (repoId: number | string, projectId: string) =>
  actions.unlinkRepositoryAction({}, form({ repoId: String(repoId), projectId }));

const claimedBy = async (installationId: number) => {
  const { rows } = await client.query<{ claimed_workspace_id: string | null }>(
    'select claimed_workspace_id from github_installations where installation_id = $1',
    [installationId],
  );
  return rows[0]?.claimed_workspace_id ?? null;
};
const linkOf = async (repoId: number) => {
  const { rows } = await client.query<{
    project_id: string | null;
    workspace_id: string | null;
    linked_by: string | null;
  }>('select project_id, workspace_id, linked_by from github_repositories where repo_id = $1', [
    repoId,
  ]);
  return rows[0] ?? null;
};
/** Claims as the given owner directly through JD-M10 (test setup, not under test). */
const claimDirect = (workspaceId: string, installationId: number, githubAccountId: number) =>
  createGithubRepository(db).claimInstallation({ workspaceId, installationId, githubAccountId });

const NOT_ALLOWED = 'Only workspace owners and admins can change GitHub connections.';
const SIGNED_OUT = 'Your session ended. Sign in again to continue.';

beforeEach(async () => {
  await client.exec(
    'truncate github_deliveries, github_installations, github_repositories, workspaces, users cascade',
  );
  w = await seed();
  signInAs(null);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('role matrix (ADR-0019 §4: owners and admins only)', () => {
  it('canManageProject allows owner and admin only', () => {
    expect(
      ['owner', 'admin', 'member', 'viewer', '', null, undefined].map(canManageProject),
    ).toEqual([true, true, false, false, false, false, false]);
  });

  it('anonymous: claim, release, link and unlink are refused and nothing changes', async () => {
    expect(await claim(INST.A)).toEqual({ error: SIGNED_OUT });
    expect(await release(INST.A)).toEqual({ error: SIGNED_OUT });
    expect(await link(REPO.A1, w.PA)).toEqual({ error: SIGNED_OUT });
    expect(await unlink(REPO.A1, w.PA)).toEqual({ error: SIGNED_OUT });
    expect(await claimedBy(INST.A)).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['member', () => w.memberA, INST.MEMBER],
    ['viewer', () => w.viewerA, INST.VIEWER],
  ])(
    'a %s whose GitHub id matches is refused at every action',
    async (_role, user, installationId) => {
      signInAs(user(), w.A);
      expect(await claim(installationId)).toEqual({ error: NOT_ALLOWED });
      expect(await claimedBy(installationId)).toBeNull();
      // Set a claim and link up directly, then try to change them.
      await claimDirect(w.A, INST.A, GH.ownerA);
      await createGithubRepository(db).linkRepository({
        workspaceId: w.A,
        repoId: REPO.A1,
        projectId: w.PA,
        userId: w.ownerA,
      });
      expect(await release(INST.A)).toEqual({ error: NOT_ALLOWED });
      expect(await link(REPO.A2, w.PA)).toEqual({ error: NOT_ALLOWED });
      expect(await unlink(REPO.A1, w.PA)).toEqual({ error: NOT_ALLOWED });
      expect(await claimedBy(INST.A)).toBe(w.A);
      expect((await linkOf(REPO.A1))?.project_id).toBe(w.PA);
      expect((await linkOf(REPO.A2))?.project_id).toBeNull();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('an owner whose GitHub id matches claims (claimed_workspace_id = the viewer’s workspace)', async () => {
    signInAs(w.ownerA, w.A);
    expect(await claim(INST.A)).toEqual({ done: CLAIM_MESSAGES.claimed });
    expect(await claimedBy(INST.A)).toBe(w.A);
    expect(revalidatePath).toHaveBeenCalledWith('/integrations/github');
  });

  it('an admin whose GitHub id matches claims (logic level: membershipLimit 1)', async () => {
    signInAs(w.adminA, w.A);
    expect(await claim(INST.ADMIN)).toEqual({ done: CLAIM_MESSAGES.claimed });
    expect(await claimedBy(INST.ADMIN)).toBe(w.A);
  });

  it('an admin links and unlinks (logic level)', async () => {
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.adminA, w.A);
    expect(await link(REPO.A1, w.PA)).toEqual({ done: 'Repository linked.' });
    expect(await linkOf(REPO.A1)).toEqual({
      project_id: w.PA,
      workspace_id: w.A,
      linked_by: w.adminA,
    });
    expect(await unlink(REPO.A1, w.PA)).toEqual({ done: 'Repository unlinked.' });
    expect((await linkOf(REPO.A1))?.project_id).toBeNull();
  });
});

describe('claim: the GitHub-id rule (account_id from the signed webhook row)', () => {
  it('mismatch: an owner cannot claim another account’s installation', async () => {
    signInAs(w.ownerA, w.A);
    expect(await claim(INST.B)).toEqual({ error: CLAIM_MESSAGES.account_mismatch });
    expect(await claimedBy(INST.B)).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('no GitHub account linked: refused before any claim is attempted', async () => {
    signInAs(w.noGithub, w.NOGH);
    expect(await claim(INST.A)).toEqual({ error: CLAIM_MESSAGES.no_github_account });
    expect(await claimedBy(INST.A)).toBeNull();
  });

  it('another provider’s account with the same numeric id does not count', async () => {
    await db
      .insert(accounts)
      .values({ userId: w.noGithub, accountId: String(GH.ownerA), providerId: 'google' });
    signInAs(w.noGithub, w.NOGH);
    expect(await claim(INST.A)).toEqual({ error: CLAIM_MESSAGES.no_github_account });
    expect(await claimedBy(INST.A)).toBeNull();
  });

  it('Organization installations are refused: a foreign one gets the generic answer, one of the viewer’s own account the plain message', async () => {
    signInAs(w.ownerA, w.A);
    // An organization's account id is the organization's, never the viewer's (L-2).
    expect(await claim(INST.ORG)).toEqual({ error: CLAIM_MESSAGES.account_mismatch });
    expect(await claimedBy(INST.ORG)).toBeNull();
    await installation(777, GH.ownerA, [], 'Organization');
    const result = await claim(777);
    expect(result).toEqual({ error: CLAIM_MESSAGES.organization });
    expect(result.error).toMatch(/Organization installations aren’t supported yet/);
    expect(await claimedBy(777)).toBeNull();
  });

  it('a spoofed installation id (another account’s, as in a forged setup_url) claims nothing', async () => {
    // The setup_url `installation_id` is only a hint; posting it to the action is the strongest
    // form of trusting it, and the account check still refuses.
    signInAs(w.ownerA, w.A);
    expect(await claim(INST.B)).toEqual({ error: CLAIM_MESSAGES.account_mismatch });
    signInAs(w.ownerB, w.B);
    expect(await claim(INST.A)).toEqual({ error: CLAIM_MESSAGES.account_mismatch });
    expect(await claimedBy(INST.A)).toBeNull();
    expect(await claimedBy(INST.B)).toBeNull();
  });

  it.each(['', 'abc', '-501', '0', '1e3', '501.5', '501 OR 1=1', '99999999999999999999'])(
    'a malformed installation id %j gets the generic answer and nothing is claimed',
    async (bad) => {
      signInAs(w.ownerA, w.A);
      expect(await claim(bad)).toEqual({ error: CLAIM_MESSAGES.account_mismatch });
      expect(await claimedBy(INST.A)).toBeNull();
    },
  );

  it('unknown and foreign installation ids get the same answer, so ids cannot be enumerated (L-2)', async () => {
    await claimDirect(w.B, INST.B, GH.ownerB);
    signInAs(w.ownerA, w.A);
    const unknown = await claim(424242);
    const foreignUnclaimed = await claim(INST.MEMBER);
    const foreignClaimedElsewhere = await claim(INST.B);
    expect(unknown).toEqual({ error: CLAIM_MESSAGES.account_mismatch });
    expect(foreignUnclaimed).toEqual(unknown);
    expect(foreignClaimedElsewhere).toEqual(unknown);
    expect(await claimedBy(INST.B)).toBe(w.B);
    expect(await claimedBy(INST.MEMBER)).toBeNull();
  });

  it('first claim wins; the same workspace again is idempotent', async () => {
    signInAs(w.ownerA, w.A);
    expect(await claim(INST.A)).toEqual({ done: CLAIM_MESSAGES.claimed });
    expect(await claim(INST.A)).toEqual({ done: CLAIM_MESSAGES.already_yours });
    // Same GitHub user, other workspace (C): the first claim stands.
    signInAs(w.ownerA, w.C);
    expect(await claim(INST.A)).toEqual({ error: CLAIM_MESSAGES.claimed_elsewhere });
    expect(await claimedBy(INST.A)).toBe(w.A);
  });
});

describe('release (D0 M5)', () => {
  beforeEach(async () => {
    await claimDirect(w.A, INST.A, GH.ownerA);
    const repo = createGithubRepository(db);
    await repo.linkRepository({
      workspaceId: w.A,
      repoId: REPO.A1,
      projectId: w.PA,
      userId: w.ownerA,
    });
    await repo.linkRepository({
      workspaceId: w.A,
      repoId: REPO.A2,
      projectId: w.PA2,
      userId: w.ownerA,
    });
  });

  it('an owner releases the claim and every link of it is cleared', async () => {
    signInAs(w.ownerA, w.A);
    expect(await release(INST.A)).toEqual({
      done: 'Claim released. Its repository links were removed.',
    });
    expect(await claimedBy(INST.A)).toBeNull();
    expect(await linkOf(REPO.A1)).toEqual({
      project_id: null,
      workspace_id: null,
      linked_by: null,
    });
    expect(await linkOf(REPO.A2)).toEqual({
      project_id: null,
      workspace_id: null,
      linked_by: null,
    });
    // Repository rows stay (only signed deliveries remove them).
    expect(await linkOf(REPO.A1)).not.toBeNull();
  });

  it('re-claiming after a release follows the same rule (another workspace may now claim)', async () => {
    signInAs(w.ownerA, w.A);
    await release(INST.A);
    signInAs(w.ownerA, w.C);
    expect(await claim(INST.A)).toEqual({ done: CLAIM_MESSAGES.claimed });
    expect(await claimedBy(INST.A)).toBe(w.C);
  });

  it('another workspace cannot release it', async () => {
    signInAs(w.ownerB, w.B);
    expect(await release(INST.A)).toEqual({ error: 'We have no record of that installation.' });
    signInAs(w.ownerA, w.C);
    expect(await release(INST.A)).toEqual({ error: 'We have no record of that installation.' });
    expect(await claimedBy(INST.A)).toBe(w.A);
    expect((await linkOf(REPO.A1))?.project_id).toBe(w.PA);
  });

  it('an unlinked GitHub account keeps the claim, and the owner can still release it', async () => {
    await client.query(`delete from accounts where provider_id = 'github' and user_id = $1`, [
      w.ownerA,
    ]);
    expect(await claimedBy(INST.A)).toBe(w.A);
    signInAs(w.ownerA, w.A);
    expect((await release(INST.A)).done).toBeDefined();
    expect(await claimedBy(INST.A)).toBeNull();
  });

  it('a malformed id releases nothing', async () => {
    signInAs(w.ownerA, w.A);
    expect(await release('501 OR 1=1')).toEqual({
      error: 'We have no record of that installation.',
    });
    expect(await claimedBy(INST.A)).toBe(w.A);
  });
});

describe('link (ADR-0019 §4, D0 H3)', () => {
  beforeEach(async () => {
    await claimDirect(w.A, INST.A, GH.ownerA);
    await claimDirect(w.B, INST.B, GH.ownerB);
  });

  it('an owner links a repository of the workspace’s claim to a project of the workspace', async () => {
    signInAs(w.ownerA, w.A);
    expect(await link(REPO.A1, w.PA)).toEqual({ done: 'Repository linked.' });
    expect(await linkOf(REPO.A1)).toEqual({
      project_id: w.PA,
      workspace_id: w.A,
      linked_by: w.ownerA,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${w.PA}`);
  });

  it('one project per repository: a second project is refused until unlinked', async () => {
    signInAs(w.ownerA, w.A);
    await link(REPO.A1, w.PA);
    expect((await link(REPO.A1, w.PA2)).error).toMatch(/already linked to another project/);
    expect((await linkOf(REPO.A1))?.project_id).toBe(w.PA);
    expect(await unlink(REPO.A1, w.PA)).toEqual({ done: 'Repository unlinked.' });
    expect(await link(REPO.A1, w.PA2)).toEqual({ done: 'Repository linked.' });
    expect((await linkOf(REPO.A1))?.project_id).toBe(w.PA2);
  });

  it.each([
    ['L1', () => w.PL1],
    ['L2', () => w.PL2],
  ])('an %s project needs the server-side confirmation', async (_cls, project) => {
    signInAs(w.ownerA, w.A);
    for (const extra of [
      {},
      { confirmRepoName: '' },
      { confirmRepoName: 'on' },
      { confirmRepoName: 'YES' },
    ]) {
      expect(await link(REPO.A1, project(), extra)).toEqual({
        error: LINK_CONFIRM_REQUIRED,
        needsConfirm: true,
      });
      expect((await linkOf(REPO.A1))?.project_id).toBeNull();
    }
    expect(await link(REPO.A1, project(), { confirmRepoName: 'yes' })).toEqual({
      done: 'Repository linked.',
    });
    expect((await linkOf(REPO.A1))?.project_id).toBe(project());
  });

  it('an L0 project needs no confirmation', async () => {
    signInAs(w.ownerA, w.A);
    expect(await link(REPO.A1, w.PA)).toEqual({ done: 'Repository linked.' });
  });

  it('cross-workspace: another workspace’s repository, or project, is refused', async () => {
    signInAs(w.ownerA, w.A);
    // B's claimed repository → A's project.
    expect(await link(REPO.B, w.PA)).toEqual({
      error: 'That repository is not available to this workspace.',
    });
    // A's repository → B's project (and the L1/L2 check never learns B's class).
    expect(await link(REPO.A1, w.PB)).toEqual({ error: 'Project not found.' });
    signInAs(w.ownerB, w.B);
    // A's repository → B's own project.
    expect(await link(REPO.A1, w.PB)).toEqual({
      error: 'That repository is not available to this workspace.',
    });
    expect((await linkOf(REPO.A1))?.project_id).toBeNull();
    expect((await linkOf(REPO.B))?.project_id).toBeNull();
  });

  it('a repository of an unclaimed installation cannot be linked', async () => {
    signInAs(w.ownerA, w.A);
    expect(await link(REPO.ADMIN, w.PA)).toEqual({
      error: 'That repository is not available to this workspace.',
    });
  });

  it('malformed ids write nothing', async () => {
    signInAs(w.ownerA, w.A);
    expect(await link('9001; drop table', w.PA)).toEqual({
      error: 'That repository is not available to this workspace.',
    });
    expect(await link(REPO.A1, 'not-a-uuid')).toEqual({ error: 'Project not found.' });
    expect((await linkOf(REPO.A1))?.project_id).toBeNull();
  });

  it('another workspace cannot unlink; the owner can', async () => {
    signInAs(w.ownerA, w.A);
    await link(REPO.A1, w.PA);
    signInAs(w.ownerB, w.B);
    expect(await unlink(REPO.A1, w.PB)).toEqual({
      error: 'That repository is not available to this workspace.',
    });
    expect((await linkOf(REPO.A1))?.project_id).toBe(w.PA);
    signInAs(w.ownerA, w.A);
    expect(await unlink(REPO.A1, w.PA)).toEqual({ done: 'Repository unlinked.' });
    expect(await unlink(REPO.A1, w.PA)).toEqual({
      error: 'That repository is not available to this workspace.',
    });
  });

  it('a database error maps to a calm message and logs only the error name', async () => {
    signInAs(w.ownerA, w.A);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'violates foreign key constraint on host fake-db.example.test password=fake';
    vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error(secret));
    expect(await link(REPO.A1, w.PA)).toEqual({
      error: 'That change could not be saved. Reload the page and try again.',
    });
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('github link failed');
    expect(logged).not.toContain('fake-db');
    expect(logged).not.toContain(String(REPO.A1));
    expect(logged).not.toContain(w.PA);
  });
});
