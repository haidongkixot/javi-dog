// @vitest-environment jsdom
import type { UsageAnalytics, UsageDay } from '@javis-dog/analytics';
import type { DashboardSnapshot } from '@javis-dog/realtime';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Usage analytics UI (TEST_PLAN §S4b, ADR-0013) with fixtures and an injected reader.
// Screenshot budget 0: role/name/DOM assertions only.

const state = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
const readUsage = vi.hoisted(() => vi.fn());
const readSnapshot = vi.hoisted(() => vi.fn());
const getViewerCalls = vi.hoisted(() => ({ n: 0 }));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => {
    getViewerCalls.n += 1;
    return state.viewer;
  },
}));
vi.mock('@/lib/auth', () => ({ getDb: () => state.db }));
vi.mock('@javis-dog/analytics', () => ({
  ANALYTICS_DEFAULT_DAYS: 14,
  createAnalyticsReader: () => ({ usage: readUsage }),
}));
vi.mock('@javis-dog/realtime', () => ({
  createDashboardReader: () => ({ snapshot: readSnapshot }),
}));
vi.mock('next/navigation', () => ({ notFound }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { UsageChart, axisLabels } = await import('@/components/analytics/usage-chart');
const { niceTicks, formatUsd } = await import('@/components/analytics/format');
const { OverviewUsage, ProjectUsage } = await import('@/components/analytics/usage-panels');
const { OverviewView } = await import('@/components/dashboard/overview-view');
const { default: OverviewPage } = await import('@/app/page');
const { default: ProjectPage } = await import('@/app/projects/[id]/page');

const NOW = '2026-10-28T10:00:00.000Z';
const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

const zero = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  reports: 0,
  estimatedReports: 0,
};

/** 14 UTC days, 15 Oct – 28 Oct 2026, zero-filled, with `over` applied by date. */
const days = (over: Record<string, Partial<UsageDay>> = {}): UsageDay[] =>
  Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 15 + i)).toISOString().slice(0, 10);
    return { date, ...zero, tasksCompleted: 0, tasksFailed: 0, ...over[date] };
  });

const usage = (d: UsageDay[], over: Partial<UsageAnalytics> = {}): UsageAnalytics => {
  const sum = (k: keyof typeof zero | 'tasksCompleted' | 'tasksFailed') =>
    d.reduce((s, x) => s + x[k], 0);
  const totals = {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    estimatedCostUsd: sum('estimatedCostUsd'),
    reports: sum('reports'),
    estimatedReports: sum('estimatedReports'),
    tasksCompleted: sum('tasksCompleted'),
    tasksFailed: sum('tasksFailed'),
  };
  return {
    generatedAt: NOW,
    from: d[0]!.date,
    to: d[d.length - 1]!.date,
    days: d,
    byModel: [],
    byProject: [],
    totals,
    lastReportAt: totals.reports > 0 ? '2026-10-28T08:00:00.000Z' : null,
    ...over,
  };
};

const ACTIVE_DAYS = days({
  '2026-10-16': { inputTokens: 1200, outputTokens: 300, estimatedCostUsd: 0.42, reports: 2 },
  '2026-10-27': {
    inputTokens: 9000,
    outputTokens: 1500,
    cacheReadTokens: 40000,
    estimatedCostUsd: 3.1,
    reports: 5,
    tasksCompleted: 3,
    tasksFailed: 1,
  },
  '2026-10-28': { inputTokens: 400, outputTokens: 4000, estimatedCostUsd: 0.004, reports: 1 },
});
const WEB_ID = '33333333-3333-4333-8333-333333333333';
const API_ID = '44444444-4444-4444-8444-444444444444';
const BY_PROJECT: UsageAnalytics['byProject'] = [
  {
    projectId: WEB_ID,
    slug: 'web-app',
    name: 'Web App',
    inputTokens: 10200,
    outputTokens: 5000,
    cacheReadTokens: 40000,
    cacheWriteTokens: 0,
    estimatedCostUsd: 3.5,
    reports: 6,
    estimatedReports: 0,
  },
  {
    projectId: API_ID,
    slug: 'api',
    name: 'API',
    inputTokens: 400,
    outputTokens: 800,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0.024,
    reports: 2,
    estimatedReports: 0,
  },
];
const ACTIVE = usage(ACTIVE_DAYS, {
  byProject: BY_PROJECT,
  byModel: [
    {
      model: 'claude-opus-5-5',
      inputTokens: 10200,
      outputTokens: 5500,
      cacheReadTokens: 40000,
      cacheWriteTokens: 1200,
      estimatedCostUsd: 3.52,
      reports: 7,
      estimatedReports: 0,
    },
    {
      model: null,
      inputTokens: 400,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.004,
      reports: 1,
      estimatedReports: 0,
    },
  ],
});
const EMPTY = usage(days());

