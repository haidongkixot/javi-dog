// Private SQL for the JD-M07 reader (ADR-0012). Not exported from the module's public index.
// Every query is scoped by `workspace_id` (events and projects) and, for events, bounded to the
// snapshot window `(now − 24 h, now]`. Raw `db.execute` + `rowsOf` works on neon-http and PGlite.
// Times leave the database as epoch milliseconds (float8), so no driver-specific timestamp
// parsing is involved.
import type { AnyDb } from '@javis-dog/event-store';
import { sql, type SQL } from 'drizzle-orm';

// neon-http and PGlite both return `{ rows }` (same accessor as JD-M06 client.ts).
const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

/** Epoch milliseconds (whole ms) of a timestamptz expression, null-preserving. */
const epochMs = (expr: SQL) => sql`floor(extract(epoch from ${expr}) * 1000)::float8`;

/** Integer counter from `usage_delta`; a missing or non-numeric value counts as 0. */
const usageCounter = (key: 'input_tokens' | 'output_tokens') =>
  sql`case when jsonb_typeof(e.usage_delta -> ${key}) = 'number'
           then (e.usage_delta ->> ${key})::numeric else 0 end`;

/** Latest-first order for events: received time, then sequence, then row id. */
const LATEST_FIRST = sql`e.received_at desc, e.sequence desc, e.id desc`;

/**
 * An agent's self-report (ADR-0017 §6): a `heartbeat` with a status and a `tool_name`. The rule
 * is structural, with no list of tool names; no collector heartbeat carries a `tool_name`.
 */
const isSelfReport = sql`(e.type = 'heartbeat' and e.status is not null
                          and e.attributes ->> 'tool_name' is not null)`;

/**
 * Collector activity that ends a self-report's hold on the thread status (ADR-0017 §6):
 * `task.*`, `session.*`, `agent.*`, or a `heartbeat working` without a `tool_name` (a new prompt).
 * A collector `heartbeat idle`, `attention.requested`, `usage.reported` and `error` do not.
 */
const clearsSelfReport = sql`(e.type in ('task.started', 'task.completed', 'task.failed',
                                         'session.started', 'session.ended',
                                         'agent.started', 'agent.stopped')
                              or (e.type = 'heartbeat' and e.status = 'working'
                                  and e.attributes ->> 'tool_name' is null))`;

/** `error_code` of a self-report only (it carries `<status>.<reason>`); null for every other event. */
const selfReportCode = sql`case when ${isSelfReport} then e.attributes ->> 'error_code' end`;

export interface Scope {
  workspaceId: string;
  /** The snapshot clock as an ISO string (database clock unless pinned). */
  nowIso: string;
  windowHours: number;
}

const now = (s: Scope) => sql`${s.nowIso}::timestamptz`;

/** `e` is in the workspace and received inside `(now − windowHours, now]`. */
const inWindow = (s: Scope) =>
  sql`e.workspace_id = ${s.workspaceId}::uuid
      and e.received_at > ${now(s)} - make_interval(hours => ${s.windowHours}::int)
      and e.received_at <= ${now(s)}`;

/** Query 0 (only when no clock is pinned): the database clock, truncated to whole ms. */
export const readDbNow = async (db: AnyDb): Promise<number> => {
  const [row] = rowsOf<{ now_ms: number | string }>(
    await db.execute(sql`select ${epochMs(sql`now()`)} as now_ms`),
  );
  return Number(row?.now_ms);
};

export interface ThreadRow {
  project_id: string;
  project_slug: string;
  project_name: string;
  thread_ref: string;
  first_ms: number | string;
  last_ms: number | string;
  last_type: string;
  status: string | null;
  /** The self-reported status while no later clearing activity exists, else null. */
  agent_status: string | null;
  /** That self-report's raw `error_code`, or null. */
  agent_error_code: string | null;
  agents: number | string;
  tasks_completed: number | string;
  last_task_ms: number | string | null;
  input_tokens: number | string;
  output_tokens: number | string;
  hour_tokens: number | string;
  hour_reports: number | string;
  hour_last_ms: number | string | null;
}

