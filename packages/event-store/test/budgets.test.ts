import { randomUUID } from 'node:crypto';
import { createProjectRepository, ProjectRepositoryError } from '@javis-dog/projects';
import { createBudgetRepository } from '@javis-dog/resilience';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventRepository, retentionCutoff, type NewEvent } from '../src/index.ts';
import { freshDb } from './helpers.ts';

// JD-M12 repository against the real migrations (0000–0005), TEST_PLAN §S4c.

let ctx: Awaited<ReturnType<typeof freshDb>>;
let projectsRepo: ReturnType<typeof createProjectRepository>;
let events: ReturnType<typeof createEventRepository>;
let budgets: ReturnType<typeof createBudgetRepository>;

beforeAll(async () => {
  ctx = await freshDb();
  projectsRepo = createProjectRepository(ctx.db);
  events = createEventRepository(ctx.db);
  budgets = createBudgetRepository(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, users cascade');
});

const NOW = new Date('2026-10-20T12:00:00Z');
const at = (iso: string) => ({ now: new Date(iso) });

type Scope = { workspaceId: string; projectId: string };

const setup = async (name = 'Signal team', projectName = 'Web') => {
  const ws = await projectsRepo.createWorkspace({ name });
  const p = await projectsRepo.createProject(ws.id, {
    name: projectName,
    platforms: ['claude-code'],
  });
  return { workspaceId: ws.id, projectId: p.id, slug: p.slug };
};

const addProject = async (workspaceId: string, name: string) => {
  const p = await projectsRepo.createProject(workspaceId, { name, platforms: ['claude-code'] });
  return { workspaceId, projectId: p.id };
};

const member = async (
  workspaceId: string,
  email: string,
  role: 'owner' | 'admin' | 'member',
  verified = true,
) => {
  const { rows } = await ctx.client.query<{ id: string }>(
    'insert into users (name, email, email_verified) values ($1, $2, $3) returning id',
    [email, email, verified],
  );
  const userId = rows[0]!.id;
  await ctx.client.query(
    'insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)',
    [workspaceId, userId, role],
  );
  return userId;
};

const usage = (
  s: Scope,
  receivedAt: string,
  costUsd: unknown,
  extra: Partial<NewEvent> = {},
): NewEvent => ({
  ...s,
  producerId: 'prod_a',
  eventId: randomUUID(),
  threadRef: 'sess_1',
  sequence: 1,
  type: 'usage.reported',
  status: null,
  privacyClass: 'L0',
  occurredAt: new Date(receivedAt),
  receivedAt: new Date(receivedAt),
  usageDelta: { cost_usd: costUsd },
  ...extra,
});

const spend = (s: Scope, costUsd: number, receivedAt = '2026-10-10T08:00:00Z') =>
  events.insertEvents([usage(s, receivedAt, costUsd)]);

const alertRows = async (projectId: string) =>
  (
    await ctx.client.query<{
      id: string;
      month: string;
      threshold: number;
      status: string;
      attempts: number;
      sent_at: Date | null;
    }>(
      `select id, to_char(month, 'YYYY-MM-DD') as month, threshold, status, attempts, sent_at
         from budget_alerts where project_id = $1 order by month, threshold`,
      [projectId],
    )
  ).rows;

describe('status: month-to-date spend', () => {
  it('sums cost_usd of usage.reported received in [UTC month start, now] only', async () => {
    const s = await setup();
    await events.insertEvents([
      // Last month by 1 ms: excluded.
      usage(s, '2026-09-30T23:59:59.999Z', 5),
      // First instant of the month: included.
      usage(s, '2026-10-01T00:00:00.000Z', 1.25),
      usage(s, '2026-10-10T08:00:00Z', 2.5, { usageDelta: { cost_usd: 2.5, estimated: true } }),
      usage(s, '2026-10-12T08:00:00Z', 0.000001),
      // Not usage: excluded even with a cost.
      usage(s, '2026-10-12T09:00:00Z', 100, { type: 'heartbeat', status: 'working' }),
      // A non-numeric cost counts as 0 but is still a report.
      usage(s, '2026-10-13T08:00:00Z', '3'),
      // After the (pinned) clock: excluded.
      usage(s, '2026-10-20T12:00:00.001Z', 7),
    ]);
    expect(await budgets.status(s.workspaceId, s.projectId, { now: NOW })).toEqual({
      projectId: s.projectId,
      limitUsd: null,
      month: '2026-10',
      spendUsd: 3.750001,
      percentUsed: null,
      // 3.750001 × 31 / 19.5 days
      forecastUsd: 5.96,
      reports: 4,
      estimatedReports: 1,
      alerted: [],
      generatedAt: '2026-10-20T12:00:00.000Z',
    });

    await budgets.setBudget(s.workspaceId, s.projectId, 10, randomUUID());
    expect(await budgets.status(s.workspaceId, s.projectId, { now: NOW })).toMatchObject({
      limitUsd: 10,
      percentUsed: 37.5,
    });
  });

  it('has no forecast during the first 24 h and starts again at the next month', async () => {
    const s = await setup();
    await spend(s, 4, '2026-10-31T10:00:00Z');
    await spend(s, 1, '2026-11-01T00:00:00Z');
    expect(
      await budgets.status(s.workspaceId, s.projectId, at('2026-11-01T23:59:59Z')),
    ).toMatchObject({ month: '2026-11', spendUsd: 1, reports: 1, forecastUsd: null });
    expect(
      await budgets.status(s.workspaceId, s.projectId, at('2026-11-02T00:00:00Z')),
    ).toMatchObject({ spendUsd: 1, forecastUsd: 30 });
  });

  it('uses the database clock when none is pinned', async () => {
    const s = await setup();
    const before = Date.now();
    const st = await budgets.status(s.workspaceId, s.projectId);
    const generated = Date.parse(st!.generatedAt);
    expect(generated).toBeGreaterThanOrEqual(before - 5_000);
    expect(generated).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(st!.month).toBe(st!.generatedAt.slice(0, 7));
  });
});

describe('isolation', () => {
  it('never reads, sets or clears a project of another workspace', async () => {
    const a = await setup('A team');
    const b = await setup('B team');
    await budgets.setBudget(a.workspaceId, a.projectId, 10, randomUUID());
    await spend(a, 3);

    expect(await budgets.status(b.workspaceId, a.projectId, { now: NOW })).toBeNull();
    await expect(budgets.setBudget(b.workspaceId, a.projectId, 1, randomUUID())).rejects.toThrow(
      ProjectRepositoryError,
    );
    await expect(
      budgets.setBudget(b.workspaceId, a.projectId, 1, randomUUID()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await budgets.clearBudget(b.workspaceId, a.projectId);
    expect(await budgets.statuses(b.workspaceId, { now: NOW })).toEqual([]);
    expect(await budgets.claimAlert({ workspaceId: b.workspaceId, projectId: a.projectId })).toBe(
      null,
    );
    // A's budget is untouched.
    expect(await budgets.status(a.workspaceId, a.projectId, { now: NOW })).toMatchObject({
      limitUsd: 10,
      spendUsd: 3,
    });
  });

  it('treats malformed ids as not found instead of a database error', async () => {
    const a = await setup();
    expect(await budgets.status('nope', a.projectId)).toBeNull();
    expect(await budgets.status(a.workspaceId, 'nope')).toBeNull();
    expect(await budgets.statuses('nope')).toEqual([]);
    await expect(budgets.setBudget(a.workspaceId, 'nope', 5, randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await budgets.claimAlert({ workspaceId: a.workspaceId, projectId: 'nope' })).toBeNull();
  });
});

describe('setBudget / clearBudget / statuses', () => {
  it('upserts with updated_by and updated_at, then clears', async () => {
    const s = await setup();
    const u1 = randomUUID();
    const u2 = randomUUID();
    await budgets.setBudget(s.workspaceId, s.projectId, 50, u1);
    await budgets.setBudget(s.workspaceId, s.projectId, 75.5, u2);
    const { rows } = await ctx.client.query<{ limit: string; updated_by: string; n: number }>(
      `select monthly_limit_usd::text as limit, updated_by, count(*) over ()::int as n
         from project_budgets where project_id = $1`,
      [s.projectId],
    );
    expect(rows).toEqual([{ limit: '75.50', updated_by: u2, n: 1 }]);
    expect((await budgets.status(s.workspaceId, s.projectId, { now: NOW }))!.limitUsd).toBe(75.5);

    await budgets.clearBudget(s.workspaceId, s.projectId);
    expect((await budgets.status(s.workspaceId, s.projectId, { now: NOW }))!.limitUsd).toBeNull();
    // Clearing again is a no-op.
    await budgets.clearBudget(s.workspaceId, s.projectId);
  });

  it('accepts 0.01 and 1 000 000; refuses ≤ 0, > 1 000 000, > 2 decimals and non-finite', async () => {
    const s = await setup();
    await budgets.setBudget(s.workspaceId, s.projectId, 0.01, randomUUID());
    await budgets.setBudget(s.workspaceId, s.projectId, 1_000_000, randomUUID());
    for (const bad of [0, -1, 1_000_000.01, 1.005, 0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        budgets.setBudget(s.workspaceId, s.projectId, bad, randomUUID()),
      ).rejects.toThrow(RangeError);
    }
    expect((await budgets.status(s.workspaceId, s.projectId, { now: NOW }))!.limitUsd).toBe(
      1_000_000,
    );
  });

  it('lists every budgeted project of the workspace, ordered by name, in one query', async () => {
    const s = await setup('A team', 'Zeta');
    const alpha = await addProject(s.workspaceId, 'Alpha');
    await addProject(s.workspaceId, 'No budget');
    const other = await setup('B team', 'Other');
    await budgets.setBudget(s.workspaceId, s.projectId, 20, randomUUID());
    await budgets.setBudget(s.workspaceId, alpha.projectId, 10, randomUUID());
    await budgets.setBudget(other.workspaceId, other.projectId, 10, randomUUID());
    await spend(s, 5);
    await spend(alpha, 9);

    const execute = vi.spyOn(ctx.db, 'execute');
    const list = await budgets.statuses(s.workspaceId, { now: NOW });
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockRestore();

    expect(list.map((x) => [x.projectId, x.limitUsd, x.spendUsd, x.percentUsed])).toEqual([
      [alpha.projectId, 10, 9, 90],
      [s.projectId, 20, 5, 25],
    ]);
  });
});

describe('claimAlert: exactly once per (project, month, threshold)', () => {
  const budgeted = async (limit: number, cost: number) => {
    const s = await setup();
    await member(s.workspaceId, 'owner@example.com', 'owner');
    await budgets.setBudget(s.workspaceId, s.projectId, limit, randomUUID());
    if (cost > 0) await spend(s, cost);
    return s;
  };

  it('returns null without a budget, or below 80 %', async () => {
    const s = await setup();
    await member(s.workspaceId, 'owner@example.com', 'owner');
    await spend(s, 50);
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    await budgets.setBudget(s.workspaceId, s.projectId, 62.51, randomUUID());
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    expect(await alertRows(s.projectId)).toEqual([]);
  });

  it('gives exactly one job to 5 concurrent claims, then none after it was sent', async () => {
    const s = await budgeted(10, 8.5);
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () => budgets.claimAlert(s, { now: NOW })),
    );
    const claimed = jobs.filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
    const job = claimed[0]!;
    expect(job).toMatchObject({
      projectId: s.projectId,
      workspaceId: s.workspaceId,
      projectName: 'Web',
      projectSlug: s.slug,
      threshold: 80,
      recipients: ['owner@example.com'],
      status: { limitUsd: 10, spendUsd: 8.5, percentUsed: 85, month: '2026-10', alerted: [] },
    });
    expect(await alertRows(s.projectId)).toMatchObject([
      { id: job.alertId, month: '2026-10-01', threshold: 80, status: 'pending', attempts: 1 },
    ]);

    await budgets.markAlert(job.alertId, 'sent');
    const [row] = await alertRows(s.projectId);
    expect(row).toMatchObject({ status: 'sent' });
    expect(row!.sent_at).toBeInstanceOf(Date);
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    expect((await budgets.status(s.workspaceId, s.projectId, { now: NOW }))!.alerted).toEqual([80]);
  });

  it('jumping straight to 100 % sends one 100 alert and records 80 as covered', async () => {
    const s = await budgeted(10, 12);
    const jobs = await Promise.all(
      Array.from({ length: 5 }, () => budgets.claimAlert(s, { now: NOW })),
    );
    const claimed = jobs.filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ threshold: 100, status: { alerted: [80] } });
    expect(await alertRows(s.projectId)).toMatchObject([
      { threshold: 80, status: 'covered' },
      { threshold: 100, status: 'pending' },
    ]);
    await budgets.markAlert(claimed[0]!.alertId, 'sent');
    expect((await budgets.status(s.workspaceId, s.projectId, { now: NOW }))!.alerted).toEqual([
      80, 100,
    ]);
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
  });

  it('never downgrades a sent 80 to covered; a failed 80 becomes covered once 100 is crossed', async () => {
    const sent = await budgeted(10, 8);
    await budgets.markAlert((await budgets.claimAlert(sent, { now: NOW }))!.alertId, 'sent');
    await spend(sent, 2);
    expect(await budgets.claimAlert(sent, { now: NOW })).toMatchObject({ threshold: 100 });
    expect(await alertRows(sent.projectId)).toMatchObject([
      { threshold: 80, status: 'sent' },
      { threshold: 100, status: 'pending' },
    ]);

    await ctx.client.exec('truncate workspaces, users cascade');
    const failed = await budgeted(10, 8);
    await budgets.markAlert((await budgets.claimAlert(failed, { now: NOW }))!.alertId, 'failed');
    await spend(failed, 2);
    expect(await budgets.claimAlert(failed, { now: NOW })).toMatchObject({ threshold: 100 });
    expect(await alertRows(failed.projectId)).toMatchObject([
      { threshold: 80, status: 'covered' },
      { threshold: 100, status: 'pending' },
    ]);
  });

  it('does not re-alert a threshold after the limit is raised mid-month', async () => {
    const s = await budgeted(10, 8.5);
    await budgets.markAlert((await budgets.claimAlert(s, { now: NOW }))!.alertId, 'sent');
    await budgets.setBudget(s.workspaceId, s.projectId, 20, randomUUID());
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    // 85 % of the new limit: 80 was already sent this month.
    await spend(s, 8.5);
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    // 100 % of the new limit has not been alerted yet.
    await spend(s, 3);
    expect(await budgets.claimAlert(s, { now: NOW })).toMatchObject({ threshold: 100 });
    expect(await alertRows(s.projectId)).toHaveLength(2);
  });

  it('retries a failed alert on later claims, up to 5 attempts in total', async () => {
    const s = await budgeted(10, 9);
    const first = await budgets.claimAlert(s, { now: NOW });
    for (let attempt = 2; attempt <= 5; attempt++) {
      await budgets.markAlert(first!.alertId, 'failed');
      const retry = await budgets.claimAlert(s, { now: NOW });
      expect(retry).toMatchObject({ alertId: first!.alertId, threshold: 80 });
      expect((await alertRows(s.projectId))[0]).toMatchObject({
        status: 'pending',
        attempts: attempt,
      });
    }
    await budgets.markAlert(first!.alertId, 'failed');
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    expect(await alertRows(s.projectId)).toMatchObject([{ status: 'failed', attempts: 5 }]);
  });

  it('reclaims a pending claim only once it is older than 10 minutes', async () => {
    const s = await budgeted(10, 9);
    const first = await budgets.claimAlert(s, at('2026-10-20T12:00:00Z'));
    expect(first).not.toBeNull();
    expect(await budgets.claimAlert(s, at('2026-10-20T12:09:59Z'))).toBeNull();
    expect(await budgets.claimAlert(s, at('2026-10-20T12:10:00Z'))).toBeNull();
    const reclaimed = await budgets.claimAlert(s, at('2026-10-20T12:10:01Z'));
    expect(reclaimed).toMatchObject({ alertId: first!.alertId });
    expect(await alertRows(s.projectId)).toMatchObject([{ status: 'pending', attempts: 2 }]);
    // The reclaim restarted the clock.
    expect(await budgets.claimAlert(s, at('2026-10-20T12:15:00Z'))).toBeNull();
  });

  it('a failed mark never turns a sent row back into a retryable one', async () => {
    const s = await budgeted(10, 9);
    const job = await budgets.claimAlert(s, { now: NOW });
    await budgets.markAlert(job!.alertId, 'sent');
    await budgets.markAlert(job!.alertId, 'failed');
    expect(await alertRows(s.projectId)).toMatchObject([{ status: 'sent' }]);
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
  });

  it('alerts again in the next UTC month', async () => {
    const s = await budgeted(10, 0);
    await spend(s, 9, '2026-09-15T00:00:00Z');
    await budgets.markAlert(
      (await budgets.claimAlert(s, at('2026-09-20T00:00:00Z')))!.alertId,
      'sent',
    );
    expect(await budgets.claimAlert(s, at('2026-10-02T00:00:00Z'))).toBeNull();
    await spend(s, 9, '2026-10-02T00:00:00Z');
    expect(await budgets.claimAlert(s, at('2026-10-03T00:00:00Z'))).toMatchObject({
      threshold: 80,
      status: { month: '2026-10' },
    });
    expect((await alertRows(s.projectId)).map((r) => r.month)).toEqual([
      '2026-09-01',
      '2026-10-01',
    ]);
  });
});

