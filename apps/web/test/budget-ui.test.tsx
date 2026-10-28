// @vitest-environment jsdom
import type { BudgetStatus } from '@javis-dog/resilience';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Budget UI (TEST_PLAN §S4c, ADR-0014): server actions with a fake JD-M12 repository, the
// loaders, the Project detail budget card and the Projects list column. Screenshot budget 0:
// role/name/DOM assertions only.

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-10-20T12:00:00.000Z';

const state = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
const store = vi.hoisted(() => ({
  status: vi.fn(),
  statuses: vi.fn(),
  setBudget: vi.fn(),
  clearBudget: vi.fn(),
}));
const projects = vi.hoisted(() => ({
  getProject: vi.fn(),
  listTokens: vi.fn(),
  listProjects: vi.fn(),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('@/lib/viewer', async (orig) => ({
  ...(await orig<typeof import('@/lib/viewer')>()),
  getViewer: async () => state.viewer,
}));
vi.mock('@/lib/auth', () => ({ getDb: () => state.db }));
vi.mock('@javis-dog/resilience', async (orig) => ({
  ...(await orig<typeof import('@javis-dog/resilience')>()),
  createBudgetRepository: () => store,
}));
vi.mock('@javis-dog/analytics', () => ({
  ANALYTICS_DEFAULT_DAYS: 14,
  createAnalyticsReader: () => ({
    usage: async () => {
      throw new Error('not under test');
    },
  }),
}));
vi.mock('@javis-dog/realtime', () => ({
  createDashboardReader: () => ({
    snapshot: async () => {
      throw new Error('not under test');
    },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath }));
vi.mock('next/navigation', () => ({ notFound }));

const { setBudgetAction, clearBudgetAction } = await import('@/app/projects/actions');
const { budgetLimitSchema, canManageBudget, loadBudget, loadBudgets } =
  await import('@/lib/budgets');
const { BudgetCard, ALERT_RECIPIENTS_TEXT } = await import('@/components/budget/budget-card');
const { BudgetCell, toBudgetCell } = await import('@/components/budget/budget-cell');
const { ProjectsTable } = await import('@/components/dashboard/projects-table');
// The real JD-M12 arithmetic (the mock above only replaces the repository).
const { crossedThreshold } = await import('@javis-dog/resilience');
const { default: ProjectPage } = await import('@/app/projects/[id]/page');
const { default: ProjectsPage } = await import('@/app/projects/page');

/** A status; `thresholdReached` follows spend and limit (exact) unless given. */
const status = (over: Partial<BudgetStatus> = {}): BudgetStatus => {
  const s = {
    projectId: PROJECT,
    limitUsd: 10,
    month: '2026-10',
    spendUsd: 6.2,
    percentUsed: 62,
    forecastUsd: 9.61,
    reports: 9,
    estimatedReports: 0,
    alerted: [],
    pendingAlerts: [],
    failedAlerts: [],
    exhaustedAlerts: [],
    generatedAt: NOW,
    ...over,
  };
  return {
    thresholdReached: s.limitUsd === null ? null : crossedThreshold(s.spendUsd, s.limitUsd),
    ...s,
  };
};
const noBudget = (over: Partial<BudgetStatus> = {}) =>
  status({ limitUsd: null, percentUsed: null, ...over });

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};
const viewerAs = (role: string) => ({
  user: { id: 'user-1', name: 'Hai', email: 'owner@example.test' },
  workspaceId: WS,
  role,
  projects,
});

/**
 * Where a money text gets its "estimated" label: a table cell from its column header and its
 * own text, a description-list value from its term, anything else from its own element.
 */
const moneyContext = (el: Element): string => {
  const cell = el.closest('td');
  const table = el.closest('table');
  if (cell && table) {
    const index = [...cell.parentElement!.children].indexOf(cell);
    return `${table.querySelectorAll('thead th')[index]!.textContent} ${el.textContent}`;
  }
  const dd = el.closest('dd');
  if (dd) return dd.parentElement!.textContent ?? '';
  return el.textContent ?? '';
};
/** Every element whose own text shows a dollar amount. */
const moneyElements = (root: Element) =>
  [root, ...root.querySelectorAll('*')].filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && /\$/.test(n.textContent ?? '')),
  );
const expectMoneyEstimated = (root: Element) => {
  const money = moneyElements(root);
  for (const el of money) expect(moneyContext(el)).toMatch(/estimated/i);
  return money.length;
};

const card = () => screen.getByRole('region', { name: 'Monthly budget' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.viewer = viewerAs('owner');
  state.db = {};
  projects.getProject.mockResolvedValue({ id: PROJECT, name: 'Alpha app', description: null });
  projects.listTokens.mockResolvedValue([]);
  store.setBudget.mockResolvedValue(undefined);
  store.clearBudget.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('setBudgetAction / clearBudgetAction — role matrix', () => {
  it.each(['owner', 'admin'])('%s sets and clears within the viewer’s workspace', async (role) => {
    state.viewer = viewerAs(role);
    expect(await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: '12.50' }))).toEqual({
      saved: 'set',
    });
    expect(store.setBudget).toHaveBeenCalledExactlyOnceWith(WS, PROJECT, 12.5, 'user-1');
    expect(projects.getProject).toHaveBeenCalledWith(WS, PROJECT);
    expect(revalidatePath).toHaveBeenCalledWith(`/projects/${PROJECT}`);
    expect(revalidatePath).toHaveBeenCalledWith('/projects');

    expect(await clearBudgetAction({}, form({ projectId: PROJECT }))).toEqual({
      saved: 'cleared',
    });
    expect(store.clearBudget).toHaveBeenCalledExactlyOnceWith(WS, PROJECT);
  });

  it('refuses a member and never writes', async () => {
    state.viewer = viewerAs('member');
    const refused = { errors: { form: 'Only workspace owners and admins can change budgets.' } };
    expect(await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: '10' }))).toEqual(
      refused,
    );
    expect(await clearBudgetAction({}, form({ projectId: PROJECT }))).toEqual(refused);
    expect(store.setBudget).not.toHaveBeenCalled();
    expect(store.clearBudget).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a signed-out request and never writes', async () => {
    state.viewer = null;
    const refused = { errors: { form: 'Your session ended. Sign in again to continue.' } };
    expect(await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: '10' }))).toEqual(
      refused,
    );
    expect(await clearBudgetAction({}, form({ projectId: PROJECT }))).toEqual(refused);
    expect(store.setBudget).not.toHaveBeenCalled();
    expect(store.clearBudget).not.toHaveBeenCalled();
  });

  it('ignores any workspace field in the form', async () => {
    await setBudgetAction(
      {},
      form({ projectId: PROJECT, limitUsd: '10', workspaceId: OTHER, role: 'owner' }),
    );
    expect(store.setBudget).toHaveBeenCalledWith(WS, PROJECT, 10, 'user-1');
  });
});