const SNAPSHOT: DashboardSnapshot = {
  generatedAt: NOW,
  freshnessWindowMs: 180_000,
  windowHours: 24,
  overview: {
    activeProjects: { value: 0, lastSignalAt: null },
    agentsWorking: { value: 0, lastSignalAt: null },
    tasksCompleted24h: { value: 0, lastSignalAt: null },
    tokensLastHour: { value: 0, lastSignalAt: null, reports: 0 },
  },
  projects: [],
  threads: [],
  activity: [],
} as unknown as DashboardSnapshot;

const region = (name: string) => screen.getByRole('region', { name });

/**
 * Where a cost text gets its "estimated" label: a table cell from its column header, a
 * description-list value from its term, anything else from its own text.
 */
const costContext = (el: Element): string => {
  const cell = el.closest('td, th');
  const table = el.closest('table');
  if (cell && table && cell.closest('tbody')) {
    const index = [...cell.parentElement!.children].indexOf(cell);
    return table.querySelectorAll('thead th')[index]!.textContent ?? '';
  }
  const dd = el.closest('dd');
  if (dd) return dd.parentElement!.textContent ?? '';
  return el.textContent ?? '';
};

/** Every element whose own text mentions dollars or USD. */
const costElements = (root: Element) =>
  [root, ...root.querySelectorAll('*')].filter((el) =>
    [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && /\$|USD/.test(n.textContent ?? ''),
    ),
  );

