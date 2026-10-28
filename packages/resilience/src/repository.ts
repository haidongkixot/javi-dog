import { ProjectRepositoryError } from '@javis-dog/projects';
import { sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  crossedThreshold,
  forecastSpend,
  MAX_MONTHLY_LIMIT_USD,
  percentOfLimit,
  utcMonth,
} from './budget.ts';
import type { BudgetThreshold } from './budget.ts';
import type { BudgetAlertJob, BudgetStatus } from './types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- composed schema type lives in JD-M06
export type BudgetDb = PgDatabase<PgQueryResultHKT, any>;

// Raw SQL by table name: `events` belongs to JD-M06, which depends on this module (no import
// cycle), and the identity tables are read without loading the auth runtime. Single statements
// only — neon-http has no interactive transactions (ADR-0008); every write is atomic on its own.

/** neon-http and PGlite both return `{ rows }` (same accessor as JD-M06 and JD-M08). */
const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string) => UUID_RE.test(v);

/** A failed or stale pending claim is retried until a row has this many attempts. */
const MAX_ALERT_ATTEMPTS = 5;
/** A pending claim older than this is considered abandoned (the sender died). */
const STALE_PENDING = sql`interval '10 minutes'`;

/** The database clock, unless a test or a caller pins it. */
const clockOf = (now: Date | undefined): SQL =>
  now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

type Num = number | string;

interface StatusRow {
  project_id: string;
  name: string;
  slug: string;
  limit_usd: Num | null;
  now_ms: Num;
  spend_usd: Num;
  reports: Num;
  estimated_reports: Num;
  /** This month's `budget_alerts` status and attempts per threshold; null without a row. */
  status_80: AlertRowStatus | null;
  status_100: AlertRowStatus | null;
  attempts_80: Num | null;
  attempts_100: Num | null;
}

type AlertRowStatus = 'pending' | 'sent' | 'failed' | 'covered';

/**
 * Status rows for the workspace's projects (one, or every budgeted one) in ONE statement.
 * Spend: `usage.reported` events of the project received in `[UTC month start, now]`; a missing
 * or non-numeric `cost_usd` counts as 0 (same rule as JD-M08); the exact numeric sum is rounded
 * to 6 decimals before it leaves the database.
 */
const statusQuery = (
  workspaceId: string,
  clock: SQL,
  only: { projectId: string } | { budgeted: true },
) => {
  const filter =
    'projectId' in only
      ? sql`and p.id = ${only.projectId}::uuid`
      : sql`and b.project_id is not null`;
  return sql`
    with clock as (select ${clock} as now),
         win as (
           select now,
                  date_trunc('month', now at time zone 'UTC') at time zone 'UTC' as start,
                  date_trunc('month', now at time zone 'UTC')::date as month
             from clock)
    select p.id as project_id, p.name, p.slug,
           b.monthly_limit_usd as limit_usd,
           floor(extract(epoch from win.now) * 1000)::float8 as now_ms,
           u.spend_usd, u.reports, u.estimated_reports,
           al.status_80, al.status_100, al.attempts_80, al.attempts_100
      from projects p
      cross join win
      left join project_budgets b on b.project_id = p.id and b.workspace_id = p.workspace_id
      cross join lateral (
        select coalesce(round(sum(case when jsonb_typeof(e.usage_delta -> 'cost_usd') = 'number'
                                       then (e.usage_delta ->> 'cost_usd')::numeric else 0 end),
                              6), 0)::float8 as spend_usd,
               count(*)::int as reports,
               (count(*) filter (
                  where coalesce(e.usage_delta -> 'estimated' = 'true'::jsonb, false)))::int
                 as estimated_reports
          from events e
         where e.workspace_id = p.workspace_id
           and e.project_id = p.id
           and e.type = 'usage.reported'
           and e.received_at >= win.start
           and e.received_at <= win.now) u
      cross join lateral (
        -- At most one row per threshold (unique key), so max() just picks it.
        select max(a.status) filter (where a.threshold = 80) as status_80,
               max(a.status) filter (where a.threshold = 100) as status_100,
               max(a.attempts) filter (where a.threshold = 80) as attempts_80,
               max(a.attempts) filter (where a.threshold = 100) as attempts_100
          from budget_alerts a
         where a.project_id = p.id and a.month = win.month) al
     where p.workspace_id = ${workspaceId}::uuid ${filter}
     order by p.name, p.id`;
};

/**
 * Alert fields from this month's rows. `alerted` only claims emails that were sent: a covered
 * 80 counts once the 100 email it was folded into was sent (ADR-0014 Changes, S4c review).
 */