/**
 * Query 1: one row per `(project_id, thread_ref)` in the window, plus the per-thread inputs of
 * the token-burn (last 60 min) and tasks-completed counters. `agent_status` takes the latest
 * event that is either a self-report or clearing activity (full `LATEST_FIRST` order) and keeps
 * its status only when that event is the self-report, so one scan decides the precedence.
 */
export const readThreads = async (db: AnyDb, s: Scope): Promise<ThreadRow[]> => {
  const isUsage = sql`e.type = 'usage.reported'`;
  const isTask = sql`e.type = 'task.completed'`;
  const inLastHour = sql`e.received_at > ${now(s)} - interval '60 minutes'`;
  const tokens = sql`(${usageCounter('input_tokens')} + ${usageCounter('output_tokens')})`;
  return rowsOf<ThreadRow>(
    await db.execute(sql`
      select e.project_id, p.slug as project_slug, p.name as project_name, e.thread_ref,
             ${epochMs(sql`min(e.received_at)`)} as first_ms,
             ${epochMs(sql`max(e.received_at)`)} as last_ms,
             (array_agg(e.type order by ${LATEST_FIRST}))[1] as last_type,
             (array_agg(e.status order by ${LATEST_FIRST})
                filter (where e.status is not null))[1] as status,
             (array_agg(case when ${isSelfReport} then e.status end order by ${LATEST_FIRST})
                filter (where ${isSelfReport} or ${clearsSelfReport}))[1] as agent_status,
             (array_agg(${selfReportCode} order by ${LATEST_FIRST})
                filter (where ${isSelfReport} or ${clearsSelfReport}))[1] as agent_error_code,
             count(distinct e.agent_ref)::int as agents,
             (count(*) filter (where ${isTask}))::int as tasks_completed,
             ${epochMs(sql`max(e.received_at) filter (where ${isTask})`)} as last_task_ms,
             coalesce(sum(${usageCounter('input_tokens')}) filter (where ${isUsage}), 0)::float8
               as input_tokens,
             coalesce(sum(${usageCounter('output_tokens')}) filter (where ${isUsage}), 0)::float8
               as output_tokens,
             coalesce(sum(${tokens}) filter (where ${isUsage} and ${inLastHour}), 0)::float8
               as hour_tokens,
             (count(*) filter (where ${isUsage} and ${inLastHour}))::int as hour_reports,
             ${epochMs(sql`max(e.received_at) filter (where ${isUsage} and ${inLastHour})`)}
               as hour_last_ms
        from events e
        join projects p on p.id = e.project_id and p.workspace_id = e.workspace_id
       where ${inWindow(s)} and p.workspace_id = ${s.workspaceId}::uuid
       group by e.project_id, p.slug, p.name, e.thread_ref`),
  );
};

export interface ActivityRow {
  at_ms: number | string;
  project_slug: string;
  thread_ref: string;
  type: string;
  status: string | null;
  tool_name: string | null;
  self_report: boolean;
  /** Raw `error_code` of a self-report row only; null for every other row. */
  agent_error_code: string | null;
}

/**
 * Query 2: the newest events in the window. Reads `tool_name`, and `error_code` of self-reports
 * only (for their listed reason); no other attribute.
 */
export const readActivity = async (db: AnyDb, s: Scope, limit: number): Promise<ActivityRow[]> =>
  rowsOf<ActivityRow>(
    await db.execute(sql`
      select ${epochMs(sql`e.received_at`)} as at_ms, p.slug as project_slug, e.thread_ref,
             e.type, e.status, e.attributes ->> 'tool_name' as tool_name,
             ${isSelfReport} as self_report, ${selfReportCode} as agent_error_code
        from events e
        join projects p on p.id = e.project_id and p.workspace_id = e.workspace_id
       where ${inWindow(s)} and p.workspace_id = ${s.workspaceId}::uuid
       order by ${LATEST_FIRST}
       limit ${limit}::int`),
  );

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  last_signal_ms: number | string | null;
}

/** Query 3: every project of the workspace, with or without events. */
export const readProjects = async (db: AnyDb, workspaceId: string): Promise<ProjectRow[]> =>
  rowsOf<ProjectRow>(
    await db.execute(sql`
      select p.id, p.slug, p.name, ${epochMs(sql`p.last_signal_at`)} as last_signal_ms
        from projects p
       where p.workspace_id = ${workspaceId}::uuid
       order by p.created_at, p.id`),
  );
