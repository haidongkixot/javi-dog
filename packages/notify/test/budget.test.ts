import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  budgetAlertEmail,
  budgetMonthLabel,
  NotifyError,
  sendBudgetAlertEmail,
  sendEmail,
  type BudgetAlertEmailInput,
  type BudgetAlertSendInput,
} from '../src/index.ts';

const config = {
  apiKey: 're_test',
  from: "Javi's Dog <alerts@example.com>",
  appUrl: 'https://app.example',
};

const input = (over: Partial<BudgetAlertEmailInput> = {}): BudgetAlertEmailInput => ({
  projectName: 'Web App',
  projectUrl: 'https://app.example/projects/p_1',
  monthLabel: 'October 2026',
  threshold: 80,
  spendUsd: 8.12,
  limitUsd: 10,
  percentUsed: 81.2,
  forecastUsd: 24.36,
  estimatedReports: 0,
  reports: 42,
  ...over,
});

const job = (over: Partial<BudgetAlertSendInput> = {}): BudgetAlertSendInput => ({
  alertId: 'alert_1',
  projectId: 'p_1',
  projectName: 'Web App',
  threshold: 80,
  recipients: ['ada@example.com', 'grace@example.com'],
  status: {
    month: '2026-10',
    spendUsd: 8.12,
    limitUsd: 10,
    percentUsed: 81.2,
    forecastUsd: 24.36,
    reports: 42,
    estimatedReports: 3,
  },
  ...over,
});

const bodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
const headers = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);

/** Every line (text) or paragraph/list item (HTML) that states money or a percent says "estimated". */
const expectEstimated = ({
  subject,
  text,
  html,
}: {
  subject: string;
  text: string;
  html: string;
}) => {
  const htmlParts = html.split(/<\/?(?:p|li|ul)[^>]*>/);
  for (const part of [subject, ...text.split('\n'), ...htmlParts].filter((l) => /[$%]/.test(l))) {
    expect(part.toLowerCase()).toContain('estimated');
  }
};

afterEach(() => vi.restoreAllMocks());

describe('budgetAlertEmail', () => {
  it('labels every money value as estimated and links to the project', () => {
    const { subject, text, html } = budgetAlertEmail(input());
    // The crossed threshold, not the (floored) current percent.
    expect(subject).toBe('Web App reached 80 % of its October 2026 budget (estimated)');
    expect(text).toContain('Estimated spend: $8.12 of your $10.00 budget (81 %)');
    expect(text).toContain('Forecast for October 2026: about $24.36 (estimated)');
    expect(text).toContain('Open the project: https://app.example/projects/p_1');
    expect(html).toContain('href="https://app.example/projects/p_1"');
    expect(html).toContain('Estimated spend: $8.12 of your $10.00 budget (81 %)');
    expectEstimated({ subject, text, html });
  });

  it('states the crossed threshold as estimated in subject and lead, never a rounded percent', () => {
    const e = budgetAlertEmail(input({ percentUsed: 99.99, spendUsd: 9.999 }));
    expect(e.subject).toBe('Web App reached 80 % of its October 2026 budget (estimated)');
    expect(e.text).toContain('Web App has used an estimated 80 % of its October 2026 budget.');
    expect(e.text).toContain('(99 %)');
    expect(e.text).not.toContain('100 %)');
    const reached = budgetAlertEmail(input({ threshold: 100, percentUsed: 104, spendUsd: 10.4 }));
    expect(reached.text).toContain(
      'Web App has used an estimated 100 % of its October 2026 budget.',
    );
    for (const x of [e, reached]) expectEstimated(x);
  });

  it('promises "usually one email" per threshold and project, not "at most"', () => {
    const { text, html } = budgetAlertEmail(input());
    expect(text).toContain('usually one email per threshold and project each month');
    expect(html).toContain('usually one email per threshold and project each month');
    expect(text).not.toContain('at most one');
  });

  it('says "too early to forecast" without a forecast', () => {
    const { text, html } = budgetAlertEmail(input({ forecastUsd: null }));
    expect(text).toContain('too early to forecast');
    expect(html).toContain('too early to forecast');
    expect(text).not.toContain('about $');
  });

  it('notes estimated usage reports only when there are some', () => {
    expect(budgetAlertEmail(input()).text).not.toContain('carried estimated figures');
    expect(budgetAlertEmail(input({ estimatedReports: 3 })).text).toContain(
      'Note: 3 of 42 usage reports this month carried estimated figures',
    );
  });

  it('words the 100 % alert as reached, floors percentages and stays calm', () => {
    const reached = budgetAlertEmail(
      input({ threshold: 100, spendUsd: 10.4, percentUsed: 104, forecastUsd: 31.2 }),
    );
    expect(reached.subject).toBe('Web App reached its October 2026 budget (estimated)');
    expect(reached.text).toContain('$10.40 of your $10.00 budget (104 %)');
    expectEstimated(reached);
    expect(budgetAlertEmail(input({ percentUsed: 99.6 })).text).toContain('(99 %)');
    for (const e of [reached, budgetAlertEmail(input())]) {
      const all = `${e.subject} ${e.text} ${e.html}`;
      expect(all).not.toMatch(/\b(live|secure|encrypted|urgent|warning|alert!)\b/i);
      expect(all).not.toContain('!');
    }
  });

  it('escapes the project name in HTML and keeps the subject on one line', () => {
    const e = budgetAlertEmail(input({ projectName: '<b>x</b>\r\nBcc: evil' }));
    expect(e.html).toContain('&#60;b&#62;x&#60;/b&#62;');
    expect(e.html).not.toContain('<b>x');
    expect(e.subject).not.toMatch(/[\r\n]/);
  });

  it('formats months in UTC', () => {
    expect(budgetMonthLabel('2026-10')).toBe('October 2026');
    expect(budgetMonthLabel('2027-01')).toBe('January 2027');
    expect(budgetMonthLabel('odd')).toBe('odd');
  });
});