beforeEach(() => {
  // The viewer's clock is pinned: usage times are compared with the client's UTC date.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.viewer = null;
  state.db = null;
  getViewerCalls.n = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('UsageChart', () => {
  it('draws one input and one output column for each of the 14 days', () => {
    const { container } = render(<UsageChart days={ACTIVE_DAYS} />);
    expect(container.querySelectorAll('[data-day]')).toHaveLength(14);
    expect(container.querySelectorAll('[data-series="input"]')).toHaveLength(14);
    expect(container.querySelectorAll('[data-series="output"]')).toHaveLength(14);
  });

  it('scales columns to their values and keeps days without reports at zero height', () => {
    const { container } = render(<UsageChart days={ACTIVE_DAYS} />);
    const height = (date: string, series: string) =>
      Number(
        container
          .querySelector(`[data-day="${date}"] [data-series="${series}"]`)!
          .getAttribute('data-height'),
      );
    expect(height('2026-10-27', 'input')).toBeGreaterThan(height('2026-10-16', 'input'));
    expect(height('2026-10-28', 'output')).toBeGreaterThan(height('2026-10-28', 'input'));
    expect(height('2026-10-15', 'input')).toBe(0);
    expect(height('2026-10-15', 'output')).toBe(0);
  });

  it('is an image with a summary label naming the UTC period and totals', () => {
    render(<UsageChart days={ACTIVE_DAYS} />);
    const img = screen.getByRole('img');
    const label = img.getAttribute('aria-label')!;
    expect(label).toContain('per UTC day');
    expect(label).toContain('14 days from 15 Oct 2026 to 28 Oct 2026');
    expect(label).toContain('10,600 input and 5,800 output tokens');
    expect(label).toContain('Busiest day 27 Oct 2026');
  });

  it('labels the axis with UTC dates and has a legend for both series', () => {
    const { container } = render(<UsageChart days={ACTIVE_DAYS} />);
    const axis = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    for (let d = 15; d <= 28; d++) expect(axis).toContain(String(d));
    expect(axis).toContain('Oct');
    expect(container.querySelector('[data-axis-title]')!.textContent).toBe('Date (UTC)');
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((l) => l.textContent),
    ).toEqual(['Input tokens (left)', 'Output tokens (right)']);
  });

  it('has a table equivalent with a caption, column headers and UTC row headers', () => {
    render(<UsageChart days={ACTIVE_DAYS} />);
    const table = screen.getByRole('table');
    expect(table.querySelector('caption')!.textContent).toBe(
      'Input and output tokens per UTC day, 15 Oct – 28 Oct 2026',
    );
    const cols = within(table).getAllByRole('columnheader');
    expect(cols.map((c) => c.textContent)).toEqual([
      'Date (UTC)',
      'Input tokens',
      'Output tokens',
      'Usage reports',
    ]);
    for (const c of cols) expect(c.getAttribute('scope')).toBe('col');
    const rows = within(table).getAllByRole('rowheader');
    expect(rows).toHaveLength(14);
    for (const r of rows) expect(r.getAttribute('scope')).toBe('row');
    // A day without reports reads "—", not a measured 0.
    const first = within(table).getAllByRole('row')[1]!;
    expect(first.textContent).toBe('15 Oct 2026——0');
  });
});

describe('axis and cost formatting', () => {
  it('picks clean whole-number ticks at or above the maximum', () => {
    expect(niceTicks(10_500)).toEqual({ top: 15_000, ticks: [5000, 10_000, 15_000] });
    expect(niceTicks(9000)).toEqual({ top: 10_000, ticks: [2500, 5000, 7500, 10_000] });
    expect(niceTicks(3)).toEqual({ top: 3, ticks: [1, 2, 3] });
    expect(niceTicks(10)).toEqual({ top: 10, ticks: [5, 10] });
  });

  it('never rounds a positive cost down to $0.00', () => {
    expect(formatUsd(0.004)).toBe('< $0.01');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });
});

describe('Overview "Token consumption"', () => {
  it('shows the chart, the period totals and when it was computed', () => {
    render(<OverviewView snapshot={SNAPSHOT} usage={{ kind: 'ready', usage: ACTIVE }} />);
    const card = region('Token consumption');
    expect(within(card).getByRole('img')).toBeTruthy();
    const totals = within(card)
      .getAllByRole('definition')
      .map((d) => d.textContent);
    expect(totals).toEqual(['10,600', '5,800', '$3.52']);
    expect(within(card).getByText('Estimated cost')).toBeTruthy();
    expect(card.textContent).toContain('Computed 10:00:00 UTC');
    expect(card.textContent).toContain('From 8 usage reports');
    const last = within(card).getByText(/Last usage report/);
    expect(last.textContent).toBe('Last usage report 08:00 UTC');
    expect(last.querySelector('time')!.getAttribute('title')).toBe('28 Oct 2026, 08:00:00 UTC');
  });

  it('shows the empty state instead of a chart of zeros when no usage was reported', () => {
    render(<OverviewView snapshot={SNAPSHOT} usage={{ kind: 'ready', usage: EMPTY }} />);
    const card = region('Token consumption');
    expect(within(card).getByText('No usage reports in the last 14 days')).toBeTruthy();
    expect(within(card).queryByRole('img')).toBeNull();
    expect(card.querySelector('svg, [data-day]')).toBeNull();
    expect(card.textContent).toContain('Computed 10:00:00 UTC');
    expect(card.textContent).not.toMatch(/\$/);
  });

  it('says when usage could not be loaded', () => {
    render(<OverviewView snapshot={SNAPSHOT} usage={{ kind: 'unavailable' }} />);
    expect(within(region('Token consumption')).getByText('Usage could not be loaded')).toBeTruthy();
  });

  it('keeps an honest empty state without usage data', () => {
    render(<OverviewView snapshot={null} />);
    const card = region('Token consumption');
    expect(within(card).getByText('No usage data yet')).toBeTruthy();
    expect(within(card).queryByRole('img')).toBeNull();
  });
});

describe('cost is always labelled "estimated"', () => {
  it.each([
    ['Overview', () => render(<OverviewUsage load={{ kind: 'ready', usage: ACTIVE }} />)],
    ['Project', () => render(<ProjectUsage load={{ kind: 'ready', usage: ACTIVE }} />)],
  ])('%s: every text with "$" or "USD" has an estimated label', (_, draw) => {
    const { container } = draw();
    const found = costElements(container);
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const el of found) expect(costContext(el)).toMatch(/estimated/i);
  });

  it('guard self-test: an unlabelled cost is caught', () => {
    const { container } = render(
      <div>
        <p>Cost $3.52</p>
      </div>,
    );
    const found = costElements(container);
    expect(found).toHaveLength(1);
    expect(costContext(found[0]!)).not.toMatch(/estimated/i);
  });
});

