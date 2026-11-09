// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { schema } from '@javis-dog/event-store';
import { createGithubRepository } from '@javis-dog/github-bridge';
import { accounts, users, workspaceMembers } from '@javis-dog/identity';
import { createProjectRepository } from '@javis-dog/projects';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// apps/web takes PGlite and drizzle from its dev dependencies (same copies JD-M06 tests use).
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

// S5g — /integrations/github and the project page GitHub card on PGlite (TEST_PLAN §S5g rows
// "Claim", "Link", "Integrations status"; ADR-0019 §4, §8; design review D0 H1, M4, M5).
// Covers: the setup_url `installation_id` hint is ignored, the install link is owner-only,
// repository names reach members of the claiming workspace only, and an unlinked GitHub account
// keeps the claim but says it can't be re-verified. DOM text assertions only; screenshot budget 0.

type Session = { userId: string; activeWorkspaceId: string | null };
const state = vi.hoisted(() => ({ db: null as unknown, session: null as Session | null }));
const getSession = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
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
  redirect: vi.fn(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const { default: GithubPage } = await import('@/app/integrations/github/page');
const { default: ProjectPage } = await import('@/app/projects/[id]/page');
const { NOT_REVERIFIABLE_TEXT, ORGANIZATION_TEXT, OTHER_ACCOUNT_TEXT } =
  await import('@/components/github/installations');
const { OWNER_ONLY_TEXT } = await import('@/components/github/status');

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

const GH = { ownerA: 1001, memberA: 1005, ownerB: 2002 };
const INST = { A: 501, B: 502 };
const REPO = { A1: 9001, A2: 9002, B: 9004 };
const FAKE_SECRET = 'fake-webhook-secret-for-tests-only';
const SLUG = 'javis-dog-test-app';
const INSTALL_URL = `https://github.com/apps/${SLUG}/installations/new`;

interface World {
  A: string;
  B: string;
  PA: string;
  PL1: string;
  PB: string;
  ownerA: string;
  memberA: string;
  ownerB: string;
  noGithub: string;
}
let w: World;

const seedUser = async (name: string, email: string, githubId?: number) => {
  const [u] = await db.insert(users).values({ name, email, emailVerified: true }).returning();
  if (githubId !== undefined)
    await db
      .insert(accounts)
      .values({ userId: u!.id, accountId: String(githubId), providerId: 'github' });
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

const seed = async (): Promise<World> => {
  const projects = createProjectRepository(db);
  const A = (await projects.createWorkspace({ name: 'Alpha workspace' })).id;
  const B = (await projects.createWorkspace({ name: 'Bravo workspace' })).id;
  const N = (await projects.createWorkspace({ name: 'No GitHub workspace' })).id;
  const ownerA = await seedUser('Ana Owner', 'ana@alpha.test', GH.ownerA);
  const memberA = await seedUser('Max Member', 'max@alpha.test', GH.memberA);
  const ownerB = await seedUser('Bea Owner', 'bea@bravo.test', GH.ownerB);
  const noGithub = await seedUser('Nia Google', 'nia@nogh.test');
  await db.insert(workspaceMembers).values([
    { organizationId: A, userId: ownerA, role: 'owner' },
    { organizationId: A, userId: memberA, role: 'member' },
    { organizationId: B, userId: ownerB, role: 'owner' },
    { organizationId: N, userId: noGithub, role: 'owner' },
  ]);
  const pa = await projects.createProject(A, { name: 'Alpha app', platforms: ['claude-code'] });
  const pl1 = await projects.createProject(A, { name: 'Alpha hashed', platforms: ['claude-code'] });
  await projects.setPrivacyClass(A, pl1.id, 'L1');
  const pb = await projects.createProject(B, { name: 'Bravo app', platforms: ['claude-code'] });
  await installation(INST.A, GH.ownerA, [
    [REPO.A1, 'ana/alpha-repo'],
    [REPO.A2, 'ana/second-repo'],
  ]);
  await installation(INST.B, GH.ownerB, [[REPO.B, 'bea/bravo-repo']]);
  return { A, B, PA: pa.id, PL1: pl1.id, PB: pb.id, ownerA, memberA, ownerB, noGithub };
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

const renderPage = async (page: () => Promise<ReactElement>) => {
  const { container } = render(await page());
  return container.innerHTML;
};
const githubPage =
  (query: Record<string, string> = {}) =>
  () =>
    GithubPage({ searchParams: Promise.resolve(query) });
const projectPage = (id: string) => () => ProjectPage({ params: Promise.resolve({ id }) });
const claimedBy = async (installationId: number) =>
  (
    await client.query<{ c: string | null }>(
      'select claimed_workspace_id as c from github_installations where installation_id = $1',
      [installationId],
    )
  ).rows[0]?.c ?? null;
const claimDirect = (workspaceId: string, installationId: number, githubAccountId: number) =>
  createGithubRepository(db).claimInstallation({ workspaceId, installationId, githubAccountId });
const configure = (env: Partial<Record<string, string>>) => {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? '');
};
const fullyConfigured = () =>
  configure({
    GITHUB_APP_WEBHOOK_SECRET: FAKE_SECRET,
    GITHUB_APP_SLUG: SLUG,
    GITHUB_APP_OWNER_ID: String(GH.ownerA),
  });

beforeEach(async () => {
  await client.exec(
    'truncate github_deliveries, github_installations, github_repositories, workspaces, users, ingest_rate_windows cascade',
  );
  w = await seed();
  signInAs(null);
  configure({ GITHUB_APP_WEBHOOK_SECRET: '', GITHUB_APP_SLUG: '', GITHUB_APP_OWNER_ID: '' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('/integrations/github — owner-only install link (D0 H1)', () => {
  it('the app owner (linked GitHub id = GITHUB_APP_OWNER_ID) gets the install link and the select-repositories advice', async () => {
    fullyConfigured();
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    const link = screen.getByRole('link', { name: 'Install the app on GitHub' });
    expect(link.getAttribute('href')).toBe(INSTALL_URL);
    expect(document.body.textContent).toContain('Only select repositories');
  });

  it.each([
    ['another workspace owner with another GitHub id', () => signInAs(w.ownerB, w.B)],
    ['an owner without a GitHub account', () => signInAs(w.noGithub)],
    ['a member of the owner’s workspace', () => signInAs(w.memberA, w.A)],
    ['a signed-out visitor', () => signInAs(null)],
  ])('%s sees no install link, only the owner-only notice', async (_who, as) => {
    fullyConfigured();
    as();
    const html = await renderPage(githubPage());
    expect(html).not.toContain('github.com/apps');
    expect(screen.queryByRole('link', { name: /install/i })).toBeNull();
    expect(document.body.textContent).toContain(OWNER_ONLY_TEXT);
  });

  it('without the webhook secret even the owner gets no link, and the status says not set up', async () => {
    configure({ GITHUB_APP_SLUG: SLUG, GITHUB_APP_OWNER_ID: String(GH.ownerA) });
    signInAs(w.ownerA, w.A);
    const html = await renderPage(githubPage());
    expect(html).not.toContain('github.com/apps');
    expect(document.body.textContent).toContain('GitHub: not set up');
  });

  it('never renders the secret value', async () => {
    fullyConfigured();
    signInAs(w.ownerA, w.A);
    expect(await renderPage(githubPage())).not.toContain(FAKE_SECRET);
  });
});

describe('/integrations/github — claims', () => {
  it('a spoofed installation_id hint (another account’s installation) is ignored: nothing claimed, not echoed', async () => {
    fullyConfigured();
    signInAs(w.ownerA, w.A);
    const html = await renderPage(
      githubPage({ installation_id: String(INST.B), setup_action: 'install' }),
    );
    expect(await claimedBy(INST.B)).toBeNull();
    expect(await claimedBy(INST.A)).toBeNull();
    expect(html).not.toContain(String(INST.B));
    expect(html).not.toContain('bea/bravo-repo');
    // The only claim offered is the viewer's own installation, from the signed webhook row.
    const forms = [...document.querySelectorAll('input[name="installationId"]')].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(forms).toEqual([String(INST.A)]);
    expect(document.body.textContent).toContain('Back from GitHub');
  });

  it('a hint naming the viewer’s own installation still claims nothing by itself', async () => {
    fullyConfigured();
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage({ installation_id: String(INST.A), setup_action: 'install' }));
    expect(await claimedBy(INST.A)).toBeNull();
  });

  it('repository names appear only for the claiming workspace; members read without controls', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.ownerB, w.B);
    let html = await renderPage(githubPage());
    expect(html).not.toContain('ana/alpha-repo');
    expect(html).not.toContain('ana/second-repo');
    cleanup();
    signInAs(w.memberA, w.A);
    html = await renderPage(githubPage());
    expect(html).toContain('ana/alpha-repo');
    expect(screen.queryByRole('button', { name: /release|claim/i })).toBeNull();
    expect(document.body.textContent).toContain('Only workspace owners and admins can claim');
  });

  it('explains plainly that organization installations aren’t supported yet (L-2)', async () => {
    fullyConfigured();
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    const region = screen.getByRole('region', { name: 'Installations' });
    expect(region.textContent).toContain(
      'Organization installations aren’t supported yet: install the app on your personal GitHub account.',
    );
    expect(ORGANIZATION_TEXT).toMatch(/personal GitHub account/);
  });

  it('the owner sees the claim with a release control', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    const region = screen.getByRole('region', { name: 'Installations' });
    expect(within(region).getByRole('button', { name: 'Release claim' })).toBeTruthy();
    expect(region.textContent).toContain('ana/alpha-repo');
    expect(region.textContent).not.toContain(NOT_REVERIFIABLE_TEXT);
  });

  it('after the GitHub account is unlinked the claim stays and says it can’t be re-verified', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    await client.query(`delete from accounts where provider_id = 'github' and user_id = $1`, [
      w.ownerA,
    ]);
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    expect(await claimedBy(INST.A)).toBe(w.A);
    const region = screen.getByRole('region', { name: 'Installations' });
    expect(region.textContent).toContain(NOT_REVERIFIABLE_TEXT);
    expect(region.textContent).toContain('ana/alpha-repo');
  });

  it('with a different GitHub account linked the claim stays and says it can’t be re-verified', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    await client.query(
      `update accounts set account_id = '99999' where provider_id = 'github' and user_id = $1`,
      [w.ownerA],
    );
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    expect(await claimedBy(INST.A)).toBe(w.A);
    const region = screen.getByRole('region', { name: 'Installations' });
    expect(region.textContent).toContain(OTHER_ACCOUNT_TEXT);
    expect(region.textContent).not.toContain(NOT_REVERIFIABLE_TEXT);
  });
});

