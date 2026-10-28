// Private SQL for the JD-M08 reader (ADR-0013). Not exported from the module's public index.
// Every events query is scoped by `workspace_id` and bounded to `[from 00:00 UTC, now]` on
// `received_at`, which `events_workspace_received_idx (workspace_id, received_at)` serves.
// Raw `db.execute` + `rowsOf` works on neon-http and PGlite (same as JD-M07). Times leave the
// database as epoch milliseconds and money as numeric rounded to 6 decimals, then float8.
import type { AnyDb } from '@javis-dog/event-store';
import { sql, type SQL } from 'drizzle-orm';

// neon-http and PGlite both return `{ rows }` (same accessor as JD-M06 client.ts).
const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

/** Epoch milliseconds (whole ms) of a timestamptz expression, null-preserving. */
const epochMs = (expr: SQL) => sql`floor(extract(epoch from ${expr}) * 1000)::float8`;

/** Numeric value of a `usage_delta` key; a missing or non-numeric value counts as 0. */
const usageNumber = (key: string) =>
  sql`case when jsonb_typeof(e.usage_delta -> ${key}) = 'number'
           then (e.usage_delta ->> ${key})::numeric else 0 end`;

/** Exact numeric sums leave as float8; cost is rounded to 6 decimals first (no float noise). */
const USAGE_SUMS = sql`
  coalesce(sum(${usageNumber('input_tokens')}), 0)::float8 as input_tokens,
  coalesce(sum(${usageNumber('output_tokens')}), 0)::float8 as output_tokens,
  coalesce(sum(${usageNumber('cache_read_tokens')}), 0)::float8 as cache_read_tokens,
  coalesce(sum(${usageNumber('cache_write_tokens')}), 0)::float8 as cache_write_tokens,
  coalesce(round(sum(${usageNumber('cost_usd')}), 6), 0)::float8 as cost_usd,
  count(*)::int as reports`;

export interface Range {
  workspaceId: string;
  /** Narrows every figure to one project; the workspace filter still applies. */
  projectId?: string;
  /** Inclusive start: 00:00:00.000 UTC of the first day, ISO. */
  fromIso: string;
  /** Inclusive end: the reader clock, ISO. */
  nowIso: string;
}

/** `e` is in the workspace (and project, if any) and received inside `[from, now]`. */
const inRange = (r: Range) => {
  const base = sql`e.workspace_id = ${r.workspaceId}::uuid
      and e.received_at >= ${r.fromIso}::timestamptz
      and e.received_at <= ${r.nowIso}::timestamptz`;
  return r.projectId === undefined ? base : sql`${base} and e.project_id = ${r.projectId}::uuid`;
};

const IS_USAGE = sql`e.type = 'usage.reported'`;

/** Query 0 (only when no clock is pinned): the database clock, truncated to whole ms. */
export const readDbNow = async (db: AnyDb): Promise<number> => {
  const [row] = rowsOf<{ now_ms: number | string }>(
    await db.execute(sql`select ${epochMs(sql`now()`)} as now_ms`),
  );
  return Number(row?.now_ms);
};

type Num = number | string;

export interface UsageSumsRow {
  input_tokens: Num;
  output_tokens: Num;
  cache_read_tokens: Num;
  cache_write_tokens: Num;
  cost_usd: Num;
  reports: Num;
}

export interface DayRow extends UsageSumsRow {
  /** UTC date `YYYY-MM-DD`; null on the grand-total row. */
  day: string | null;
  is_total: boolean;
  tasks_completed: Num;
  tasks_failed: Num;
  last_report_ms: Num | null;
}

/**
 * Query 1: one row per UTC day with events, plus a grand-total row (`grouping sets ((day), ())`)
 * so the range cost is rounded once from the exact sum. Usage sums count `usage.reported` only.
 */
export const readDays = async (db: AnyDb, r: Range): Promise<DayRow[]> =>
  rowsOf<DayRow>(
    await db.execute(sql`
      select d.day, grouping(d.day) = 1 as is_total,
             coalesce(sum(d.input_tokens) filter (where d.is_usage), 0)::float8 as input_tokens,
             coalesce(sum(d.output_tokens) filter (where d.is_usage), 0)::float8 as output_tokens,
             coalesce(sum(d.cache_read_tokens) filter (where d.is_usage), 0)::float8
               as cache_read_tokens,
             coalesce(sum(d.cache_write_tokens) filter (where d.is_usage), 0)::float8
               as cache_write_tokens,
             coalesce(round(sum(d.cost_usd) filter (where d.is_usage), 6), 0)::float8 as cost_usd,
             (count(*) filter (where d.is_usage))::int as reports,
             (count(*) filter (where d.type = 'task.completed'))::int as tasks_completed,
             (count(*) filter (where d.type = 'task.failed'))::int as tasks_failed,
             ${epochMs(sql`max(d.received_at) filter (where d.is_usage)`)} as last_report_ms
        from (select to_char(e.received_at at time zone 'UTC', 'YYYY-MM-DD') as day,
                     e.type, e.received_at, ${IS_USAGE} as is_usage,
                     ${usageNumber('input_tokens')} as input_tokens,
                     ${usageNumber('output_tokens')} as output_tokens,
                     ${usageNumber('cache_read_tokens')} as cache_read_tokens,
                     ${usageNumber('cache_write_tokens')} as cache_write_tokens,
                     ${usageNumber('cost_usd')} as cost_usd
                from events e
               where ${inRange(r)}
                 and e.type in ('usage.reported', 'task.completed', 'task.failed')) d
       group by grouping sets ((d.day), ())`),
  );

export interface ModelRow extends UsageSumsRow {
  model: string | null;
}

/** Query 2: usage per `usage_delta.model` (null when the report carried none). */
export const readByModel = async (db: AnyDb, r: Range): Promise<ModelRow[]> =>
  rowsOf<ModelRow>(
    await db.execute(sql`
      select e.usage_delta ->> 'model' as model, ${USAGE_SUMS}
        from events e
       where ${inRange(r)} and ${IS_USAGE}
       group by e.usage_delta ->> 'model'`),
  );

export interface ProjectRow extends UsageSumsRow {
  project_id: string;
  slug: string;
  name: string;
}

/** Query 3: usage per project; the join re-checks that the project belongs to the workspace. */
export const readByProject = async (db: AnyDb, r: Range): Promise<ProjectRow[]> =>
  rowsOf<ProjectRow>(
    await db.execute(sql`
      select e.project_id, p.slug, p.name, ${USAGE_SUMS}
        from events e
        join projects p on p.id = e.project_id and p.workspace_id = e.workspace_id
       where ${inRange(r)} and ${IS_USAGE} and p.workspace_id = ${r.workspaceId}::uuid
       group by e.project_id, p.slug, p.name`),
  );