describe('Project usage', () => {
  it('lists usage by model with an estimated-cost column and a label for unknown models', () => {
    render(<ProjectUsage load={{ kind: 'ready', usage: ACTIVE }} />);
    const table = screen.getAllByRole('table').find((t) => /per model/.test(t.textContent!))!;
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual([
      'Model',
      'Input tokens',
      'Output tokens',
      'Cache read',
      'Cache write',
      'Estimated cost (USD)',
      'Reports',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toBe('claude-opus-5-510,2005,50040,0001,200$3.527');
    // Under a cent is not rounded down to a measured "$0.00".
    expect(rows[1]!.textContent).toBe('Model not reported40030000< $0.011');
  });

  it('shows task outcomes for the period', () => {
    render(<ProjectUsage load={{ kind: 'ready', usage: ACTIVE }} />);
    expect(screen.getByRole('heading', { name: 'Task outcomes' })).toBeTruthy();
    const terms = screen.getAllByRole('term').map((t) => t.parentElement!.textContent);
    expect(terms).toContain('Tasks completed3');
    expect(terms).toContain('Tasks failed1');
  });

  it('shows the empty state but keeps task outcomes when no usage was reported', () => {
    const quiet = usage(days({ '2026-10-20': { tasksCompleted: 2 } }));
    render(<ProjectUsage load={{ kind: 'ready', usage: quiet }} />);
    expect(screen.getByText('No usage reports in the last 14 days')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Usage by model' })).toBeNull();
    expect(screen.getByText('Tasks completed').parentElement!.textContent).toBe('Tasks completed2');
  });
});

describe('server pages', () => {
  it('Overview reads usage for the viewer’s workspace with one session lookup', async () => {
    state.db = {};
    state.viewer = { workspaceId: WS };
    readSnapshot.mockResolvedValue(SNAPSHOT);
    readUsage.mockResolvedValue(ACTIVE);
    render(await OverviewPage());
    expect(readUsage).toHaveBeenCalledExactlyOnceWith(WS, { days: 14 });
    expect(readSnapshot).toHaveBeenCalledWith(WS);
    expect(getViewerCalls.n).toBe(1);
    expect(within(region('Token consumption')).getByRole('img')).toBeTruthy();
  });

  it('Overview without a database never reads usage', async () => {
    render(await OverviewPage());
    expect(readUsage).not.toHaveBeenCalled();
    expect(getViewerCalls.n).toBe(0);
  });

  it('Project detail reads usage only for the project scoped to the viewer’s workspace', async () => {
    state.db = {};
    const getProject = vi.fn(async () => ({ id: PROJECT, name: 'Alpha app', description: null }));
    state.viewer = {
      workspaceId: WS,
      projects: { getProject, listTokens: vi.fn(async () => []) },
    };
    readUsage.mockResolvedValue(ACTIVE);
    render(await ProjectPage({ params: Promise.resolve({ id: PROJECT }) }));
    expect(getProject).toHaveBeenCalledWith(WS, PROJECT);
    // The project page never shows usage by project, so it does not query it.
    expect(readUsage).toHaveBeenCalledExactlyOnceWith(WS, {
      days: 14,
      projectId: PROJECT,
      include: { byProject: false },
    });
    const card = region('Usage (last 14 days)');
    expect(within(card).getByRole('img')).toBeTruthy();
    expect(within(card).getByRole('heading', { name: 'Usage by model' })).toBeTruthy();
  });

  it('Project detail of another workspace is not found and reads no usage', async () => {
    state.db = {};
    state.viewer = {
      workspaceId: WS,
      projects: { getProject: vi.fn(async () => null), listTokens: vi.fn() },
    };
    await expect(ProjectPage({ params: Promise.resolve({ id: PROJECT }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(readUsage).not.toHaveBeenCalled();
  });
});

describe('usage times on a page left open (product rule 2)', () => {
  const at = (generatedAt: string, lastReportAt: string): UsageAnalytics => ({
    ...ACTIVE,
    generatedAt,
    lastReportAt,
  });
  const lastText = () => screen.getByText(/Last usage report/).textContent;
  const computedText = () => screen.getByText(/^Computed/).textContent;

  it('3 h after the read, the last report shows its absolute time, never a stale "ago"', () => {
    vi.setSystemTime('2026-10-28T13:00:00.000Z');
    const u = at('2026-10-28T10:00:00.000Z', '2026-10-28T09:58:00.000Z');
    const { container } = render(<OverviewUsage load={{ kind: 'ready', usage: u }} />);
    expect(lastText()).toBe('Last usage report 09:58 UTC');
    expect(container.textContent).not.toMatch(/\bago\b/);
    expect(computedText()).toBe('Computed 10:00:00 UTC');
  });

  it('a read from a previous UTC date shows that date', () => {
    vi.setSystemTime('2026-10-29T01:00:00.000Z');
    render(
      <OverviewUsage
        load={{ kind: 'ready', usage: at('2026-10-28T23:30:00.000Z', '2026-10-28T23:28:00.000Z') }}
      />,
    );
    expect(computedText()).toBe('Computed 28 Oct 2026, 23:30:00 UTC');
    expect(lastText()).toBe('Last usage report 28 Oct 2026, 23:28 UTC');
  });

  it('a last report from an earlier day shows its date even when computed today', () => {
    render(<ProjectUsage load={{ kind: 'ready', usage: at(NOW, '2026-10-26T08:05:00.000Z') }} />);
    expect(lastText()).toBe('Last usage report 26 Oct 2026, 08:05 UTC');
    expect(computedText()).toBe('Computed 10:00:00 UTC');
  });

  it('re-renders on the client clock: after UTC midnight the date appears', () => {
    vi.useRealTimers();
    vi.useFakeTimers({ now: new Date('2026-10-28T23:59:30.000Z') });
    render(
      <OverviewUsage
        load={{ kind: 'ready', usage: at('2026-10-28T23:50:00.000Z', '2026-10-28T23:45:00.000Z') }}
      />,
    );
    expect(computedText()).toBe('Computed 23:50:00 UTC');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(computedText()).toBe('Computed 28 Oct 2026, 23:50:00 UTC');
    expect(lastText()).toBe('Last usage report 28 Oct 2026, 23:45 UTC');
  });

  it('the server render always carries the date (no client clock yet, no hydration guess)', () => {
    const html = renderToStaticMarkup(<OverviewUsage load={{ kind: 'ready', usage: ACTIVE }} />);
    expect(html).toContain('28 Oct 2026, 10:00:00 UTC');
    expect(html).toContain('28 Oct 2026, 08:00 UTC');
    expect(html).not.toMatch(/\bago\b/);
  });
});

describe('estimated token counts', () => {
  const NOTE = 'Includes estimated token counts (3 of 8 reports)';
  const EST: UsageAnalytics = { ...ACTIVE, totals: { ...ACTIVE.totals, estimatedReports: 3 } };

  it('Overview: says so next to the totals and in the daily table caption', () => {
    const { container } = render(<OverviewUsage load={{ kind: 'ready', usage: EST }} />);
    const note = screen.getByText(NOTE, { selector: 'p' });
    expect(note.previousElementSibling!.tagName).toBe('DL');
    const caption = [...container.querySelectorAll('caption')].find((c) =>
      /per UTC day/.test(c.textContent!),
    )!;
    expect(caption.textContent).toContain(NOTE);
  });

  it('Project: says so next to the totals and in the by-model caption', () => {
    const { container } = render(<ProjectUsage load={{ kind: 'ready', usage: EST }} />);
    expect(screen.getByText(NOTE, { selector: 'p' })).toBeTruthy();
    const caption = [...container.querySelectorAll('caption')].find((c) =>
      /per model/.test(c.textContent!),
    )!;
    expect(caption.textContent).toContain(NOTE);
  });

  it('says nothing when every count is exact', () => {
    const { container } = render(<ProjectUsage load={{ kind: 'ready', usage: ACTIVE }} />);
    expect(container.textContent).not.toMatch(/estimated token counts/i);
  });
});

describe('chart labels', () => {
  /** 14 UTC days from 31 Oct 2026, with input/output on day `peakDay`. */
  const fromOct31 = (peakDay: number): UsageDay[] =>
    Array.from({ length: 14 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 9, 31 + i)).toISOString().slice(0, 10);
      const base = { date, ...zero, tasksCompleted: 0, tasksFailed: 0 };
      if (i === peakDay) return { ...base, inputTokens: 5000, outputTokens: 100, reports: 1 };
      if (i === 6) return { ...base, inputTokens: 100, outputTokens: 50, reports: 1 };
      return base;
    });
  const slot = 100 / 14;

  it('skips a month label in the slot directly before another month label', () => {
    const l = axisLabels(fromOct31(0));
    expect(l.months).toEqual([{ index: 1, text: 'Nov' }]);
    // A range that only crosses a month keeps both labels.
    expect(axisLabels(ACTIVE_DAYS).months).toEqual([{ index: 0, text: 'Oct' }]);
    const crossing = days().map((d, i) => ({
      ...d,
      date: new Date(Date.UTC(2026, 9, 25 + i)).toISOString().slice(0, 10),
    }));
    expect(axisLabels(crossing).months).toEqual([
      { index: 0, text: 'Oct' },
      { index: 7, text: 'Nov' },
    ]);
  });

  it('keeps a peak on day 0 inside the plot (start-anchored at its column, x ≥ 0)', () => {
    const { peak } = axisLabels(fromOct31(0));
    expect(peak).toMatchObject({ index: 0, series: 'input', value: 5000, anchor: 'start' });
    expect(peak!.x).toBeGreaterThanOrEqual(0);
    expect(peak!.x).toBeCloseTo(0.18 * slot, 6);
  });

  it('end-anchors a peak on the last day and centres one in between', () => {
    expect(axisLabels(fromOct31(13)).peak).toMatchObject({ index: 13, anchor: 'end' });
    expect(axisLabels(fromOct31(13)).peak!.x).toBeLessThanOrEqual(100);
    const mid = axisLabels(ACTIVE_DAYS).peak!;
    expect(mid).toMatchObject({ index: 12, series: 'input', value: 9000, anchor: 'middle' });
    expect(mid.x).toBeCloseTo((12 + 0.18 + 0.15) * slot, 6);
  });

  it('renders those placements: one month label, the peak start-anchored', () => {
    const { container } = render(<UsageChart days={fromOct31(0)} />);
    expect([...container.querySelectorAll('[data-month]')].map((t) => t.textContent)).toEqual([
      'Nov',
    ]);
    const peak = container.querySelector('[data-peak]')!;
    expect(peak.textContent).toBe('5K');
    expect(peak.getAttribute('text-anchor')).toBe('start');
    expect(Number.parseFloat(peak.getAttribute('x')!)).toBeGreaterThanOrEqual(0);
  });
});

describe('series identity and hover', () => {
  it('the legend states the column order within a day', () => {
    render(<UsageChart days={ACTIVE_DAYS} />);
    const items = within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Input tokens (left)',
      'Output tokens (right)',
    ]);
  });

  it('hover outlines a column in ink instead of fading it', () => {
    const { container } = render(<UsageChart days={ACTIVE_DAYS} />);
    const columns = [...container.querySelectorAll('[data-series]')];
    expect(columns).toHaveLength(28);
    for (const c of columns) {
      expect(c.getAttribute('class')).not.toMatch(/opacity/);
      expect(c.getAttribute('class')).toMatch(/group-hover:stroke-ink/);
    }
  });
});

describe('usage by project (Overview)', () => {
  it('lists projects with links, tokens and estimated cost when ≥ 2 projects have usage', () => {
    render(<OverviewView snapshot={SNAPSHOT} usage={{ kind: 'ready', usage: ACTIVE }} />);
    const card = region('Token consumption');
    expect(
      within(card).getByRole('heading', { name: 'Usage by project (last 14 days)' }),
    ).toBeTruthy();
    const table = within(card)
      .getAllByRole('table')
      .find((t) => /per project/.test(t.querySelector('caption')!.textContent!))!;
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Project', 'Input tokens', 'Output tokens', 'Estimated cost (USD)']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['Web App10,2005,000$3.50', 'API400800$0.02']);
    expect(within(table).getByRole('link', { name: 'Web App' }).getAttribute('href')).toBe(
      `/projects/${WEB_ID}`,
    );
    expect(within(table).getByRole('link', { name: 'API' }).getAttribute('href')).toBe(
      `/projects/${API_ID}`,
    );
  });

  it('is left out with a single project', () => {
    const one = { ...ACTIVE, byProject: BY_PROJECT.slice(0, 1) };
    render(<OverviewUsage load={{ kind: 'ready', usage: one }} />);
    expect(screen.queryByRole('heading', { name: /Usage by project/ })).toBeNull();
  });

  it('is never shown on the project page', () => {
    render(<ProjectUsage load={{ kind: 'ready', usage: ACTIVE }} />);
    expect(screen.queryByRole('heading', { name: /Usage by project/ })).toBeNull();
  });
});