describe('budget limit validation', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    ['12.50', 12.5],
    [' 7 ', 7],
    ['0.01', 0.01],
    ['1000000', 1_000_000],
    ['1000000.00', 1_000_000],
  ])('accepts %j as %d', async (input, value) => {
    expect(budgetLimitSchema.parse(input)).toBe(value);
    expect(await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: input }))).toEqual({
      saved: 'set',
    });
    expect(store.setBudget).toHaveBeenCalledWith(WS, PROJECT, value, 'user-1');
  });

  it.each([
    ['-1', /plain amount/],
    ['0', /more than 0/],
    ['0.00', /more than 0/],
    ['1e3', /plain amount/],
    ['12.345', /at most 2 decimals/],
    ['abc', /plain amount/],
    ['', /Enter a monthly limit/],
    ['1000000.01', /at most 1,000,000/],
    ['1,000', /plain amount/],
    ['$5', /plain amount/],
    ['12.', /plain amount/],
    ['Infinity', /plain amount/],
  ])('refuses %j without writing', async (input, message) => {
    expect(budgetLimitSchema.safeParse(input).success).toBe(false);
    const res = await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: input }));
    expect(res.errors?.limitUsd).toMatch(message);
    expect(store.setBudget).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('budget actions — project scope and failures', () => {
  it('refuses a project outside the viewer’s workspace before the repository', async () => {
    projects.getProject.mockResolvedValue(null);
    expect(await setBudgetAction({}, form({ projectId: OTHER, limitUsd: '10' }))).toEqual({
      errors: { form: 'Project not found.' },
    });
    expect(await clearBudgetAction({}, form({ projectId: OTHER }))).toEqual({
      errors: { form: 'Project not found.' },
    });
    expect(projects.getProject).toHaveBeenCalledWith(WS, OTHER);
    expect(store.setBudget).not.toHaveBeenCalled();
    expect(store.clearBudget).not.toHaveBeenCalled();
  });

  it('maps a repository not_found to an error state', async () => {
    const notFoundError = Object.assign(new Error('not_found'), { code: 'not_found' });
    store.setBudget.mockRejectedValue(notFoundError);
    store.clearBudget.mockRejectedValue(notFoundError);
    expect(await setBudgetAction({}, form({ projectId: OTHER, limitUsd: '10' }))).toEqual({
      errors: { form: 'Project not found.' },
    });
    expect(await clearBudgetAction({}, form({ projectId: OTHER }))).toEqual({
      errors: { form: 'Project not found.' },
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('rejects malformed project ids before the database', async () => {
    expect(await setBudgetAction({}, form({ projectId: '../x', limitUsd: '10' }))).toEqual({
      errors: { form: 'Project not found.' },
    });
    expect(projects.getProject).not.toHaveBeenCalled();
  });

  it('says so without a database', async () => {
    state.db = null;
    const res = await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: '10' }));
    expect(res.errors?.form).toMatch(/need a database/);
  });

  it('maps a repository RangeError to the limit field', async () => {
    store.setBudget.mockRejectedValue(new RangeError('limit'));
    const res = await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: '10' }));
    expect(res.errors?.limitUsd).toBe('This limit is out of range.');
  });

  it('logs an unexpected failure by name only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.setBudget.mockRejectedValue(new TypeError('postgres://user:secret@host'));
    const res = await setBudgetAction({}, form({ projectId: PROJECT, limitUsd: '10' }));
    expect(res.errors?.form).toBe('The budget could not be saved. Try again in a moment.');
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]![0])).toContain('TypeError');
    expect(String(log.mock.calls[0]![0])).not.toContain('secret');
  });

  it('only owners and admins manage budgets', () => {
    expect(['owner', 'admin', 'member', null].map(canManageBudget)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('loadBudget / loadBudgets', () => {
  const deps = (over: Partial<Parameters<typeof loadBudget>[0]> = {}) => ({
    getViewer: vi.fn(async () => ({ workspaceId: WS })),
    getDb: () => ({}),
    repository: () => store,
    ...over,
  });

  it('is not configured without a database and never looks up the session', async () => {
    const d = deps({ getDb: () => null });
    expect(await loadBudget(d, PROJECT)).toEqual({ kind: 'not_configured' });
    expect(await loadBudgets(d)).toEqual({ kind: 'not_configured' });
    expect(d.getViewer).not.toHaveBeenCalled();
  });

  it('is signed out without a viewer', async () => {
    const d = deps({ getViewer: vi.fn(async () => null) });
    expect(await loadBudget(d, PROJECT)).toEqual({ kind: 'signed_out' });
    expect(await loadBudgets(d)).toEqual({ kind: 'signed_out' });
  });

  it('reads with the viewer’s workspace', async () => {
    store.status.mockResolvedValue(status());
    store.statuses.mockResolvedValue([status()]);
    expect(await loadBudget(deps(), PROJECT)).toEqual({ kind: 'ready', status: status() });
    expect(await loadBudgets(deps())).toEqual({ kind: 'ready', statuses: [status()] });
    expect(store.status).toHaveBeenCalledWith(WS, PROJECT);
    expect(store.statuses).toHaveBeenCalledWith(WS);
  });

  it('is unavailable when the read fails or the project is outside the workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    store.status.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('down'));
    store.statuses.mockRejectedValue(new Error('down'));
    expect(await loadBudget(deps(), PROJECT)).toEqual({ kind: 'unavailable' });
    expect(await loadBudget(deps(), PROJECT)).toEqual({ kind: 'unavailable' });
    expect(await loadBudgets(deps())).toEqual({ kind: 'unavailable' });
  });
});

describe('BudgetCard', () => {
  const ready = (s: BudgetStatus) => ({ kind: 'ready' as const, status: s });

  it.each([true, false])('every dollar amount says estimated (canEdit %s)', (canEdit) => {
    for (const s of [
      status(),
      status({ percentUsed: 124, spendUsd: 12.4, forecastUsd: 18.6, alerted: [80, 100] }),
      status({ forecastUsd: null, estimatedReports: 2 }),
      noBudget(),
    ]) {
      const { unmount } = render(<BudgetCard load={ready(s)} canEdit={canEdit} />);
      expect(expectMoneyEstimated(card())).toBeGreaterThan(0);
      unmount();
    }
  });

  it('without a budget, owners and admins get an explanation and a form', () => {
    render(<BudgetCard load={ready(noBudget({ spendUsd: 3.2 }))} canEdit />);
    const c = card();
    expect(c.textContent).toContain('Set a monthly limit in US dollars.');
    expect(c.textContent).toContain(ALERT_RECIPIENTS_TEXT);
    expect(c.textContent).toContain('Estimated spend so far in October 2026 (UTC): $3.20');
    const input = within(c).getByRole('textbox', { name: 'Monthly limit (USD)' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    expect(within(c).getByRole('button', { name: 'Set budget' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Remove budget' })).toBeNull();
    expect(within(c).queryByText('No budget set')).toBeNull();
  });

  it('without a budget, members read “No budget set” and get no form', () => {
    render(<BudgetCard load={ready(noBudget())} canEdit={false} />);
    const c = card();
    expect(within(c).getByText('No budget set')).toBeTruthy();
    expect(within(c).queryByRole('textbox')).toBeNull();
    expect(within(c).queryByRole('button')).toBeNull();
  });

  it('below 80 %: spend vs limit, a bar with text, a forecast and no badge', () => {
    render(<BudgetCard load={ready(status())} canEdit />);
    const c = card();
    expect(c.querySelector('dt')!.textContent).toBe('Estimated spend, October 2026 (UTC)');
    expect(c.querySelector('dd')!.textContent).toBe('$6.20 of $10.00');
    // The bar is decorative; its value is the visible text next to it (not colour only).
    const text = within(c).getByText('62 % of $10.00 (estimated)');
    const bar = text.previousElementSibling!;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('62%');
    expect(within(c).getByText('Forecast for October: $9.61 (estimated)')).toBeTruthy();
    expect(c.textContent).not.toMatch(/80 % reached|Budget reached/);
    expect(c.textContent).toContain('No budget alerts this month.');
    expect(c.textContent).toContain(ALERT_RECIPIENTS_TEXT);
    expect(within(c).getByRole('time').getAttribute('dateTime')).toBe(NOW);
  });

  it.each([
    [79.99, '79 % of $10.00 (estimated)', null],
    [80, '80 % of $10.00 (estimated)', '80 % reached'],
    [99.99, '99 % of $10.00 (estimated)', '80 % reached'],
    [100, '100 % of $10.00 (estimated)', 'Budget reached'],
    [124, '124 % of $10.00 (estimated)', 'Budget reached'],
  ])('at %d %% shows %j and badge %j', (percentUsed, text, badge) => {
    render(
      <BudgetCard
        load={ready(status({ percentUsed, spendUsd: percentUsed / 10 }))}
        canEdit={false}
      />,
    );
    const c = card();
    expect(within(c).getByText(text)).toBeTruthy();
    const bar = within(c).getByText(text).previousElementSibling!.firstElementChild as HTMLElement;
    expect(bar.style.width).toBe(`${Math.min(percentUsed, 100)}%`);
    if (badge) expect(within(c).getByText(badge)).toBeTruthy();
    else expect(c.textContent).not.toMatch(/reached/);
  });

  it('badges by the exact threshold, never by the percent shown', () => {
    // 7.999999 of 10 is below 80 % even if a caller hands over a rounded 80.
    render(
      <BudgetCard load={ready(status({ percentUsed: 80, spendUsd: 7.999999 }))} canEdit={false} />,
    );
    expect(card().textContent).not.toMatch(/reached/);
    cleanup();
    render(
      <BudgetCard
        load={ready(status({ percentUsed: 99.99, spendUsd: 9.999999 }))}
        canEdit={false}
      />,
    );
    expect(within(card()).getByText('99 % of $10.00 (estimated)')).toBeTruthy();
    expect(within(card()).getByText('80 % reached')).toBeTruthy();
    expect(card().textContent).not.toMatch(/Budget reached/);
  });

  it('says when it is too early to forecast', () => {
    render(<BudgetCard load={ready(status({ forecastUsd: null }))} canEdit={false} />);
    expect(
      within(card()).getByText(
        'Too early to forecast — check back after the first day of the month.',
      ),
    ).toBeTruthy();
    expect(card().textContent).not.toContain('Forecast for');
  });

  it('flags a forecast above the limit, still estimated', () => {
    render(<BudgetCard load={ready(status({ forecastUsd: 12.4 }))} canEdit={false} />);
    expect(
      within(card()).getByText('Forecast for October: $12.40 (estimated) — above the $10.00 limit'),
    ).toBeTruthy();
  });

  it('notes estimated token counts when some reports were estimated', () => {
    render(<BudgetCard load={ready(status({ estimatedReports: 2 }))} canEdit={false} />);
    expect(
      within(card()).getByText('Includes estimated token counts (2 of 9 reports)'),
    ).toBeTruthy();
  });

  it.each([
    [[80], 'Owners were emailed at 80 % this month.'],
    [[80, 100], 'Owners were emailed at 100 % this month (this covers the 80 % alert).'],
    [[100], 'Owners were emailed at 100 % this month (this covers the 80 % alert).'],
  ] as const)('lists alerts %j', (alerted, text) => {
    render(
      <BudgetCard
        load={ready(status({ alerted: [...alerted], percentUsed: 100, spendUsd: 10 }))}
        canEdit={false}
      />,
    );
    expect(within(card()).getByText(text)).toBeTruthy();
  });

  const FAILED = 'An alert email could not be sent yet — it is retried with the next usage report.';
  const GAVE_UP = 'An alert email could not be sent — gave up after 5 attempts.';
  const PENDING =
    'An alert email is on its way; if it does not go out, the next usage report retries it.';

  const alertCases: [string, Partial<BudgetStatus>, string[]][] = [
    ['failed', { failedAlerts: [80] }, [FAILED]],
    ['exhausted', { failedAlerts: [100], exhaustedAlerts: [100] }, [GAVE_UP]],
    [
      '80 sent, 100 failed',
      { alerted: [80], failedAlerts: [100] },
      ['Owners were emailed at 80 % this month.', FAILED],
    ],
    ['pending', { pendingAlerts: [100] }, [PENDING]],
    ['none', {}, ['No budget alerts this month.']],
  ];

  it.each(alertCases)('only claims emails that were sent (%s)', (_name, over, texts) => {
    render(
      <BudgetCard
        load={ready(status({ percentUsed: 100, spendUsd: 10, ...over }))}
        canEdit={false}
      />,
    );
    const c = card();
    for (const t of texts) expect(within(c).getByText(t)).toBeTruthy();
    if (!over.alerted) expect(c.textContent).not.toContain('Owners were emailed');
    if (Object.keys(over).length > 0) {
      expect(c.textContent).not.toContain('No budget alerts this month.');
    }
  });

  it('with a budget, owners and admins can edit and remove it', () => {
    render(<BudgetCard load={ready(status())} canEdit />);
    const c = card();
    const input = within(c).getByRole('textbox', { name: 'New monthly limit (USD)' });
    expect((input as HTMLInputElement).value).toBe('10.00');
    expect(within(c).getByRole('button', { name: 'Save limit' })).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Remove budget' })).toBeTruthy();
    const hidden = c.querySelectorAll<HTMLInputElement>('input[type="hidden"][name="projectId"]');
    expect([...hidden].map((h) => h.value)).toEqual([PROJECT, PROJECT]);
  });

  it('with a budget, members read it without a form', () => {
    render(<BudgetCard load={ready(status())} canEdit={false} />);
    const c = card();
    expect(within(c).queryByRole('textbox')).toBeNull();
    expect(within(c).queryByRole('button')).toBeNull();
    expect(c.textContent).toContain('Only workspace owners and admins can change this budget.');
  });

  it('shows a refused value next to the field', async () => {
    render(<BudgetCard load={ready(status())} canEdit />);
    const input = screen.getByRole('textbox', { name: 'New monthly limit (USD)' });
    fireEvent.change(input, { target: { value: '12.345' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/at most 2 decimals/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    expect(store.setBudget).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'unavailable' as const }, 'Budget could not be loaded'],
    [{ kind: 'not_configured' as const }, 'Budgets are not available'],
    [{ kind: 'signed_out' as const }, 'Sign in to see this budget'],
  ])('%j has its own empty state', (load, title) => {
    render(<BudgetCard load={load} canEdit />);
    expect(within(card()).getByText(title)).toBeTruthy();
    expect(within(card()).queryByRole('textbox')).toBeNull();
  });
});

describe('Project detail page', () => {
  it('reads the budget of the scoped project and shows the form to owners', async () => {
    store.status.mockResolvedValue(status());
    render(await ProjectPage({ params: Promise.resolve({ id: PROJECT }) }));
    expect(store.status).toHaveBeenCalledExactlyOnceWith(WS, PROJECT);
    expect(within(card()).getByRole('button', { name: 'Save limit' })).toBeTruthy();
  });

  it('is read-only for members', async () => {
    state.viewer = viewerAs('member');
    store.status.mockResolvedValue(status());
    render(await ProjectPage({ params: Promise.resolve({ id: PROJECT }) }));
    expect(within(card()).getByText('62 % of $10.00 (estimated)')).toBeTruthy();
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('never reads a budget for a project outside the workspace', async () => {
    projects.getProject.mockResolvedValue(null);
    await expect(ProjectPage({ params: Promise.resolve({ id: OTHER }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(store.status).not.toHaveBeenCalled();
  });
});

describe('Projects list — Budget column', () => {
  const rows = [PROJECT, OTHER, '44444444-4444-4444-8444-444444444444'].map((id, i) => ({
    id,
    name: ['Alpha app', 'Beta service', 'Gamma tool'][i]!,
    slug: ['alpha', 'beta', 'gamma'][i]!,
    platforms: ['claude-code'],
    privacyClass: 'L0',
    createdAt: '2026-10-01T08:00:00.000Z',
  }));

  it('maps statuses to cells', () => {
    const load = {
      kind: 'ready' as const,
      statuses: [status(), noBudget({ projectId: OTHER })],
    };
    expect(toBudgetCell(load, PROJECT)).toEqual({
      kind: 'set',
      limitUsd: 10,
      percentUsed: 62,
      threshold: null,
    });
    expect(toBudgetCell(load, OTHER)).toEqual({ kind: 'none' });
    expect(toBudgetCell(load, rows[2]!.id)).toEqual({ kind: 'none' });
    expect(toBudgetCell({ kind: 'unavailable' }, PROJECT)).toEqual({ kind: 'not_loaded' });
  });

  it('shows percent of limit, threshold badges and “No budget”', () => {
    render(
      <ProjectsTable
        rows={[
          { ...rows[0]!, budget: { kind: 'set', limitUsd: 10, percentUsed: 62, threshold: null } },
          {
            ...rows[1]!,
            budget: { kind: 'set', limitUsd: 25, percentUsed: 104.2, threshold: 100 },
          },
          { ...rows[2]!, budget: { kind: 'none' } },
        ]}
        snapshot={null}
      />,
    );
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toContain('Budget');
    const col = headers.indexOf('Budget');
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.children[col]!);
    expect(cells[0]!.textContent).toBe('62 % of $10.00 estimated');
    expect(cells[1]!.textContent).toBe('Budget reached104 % of $25.00 estimated');
    expect(within(cells[1] as HTMLElement).getByText('Budget reached')).toBeTruthy();
    expect(cells[2]!.textContent).toBe('No budget');
    expectMoneyEstimated(table);
  });

  it('badges 80 % in the list too', () => {
    render(<BudgetCell budget={{ kind: 'set', limitUsd: 10, percentUsed: 80, threshold: 80 }} />);
    expect(screen.getByText('80 % reached')).toBeTruthy();
  });

  it('badges the list by the exact threshold, not the percent', () => {
    const load = {
      kind: 'ready' as const,
      statuses: [status({ percentUsed: 80, spendUsd: 7.999999 })],
    };
    const cell = toBudgetCell(load, PROJECT);
    expect(cell).toMatchObject({ kind: 'set', threshold: null });
    render(<BudgetCell budget={cell} />);
    expect(screen.queryByText(/reached/)).toBeNull();
  });

  it('the page loads budgets for the viewer’s workspace', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    projects.listProjects.mockResolvedValue(
      rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
    );
    store.statuses.mockResolvedValue([status({ percentUsed: 85, spendUsd: 8.5 })]);
    render(await ProjectsPage());
    expect(store.statuses).toHaveBeenCalledExactlyOnceWith(WS);
    const table = screen.getByRole('table', { name: /projects/i });
    expect(within(table).getByText('80 % reached')).toBeTruthy();
    expect(within(table).getAllByText('No budget')).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it('the page says “Not loaded” when budgets cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    projects.listProjects.mockResolvedValue(
      rows.slice(0, 1).map((r) => ({ ...r, createdAt: new Date(r.createdAt) })),
    );
    store.statuses.mockRejectedValue(new Error('down'));
    render(await ProjectsPage());
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(row.children[headers.indexOf('Budget')]!.textContent).toBe('Not loaded');
    vi.unstubAllGlobals();
  });
});
