// @vitest-environment jsdom
import type { ActivityItem, DashboardSnapshot, ThreadState } from '@javis-dog/realtime';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { atClientTime } from '@/components/dashboard/aging';
import { AgentsView } from '@/components/dashboard/agents-view';
import { OverviewView } from '@/components/dashboard/overview-view';

// TEST_PLAN §S5g rows "Dashboard: GitHub threads labelled with their source, never as agents"
// and "D0: GitHub threads … stay out of the squad, agents-working and agent-task counts, and
// have separate CI/PR counts" (ADR-0019 decision 6, D0 M1), component layer. The snapshot is
// what the JD-M07 reader returns for bridge threads (source `github`, no status). Screenshot
// budget 0: text and roles only.

const NOW = '2026-11-01T12:00:00.000Z';
const ago = (s: number) => new Date(Date.parse(NOW) - s * 1000).toISOString();
const P = '22222222-2222-4222-8222-222222222222';

const base = (over: Partial<ThreadState>): ThreadState => ({
  projectId: P,
  projectSlug: 'web-app',
  projectName: 'Web App',
  threadRef: 'cc_0000000000000000000000000000aaaa',
  source: 'agent',
  githubKind: null,
  status: 'working',
  statusSource: 'collector',
  statusReason: null,
  lastType: 'heartbeat',
  firstSignalAt: ago(3600),
  lastSignalAt: ago(12),
  freshness: 'fresh',
  attention: false,
  needsAttention: false,
  agents: 1,
  tasksCompleted: 2,
  inputTokens: 0,
  outputTokens: 0,
  identity: null,
  ...over,
});

/** A bridge thread as the reader returns it: no status, never attention, no agent tasks. */
const gh = (over: Partial<ThreadState>): ThreadState =>
  base({
    source: 'github',
    status: null,
    agents: 0,
    tasksCompleted: 0,
    ...over,
  });

const AGENT = base({});
const CI_RUNNING = gh({
  threadRef: 'gh_1bc5aa12a165e0980828c6303598c7f1',
  githubKind: 'ci',
  lastType: 'task.started',
  lastSignalAt: ago(30),
});
const CI_FAILED = gh({
  threadRef: 'gh_b92fd9c91f9d3f6ca725c3398cf1d71b',
  githubKind: 'ci',
  lastType: 'task.failed',
  lastSignalAt: ago(240),
  freshness: 'ended',
});
const PR_OPEN = gh({
  threadRef: 'gh_d77472d6d132fd3dda134cc7cd2a1d60',
  githubKind: 'pr',
  lastType: 'x.github.pr.opened',
  lastSignalAt: ago(600),
  freshness: 'stale',
});
const PR_MERGED = gh({
  threadRef: 'gh_8cd68c4910004fcb09f0ab33adaec754',
  githubKind: 'pr',
  lastType: 'x.github.pr.merged',
  lastSignalAt: ago(1200),
  freshness: 'ended',
});
const GITHUB = [CI_RUNNING, CI_FAILED, PR_OPEN, PR_MERGED];

const item = (t: ThreadState, type: string, at: string, toolName: string | null): ActivityItem => ({
  at,
  projectSlug: t.projectSlug,
  threadRef: t.threadRef,
  type,
  status: t.source === 'github' ? null : 'working',
  toolName,
  statusSource: 'collector',
  statusReason: null,
});

const SNAPSHOT: DashboardSnapshot = {
  generatedAt: NOW,
  freshnessWindowMs: 180_000,
  windowHours: 24,
  overview: {
    activeProjects: { value: 1, lastSignalAt: ago(12) },
    agentsWorking: { value: 1, lastSignalAt: ago(12) },
    tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
    tasksCompleted24h: { value: 2, lastSignalAt: ago(100) },
  },
  github: {
    ciRunning: { value: 1, lastSignalAt: ago(30) },
    ciNoResult: { value: 0, lastSignalAt: null },
    ciFailed24h: { value: 1, lastSignalAt: ago(240) },
    prsOpen: { value: 1, lastSignalAt: ago(600) },
  },
  threads: [CI_RUNNING, AGENT, CI_FAILED, PR_OPEN, PR_MERGED],
  activity: [
    item(AGENT, 'heartbeat', ago(12), null),
    item(CI_RUNNING, 'task.started', ago(30), 'github-actions'),
    item(CI_FAILED, 'task.failed', ago(240), 'github-actions'),
    item(PR_OPEN, 'x.github.pr.opened', ago(600), null),
  ],
  projects: [
    {
      id: P,
      slug: 'web-app',
      name: 'Web App',
      lastSignalAt: ago(12),
      freshness: 'fresh',
      freshThreads: 2,
      attentionThreads: 0,
    },
  ],
};

