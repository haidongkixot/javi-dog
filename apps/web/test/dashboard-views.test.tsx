// @vitest-environment jsdom
import type { DashboardSnapshot, ThreadState } from '@javis-dog/realtime';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
const readSnapshot = vi.hoisted(() => vi.fn());
vi.mock('@/lib/viewer', () => ({ getViewer: async () => state.viewer }));
vi.mock('@/lib/auth', () => ({ getDb: () => state.db }));
vi.mock('@javis-dog/realtime', () => ({
  createDashboardReader: () => ({ snapshot: readSnapshot }),
}));

const { OverviewView } = await import('@/components/dashboard/overview-view');
const { AgentsView } = await import('@/components/dashboard/agents-view');
const { ProjectsTable } = await import('@/components/dashboard/projects-table');
const { OverviewDashboard, AgentsDashboard, ProjectsDashboard } =
  await import('@/components/dashboard/dashboards');
const { POLL_INTERVAL_MS } = await import('@/components/dashboard/use-dashboard-snapshot');
const { default: OverviewPage } = await import('@/app/page');
const { default: AgentsPage } = await import('@/app/agents/page');

const NOW = '2026-10-28T10:00:00.000Z';
const ago = (s: number) => new Date(Date.parse(NOW) - s * 1000).toISOString();
const WS = '11111111-1111-4111-8111-111111111111';
const P_ALPHA = '22222222-2222-4222-8222-222222222222';
const P_BETA = '33333333-3333-4333-8333-333333333333';
const P_GAMMA = '44444444-4444-4444-8444-444444444444';

const thread = (over: Partial<ThreadState>): ThreadState => ({
  projectId: P_ALPHA,
  projectSlug: 'alpha',
  projectName: 'Alpha app',
  threadRef: 'cc_0000000000000000000000000000aaaa',
  status: 'working',
  statusSource: 'collector',
  statusReason: null,
  lastType: 'agent.heartbeat',
  firstSignalAt: ago(3600),
  lastSignalAt: ago(12),
  freshness: 'fresh',
  attention: false,
  needsAttention: false,
  agents: 1,
  tasksCompleted: 2,
  inputTokens: 1200,
  outputTokens: 300,
  ...over,
});

const WORKING = thread({});
// Review focus: waiting for permission, quiet for 5 min → still "waiting", labelled stale.
const WAITING_STALE = thread({
  projectId: P_BETA,
  projectSlug: 'beta',
  projectName: 'Beta service',
  threadRef: 'cc_1111111111111111111111111111bbbb',
  status: 'waiting',
  lastType: 'permission.requested',
  lastSignalAt: ago(300),
  freshness: 'stale',
  attention: true,
  needsAttention: true,
  inputTokens: 0,
  outputTokens: 0,
});
// Review focus: a session that ended an hour ago is "ended", not "stale".
const ENDED = thread({
  threadRef: 'cc_2222222222222222222222222222cccc',
  status: 'completed',
  lastType: 'session.ended',
  lastSignalAt: ago(3600),
  freshness: 'ended',
});

const SNAPSHOT: DashboardSnapshot = {
  generatedAt: NOW,
  freshnessWindowMs: 180_000,
  windowHours: 24,
  overview: {
    activeProjects: { value: 1, lastSignalAt: ago(12) },
    agentsWorking: { value: 1, lastSignalAt: ago(12) },
    tokensLastHour: { value: 1500, lastSignalAt: ago(40), reports: 3 },
    tasksCompleted24h: { value: 4, lastSignalAt: ago(900) },
  },
  // Deliberately not attention-first: the views must sort.
  threads: [WORKING, ENDED, WAITING_STALE],
  activity: [
    {
      at: ago(12),
      projectSlug: 'alpha',
      threadRef: WORKING.threadRef,
      type: 'tool.completed',
      status: 'working',
      toolName: 'Edit',
      statusSource: 'collector',
      statusReason: null,
    },
    {
      at: ago(300),
      projectSlug: 'beta',
      threadRef: WAITING_STALE.threadRef,
      type: 'permission.requested',
      status: 'waiting',
      toolName: null,
      statusSource: 'collector',
      statusReason: null,
    },
  ],
  projects: [
    {
      id: P_ALPHA,
      slug: 'alpha',
      name: 'Alpha app',
      lastSignalAt: ago(12),
      freshness: 'fresh',
      freshThreads: 1,
      attentionThreads: 0,
    },
    {
      id: P_BETA,
      slug: 'beta',
      name: 'Beta service',
      lastSignalAt: ago(300),
      freshness: 'stale',
      freshThreads: 0,
      attentionThreads: 1,
    },
    {
      id: P_GAMMA,
      slug: 'gamma',
      name: 'Gamma tool',
      lastSignalAt: null,
      freshness: 'never',
      freshThreads: 0,
      attentionThreads: 0,
    },
  ],
};