describe('claimAlert recipients', () => {
  it('are the verified owners of that workspace only', async () => {
    const s = await setup('A team');
    const other = await setup('B team');
    await member(s.workspaceId, 'b-owner@example.com', 'owner');
    await member(s.workspaceId, 'a-owner@example.com', 'owner');
    await member(s.workspaceId, 'unverified-owner@example.com', 'owner', false);
    await member(s.workspaceId, 'admin@example.com', 'admin');
    await member(s.workspaceId, 'member@example.com', 'member');
    await member(other.workspaceId, 'other-owner@example.com', 'owner');
    await budgets.setBudget(s.workspaceId, s.projectId, 10, randomUUID());
    await spend(s, 10);
    expect((await budgets.claimAlert(s, { now: NOW }))!.recipients).toEqual([
      'a-owner@example.com',
      'b-owner@example.com',
    ]);
  });

  it('without a verified owner nothing is claimed; a later claim works once one exists', async () => {
    const s = await setup();
    await member(s.workspaceId, 'unverified-owner@example.com', 'owner', false);
    await member(s.workspaceId, 'admin@example.com', 'admin');
    await budgets.setBudget(s.workspaceId, s.projectId, 10, randomUUID());
    await spend(s, 10);
    expect(await budgets.claimAlert(s, { now: NOW })).toBeNull();
    expect(await alertRows(s.projectId)).toEqual([]);

    await ctx.client.query(`update users set email_verified = true where email = $1`, [
      'unverified-owner@example.com',
    ]);
    expect(await budgets.claimAlert(s, { now: NOW })).toMatchObject({
      threshold: 100,
      recipients: ['unverified-owner@example.com'],
    });
  });
});