const region = (name: string) => screen.getByRole('region', { name });
const GITHUB_WORDS = /GitHub/;

afterEach(cleanup);

describe('Overview with GitHub threads', () => {
  it('keeps GitHub threads out of the agent squad', () => {
    render(<OverviewView snapshot={SNAPSHOT} />);
    const squad = region('Agent squad');
    const items = within(squad).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(within(squad).getByTitle(AGENT.threadRef)).toBeTruthy();
    expect(squad.textContent).not.toMatch(GITHUB_WORDS);
    for (const t of GITHUB) expect(within(squad).queryByTitle(t.threadRef)).toBeNull();
  });

  it('labels GitHub signals "GitHub CI" or "GitHub PR" in recent activity, agents unlabelled', () => {
    render(<OverviewView snapshot={SNAPSHOT} />);
    const items = within(region('Recent activity')).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).not.toMatch(GITHUB_WORDS);
    expect(items[1]!.textContent).toContain('GitHub CI · task.started · github-actions');
    expect(items[2]!.textContent).toContain('GitHub CI · task.failed');
    expect(items[3]!.textContent).toContain('GitHub PR · x.github.pr.opened');
    // A GitHub signal carries no status pill and no agent count.
    for (const li of items.slice(1)) {
      expect(li.textContent).not.toMatch(/Working|agent/);
    }
  });

  it('shows the CI and PR counts on their own card, each with its last delivery', () => {
    render(<OverviewView snapshot={SNAPSHOT} />);
    const card = region('GitHub CI and pull requests');
    const rows = within(card).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'CI runs in progressLast delivery 30 s ago (1 Nov 2026, 11:59:30 UTC)1',
      'CI runs failedLast delivery 4 min ago (1 Nov 2026, 11:56:00 UTC)1',
      'Open pull requestsLast delivery 10 min ago (1 Nov 2026, 11:50:00 UTC)1',
    ]);
    expect(card.textContent).toContain('counted apart from your agents');
    expect(card.textContent).toContain('GitHub sends no heartbeat');
    // The agent counters stay the reader's agent-only values.
    const agentsWorking = screen
      .getByRole('heading', { name: 'Agents working' })
      .closest('article');
    expect(agentsWorking!.textContent).toContain('1');
  });

  it('never calls a GitHub value live or connected', () => {
    render(<OverviewView snapshot={SNAPSHOT} />);
    const github = [
      region('GitHub CI and pull requests'),
      ...within(region('Recent activity'))
        .getAllByRole('listitem')
        .filter((li) => GITHUB_WORDS.test(li.textContent ?? '')),
    ];
    expect(github).toHaveLength(4);
    for (const el of github) expect(el.textContent).not.toMatch(/\blive\b|\bconnected\b/i);
  });

  it('with only GitHub threads: no agent in the squad and a quiet pack', () => {
    render(
      <OverviewView
        snapshot={{
          ...SNAPSHOT,
          overview: { ...SNAPSHOT.overview, agentsWorking: { value: 0, lastSignalAt: null } },
          threads: GITHUB,
          activity: [],
        }}
      />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Your pack is quiet right now.',
    );
    expect(region('Agent squad').textContent).toContain('No agents connected');
    expect(region('GitHub CI and pull requests')).toBeTruthy();
  });

  it('renders no GitHub card when no GitHub thread is in the window', () => {
    render(<OverviewView snapshot={{ ...SNAPSHOT, threads: [AGENT] }} />);
    expect(screen.queryByRole('region', { name: 'GitHub CI and pull requests' })).toBeNull();
  });
});

