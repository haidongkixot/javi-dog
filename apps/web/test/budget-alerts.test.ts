import type { BudgetAlertJob } from '@javis-dog/resilience';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBudgetAlertDeps,
  processBudgetAlert,
  type BudgetAlertDeps,
} from '@/lib/budget-alerts';

const scope = { workspaceId: 'ws_1', projectId: 'p_1' };

const job = (over: Partial<BudgetAlertJob> = {}): BudgetAlertJob => ({
  alertId: 'alert_1',
  attempt: 1,
  projectId: 'p_1',
  workspaceId: 'ws_1',
  projectName: 'Web App',
  projectSlug: 'web-app',
  threshold: 80,
  recipients: ['ada@example.com', 'grace@example.com'],
  status: {
    projectId: 'p_1',
    limitUsd: 10,
    month: '2026-10',
    spendUsd: 8.12,
    percentUsed: 81.2,
    forecastUsd: 24.36,
    reports: 42,
    estimatedReports: 0,
    thresholdReached: 80,
    alerted: [],
    pendingAlerts: [80],
    failedAlerts: [],
    exhaustedAlerts: [],
    generatedAt: '2026-10-28T10:00:00.000Z',
  },
  ...over,
});

const fakeDeps = (claimed: BudgetAlertJob | null, fetchImpl: typeof fetch) => {
  const claimAlert = vi.fn(async () => claimed);
  const markAlert = vi.fn(async () => {});
  const deps: BudgetAlertDeps = {
    budgets: { claimAlert, markAlert },
    mail: {
      apiKey: 're_test',
      from: "Javi's Dog <alerts@example.com>",
      appUrl: 'https://app.example',
      fetch: fetchImpl,
    },
  };
  return { deps, claimAlert, markAlert };
};

const ok = () => vi.fn(async () => Response.json({ id: 'email_1' })) as unknown as typeof fetch;

const spyLogs = () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const lines = () =>
    [...info.mock.calls, ...error.mock.calls].map(([line]) => JSON.parse(String(line)));
  return { lines, raw: () => JSON.stringify([info.mock.calls, error.mock.calls]) };
};

afterEach(() => vi.restoreAllMocks());

describe('processBudgetAlert', () => {
  it('sends nothing and marks nothing when there is no alert to claim', async () => {
    const logs = spyLogs();
    const fetchMock = ok();
    const { deps, claimAlert, markAlert } = fakeDeps(null, fetchMock);
    expect(await processBudgetAlert(deps, scope)).toBe('none');
    expect(claimAlert).toHaveBeenCalledWith(scope);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markAlert).not.toHaveBeenCalled();
    expect(logs.lines()).toEqual([]);
  });

  it('emails each owner separately and marks the alert sent', async () => {
    const logs = spyLogs();
    const fetchMock = ok();
    const { deps, markAlert } = fakeDeps(job(), fetchMock);
    expect(await processBudgetAlert(deps, scope)).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const recipients = vi
      .mocked(fetchMock)
      .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).to);
    expect(recipients).toEqual([['ada@example.com'], ['grace@example.com']]);
    expect(markAlert).toHaveBeenCalledExactlyOnceWith('alert_1', 'sent');
    expect(logs.lines()).toEqual([
      { level: 'info', module: 'JD-APP', msg: 'budget alert sent', threshold: 80, outcome: 'sent' },
    ]);
    expect(logs.raw()).not.toContain('@');
  });

  it('sends a stable idempotency key per alert and recipient, so a retry can be de-duplicated', async () => {
    spyLogs();
    const fetchMock = ok();
    const { deps } = fakeDeps(job(), fetchMock);
    await processBudgetAlert(deps, scope);
    await processBudgetAlert(deps, scope);
    const keys = vi
      .mocked(fetchMock)
      .mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
    // Same claimed attempt → same keys; the attempt number is part of the key.
    expect(keys).toEqual([
      'budget-alert/alert_1/1/0',
      'budget-alert/alert_1/1/1',
      'budget-alert/alert_1/1/0',
      'budget-alert/alert_1/1/1',
    ]);
  });

  it('marks the alert failed when one owner email fails, after trying every owner', async () => {
    const logs = spyLogs();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('invalid to: ada@example.com', { status: 422 }))
      .mockResolvedValueOnce(Response.json({ id: 'email_2' })) as unknown as typeof fetch;
    const { deps, markAlert } = fakeDeps(job({ threshold: 100 }), fetchMock);
    expect(await processBudgetAlert(deps, scope)).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markAlert).toHaveBeenCalledExactlyOnceWith('alert_1', 'failed');
    expect(logs.lines()).toEqual([
      {
        level: 'error',
        module: 'JD-APP',
        msg: 'budget alert failed',
        threshold: 100,
        outcome: 'failed',
        errors: ['NotifyError'],
      },
    ]);
    expect(logs.raw()).not.toContain('@');
  });

  it('marks failed without sending when the job has no recipients or no limit', async () => {
    spyLogs();
    for (const claimed of [
      job({ recipients: [] }),
      job({ status: { ...job().status, limitUsd: null } }),
    ]) {
      const fetchMock = ok();
      const { deps, markAlert } = fakeDeps(claimed, fetchMock);
      expect(await processBudgetAlert(deps, scope)).toBe('failed');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markAlert).toHaveBeenCalledExactlyOnceWith('alert_1', 'failed');
    }
  });

  it('never throws when the repository fails, and logs error names only', async () => {
    const logs = spyLogs();
    const { deps, markAlert } = fakeDeps(job(), ok());
    deps.budgets.claimAlert = vi.fn(async () => {
      throw new Error('connect postgresql://user:hunter2@host/db');
    });
    expect(await processBudgetAlert(deps, scope)).toBe('error');
    expect(markAlert).not.toHaveBeenCalled();

    const second = fakeDeps(job(), ok());
    second.deps.budgets.markAlert = vi.fn(async () => {
      throw new Error('timeout at ada@example.com');
    });
    expect(await processBudgetAlert(second.deps, scope)).toBe('sent');

    expect(logs.lines()).toEqual([
      {
        level: 'error',
        module: 'JD-APP',
        msg: 'budget alert claim failed',
        outcome: 'error',
        errors: ['Error'],
      },
      {
        level: 'error',
        module: 'JD-APP',
        msg: 'budget alert mark failed',
        threshold: 80,
        outcome: 'sent',
        errors: ['Error'],
      },
    ]);
    expect(logs.raw()).not.toContain('@');
    expect(logs.raw()).not.toContain('hunter2');
  });
});

describe('createBudgetAlertDeps', () => {
  const full = {
    RESEND_API_KEY: 're_x',
    EMAIL_FROM: 'a <a@example.com>',
    BETTER_AUTH_URL: 'https://app.example',
  };

  it('is null (nothing claimed) unless Resend, sender and app URL are all configured', () => {
    for (const key of Object.keys(full)) {
      expect(createBudgetAlertDeps({} as never, { ...full, [key]: '' })).toBeNull();
    }
    expect(createBudgetAlertDeps({} as never, full)?.mail).toEqual({
      apiKey: 're_x',
      from: 'a <a@example.com>',
      appUrl: 'https://app.example',
    });
  });
});