describe('retentionCutoff keeps the current UTC month (ADR-0014)', () => {
  it.each([
    // Day 31 of a 31-day month: 30 days back would cut into day 1.
    ['2026-10-31T12:00:00Z', '2026-10-01T00:00:00.000Z'],
    ['2026-10-31T23:59:59.999Z', '2026-10-01T00:00:00.000Z'],
    // Exactly 30 days after the month start: both rules agree.
    ['2026-10-31T00:00:00Z', '2026-10-01T00:00:00.000Z'],
    // Day 30: plain 30 days still ends before the month start.
    ['2026-10-30T23:59:59Z', '2026-09-30T23:59:59.000Z'],
    // Mid-month: plain 30 days.
    ['2026-10-20T12:00:00Z', '2026-09-20T12:00:00.000Z'],
    ['2026-10-23T20:00:00Z', '2026-09-23T20:00:00.000Z'],
    // Short months: 30 days already reaches into the previous month.
    ['2027-03-01T10:00:00Z', '2027-01-30T10:00:00.000Z'],
    ['2028-02-29T23:59:59Z', '2028-01-30T23:59:59.000Z'],
  ])('now %s → cutoff %s', (now, cutoff) => {
    expect(retentionCutoff(new Date(now)).toISOString()).toBe(cutoff);
  });

  it('on day 31 the purge keeps day 1, so month-to-date spend is complete', async () => {
    const s = await setup();
    await events.insertEvents([
      usage(s, '2026-09-30T23:59:59.999Z', 100),
      usage(s, '2026-10-01T00:00:00.000Z', 1.5),
      usage(s, '2026-10-30T00:00:00Z', 2),
    ]);
    const now = new Date('2026-10-31T23:00:00Z');
    expect(await events.purgeEventsBefore(retentionCutoff(now), now)).toMatchObject({
      deleted: 1,
    });
    expect(await budgets.status(s.workspaceId, s.projectId, { now })).toMatchObject({
      spendUsd: 3.5,
      reports: 2,
    });
  });
});