describe('sendEmail', () => {
  it('sends one request per recipient so owners never see each other', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => Response.json({ id: `email_${++n}` }));
    const report = await sendEmail(
      { ...config, fetch: fetchMock },
      { to: ['a@example.com', 'b@example.com'], subject: 's', text: 't', html: 'h' },
    );
    expect(report).toEqual({ ids: ['email_1', 'email_2'], errors: [] });
    expect(bodies(fetchMock).map((b) => b.to)).toEqual([['a@example.com'], ['b@example.com']]);
    for (const b of bodies(fetchMock)) {
      expect(b).not.toHaveProperty('cc');
      expect(b).not.toHaveProperty('bcc');
    }
  });

  it('keeps going after a failure and reports errors without addresses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad recipient a@example.com', { status: 422 }))
      .mockRejectedValueOnce('socket hang up')
      .mockResolvedValueOnce(Response.json({ id: 'email_3' }));
    const report = await sendEmail(
      { ...config, fetch: fetchMock },
      {
        to: ['a@example.com', 'b@example.com', 'c@example.com'],
        subject: 's',
        text: 't',
        html: 'h',
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(report.ids).toEqual(['email_3']);
    expect(report.errors.map((e) => [e.name, (e as NotifyError).status])).toEqual([
      ['NotifyError', 422],
      ['NotifyError', 0],
    ]);
    expect(JSON.stringify(report.errors.map((e) => [e.name, e.message]))).not.toContain('@');
  });
});

