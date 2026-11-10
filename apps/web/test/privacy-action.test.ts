import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0018 §7, TEST_PLAN §S5f "Class change by owners/admins only": the server action changes
// one column for owners and admins of the viewer's workspace, takes the class and nothing else,
// and never logs its input. The JD-M04 repository is faked here; its SQL is tested on PGlite in
// privacy-reader-roundtrip.test.ts.

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
const projects = vi.hoisted(() => ({ setPrivacyClass: vi.fn(), getProject: vi.fn() }));
const github = vi.hoisted(() => ({ workspaceInstallations: vi.fn() }));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => state.viewer,
}));
// No database unless a test sets one; the S5h linked-repository read is faked at JD-M10's
// boundary (its SQL runs on PGlite in privacy-class-linked-repo.test.ts).
vi.mock('@/lib/auth', () => ({ getDb: () => state.db }));
vi.mock('@/lib/github', () => ({ githubRepository: () => github }));
vi.mock('next/cache', () => ({ revalidatePath }));

const { changePrivacyClassAction } = await import('@/app/projects/actions');

const viewerAs = (role: unknown) => ({
  user: { id: 'user-1', name: 'Hai', email: 'owner@example.test' },
  workspaceId: WS,
  role,
  projects,
});

beforeEach(() => {
  state.viewer = viewerAs('owner');
  state.db = null;
  projects.setPrivacyClass.mockImplementation(async (_ws, id, c) => ({ id, privacyClass: c }));
  // The current class is read first when raising (S5h review L2).
  projects.getProject.mockImplementation(async (_ws, id) => ({ id, privacyClass: 'L0' }));
});
afterEach(() => vi.clearAllMocks());

describe('changePrivacyClassAction — role matrix', () => {
  it.each([
    ['owner', 'L2'],
    ['owner', 'L1'],
    ['owner', 'L0'],
    ['admin', 'L2'],
    ['admin', 'L0'],
  ])('%s sets %s', async (role, privacyClass) => {
    state.viewer = viewerAs(role);
    expect(await changePrivacyClassAction(PROJECT, privacyClass)).toEqual({ privacyClass });
    expect(projects.setPrivacyClass).toHaveBeenCalledExactlyOnceWith(WS, PROJECT, privacyClass);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);
  });

  it.each(['member', null, undefined, '', 'viewer', 'Owner'])(
    'refuses the role %j and writes nothing',
    async (role) => {
      state.viewer = viewerAs(role);
      expect(await changePrivacyClassAction(PROJECT, 'L2')).toEqual({
        error: 'Only workspace owners and admins can change the privacy class.',
      });
      expect(projects.setPrivacyClass).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('refuses a signed-out request', async () => {
    state.viewer = null;
    expect(await changePrivacyClassAction(PROJECT, 'L2')).toEqual({
      error: 'Your session ended. Sign in again to continue.',
    });
    expect(projects.setPrivacyClass).not.toHaveBeenCalled();
  });

  it.each(['L3', 'l2', '', 'L2 ', 'JDK1-AAAA'])('refuses the class %j', async (value) => {
    expect(await changePrivacyClassAction(PROJECT, value)).toEqual({
      error: 'Choose L0, L1 or L2.',
    });
    expect(projects.setPrivacyClass).not.toHaveBeenCalled();
  });

  it('a malformed id or another workspace’s project reads as not found', async () => {
    expect(await changePrivacyClassAction('nope', 'L2')).toEqual({ error: 'Project not found.' });
    expect(projects.setPrivacyClass).not.toHaveBeenCalled();
    projects.setPrivacyClass.mockResolvedValueOnce(null);
    expect(await changePrivacyClassAction(PROJECT, 'L2')).toEqual({ error: 'Project not found.' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('takes exactly two arguments (project id, class) and logs nothing', async () => {
    expect(changePrivacyClassAction.length).toBe(2);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((l) =>
      vi.spyOn(console, l).mockImplementation(() => {}),
    );
    await changePrivacyClassAction(PROJECT, 'L2');
    await changePrivacyClassAction(PROJECT, 'bogus');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('changePrivacyClassAction — linked repository read (S5h)', () => {
  const FAILED = 'The privacy class could not be changed. Try again in a moment.';

  it('fails closed when the linked repositories cannot be read: nothing is written', async () => {
    state.db = {};
    github.workspaceInstallations.mockRejectedValue(
      new Error('connect ECONNREFUSED db.secret-host.example:5432'),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await changePrivacyClassAction(PROJECT, 'L2')).toEqual({ error: FAILED });
    expect(projects.setPrivacyClass).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    // One line with the error's name only: never the driver message or the arguments.
    expect(error).toHaveBeenCalledOnce();
    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ module: 'JD-APP', error: 'Error' });
    expect(line).not.toMatch(/secret-host|ECONNREFUSED|L2|2222/);
    error.mockRestore();
  });

  it('reads nothing when lowering, or when the call carries the confirmation', async () => {
    state.db = {};
    github.workspaceInstallations.mockRejectedValue(new Error('not expected'));
    expect(await changePrivacyClassAction(PROJECT, 'L0')).toEqual({ privacyClass: 'L0' });
    expect(await changePrivacyClassAction(PROJECT, 'L2', { confirmLinkedRepo: true })).toEqual({
      privacyClass: 'L2',
    });
    expect(github.workspaceInstallations).not.toHaveBeenCalled();
    expect(projects.getProject).not.toHaveBeenCalled();
  });

  it('a linked repository of another project in the workspace asks nothing', async () => {
    state.db = {};
    github.workspaceInstallations.mockResolvedValue([
      {
        repositories: [
          { repoId: 1, fullName: 'ana/other', projectId: '33333333-3333-4333-8333-333333333333' },
          { repoId: 2, fullName: 'ana/unlinked', projectId: null },
        ],
      },
    ]);
    expect(await changePrivacyClassAction(PROJECT, 'L2')).toEqual({ privacyClass: 'L2' });
    expect(github.workspaceInstallations).toHaveBeenCalledExactlyOnceWith(WS);
    expect(projects.getProject).toHaveBeenCalledExactlyOnceWith(WS, PROJECT);
  });

  it('lowering L2 → L1 never reads the links, so it works even when they cannot be read (review L2)', async () => {
    state.db = {};
    projects.getProject.mockImplementation(async (_ws, id) => ({ id, privacyClass: 'L2' }));
    github.workspaceInstallations.mockRejectedValue(new Error('not expected'));
    expect(await changePrivacyClassAction(PROJECT, 'L1')).toEqual({ privacyClass: 'L1' });
    expect(await changePrivacyClassAction(PROJECT, 'L2')).toEqual({ privacyClass: 'L2' });
    expect(github.workspaceInstallations).not.toHaveBeenCalled();
    expect(projects.setPrivacyClass).toHaveBeenCalledTimes(2);
  });
});