const EMPTY: DashboardSnapshot = {
  ...SNAPSHOT,
  overview: {
    activeProjects: { value: 0, lastSignalAt: null },
    agentsWorking: { value: 0, lastSignalAt: null },
    tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
    tasksCompleted24h: { value: 0, lastSignalAt: null },
  },
  threads: [],
  activity: [],
  projects: [],
};

const LIVE = /\blive\b/i;
// Waiting, then `session.ended` (status-less): the reader keeps `attention` but the thread is over.
const ENDED_WAITING = thread({
  projectId: P_GAMMA,
  projectSlug: 'gamma',
  projectName: 'Gamma tool',
  threadRef: 'cc_3333333333333333333333333333dddd',
  status: 'waiting',
  lastType: 'session.ended',
  lastSignalAt: ago(60),
  freshness: 'ended',
  attention: true,
  needsAttention: false,
});
// Only a fresh, working thread: the snapshot itself claims activity.
const FRESH_ONLY: DashboardSnapshot = {
  ...SNAPSHOT,
  threads: [WORKING],
  projects: [SNAPSHOT.projects[0]!],
};

const card = (name: string) => screen.getByRole('heading', { name }).closest('article')!;
const region = (name: string) => screen.getByRole('region', { name });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.viewer = null;
  state.db = null;
});

describe('Overview with data', () => {
  beforeEach(() => {
    render(<OverviewView snapshot={SNAPSHOT} />);
  });

  it('leads with the attention count, visible within a 3-second scan', () => {
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'One thread needs your attention.',
    );
  });

  it('lists the waiting thread first in the agent squad, labelled waiting and stale', () => {
    const items = within(region('Agent squad')).getAllByRole('listitem');
    expect(items).toHaveLength(2); // the ended thread is not part of the squad
    expect(items[0]!.textContent).toContain('Beta service');
    expect(items[0]!.textContent).toContain('Waiting for you');
    expect(items[0]!.textContent).toContain('Stale');
    expect(items[0]!.textContent).toContain('No signal for 5 min');
    expect(items[1]!.textContent).toContain('Working');
    expect(items[1]!.textContent).toContain('Updated 12 s ago');
  });

  it('shows the four metrics with their last-signal time', () => {
    expect(card('Active projects').textContent).toContain('1');
    expect(card('Active projects').textContent).toContain('Updated 12 s ago');
    expect(card('Agents working').textContent).toContain('Updated 12 s ago');
    expect(card('Tasks completed').textContent).toContain('4');
    expect(card('Tasks completed').textContent).toContain('last 15 min ago');
  });

  it('says how many usage reports the token number comes from', () => {
    const tokens = card('Token burn rate');
    expect(tokens.textContent).toContain('1,500');
    expect(tokens.textContent).toContain('From 3 usage reports in the last hour');
    expect(tokens.textContent).toContain('Updated 40 s ago');
  });

  it('renders every signal time as <time> with an exact UTC time', () => {
    const times = document.querySelectorAll('time');
    expect(times.length).toBeGreaterThan(5);
    for (const t of times) {
      expect(t.getAttribute('dateTime')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(t.getAttribute('title')).toMatch(/UTC$/);
      expect(t.textContent).toContain('UTC'); // visually hidden exact time for screen readers
    }
  });

  it('lists recent activity with tool name and shortened thread ref', () => {
    const items = within(region('Recent activity')).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('tool.completed · Edit');
    const ref = within(items[0]!).getByTitle(WORKING.threadRef);
    expect(ref.textContent).toContain('cc_0000000…');
  });

  it('shows project health with attention first and "No signal yet" for silent projects', () => {
    const items = within(region('Project health')).getAllByRole('listitem');
    expect(items.map((i) => within(i).getByRole('link').textContent)).toEqual([
      'Beta service',
      'Alpha app',
      'Gamma tool',
    ]);
    expect(items[2]!.textContent).toContain('No signal yet');
  });

  // The chart itself is covered by analytics-views.test.tsx (S4b).
  it('keeps the token chart card honest when no usage was passed', () => {
    expect(within(region('Token consumption')).getByText('No usage data yet')).toBeTruthy();
  });

  it('never calls a value live, nor the title of a card that holds values', () => {
    const values = [
      screen.getByRole('region', { name: 'Key metrics' }),
      ...['Recent activity', 'Project health', 'Agent squad'].map((n) =>
        region(n).querySelector('ol, ul')!,
      ),
    ];
    for (const v of values) expect(v.textContent).not.toMatch(LIVE);
    const titles = [...document.querySelectorAll('section h2, article h3')];
    expect(titles.length).toBeGreaterThanOrEqual(8);
    for (const t of titles) expect(t.textContent).not.toMatch(LIVE);
  });

  it('gives screen readers a short thread ref; the full ref stays in the title', () => {
    const ref = within(region('Recent activity')).getByTitle(WORKING.threadRef);
    expect(ref.textContent).not.toContain(WORKING.threadRef);
    expect(ref.querySelector('.sr-only')!.textContent).toBe('cc_00000');
  });
});