const alertFields = (row: StatusRow) => {
  const rows = [
    { threshold: 80, status: row.status_80, attempts: Number(row.attempts_80 ?? 0) },
    { threshold: 100, status: row.status_100, attempts: Number(row.attempts_100 ?? 0) },
  ] as const;
  const where = (keep: (r: (typeof rows)[number]) => boolean): BudgetThreshold[] =>
    rows.filter(keep).map((r) => r.threshold);
  const sent100 = row.status_100 === 'sent';
  return {
    alerted: where(
      (r) => r.status === 'sent' || (r.threshold === 80 && r.status === 'covered' && sent100),
    ),
    pendingAlerts: where((r) => r.status === 'pending'),
    failedAlerts: where((r) => r.status === 'failed'),
    exhaustedAlerts: where((r) => r.status === 'failed' && r.attempts >= MAX_ALERT_ATTEMPTS),
  };
};

const toStatus = (row: StatusRow): BudgetStatus => {
  const now = new Date(Number(row.now_ms));
  const spendUsd = Number(row.spend_usd);
  const limitUsd = row.limit_usd === null ? null : Number(row.limit_usd);
  return {
    projectId: row.project_id,
    limitUsd,
    month: utcMonth(now).key,
    spendUsd,
    percentUsed: limitUsd === null ? null : percentOfLimit(spendUsd, limitUsd),
    thresholdReached: limitUsd === null ? null : crossedThreshold(spendUsd, limitUsd),
    forecastUsd: forecastSpend(spendUsd, now),
    reports: Number(row.reports),
    estimatedReports: Number(row.estimated_reports),
    ...alertFields(row),
    generatedAt: now.toISOString(),
  };
};

/**
 * The job's status as of its own claim: the claimed threshold is pending (no longer failed) and,
 * at 100 %, a pending or failed 80 is now covered. `alerted` is unchanged — nothing new was sent.
 */
const afterClaim = (status: BudgetStatus, threshold: BudgetThreshold): BudgetStatus => {
  const settled = (t: BudgetThreshold) => t === threshold || (threshold === 100 && t === 80);
  return {
    ...status,
    pendingAlerts: [threshold],
    failedAlerts: status.failedAlerts.filter((t) => !settled(t)),
    exhaustedAlerts: status.exhaustedAlerts.filter((t) => !settled(t)),
  };
};

/** 0 < x ≤ 1 000 000 with at most two decimals (ADR-0014, `numeric(12,2)`). */
const assertLimit = (limitUsd: number) => {
  if (
    typeof limitUsd !== 'number' ||
    !Number.isFinite(limitUsd) ||
    limitUsd <= 0 ||
    limitUsd > MAX_MONTHLY_LIMIT_USD ||
    Number(limitUsd.toFixed(2)) !== limitUsd
  ) {
    throw new RangeError(
      'monthly limit must be greater than 0 and at most 1000000 USD, with at most 2 decimals.',
    );
  }
};

