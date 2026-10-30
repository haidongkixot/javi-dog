import type { AnyDb } from '@javis-dog/event-store';
import { readActivity, readDbNow, readProjects, readThreads, type ThreadRow } from './queries.ts';
import {
  STATUS_REASONS,
  type ActivityItem,
  type Counter,
  type DashboardSnapshot,
  type Freshness,
  type ProjectFreshness,
  type ProjectHealth,
  type StatusReason,
  type ThreadState,
  type ThreadStatus,
} from './types.ts';

/** JGR §5 default: 3 × a 60 s heartbeat interval. */
export const FRESHNESS_WINDOW_MS = 180_000;
/** Events considered by the dashboard. */
export const SNAPSHOT_WINDOW_HOURS = 24;
export const ACTIVITY_LIMIT = 25;

/** `ended` after `session.ended`; else fresh within the window (inclusive), else stale. */
export const threadFreshness = (
  lastType: string,
  lastSignalAt: Date,
  now: Date,
  windowMs = FRESHNESS_WINDOW_MS,
): Freshness => {
  if (lastType === 'session.ended') return 'ended';
  return now.getTime() - lastSignalAt.getTime() <= windowMs ? 'fresh' : 'stale';
};

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | string | null) => (ms === null ? null : iso(Number(ms)));
/** Newest of ISO timestamps (same format, so lexical order is time order), or null. */
const newest = (values: (string | null)[]) =>
  values.reduce<string | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);

// Ingest validates `status` against JGR-R05, so stored values are ThreadStatus or null.
const asStatus = (s: string | null) => s as ThreadStatus | null;

const REASONS: ReadonlySet<string> = new Set(STATUS_REASONS);

/**
 * The reason of a self-report (ADR-0017 §6): the part after `<status>.` in its `error_code`,
 * only when the prefix is the reported status and the rest is a listed reason. Anything else is
 * dropped, so no free text from `error_code` ever reaches the snapshot.
 */
const reasonOf = (status: string | null, errorCode: string | null): StatusReason | null => {
  if (status === null || errorCode === null) return null;
  const prefix = `${status}.`;
  if (!errorCode.startsWith(prefix)) return null;
  const reason = errorCode.slice(prefix.length);
  return REASONS.has(reason) ? (reason as StatusReason) : null;
};

const FRESHNESS_RANK: Record<Freshness, number> = { fresh: 0, stale: 1, ended: 2 };

const toThread = (row: ThreadRow, now: Date): ThreadState => {
  const last = Number(row.last_ms);
  // A self-report wins until later clearing activity; the query already decided which (§6).
  const fromAgent = row.agent_status !== null;
  const status = asStatus(fromAgent ? row.agent_status : row.status);
  const statusSource = fromAgent ? 'agent' : 'collector';
  const freshness = threadFreshness(row.last_type, new Date(last), now);
  // Owner decision 2026-10-30: an agent saying it is blocked needs a human too.
  const attention = status === 'waiting' || (status === 'blocked' && statusSource === 'agent');
  return {
    projectId: row.project_id,
    projectSlug: row.project_slug,
    projectName: row.project_name,
    threadRef: row.thread_ref,
    status,
    statusSource,
    statusReason: fromAgent ? reasonOf(row.agent_status, row.agent_error_code) : null,
    lastType: row.last_type,
    firstSignalAt: iso(Number(row.first_ms)),
    lastSignalAt: iso(last),
    freshness,
    attention,
    // Attention, and not ended: a stale waiting or blocked thread still needs a human.
    needsAttention: attention && freshness !== 'ended',
    agents: Number(row.agents),
    tasksCompleted: Number(row.tasks_completed),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
  };
};

/** Attention first, then fresh → stale → ended, then newest signal; refs break exact ties. */
const compareThreads = (a: ThreadState, b: ThreadState) =>
  Number(b.needsAttention) - Number(a.needsAttention) ||
  FRESHNESS_RANK[a.freshness] - FRESHNESS_RANK[b.freshness] ||
  (a.lastSignalAt < b.lastSignalAt ? 1 : a.lastSignalAt > b.lastSignalAt ? -1 : 0) ||
  (a.projectSlug < b.projectSlug ? -1 : a.projectSlug > b.projectSlug ? 1 : 0) ||
  (a.threadRef < b.threadRef ? -1 : a.threadRef > b.threadRef ? 1 : 0);