describe('status labels from real rows (ADR-0019 §8, D0 M4)', () => {
  const statusText = () => screen.getByRole('region', { name: 'Status and setup' }).textContent;

  it('claimed without a verified delivery → waiting; with one → connected with its time, for the claiming workspace only', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    expect(statusText()).toContain('Waiting for the first delivery');
    expect(statusText()).not.toContain('Connected');
    cleanup();

    const at = new Date(Date.now() - 2 * 86_400_000);
    at.setUTCHours(8, 15, 0, 0);
    await createGithubRepository(db).touchVerifiedDelivery(INST.A, at);
    await renderPage(githubPage());
    expect(statusText()).toContain('Connected');
    expect(statusText()).toContain('08:15 UTC');
    expect(
      screen
        .getByRole('region', { name: 'Status and setup' })
        .querySelector(`time[datetime="${at.toISOString()}"]`),
    ).not.toBeNull();
    cleanup();

    signInAs(w.ownerB, w.B);
    await renderPage(githubPage());
    expect(statusText()).not.toContain('Connected');
    expect(statusText()).not.toContain('08:15');
  });

  it('release and re-claim: the old claim’s delivery does not make the new claim “Connected” (L-3)', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    const repo = createGithubRepository(db);
    await repo.touchVerifiedDelivery(INST.A, new Date(Date.now() - 60_000));
    expect(await repo.releaseInstallation(w.A, INST.A)).toBe(true);
    expect(await claimDirect(w.A, INST.A, GH.ownerA)).toBe('claimed');
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    expect(statusText()).toContain('Waiting for the first delivery');
    expect(statusText()).not.toContain('Connected');
  });

  it('a verified delivery older than 7 days is stale, not “Connected” (M-2)', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    const at = new Date(Date.now() - 8 * 86_400_000);
    await createGithubRepository(db).touchVerifiedDelivery(INST.A, at);
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    expect(statusText()).toContain('No verified delivery since');
    expect(statusText()).not.toContain('Connected');
    expect(
      screen
        .getByRole('region', { name: 'Status and setup' })
        .querySelector(`time[datetime="${at.toISOString()}"]`),
    ).not.toBeNull();
  });

  it('never says live or secure', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    await createGithubRepository(db).touchVerifiedDelivery(INST.A, new Date(Date.now() - 60_000));
    signInAs(w.ownerA, w.A);
    await renderPage(githubPage());
    expect(document.body.textContent).not.toMatch(/\blive\b|\bsecure\b/i);
  });
});