describe('sendEmail robustness', () => {
  const message = { to: ['a@example.com', 'b@example.com'], subject: 's', text: 't', html: 'h' };

  it('sends Idempotency-Key <key>/<recipient index> only when a key is given', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_1' }));
    await sendEmail({ ...config, fetch: fetchMock }, { ...message, idempotencyKey: 'k/1' });
    expect(headers(fetchMock).map((h) => h['Idempotency-Key'])).toEqual(['k/1/0', 'k/1/1']);

    fetchMock.mockClear();
    await sendEmail({ ...config, fetch: fetchMock }, message);
    for (const h of headers(fetchMock)) expect(h).not.toHaveProperty('Idempotency-Key');
    // The key is a header, never part of the email body.
    for (const b of bodies(fetchMock)) expect(b).not.toHaveProperty('idempotencyKey');
  });

  it('gives every request a 10 s timeout signal by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_1' }));
    await sendEmail({ ...config, fetch: fetchMock }, message);
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(10_000);
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  /** A fetch that only settles when its signal aborts (a hung Resend request). */
  const hangingFetch = () =>
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;

  it('counts a timed-out request as a failure without an address, and tries the next one', async () => {
    const fetchMock = hangingFetch();
    const report = await sendEmail({ ...config, fetch: fetchMock, timeoutMs: 20 }, message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(report.ids).toEqual([]);
    expect(report.errors.map((e) => [e.name, (e as NotifyError).status])).toEqual([
      ['NotifyError', 0],
      ['NotifyError', 0],
    ]);
    expect(JSON.stringify(report.errors.map((e) => [e.name, e.message]))).not.toContain('@');
  });

  it('falls back to an AbortController timer where AbortSignal.timeout is missing', async () => {
    const original = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
    try {
      const report = await sendEmail(
        { ...config, fetch: hangingFetch(), timeoutMs: 20 },
        { ...message, to: ['a@example.com'] },
      );
      expect(report.errors.map((e) => (e as NotifyError).status)).toEqual([0]);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { value: original, configurable: true });
    }
  });

  it('wraps a transport error (whatever its message) as NotifyError with status 0', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed for a@example.com');
    });
    const report = await sendEmail(
      { ...config, fetch: fetchMock },
      { ...message, to: ['a@example.com'] },
    );
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toBeInstanceOf(NotifyError);
    expect((report.errors[0] as NotifyError).status).toBe(0);
    expect(report.errors[0]!.message).not.toContain('@');
  });
});

describe('sendBudgetAlertEmail', () => {
  it('uses budget-alert/<alertId>/<attempt>/<recipient index> as the idempotency key', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_1' }));
    await sendBudgetAlertEmail({ ...config, fetch: fetchMock }, job());
    await sendBudgetAlertEmail({ ...config, fetch: fetchMock }, job({ attempt: 2 }));
    // A retry (new attempt, new figures) never reuses an earlier attempt's key.
    expect(headers(fetchMock).map((h) => h['Idempotency-Key'])).toEqual([
      'budget-alert/alert_1/1/0',
      'budget-alert/alert_1/1/1',
      'budget-alert/alert_1/2/0',
      'budget-alert/alert_1/2/1',
    ]);
  });

  it.each([
    ['https://app.example', 'https://app.example/projects/p_1'],
    ['https://app.example/', 'https://app.example/projects/p_1'],
    ['https://example.com/jd', 'https://example.com/jd/projects/p_1'],
    ['https://example.com/jd/', 'https://example.com/jd/projects/p_1'],
  ])('keeps the path prefix of the app URL %s', async (appUrl, link) => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_1' }));
    await sendBudgetAlertEmail(
      { ...config, appUrl, fetch: fetchMock },
      job({ recipients: ['ada@example.com'] }),
    );
    expect(bodies(fetchMock)[0].text).toContain(`Open the project: ${link}\n`);
  });

  it('sends the alert to each owner separately with an absolute project link', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_1' }));
    const report = await sendBudgetAlertEmail({ ...config, fetch: fetchMock }, job());
    expect(report.errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = bodies(fetchMock);
    expect(first.to).toEqual(['ada@example.com']);
    expect(second.to).toEqual(['grace@example.com']);
    expect(first).toMatchObject({ from: config.from, subject: second.subject });
    expect(first.text).toContain('https://app.example/projects/p_1');
    expect(first.text).toContain('October 2026');
    expect(first.text).toContain('3 of 42 usage reports');
    expect(first.text).not.toContain('grace@example.com');
  });

  it('derives the percentage when the status has none and refuses a job without a limit', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'email_1' }));
    await sendBudgetAlertEmail(
      { ...config, fetch: fetchMock },
      job({ recipients: ['ada@example.com'], status: { ...job().status, percentUsed: null } }),
    );
    expect(bodies(fetchMock)[0].text).toContain('(81 %)');

    const error = await sendBudgetAlertEmail(
      { ...config, fetch: fetchMock },
      job({ status: { ...job().status, limitUsd: null } }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RangeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