export const createBudgetRepository = (db: BudgetDb) => {
  const readStatus = async (workspaceId: string, projectId: string, now: Date | undefined) => {
    if (!isUuid(workspaceId) || !isUuid(projectId)) return null;
    const [row] = rowsOf<StatusRow>(
      await db.execute(statusQuery(workspaceId, clockOf(now), { projectId })),
    );
    return row ?? null;
  };

  return {
    /** The project's budget status; the project must belong to the workspace (else null). */
    async status(
      workspaceId: string,
      projectId: string,
      opts: { now?: Date } = {},
    ): Promise<BudgetStatus | null> {
      const row = await readStatus(workspaceId, projectId, opts.now);
      return row ? toStatus(row) : null;
    },

    /** Status for every project of the workspace that has a budget (projects list). One query. */
    async statuses(workspaceId: string, opts: { now?: Date } = {}): Promise<BudgetStatus[]> {
      if (!isUuid(workspaceId)) return [];
      const rows = rowsOf<StatusRow>(
        await db.execute(statusQuery(workspaceId, clockOf(opts.now), { budgeted: true })),
      );
      return rows.map(toStatus);
    },

    /**
     * Sets (or replaces) the monthly limit. Throws RangeError outside 0 < x ≤ 1 000 000 (or with
     * more than 2 decimals) and `ProjectRepositoryError('not_found')` when the project is not in
     * the workspace. One statement: the insert selects the project scoped by workspace.
     */
    async setBudget(
      workspaceId: string,
      projectId: string,
      limitUsd: number,
      userId: string,
    ): Promise<void> {
      assertLimit(limitUsd);
      if (!isUuid(workspaceId) || !isUuid(projectId)) throw new ProjectRepositoryError('not_found');
      const updatedBy = isUuid(userId) ? userId : null;
      const rows = rowsOf<{ project_id: string }>(
        await db.execute(sql`
          insert into project_budgets
                 (project_id, workspace_id, monthly_limit_usd, updated_by, updated_at)
          select p.id, p.workspace_id, ${limitUsd.toFixed(2)}::numeric, ${updatedBy}::uuid, now()
            from projects p
           where p.id = ${projectId}::uuid and p.workspace_id = ${workspaceId}::uuid
          on conflict (project_id) do update
             set monthly_limit_usd = excluded.monthly_limit_usd,
                 updated_by = excluded.updated_by,
                 updated_at = excluded.updated_at
          returning project_id`),
      );
      if (rows.length === 0) throw new ProjectRepositoryError('not_found');
    },

    /** Removes the budget; a project outside the workspace (or without a budget) is a no-op. */
    async clearBudget(workspaceId: string, projectId: string): Promise<void> {
      if (!isUuid(workspaceId) || !isUuid(projectId)) return;
      await db.execute(sql`
        delete from project_budgets
         where project_id = ${projectId}::uuid and workspace_id = ${workspaceId}::uuid`);
    },

    /**
     * After ingest: if the project has a budget and a threshold is newly crossed (or a failed /
     * stale pending alert can be retried), claims it exactly once and returns the job to send;
     * marks lower thresholds `covered`. Returns null when there is nothing to send.
     *
     * Also null — without claiming — when the workspace has no owner with a verified email: a
     * claim nobody can receive would burn the alert; the next usage report after an owner
     * verifies their email claims it then.
     */
    async claimAlert(
      scope: { workspaceId: string; projectId: string },
      opts: { now?: Date } = {},
    ): Promise<BudgetAlertJob | null> {
      if (!isUuid(scope.workspaceId) || !isUuid(scope.projectId)) return null;
      // Most ingested projects have no budget: one primary-key lookup, and the month-to-date
      // aggregate below only runs for a budgeted project of this workspace.
      const budgeted = rowsOf<{ one: number }>(
        await db.execute(sql`
          select 1 as one from project_budgets
           where project_id = ${scope.projectId}::uuid
             and workspace_id = ${scope.workspaceId}::uuid`),
      );
      if (budgeted.length === 0) return null;

      const row = await readStatus(scope.workspaceId, scope.projectId, opts.now);
      if (!row || row.limit_usd === null) return null;
      const status = toStatus(row);
      const threshold = status.thresholdReached;
      if (threshold === null) return null;

      const recipients = rowsOf<{ email: string }>(
        await db.execute(sql`
          select u.email
            from workspace_members m
            join users u on u.id = m.user_id
           where m.workspace_id = ${scope.workspaceId}::uuid
             and m.role = 'owner'
             and u.email_verified = true
           order by u.email`),
      ).map((r) => r.email);
      if (recipients.length === 0) return null;

      const clock = clockOf(opts.now);
      const month = `${status.month}-01`;
      const insert = sql`
        insert into budget_alerts (project_id, month, threshold, status, claimed_at)
        values (${scope.projectId}::uuid, ${month}::date, ${threshold}, 'pending', ${clock})
        on conflict (project_id, month, threshold) do nothing
        returning id`;
      // Crossing 100 % covers 80 % (never downgrading a sent row) in the same statement.
      const claim =
        threshold === 100
          ? sql`
            with covered as (
              insert into budget_alerts (project_id, month, threshold, status, claimed_at)
              values (${scope.projectId}::uuid, ${month}::date, 80, 'covered', ${clock})
              on conflict (project_id, month, threshold) do update
                 set status = 'covered'
               where budget_alerts.status in ('pending', 'failed')
              returning id)
            ${insert}`
          : insert;
      let [claimed] = rowsOf<{ id: string }>(await db.execute(claim));
      if (!claimed) {
        [claimed] = rowsOf<{ id: string }>(
          await db.execute(sql`
            update budget_alerts
               set status = 'pending', claimed_at = ${clock}, attempts = attempts + 1
             where project_id = ${scope.projectId}::uuid
               and month = ${month}::date
               and threshold = ${threshold}
               and attempts < ${MAX_ALERT_ATTEMPTS}
               and (status = 'failed'
                    or (status = 'pending' and claimed_at < ${clock} - ${STALE_PENDING}))
            returning id`),
        );
      }
      if (!claimed) return null;

      return {
        alertId: claimed.id,
        projectId: row.project_id,
        workspaceId: scope.workspaceId,
        projectName: row.name,
        projectSlug: row.slug,
        threshold,
        status: afterClaim(status, threshold),
        recipients,
      };
    },

    /**
     * Records the send outcome of a claimed alert. `failed` only applies to a row that is still
     * pending, so it never turns a sent or covered row back into a retryable one.
     */
    async markAlert(alertId: string, outcome: 'sent' | 'failed'): Promise<void> {
      if (!isUuid(alertId)) return;
      await db.execute(
        outcome === 'sent'
          ? sql`update budget_alerts set status = 'sent', sent_at = now()
                 where id = ${alertId}::uuid`
          : sql`update budget_alerts set status = 'failed'
                 where id = ${alertId}::uuid and status = 'pending'`,
      );
    },
  };
};

export type BudgetRepository = ReturnType<typeof createBudgetRepository>;