/** fresh > stale > ended; a signalled project with no thread in the window is stale. */
const projectFreshness = (
  lastSignalAt: string | null,
  threads: ThreadState[],
): ProjectFreshness => {
  if (lastSignalAt === null) return 'never';
  if (threads.some((t) => t.freshness === 'fresh')) return 'fresh';
  if (threads.length === 0 || threads.some((t) => t.freshness === 'stale')) return 'stale';
  return 'ended';
};

export const createDashboardReader = (db: AnyDb) => ({
  /** Workspace-scoped snapshot; `now` pins the clock for tests (default: database `now()`). */
  async snapshot(workspaceId: string, opts: { now?: Date } = {}): Promise<DashboardSnapshot> {
    // One clock for every derivation (ADR-0012): pinned, or read once from the database.
    const nowMs = opts.now ? opts.now.getTime() : await readDbNow(db);
    if (!Number.isFinite(nowMs)) throw new Error('Snapshot clock is not a valid time.');
    const now = new Date(nowMs);
    const scope = { workspaceId, nowIso: now.toISOString(), windowHours: SNAPSHOT_WINDOW_HOURS };

    const [threadRows, activityRows, projectRows] = await Promise.all([
      readThreads(db, scope),
      readActivity(db, scope, ACTIVITY_LIMIT),
      readProjects(db, workspaceId),
    ]);

    const threads = threadRows.map((r) => toThread(r, now)).sort(compareThreads);
    const fresh = threads.filter((t) => t.freshness === 'fresh');
    const working = fresh.filter((t) => t.status === 'working');

    const counter = (value: number, signals: (string | null)[]): Counter => ({
      value,
      lastSignalAt: newest(signals),
    });
    const sum = (f: (r: ThreadRow) => number | string) =>
      threadRows.reduce((acc, r) => acc + Number(f(r)), 0);

    const activity: ActivityItem[] = activityRows.map((r) => ({
      at: iso(Number(r.at_ms)),
      projectSlug: r.project_slug,
      threadRef: r.thread_ref,
      type: r.type,
      status: asStatus(r.status),
      toolName: r.tool_name,
      statusSource: r.self_report ? 'agent' : 'collector',
      statusReason: r.self_report ? reasonOf(r.status, r.agent_error_code) : null,
    }));

    const projects: ProjectHealth[] = projectRows.map((p) => {
      const own = threads.filter((t) => t.projectId === p.id);
      const lastSignalAt = isoOrNull(p.last_signal_ms);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        lastSignalAt,
        freshness: projectFreshness(lastSignalAt, own),
        freshThreads: own.filter((t) => t.freshness === 'fresh').length,
        attentionThreads: own.filter((t) => t.needsAttention).length,
      };
    });

    return {
      generatedAt: now.toISOString(),
      freshnessWindowMs: FRESHNESS_WINDOW_MS,
      windowHours: SNAPSHOT_WINDOW_HOURS,
      overview: {
        activeProjects: counter(
          new Set(fresh.map((t) => t.projectId)).size,
          fresh.map((t) => t.lastSignalAt),
        ),
        agentsWorking: counter(
          working.length,
          working.map((t) => t.lastSignalAt),
        ),
        tokensLastHour: {
          ...counter(
            sum((r) => r.hour_tokens),
            threadRows.map((r) => isoOrNull(r.hour_last_ms)),
          ),
          reports: sum((r) => r.hour_reports),
        },
        tasksCompleted24h: counter(
          sum((r) => r.tasks_completed),
          threadRows.map((r) => isoOrNull(r.last_task_ms)),
        ),
      },
      threads,
      activity,
      projects,
    };
  },
});

export type DashboardReader = ReturnType<typeof createDashboardReader>;
