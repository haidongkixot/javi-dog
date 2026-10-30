import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0018 §7, TEST_PLAN §S5f "Class change by owners/admins only": the server action changes
// one column for owners and admins of the viewer's workspace, takes the class and nothing else,
// and never logs its input. The JD-M04 repository is faked here; its SQL is tested on PGlite in
// privacy-reader-roundtrip.test.ts.

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({ viewer: null as unknown }));
const projects = vi.hoisted(() => ({ setPrivacyClass: vi.fn() }));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => state.viewer,
}));
vi.mock('@/lib/auth', () => ({ getDb: () => null }));
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
  projects.setPrivacyClass.mockImplementation(async (_ws, id, c) => ({ id, privacyClass: c }));
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