describe('Overview without usage reports or threads', () => {
  it('says "No usage reports in the last hour" instead of a measured zero', () => {
    render(
      <OverviewView
        snapshot={{
          ...SNAPSHOT,
          overview: {
            ...SNAPSHOT.overview,
            tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
          },
        }}
      />,
    );
    const tokens = card('Token burn rate');
    expect(tokens.textContent).toContain('No usage reports in the last hour');
    expect(tokens.textContent).not.toMatch(/\b0\b/);
  });

  it('keeps the empty states when the snapshot has no threads', () => {
    render(<OverviewView snapshot={EMPTY} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Your pack is waiting for its first signal.',
    );
    expect(screen.getAllByText('No signal yet')).toHaveLength(3);
    expect(card('Token burn rate').textContent).toContain('No usage reports in the last hour');
    expect(screen.getByText('No signals received')).toBeTruthy();
    expect(screen.getByText('No agents connected')).toBeTruthy();
    expect(screen.getByText('No projects yet')).toBeTruthy();
  });

  it('shows the honest empty page without any snapshot', () => {
    render(<OverviewView snapshot={null} />);
    expect(screen.getAllByText('No signal yet')).toHaveLength(4);
    expect(document.querySelectorAll('time')).toHaveLength(0);
  });
});

describe('ended threads never need attention', () => {
  const ended = { ...FRESH_ONLY, threads: [WORKING, ENDED_WAITING] };

  it('Overview: no attention headline and no squad entry for a waiting-then-ended thread', () => {
    render(<OverviewView snapshot={ended} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your pack is in motion.');
    const items = within(region('Agent squad')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('Alpha app');
  });

  it('Live agents: not counted, not sorted first, labelled "Ended" instead of "Waiting for you"', () => {
    render(<AgentsView snapshot={ended} inspector={null} />);
    expect(card('Need your attention').textContent).toContain('No thread is waiting for you');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Alpha app');
    expect(rows[1]!.textContent).toContain('Gamma tool');
    expect(rows[1]!.textContent).not.toContain('Waiting for you');
    expect(within(rows[1]!).getAllByText('Ended')).toHaveLength(2);
  });
});

describe('agent counts', () => {
  const noAgents = { ...FRESH_ONLY, threads: [thread({ agents: 0 })] };

  it('says "Not reported" instead of "0 agents" in the squad', () => {
    render(<OverviewView snapshot={noAgents} />);
    const item = within(region('Agent squad')).getByRole('listitem');
    expect(item.textContent).not.toMatch(/\b0 agents\b/);
    expect(item.textContent).toMatch(/not reported/i);
  });

  it('says "Not reported" instead of 0 in the thread monitor', () => {
    render(<AgentsView snapshot={noAgents} inspector={null} />);
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(within(row).getAllByRole('cell')[3]!.textContent).toBe('Not reported');
  });
});

describe('Live agents thread monitor', () => {
  const inspector = <div>Inspector</div>;

  it('lists attention first, with status, freshness, refs, tokens and last signal', () => {
    render(<AgentsView snapshot={SNAPSHOT} inspector={inspector} />);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows.map((r) => r.textContent ?? '');
    expect(first).toContain('Beta service');
    expect(first).toContain('Waiting for you');
    expect(first).toContain('Stale');
    expect(first).toContain('No usage reports');
    expect(second).toContain('Alpha app');
    expect(second).toContain('Fresh');
    expect(second).toContain('1,500');
    expect(third).toContain('Ended');
    expect(third).not.toContain('Stale');
    expect(within(rows[0]!).getByTitle(WAITING_STALE.threadRef).textContent).toContain(
      'cc_1111111…',
    );
    expect(within(rows[2]!).getByText(/1 h ago/)).toBeTruthy();
    expect(table.querySelector('tbody')!.textContent).not.toMatch(LIVE);
  });

  it('counts threads that need attention even when they went stale', () => {
    render(<AgentsView snapshot={SNAPSHOT} inspector={inspector} />);
    expect(card('Need your attention').textContent).toContain('1');
    expect(card('Need your attention').textContent).toContain('Stale');
    expect(card('Ended in 24 h').textContent).toContain('Ended');
  });

  it('keeps the empty state without threads', () => {
    render(<AgentsView snapshot={EMPTY} inspector={inspector} />);
    expect(screen.getByText('No threads connected')).toBeTruthy();
    expect(screen.getAllByText('No signal yet')).toHaveLength(4);
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Projects table', () => {
  const rows = [P_ALPHA, P_BETA, P_GAMMA].map((id, i) => ({
    id,
    name: ['Alpha app', 'Beta service', 'Gamma tool'][i]!,
    slug: ['alpha', 'beta', 'gamma'][i]!,
    platforms: ['claude-code'],
    privacyClass: 'L0',
    createdAt: '2026-10-20T08:00:00.000Z',
  }));

  it('adds freshness and last-signal columns from the snapshot', () => {
    render(<ProjectsTable rows={rows} snapshot={SNAPSHOT} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('Freshness');
    expect(headers).toContain('Last signal');
    const [alpha, beta, gamma] = screen.getAllByRole('row').slice(1);
    expect(alpha!.textContent).toContain('Fresh');
    expect(alpha!.querySelector('time')!.getAttribute('dateTime')).toBe(ago(12));
    expect(beta!.textContent).toContain('Stale');
    expect(beta!.textContent).toContain('1 waiting for you');
    expect(gamma!.textContent).toContain('No signal yet');
    expect(gamma!.querySelector('time')).toBeNull();
  });

  it('has a caption and a row header per project', () => {
    render(<ProjectsTable rows={rows} snapshot={SNAPSHOT} />);
    expect(screen.getByRole('table', { name: /projects/i })).toBeTruthy();
    expect(
      screen.getAllByRole('rowheader').map((h) => within(h).getByRole('link').textContent),
    ).toEqual(['Alpha app', 'Beta service', 'Gamma tool']);
  });

  it('says the freshness is not loaded when no snapshot is available', () => {
    render(<ProjectsTable rows={rows} snapshot={null} />);
    expect(screen.getAllByText('Not loaded').length).toBe(6);
  });
});

describe('refresh failures (ADR-0012)', () => {
  let visible: DocumentVisibilityState = 'visible';
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    visible = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible });
  });

  it('keeps the data and shows a "could not refresh" notice', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, ok: false, json: async () => ({}) })),
    );
    render(<OverviewDashboard initial={SNAPSHOT} />);
    expect(screen.getByRole('status').textContent).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('Could not refresh — showing data from 10:00:00 UTC');
    expect(notice.textContent).toContain('Trying again every 10\u00a0s while this tab is visible');
    expect(notice.querySelector('time')!.getAttribute('dateTime')).toBe(NOW);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'One thread needs your attention.',
    );
  });

  const hang = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  const failing = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, ok: false, json: async () => ({}) })),
    );
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it('stops calling values fresh while refreshes fail: "Not current", no activity headline', async () => {
    failing();
    render(<OverviewDashboard initial={FRESH_ONLY} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Your pack is in motion.');
    await advance(POLL_INTERVAL_MS);
    expect(screen.getByRole('status').textContent).toContain('Could not refresh');
    expect(document.body.textContent).not.toMatch(/Updated/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toMatch(/in motion/);
    const member = within(region('Agent squad')).getByRole('listitem');
    expect(member.textContent).toContain('Not current');
    expect(member.textContent).toContain('Last confirmed 09:59:48 UTC');
    expect(card('Active projects').textContent).toContain('Not current');
  });

  it('turns fresh pills into "Not current" in the thread monitor and projects table', async () => {
    failing();
    render(<AgentsDashboard initial={FRESH_ONLY} inspector={null} />);
    await advance(POLL_INTERVAL_MS);
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('Not current');
    expect(row.textContent).not.toContain('Fresh');
    cleanup();
    render(
      <ProjectsDashboard
        initial={FRESH_ONLY}
        rows={[
          {
            id: P_ALPHA,
            name: 'Alpha app',
            slug: 'alpha',
            platforms: ['claude-code'],
            privacyClass: 'L0',
            createdAt: '2026-10-20T08:00:00.000Z',
          },
        ]}
      />,
    );
    await advance(POLL_INTERVAL_MS);
    const projectRow = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(projectRow.textContent).toContain('Not current');
    expect(projectRow.textContent).not.toContain('Fresh');
  });

  it('ages values with the client clock even without new data', async () => {
    hang();
    render(<OverviewDashboard initial={FRESH_ONLY} />);
    const member = () => within(region('Agent squad')).getByRole('listitem').textContent;
    expect(member()).toContain('Updated 12 s ago');
    await advance(POLL_INTERVAL_MS);
    expect(member()).toContain('Updated 22 s ago');
  });

  it('shows a thread as stale once its client-side age passes 180 s (tab was hidden)', async () => {
    hang();
    render(<OverviewDashboard initial={FRESH_ONLY} />);
    act(() => {
      visible = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(10 * 60_000);
    act(() => {
      visible = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(screen.getByRole('status').textContent).toBe(''); // the refresh is still in flight
    const member = within(region('Agent squad')).queryByRole('listitem');
    expect(member).toBeNull(); // no fresh thread is left in the squad
    expect(screen.getByRole('heading', { level: 1 }).textContent).not.toMatch(/in motion/);
    expect(card('Active projects').textContent).not.toMatch(/Updated/);
    expect(document.body.textContent).not.toMatch(/Updated/);
  });

  it('times out a request that never settles after 8 s and polls again', async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<OverviewDashboard initial={FRESH_ONLY} />);
    await advance(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(8_000 - 1);
    expect(screen.getByRole('status').textContent).toBe('');
    await advance(1);
    expect(screen.getByRole('status').textContent).toContain('Could not refresh');
    await advance(POLL_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the sign-in prompt when the session ends', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })),
    );
    render(<OverviewDashboard initial={SNAPSHOT} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
    expect(screen.queryByText('Beta service')).toBeNull();
  });
});

describe('server pages', () => {
  it('Overview without a database renders the empty page and never reads', async () => {
    render(await OverviewPage());
    expect(screen.getAllByText('No signal yet')).toHaveLength(4);
    // Same guard as shell.test.tsx: no sample-looking numbers (product rule 4).
    expect(screen.queryByText(/\d+(\.\d+)?\s?(K\/s|%|M(?![a-z]))/)).toBeNull();
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('Overview signed out shows the sign-in prompt', async () => {
    state.db = {};
    render(await OverviewPage());
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it('Overview signed in renders the viewer’s snapshot', async () => {
    state.db = {};
    state.viewer = { workspaceId: WS };
    readSnapshot.mockResolvedValue(SNAPSHOT);
    render(await OverviewPage());
    expect(readSnapshot).toHaveBeenCalledWith(WS);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'One thread needs your attention.',
    );
  });

  it('Live agents signed in renders the thread monitor', async () => {
    state.db = {};
    state.viewer = { workspaceId: WS };
    readSnapshot.mockResolvedValue(SNAPSHOT);
    render(await AgentsPage());
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole('heading', { name: 'Thread inspector' })).toBeTruthy();
  });
});
