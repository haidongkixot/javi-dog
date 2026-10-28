// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Project and token management is limited to workspace owners and admins (S5a review L1,
// same rule as budgets in ADR-0014). Server actions with a fake JD-M04 repository, and the
// Project and Projects pages. Screenshot budget 0: role/name/DOM assertions only.

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const TOKEN = '33333333-3333-4333-8333-333333333333';

const state = vi.hoisted(() => ({ viewer: null as unknown }));
const projects = vi.hoisted(() => ({
  createProject: vi.fn(),
  issueToken: vi.fn(),
  revokeToken: vi.fn(),
  getProject: vi.fn(),
  listTokens: vi.fn(),
  listProjects: vi.fn(),
}));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => state.viewer,
}));
// No database: every loader on the pages answers "not configured" without reading.
vi.mock('@/lib/auth', () => ({ getDb: () => null }));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const { createProjectAction, issueTokenAction, revokeTokenAction } =
  await import('@/app/projects/actions');
const { canManageProject } = await import('@/lib/permissions');
const { canManageBudget } = await import('@/lib/budgets');
const { default: ProjectPage } = await import('@/app/projects/[id]/page');
const { default: ProjectsPage } = await import('@/app/projects/page');

const form = (entries: Array<[string, string]>) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const viewerAs = (role: string) => ({
  user: { id: 'user-1', name: 'Hai', email: 'owner@example.test' },
  workspaceId: WS,
  role,
  projects,
});
const projectForm = () =>
  form([
    ['name', 'Web app'],
    ['platforms', 'claude-code'],
  ]);
const activeToken = {
  id: TOKEN,
  name: 'laptop',
  displayPrefix: 'AbCd',
  createdAt: new Date('2026-10-01T10:00:00Z'),
  lastUsedAt: null,
  revokedAt: null,
};

beforeEach(() => {
  state.viewer = viewerAs('owner');
  projects.createProject.mockResolvedValue({ id: PROJECT });
  projects.issueToken.mockResolvedValue({ token: 'jd_it_plaintext', record: {} });
  projects.revokeToken.mockResolvedValue(undefined);
  projects.getProject.mockResolvedValue({ id: PROJECT, name: 'Alpha app', description: null });
  projects.listTokens.mockResolvedValue([activeToken]);
  projects.listProjects.mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('project and token actions — role matrix', () => {
  it.each(['owner', 'admin'])('%s creates a project, issues and revokes a token', async (role) => {
    state.viewer = viewerAs(role);
    expect(await createProjectAction({}, projectForm())).toEqual({ createdId: PROJECT });
    expect(projects.createProject).toHaveBeenCalledExactlyOnceWith(WS, {
      name: 'Web app',
      platforms: ['claude-code'],
    });
    expect(await issueTokenAction(PROJECT, {}, form([['name', 'laptop']]))).toEqual({
      token: 'jd_it_plaintext',
    });
    expect(projects.issueToken).toHaveBeenCalledExactlyOnceWith(WS, PROJECT, 'laptop');
    await revokeTokenAction(PROJECT, form([['tokenId', TOKEN]]));
    expect(projects.revokeToken).toHaveBeenCalledExactlyOnceWith(WS, TOKEN);
  });

  it('refuses a member on all three and never writes', async () => {
    state.viewer = viewerAs('member');
    expect(await createProjectAction({}, projectForm())).toEqual({
      errors: { form: 'Only workspace owners and admins can create projects.' },
    });
    expect(await issueTokenAction(PROJECT, {}, form([['name', 'laptop']]))).toEqual({
      error: 'Only workspace owners and admins can issue tokens.',
    });
    await revokeTokenAction(PROJECT, form([['tokenId', TOKEN]]));
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(projects.issueToken).not.toHaveBeenCalled();
    expect(projects.revokeToken).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', 'viewer', 'Owner'])('refuses the unknown role %j', async (role) => {
    state.viewer = viewerAs(role as string);
    expect((await createProjectAction({}, projectForm())).errors?.form).toMatch(/Only workspace/);
    expect((await issueTokenAction(PROJECT, {}, form([]))).error).toMatch(/Only workspace/);
    await revokeTokenAction(PROJECT, form([['tokenId', TOKEN]]));
    expect(projects.createProject).not.toHaveBeenCalled();
    expect(projects.issueToken).not.toHaveBeenCalled();
    expect(projects.revokeToken).not.toHaveBeenCalled();
  });

  it('a role field in the form does not grant anything', async () => {
    state.viewer = viewerAs('member');
    const forged = projectForm();
    forged.append('role', 'owner');
    expect((await createProjectAction({}, forged)).errors?.form).toMatch(/Only workspace/);
    expect(projects.createProject).not.toHaveBeenCalled();
  });

  it('one rule for projects and budgets: owners and admins only', () => {
    for (const fn of [canManageProject, canManageBudget]) {
      expect(['owner', 'admin', 'member', null, undefined].map((r) => fn(r))).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
    }
  });
});

describe('Project detail page — token controls by role', () => {
  const tokens = () => screen.getByRole('region', { name: 'Ingest tokens' });

  it.each(['owner', 'admin'])('%s sees Issue token and Revoke', async (role) => {
    state.viewer = viewerAs(role);
    render(await ProjectPage({ params: Promise.resolve({ id: PROJECT }) }));
    expect(within(tokens()).getByRole('button', { name: 'Issue token' })).toBeTruthy();
    expect(within(tokens()).getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });

  it('a member reads the tokens without controls, and is told why', async () => {
    state.viewer = viewerAs('member');
    render(await ProjectPage({ params: Promise.resolve({ id: PROJECT }) }));
    expect(within(tokens()).getByText('laptop')).toBeTruthy();
    expect(within(tokens()).queryByRole('button')).toBeNull();
    expect(within(tokens()).queryByRole('textbox')).toBeNull();
    expect(tokens().textContent).toContain(
      'Only workspace owners and admins can issue or revoke tokens.',
    );
  });

  it('a member with no tokens is not told to issue one', async () => {
    state.viewer = viewerAs('member');
    projects.listTokens.mockResolvedValue([]);
    render(await ProjectPage({ params: Promise.resolve({ id: PROJECT }) }));
    expect(tokens().textContent).not.toContain('Issue a token below');
  });
});

describe('Projects page — create form by role', () => {
  it.each(['owner', 'admin'])('%s gets the Create project form', async (role) => {
    state.viewer = viewerAs(role);
    render(await ProjectsPage());
    expect(screen.getByRole('button', { name: 'Create project' })).toBeTruthy();
  });

  it('a member gets no form, and is told why', async () => {
    state.viewer = viewerAs('member');
    render(await ProjectsPage());
    expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Project name' })).toBeNull();
    expect(
      screen.getByText('Only workspace owners and admins can create projects.', { exact: false }),
    ).toBeTruthy();
  });
});