describe('project page GitHub card', () => {
  const card = () => screen.getByRole('region', { name: 'GitHub' });

  it('the owner sees the linked repository and an unlink control', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    await createGithubRepository(db).linkRepository({
      workspaceId: w.A,
      repoId: REPO.A1,
      projectId: w.PA,
      userId: w.ownerA,
    });
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('Linked to ana/alpha-repo');
    expect(within(card()).getByRole('button', { name: 'Unlink' })).toBeTruthy();
    // Only unlinked repositories are offered for linking.
    const options = [...card().querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['ana/second-repo']);
  });

  it('“Connected” only when a repository is linked to this project (M-2)', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    const repo = createGithubRepository(db);
    await repo.touchVerifiedDelivery(INST.A, new Date(Date.now() - 60_000));
    // The workspace has a fresh verified delivery, but nothing is linked to this project.
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('No repository linked yet');
    expect(card().textContent).not.toContain('Connected');
    expect(
      within(card())
        .getAllByRole('link')
        .some((a) => a.getAttribute('href') === '/integrations/github'),
    ).toBe(true);
    cleanup();

    // A repository linked to another project of the workspace does not count either.
    await repo.linkRepository({
      workspaceId: w.A,
      repoId: REPO.A2,
      projectId: w.PL1,
      userId: w.ownerA,
    });
    await renderPage(projectPage(w.PA));
    expect(card().textContent).not.toContain('Connected');
    cleanup();

    await repo.linkRepository({
      workspaceId: w.A,
      repoId: REPO.A1,
      projectId: w.PA,
      userId: w.ownerA,
    });
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('Connected');
  });

  it('a linked repository whose installation is suspended is not “Connected” on the card', async () => {
    fullyConfigured();
    // A second, active installation of the same account keeps the workspace "Connected".
    await installation(503, GH.ownerA, [[9003, 'ana/third-repo']]);
    await claimDirect(w.A, 503, GH.ownerA);
    await claimDirect(w.A, INST.A, GH.ownerA);
    const repo = createGithubRepository(db);
    await repo.linkRepository({
      workspaceId: w.A,
      repoId: REPO.A1,
      projectId: w.PA,
      userId: w.ownerA,
    });
    await repo.touchVerifiedDelivery(INST.A, new Date(Date.now() - 60_000));
    await repo.touchVerifiedDelivery(503, new Date(Date.now() - 60_000));
    await client.query(
      'update github_installations set suspended_at = now() where installation_id = $1',
      [INST.A],
    );
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('Suspended on GitHub');
    expect(card().textContent).not.toContain('Connected');
  });

  it('an L1 project warns about the repository name and asks for an explicit confirmation', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PL1));
    expect(card().textContent).toMatch(/This project uses L1.*Javi’s Dog will know it/);
    const box = card().querySelector('input[type="checkbox"][name="confirmRepoName"]');
    expect(box?.getAttribute('value')).toBe('yes');
    expect(box?.hasAttribute('required')).toBe(true);
  });

  it('an L0 project shows no repository-name warning', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().querySelector('input[name="confirmRepoName"]')).toBeNull();
  });

  it('a member sees links but no form or button', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    await createGithubRepository(db).linkRepository({
      workspaceId: w.A,
      repoId: REPO.A1,
      projectId: w.PA,
      userId: w.ownerA,
    });
    signInAs(w.memberA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('Linked to ana/alpha-repo');
    expect(card().querySelectorAll('form, button, select')).toHaveLength(0);
  });

  it('another workspace’s project page shows none of A’s repositories', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    signInAs(w.ownerB, w.B);
    const html = await renderPage(projectPage(w.PB));
    expect(html).not.toContain('ana/');
    expect(card().textContent).toContain(OWNER_ONLY_TEXT);
  });

  // TEST_PLAN §S5h row 4 (ADR-0019 Changes "S5h decisions"): on an L1/L2 project with a linked
  // repository, the card says the name stays known to Javi's Dog until it is unlinked.
  const KNOWN_NAME = (cls: string) =>
    `Under ${cls}, Javi’s Dog still knows the name of a linked repository until it is unlinked.`;

  it.each([
    ['L1', 'owner', (): string => w.ownerA],
    ['L2', 'owner', (): string => w.ownerA],
    ['L2', 'member', (): string => w.memberA],
  ] as const)(
    'an %s project with a linked repository says the name stays known (%s)',
    async (cls, _, user) => {
      fullyConfigured();
      await claimDirect(w.A, INST.A, GH.ownerA);
      await createProjectRepository(db).setPrivacyClass(w.A, w.PL1, cls);
      await createGithubRepository(db).linkRepository({
        workspaceId: w.A,
        repoId: REPO.A2,
        projectId: w.PL1,
        userId: w.ownerA,
      });
      signInAs(user(), w.A);
      await renderPage(projectPage(w.PL1));
      expect(card().textContent).toContain('Linked to ana/second-repo');
      expect(within(card()).getByText(KNOWN_NAME(cls))).toBeTruthy();
      expect(card().textContent).not.toMatch(/\blive\b|\bsecure\b/i);
    },
  );

  it('no such line on an L0 project with a link, or an L1 project without one', async () => {
    fullyConfigured();
    await claimDirect(w.A, INST.A, GH.ownerA);
    await createGithubRepository(db).linkRepository({
      workspaceId: w.A,
      repoId: REPO.A1,
      projectId: w.PA,
      userId: w.ownerA,
    });
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('Linked to ana/alpha-repo');
    expect(card().textContent).not.toContain('still knows the name');
    cleanup();
    await renderPage(projectPage(w.PL1));
    expect(card().textContent).toContain('No repository is linked to this project.');
    expect(card().textContent).not.toContain('still knows the name');
  });

  it('not set up: the card says so and offers no link form', async () => {
    signInAs(w.ownerA, w.A);
    await renderPage(projectPage(w.PA));
    expect(card().textContent).toContain('GitHub: not set up');
    expect(card().querySelectorAll('form')).toHaveLength(0);
  });
});