describe('Live agents with GitHub threads', () => {
  it('keeps GitHub threads out of the thread monitor and the thread metrics', () => {
    render(<AgentsView snapshot={SNAPSHOT} inspector={null} />);
    const monitor = region('Thread monitor');
    const rows = within(monitor).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(monitor.textContent).not.toMatch(GITHUB_WORDS);
    const metrics = screen.getByRole('region', { name: 'Thread metrics' });
    const fresh = within(metrics)
      .getByRole('heading', { name: 'Fresh threads' })
      .closest('article');
    expect(fresh!.textContent).toMatch(/^Fresh threads1/);
    const ended = within(metrics)
      .getByRole('heading', { name: 'Ended in 24 h' })
      .closest('article');
    expect(ended!.textContent).toMatch(/^Ended in 24 h0/);
  });

  it('lists GitHub threads in their own table, labelled by source with their GitHub result', () => {
    render(<AgentsView snapshot={SNAPSHOT} inspector={null} />);
    const table = screen.getByRole('table', { name: 'GitHub threads' });
    const rows = within(table).getAllByRole('row').slice(1);
    const cells = rows.map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent));
    expect(cells.map((c) => [c[0], c[1], c[3], c[4]])).toEqual([
      ['GitHub CI', 'Web App', 'In progress', 'Fresh'],
      ['GitHub CI', 'Web App', 'Failed', 'Ended'],
      ['GitHub PR', 'Web App', 'Open', 'Stale'],
      ['GitHub PR', 'Web App', 'Merged', 'Ended'],
    ]);
    // Never an agent count, an agent status or an agent label in a GitHub row.
    expect(table.textContent).not.toMatch(/agent|Working|Waiting for you|No status sent/i);
  });

  it('shows the monitor empty state when only GitHub threads exist', () => {
    render(<AgentsView snapshot={{ ...SNAPSHOT, threads: GITHUB }} inspector={null} />);
    expect(region('Thread monitor').textContent).toContain('No threads connected');
    expect(screen.getByRole('table', { name: 'GitHub threads' })).toBeTruthy();
  });
});

describe('Client-side ageing', () => {
  it('never counts a GitHub thread as an agent working, even one that carried a status', () => {
    const odd = gh({ threadRef: 'gh_00000000000000000000000000000009', status: 'working' });
    const s = atClientTime(
      { ...SNAPSHOT, threads: [AGENT, odd] },
      new Date(Date.parse(NOW) + 1000).toISOString(),
    );
    expect(s.overview.agentsWorking.value).toBe(1);
    expect(s.github).toEqual(SNAPSHOT.github);
  });
});

