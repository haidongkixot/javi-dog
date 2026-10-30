// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSentinel } from './privacy-sentinel';

// ADR-0018 §7–§9 on the pages (TEST_PLAN §S5f): the project page's privacy card per role and
// class, its server-rendered HTML (no key material, the M6 field attributes), the clearing paths
// wired into the sign-out button and the dashboard's 401, and the Integrations copy. Server
// actions, session and database are faked. Screenshot budget 0.

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({ viewer: null as unknown, privacyClass: 'L2' }));
const projects = vi.hoisted(() => ({
  getProject: vi.fn(),
  listTokens: vi.fn(),
  setPrivacyClass: vi.fn(),
}));
const forgetKeysOnSignOut = vi.hoisted(() => vi.fn(async () => {}));
const signOut = vi.hoisted(() => vi.fn(async () => {}));
const order = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => state.viewer,
}));
vi.mock('@/lib/auth', () => ({ getDb: () => null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({
      data: { user: { name: 'Hai', email: 'h@example.test' } },
      isPending: false,
    }),
    signOut,
  },
}));
vi.mock('@/lib/privacy/browser', async (orig) => ({
  ...(await orig<typeof import('@/lib/privacy/browser')>()),
  forgetKeysOnSignOut,
}));

const { default: ProjectPage } = await import('@/app/projects/[id]/page');
const { default: IntegrationsPage } = await import('@/app/integrations/page');
const { AccountMenu } = await import('@/components/account-menu');
const { useDashboardSnapshot } = await import('@/components/dashboard/use-dashboard-snapshot');
const copy = await import('@/lib/privacy/copy');

const viewerAs = (role: string) => ({
  user: { id: 'user-1', name: 'Hai', email: 'owner@example.test' },
  workspaceId: WS,
  role,
  projects,
});

beforeEach(() => {
  state.viewer = viewerAs('owner');
  projects.getProject.mockImplementation(async () => ({
    id: PROJECT,
    name: 'Alpha app',
    slug: 'alpha-app',
    description: null,
    privacyClass: state.privacyClass,
  }));
  projects.listTokens.mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  forgetKeysOnSignOut.mockImplementation(async () => void order.push('forget'));
  signOut.mockImplementation(async () => void order.push('signOut'));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  order.splice(0);
});

const page = async () => ProjectPage({ params: Promise.resolve({ id: PROJECT }) });
const card = () => screen.getByRole('region', { name: 'Privacy' });

describe('project page — privacy card', () => {
  it('L2, member: the label, what Javi’s Dog sees, the limits, the role note, key entry; no class controls', async () => {
    state.privacyClass = 'L2';
    state.viewer = viewerAs('member');
    render(await page());
    const c = card();
    expect(within(c).getByRole('status').textContent).toBe(copy.LABEL_L2_NOT_CHECKED);
    for (const line of [...copy.STILL_SEES, ...copy.LIMITS])
      expect(within(c).getByText(line)).toBeTruthy();
    expect(within(c).getByText(copy.ROLE_NOTE)).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Use key' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Generate recovery key' })).toBeNull();
    expect(within(c).queryByRole('button', { name: /^Lower to/ })).toBeNull();
  });

  it('L0, owner: the setup flow with the lost-key warning; no lowering, no key entry', async () => {
    state.privacyClass = 'L0';
    render(await page());
    const c = card();
    expect(within(c).getByText(/L0: operational metadata only/)).toBeTruthy();
    expect(within(c).getByText(copy.LOST_KEY_WARNING)).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Generate recovery key' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: /^Lower to/ })).toBeNull();
    expect(within(c).queryByLabelText('Recovery key')).toBeNull();
  });

  it.each(['owner', 'admin'])('L2, %s: rotation and lowering offered', async (role) => {
    state.privacyClass = 'L2';
    state.viewer = viewerAs(role);
    render(await page());
    const c = card();
    expect(within(c).getByRole('heading', { name: 'Generate a new recovery key' })).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Lower to L0…' })).toBeTruthy();
  });

  it('never says secure, zero-knowledge or end-to-end', async () => {
    for (const cls of ['L0', 'L1', 'L2']) {
      state.privacyClass = cls;
      const { unmount } = render(await page());
      expect(card().textContent).not.toMatch(/secure|zero-knowledge|end-to-end/i);
      unmount();
    }
  });

  it('server HTML: no key material and the M6 attributes on the key field', async () => {
    state.privacyClass = 'L2';
    const html = renderToString(await page());
    expect(findSentinel(html)).toEqual([]);
    expect(html).not.toMatch(/JDK1-[0-9A-Z]{4}-/);
    // HTML attribute names are case-insensitive; React writes them camel-cased.
    const field = (/<input[^>]*id="key-entry"[^>]*>/.exec(html)?.[0] ?? '').toLowerCase();
    expect(field).toContain('type="password"');
    expect(field).toContain('autocomplete="off"');
    expect(field).toContain('spellcheck="false"');
    expect(field).toContain('autocapitalize="off"');
    expect(field).not.toMatch(/\sname=/);
  });
});

describe('clearing paths', () => {
  it('the sign-out button forgets keys before the session ends', async () => {
    render(<AccountMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(forgetKeysOnSignOut).toHaveBeenCalledExactlyOnceWith('sign-out');
    expect(order).toEqual(['forget', 'signOut']);
  });

  it('a 401 from the dashboard snapshot forgets keys (session ended)', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })),
      );
      const { result } = renderHook(() => useDashboardSnapshot(null));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.signedOut).toBe(true);
      expect(forgetKeysOnSignOut).toHaveBeenCalledExactlyOnceWith('session-ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 503 does not forget keys', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ status: 503, ok: false, json: async () => ({}) })),
      );
      renderHook(() => useDashboardSnapshot(null));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(forgetKeysOnSignOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Integrations page — privacy classes (ADR-0018 §9)', () => {
  const privacy = () => screen.getByRole('region', { name: 'Privacy classes' });

  it('describes L1 and L2 as opt-in and per project, and L0 as the default', () => {
    render(<IntegrationsPage />);
    const text = privacy().textContent ?? '';
    expect(text).toMatch(/L0 by default/);
    expect(text).toMatch(/opt-in per project/);
    expect(text.match(/opt-in, per project/g)).toHaveLength(2);
    expect(text).toContain('Off until a project owner or admin turns it on.');
  });

  it('says what Javi’s Dog still sees and who can read the names', () => {
    render(<IntegrationsPage />);
    const text = privacy().textContent ?? '';
    expect(text).toContain('sees which threads share a repo, branch or folder');
    expect(text).toContain(
      'Status, timing, token counts, event sizes and the sender’s IP stay visible',
    );
    expect(text).toContain('anyone holding the key can read the names');
  });

  it('no longer claims the classes are on, and never overclaims', () => {
    render(<IntegrationsPage />);
    const text = privacy().textContent ?? '';
    expect(text).not.toMatch(/Planned defaults/);
    expect(text).not.toMatch(/key only you hold/);
    expect(text).not.toMatch(/secure|zero-knowledge|end-to-end/i);
    expect(text).not.toMatch(/file and branch names are hashed before/i);
  });
});
