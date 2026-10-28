import { ProjectRepositoryError } from '@javis-dog/projects';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';

const repo = vi.hoisted(() => ({
  createProject: vi.fn(),
  issueToken: vi.fn(),
  revokeToken: vi.fn(),
  getProject: vi.fn(),
  listTokens: vi.fn(),
}));
const viewer = vi.hoisted(() => ({ current: null as unknown }));
const revalidatePath = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => viewer.current,
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ notFound }));

const { createProjectAction, issueTokenAction, revokeTokenAction } =
  await import('@/app/projects/actions');
const { default: ProjectPage } = await import('@/app/projects/[id]/page');

const form = (entries: Array<[string, string]>) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

beforeEach(() => {
  viewer.current = { user: { id: 'u' }, workspaceId: WS, role: 'owner', projects: repo };
});
afterEach(() => vi.clearAllMocks());

describe('createProjectAction', () => {
  it('asks to sign in again when the session is gone', async () => {
    viewer.current = null;
    expect(await createProjectAction({}, form([]))).toEqual({
      errors: { form: 'Your session ended. Sign in again to continue.' },
    });
  });

  it('creates in the viewer’s workspace and ignores any workspace field in the form', async () => {
    repo.createProject.mockResolvedValue({ id: PROJECT });
    const res = await createProjectAction(
      {},
      form([
        ['name', 'Web app'],
        ['platforms', 'claude-code'],
        ['workspaceId', '99999999-9999-4999-8999-999999999999'],
      ]),
    );
    expect(res).toEqual({ createdId: PROJECT });
    expect(repo.createProject).toHaveBeenCalledWith(WS, {
      name: 'Web app',
      platforms: ['claude-code'],
    });
    expect(revalidatePath).toHaveBeenCalledWith('/projects');
  });

  it('turns validation errors into field messages', async () => {
    const { normalizeProjectInput } = await import('@javis-dog/projects');
    repo.createProject.mockImplementation(async (_ws: string, input: unknown) =>
      normalizeProjectInput(input),
    );
    const res = await createProjectAction({}, form([['name', 'x']]));
    expect(res.errors?.name).toBe('Use at least 2 characters.');
    expect(res.errors?.platforms).toBe('Pick at least one coding environment.');
  });

  it('explains a duplicate name', async () => {
    repo.createProject.mockRejectedValue(new ProjectRepositoryError('slug_taken'));
    const res = await createProjectAction(
      {},
      form([
        ['name', 'Web app'],
        ['platforms', 'github'],
      ]),
    );
    expect(res.errors?.name).toBe('This workspace already has a project with that name.');
  });

  it('explains the 20-project cap (S5a M1)', async () => {
    repo.createProject.mockRejectedValue(new ProjectRepositoryError('project_limit'));
    const res = await createProjectAction(
      {},
      form([
        ['name', 'Web app'],
        ['platforms', 'github'],
      ]),
    );
    expect(res).toEqual({
      errors: {
        form: 'This workspace already has 20 projects, the most it can hold for now.',
      },
    });
  });
});

describe('issueTokenAction', () => {
  it('returns the plaintext once, scoped to the viewer’s workspace', async () => {
    repo.issueToken.mockResolvedValue({ token: 'jd_it_secret', record: {} });
    const res = await issueTokenAction(PROJECT, {}, form([['name', 'laptop']]));
    expect(res).toEqual({ token: 'jd_it_secret' });
    expect(repo.issueToken).toHaveBeenCalledWith(WS, PROJECT, 'laptop');
  });

  it('rejects malformed project ids before the database', async () => {
    expect(await issueTokenAction('../etc', {}, form([]))).toEqual({ error: 'Project not found.' });
    expect(repo.issueToken).not.toHaveBeenCalled();
  });

  it.each([
    ['token_limit', 'This project already has 5 active tokens. Revoke one first.'],
    [
      'token_issue_limit',
      'This project has issued 10 tokens in the last 24 hours. You can issue another once the oldest is a day old.',
    ],
    ['not_found', 'Project not found.'],
  ] as const)('maps %s to a readable message', async (code, message) => {
    repo.issueToken.mockRejectedValue(new ProjectRepositoryError(code));
    expect(await issueTokenAction(PROJECT, {}, form([]))).toEqual({ error: message });
  });
});

describe('revokeTokenAction', () => {
  it('revokes within the viewer’s workspace only', async () => {
    await revokeTokenAction(PROJECT, form([['tokenId', TOKEN]]));
    expect(repo.revokeToken).toHaveBeenCalledWith(WS, TOKEN);
  });

  it('does nothing when signed out or the id is malformed', async () => {
    await revokeTokenAction(PROJECT, form([['tokenId', 'nope']]));
    viewer.current = null;
    await revokeTokenAction(PROJECT, form([['tokenId', TOKEN]]));
    expect(repo.revokeToken).not.toHaveBeenCalled();
  });
});

describe('/projects/[id]', () => {
  it('is not found when the project is outside the viewer’s workspace', async () => {
    repo.getProject.mockResolvedValue(null);
    await expect(ProjectPage({ params: Promise.resolve({ id: PROJECT }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(repo.getProject).toHaveBeenCalledWith(WS, PROJECT);
  });

  it('is not found for malformed ids without querying', async () => {
    await expect(ProjectPage({ params: Promise.resolve({ id: 'abc' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(repo.getProject).not.toHaveBeenCalled();
  });
});