// TEST_PLAN §S5h row 2 (ADR-0019 Changes "S5h decisions"): a CI thread whose newest event is
// `task.started` and whose last delivery is more than 6 h old reads "No result received" in the
// GitHub table and on the overview card; never "Failed", "In progress", "live" or "connected".
describe('No result received (S5h)', () => {
  const HOUR = 3600;
  const CI_NO_RESULT = gh({
    threadRef: 'gh_0000000000000000000000000000ab01',
    githubKind: 'ci',
    lastType: 'task.started',
    firstSignalAt: ago(7 * HOUR),
    lastSignalAt: ago(6 * HOUR + 60),
    freshness: 'stale',
  });
  const LOST: DashboardSnapshot = {
    ...SNAPSHOT,
    github: {
      ...SNAPSHOT.github,
      ciNoResult: { value: 1, lastSignalAt: CI_NO_RESULT.lastSignalAt },
    },
    threads: [...SNAPSHOT.threads, CI_NO_RESULT],
  };
  const NOT_ALLOWED = /\bFailed\b|In progress|\blive\b|\bconnected\b/i;

  const rowOf = (ref: string) => {
    const table = screen.getByRole('table', { name: 'GitHub threads' });
    const row = within(table)
      .getAllByRole('row')
      .find((r) => r.querySelector(`[title="${ref}"]`));
    if (!row) throw new Error(`row ${ref} missing`);
    return [...row.querySelectorAll('th, td')].map((c) => c.textContent);
  };

  it('labels the run "No result received" in the GitHub table and explains it', () => {
    render(<AgentsView snapshot={LOST} inspector={null} />);
    const cells = rowOf(CI_NO_RESULT.threadRef);
    expect([cells[0], cells[3], cells[4]]).toEqual(['GitHub CI', 'No result received', 'Stale']);
    expect(cells.join(' ')).not.toMatch(NOT_ALLOWED);
    // The last signal stays as it was: when the last delivery came.
    expect(cells[5]).toContain('6 h ago');
    const card = region('GitHub CI and pull requests');
    expect(card.textContent).toContain(
      'No result received: GitHub sent no result within 6 h of the run’s last delivery.',
    );
    expect(card.textContent).toContain('GitHub sends no heartbeat');
    // The run that is still within 6 h keeps "In progress".
    expect(rowOf(CI_RUNNING.threadRef)[3]).toBe('In progress');
  });

  it('shows the count on the overview card with its last delivery, apart from runs in progress', () => {
    render(<OverviewView snapshot={LOST} />);
    const card = region('GitHub CI and pull requests');
    const rows = within(card).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'CI runs in progressLast delivery 30 s ago (1 Nov 2026, 11:59:30 UTC)1',
      'CI runs with no result receivedLast delivery 6 h ago (1 Nov 2026, 05:59:00 UTC)1',
      'CI runs failedLast delivery 4 min ago (1 Nov 2026, 11:56:00 UTC)1',
      'Open pull requestsLast delivery 10 min ago (1 Nov 2026, 11:50:00 UTC)1',
    ]);
    expect(card.textContent).toContain('GitHub sends no heartbeat');
    expect(card.textContent).toContain('No result received: GitHub sent no result within 6 h');
    expect(card.textContent).not.toMatch(/\blive\b|\bconnected\b/i);
    expect(rows[1]!.textContent).not.toMatch(NOT_ALLOWED);
  });

  it('shows no such row or note when every started run is within 6 h', () => {
    render(<OverviewView snapshot={SNAPSHOT} />);
    const card = region('GitHub CI and pull requests');
    expect(card.textContent).not.toContain('No result received');
  });

  it('a run that crosses 6 h while the browser ages the snapshot moves to no result received', () => {
    const almost = gh({
      threadRef: 'gh_0000000000000000000000000000ab02',
      githubKind: 'ci',
      lastType: 'task.started',
      lastSignalAt: ago(6 * HOUR - 30),
      freshness: 'stale',
    });
    const before: DashboardSnapshot = {
      ...SNAPSHOT,
      github: {
        ...SNAPSHOT.github,
        ciRunning: { value: 2, lastSignalAt: ago(30) },
      },
      threads: [CI_RUNNING, almost, AGENT, CI_FAILED, PR_OPEN, PR_MERGED],
    };
    // 29 s later: still within 6 h, nothing moves.
    const early = atClientTime(before, new Date(Date.parse(NOW) + 29_000).toISOString());
    expect(early.github).toEqual(before.github);
    // 31 s later: more than 6 h since its last delivery.
    const later = atClientTime(before, new Date(Date.parse(NOW) + 31_000).toISOString());
    expect(later.github).toEqual({
      ...before.github,
      ciRunning: { value: 1, lastSignalAt: ago(30) },
      ciNoResult: { value: 1, lastSignalAt: almost.lastSignalAt },
    });
    render(<AgentsView snapshot={later} inspector={null} />);
    expect(rowOf(almost.threadRef)[3]).toBe('No result received');
    expect(rowOf(CI_RUNNING.threadRef)[3]).toBe('In progress');
  });

  it('a snapshot from an older deployment without ciNoResult renders and ages (review L4)', () => {
    const older: Partial<DashboardSnapshot['github']> = { ...SNAPSHOT.github };
    delete older.ciNoResult;
    const legacy = { ...SNAPSHOT, github: older } as unknown as DashboardSnapshot;
    render(<OverviewView snapshot={legacy} />);
    expect(region('GitHub CI and pull requests').textContent).not.toContain('No result received');
    cleanup();
    const almost = gh({
      threadRef: 'gh_0000000000000000000000000000ab03',
      githubKind: 'ci',
      lastType: 'task.started',
      lastSignalAt: ago(6 * HOUR - 30),
      freshness: 'stale',
    });
    const aged = atClientTime(
      { ...legacy, threads: [...legacy.threads, almost] },
      new Date(Date.parse(NOW) + 31_000).toISOString(),
    );
    expect(aged.github.ciNoResult).toEqual({ value: 1, lastSignalAt: almost.lastSignalAt });
  });
});
