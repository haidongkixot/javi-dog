import type { AnyDb } from '@javis-dog/event-store';
import {
  readByModel,
  readByProject,
  readDays,
  readDbNow,
  type DayRow,
  type Range,
  type UsageSumsRow,
} from './queries.ts';
import type { UsageAnalytics, UsageDay, UsageTotals } from './types.ts';

export const ANALYTICS_DEFAULT_DAYS = 14;
/** Raw events are kept 30 days (ADR-0008); longer ranges would silently undercount. */
export const ANALYTICS_MAX_DAYS = 30;

const DAY_MS = 86_400_000;

/** Canonical UUID text; anything else cannot name a project, so it yields an empty result. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** clamp(round(days ?? 14), 1, 30); a non-finite NaN falls back to the default. */
const clampDays = (days: number | undefined): number => {
  const n = Math.round(days ?? ANALYTICS_DEFAULT_DAYS);
  if (Number.isNaN(n)) return ANALYTICS_DEFAULT_DAYS;
  return Math.min(ANALYTICS_MAX_DAYS, Math.max(1, n));
};

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Removes float noise from summed money (ADR-0013: round to 6 decimals). */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

const ZERO_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
  reports: 0,
};

const toTotals = (r: UsageSumsRow): UsageTotals => ({
  inputTokens: Number(r.input_tokens),
  outputTokens: Number(r.output_tokens),
  cacheReadTokens: Number(r.cache_read_tokens),
  cacheWriteTokens: Number(r.cache_write_tokens),
  estimatedCostUsd: round6(Number(r.cost_usd)),
  reports: Number(r.reports),
});

const toDay = (date: string, r: DayRow | undefined): UsageDay =>
  r
    ? {
        date,
        ...toTotals(r),
        tasksCompleted: Number(r.tasks_completed),
        tasksFailed: Number(r.tasks_failed),
      }
    : { date, ...ZERO_TOTALS, tasksCompleted: 0, tasksFailed: 0 };

/** Ordinal string order (the same on every runtime); null sorts last. */
const compareKeys = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

/** Input + output tokens descending, then the key ascending. */
const byTokensThen =
  <T extends UsageTotals>(key: (x: T) => string | null) =>
  (a: T, b: T) =>
    b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) ||
    compareKeys(key(a), key(b));

export const createAnalyticsReader = (db: AnyDb) => ({
  /** Workspace-scoped daily usage for the last `days` UTC days including today (clamped 1–30). */
  async usage(
    workspaceId: string,
    opts: { days?: number; projectId?: string; now?: Date } = {},
  ): Promise<UsageAnalytics> {
    // One clock for every derivation (ADR-0013): pinned, or read once from the database.
    const nowMs = opts.now ? opts.now.getTime() : await readDbNow(db);
    if (!Number.isFinite(nowMs)) throw new Error('Analytics clock is not a valid time.');
    const days = clampDays(opts.days);
    const toMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const fromMs = toMs - (days - 1) * DAY_MS;
    const dates = Array.from({ length: days }, (_, i) => isoDate(fromMs + i * DAY_MS));

    const range: Range = {
      workspaceId,
      fromIso: new Date(fromMs).toISOString(),
      nowIso: new Date(nowMs).toISOString(),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    };
    // A project id that is not a UUID names no project of any workspace: all-zero, no query.
    const unknownProject = opts.projectId !== undefined && !UUID_RE.test(opts.projectId);

    const [dayRows, modelRows, projectRows] = unknownProject
      ? [[], [], []]
      : await Promise.all([readDays(db, range), readByModel(db, range), readByProject(db, range)]);

    const perDay = new Map<string, DayRow>();
    let totalRow: DayRow | undefined;
    for (const r of dayRows) {
      if (r.is_total) totalRow = r;
      else if (r.day !== null) perDay.set(r.day, r);
    }
    const totals = toDay('', totalRow);
    const lastReportMs = totalRow?.last_report_ms ?? null;

    return {
      generatedAt: new Date(nowMs).toISOString(),
      from: dates[0] as string,
      to: dates[dates.length - 1] as string,
      days: dates.map((date) => toDay(date, perDay.get(date))),
      byModel: modelRows
        .map((r) => ({ model: r.model, ...toTotals(r) }))
        .sort(byTokensThen((x) => x.model)),
      byProject: projectRows
        .map((r) => ({ projectId: r.project_id, slug: r.slug, name: r.name, ...toTotals(r) }))
        .sort(byTokensThen((x) => x.slug)),
      totals: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        estimatedCostUsd: totals.estimatedCostUsd,
        reports: totals.reports,
        tasksCompleted: totals.tasksCompleted,
        tasksFailed: totals.tasksFailed,
      },
      lastReportAt: lastReportMs === null ? null : new Date(Number(lastReportMs)).toISOString(),
    };
  },
});

export type AnalyticsReader = ReturnType<typeof createAnalyticsReader>;
