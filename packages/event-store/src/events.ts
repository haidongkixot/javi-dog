import { canonicalEventId } from '@javis-dog/jgr-spec';
import { projects } from '@javis-dog/projects';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

// JD-M06 tables for the JGR signal path (ADR-0008).

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    producerId: text('producer_id').notNull(),
    eventId: text('event_id').notNull(),
    threadRef: text('thread_ref').notNull(),
    agentRef: text('agent_ref'),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    status: text('status'),
    privacyClass: text('privacy_class').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    usageDelta: jsonb('usage_delta'),
    attributes: jsonb('attributes'),
    encrypted: jsonb('encrypted'),
  },
  (t) => [
    // An event can only belong to a project inside its own workspace.
    foreignKey({
      name: 'events_project_workspace_fk',
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
    }).onDelete('cascade'),
    // Dedupe key, scoped by project so one tenant cannot pre-claim another's ids.
    uniqueIndex('events_project_producer_event_key').on(t.projectId, t.producerId, t.eventId),
    // Dedupe relies on canonical ids (ADR-0008 Changes, S3d H1): any other spelling is refused.
    check(
      'events_event_id_canonical_check',
      sql`${t.eventId} ~ '^[0-9A-HJKMNP-TV-Z]{26}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    ),
    index('events_project_thread_received_idx').on(t.projectId, t.threadRef, t.receivedAt),
    index('events_received_idx').on(t.receivedAt),
    // Workspace-wide reads over a time window: dashboard snapshot and analytics (ADR-0013).
    index('events_workspace_received_idx').on(t.workspaceId, t.receivedAt),
    check('events_privacy_class_check', sql`${t.privacyClass} in ('L0', 'L1', 'L2')`),
  ],
);

/** Fixed one-minute request windows per ingest token (ADR-0008 rate limit). */
export const ingestRateWindows = pgTable(
  'ingest_rate_windows',
  {
    tokenId: uuid('token_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ name: 'ingest_rate_windows_pkey', columns: [t.tokenId, t.windowStart] })],
);

export const eventTables = { events, ingestRateWindows };

export type NewEvent = typeof events.$inferInsert;

const RATE_WINDOW_MS = 60_000;

/** Raw events are kept this long after receipt (ADR-0008, owner Q1). */
export const EVENT_RETENTION_DAYS = 30;

/**
 * Receipt-time cutoff for the retention purge: 30 days, but never inside the current UTC month
 * (ADR-0014 changes ADR-0008), so month-to-date budget spend is complete on day 31.
 */
export const retentionCutoff = (now: Date) =>
  new Date(
    Math.min(
      now.getTime() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ),
  );

type EventsDb = PgDatabase<PgQueryResultHKT, typeof eventTables & { projects: typeof projects }>;

/**
 * Persistence for the ingest path. Single statements only (neon-http has no interactive
 * transactions); every write is idempotent or atomic on its own.
 */
export const createEventRepository = (db: EventsDb) => ({
  /**
   * Stores new events; duplicates (also within one call) are skipped. Returns the stored count.
   * Ids are canonicalized even for callers that bypass `validateEvent` (H1), and rows are sorted
   * by key so concurrent overlapping batches take row locks in one order (H5, no deadlocks).
   */
  async insertEvents(rows: NewEvent[]): Promise<number> {
    if (rows.length === 0) return 0;
    const ordered = rows
      .map((r) => ({ ...r, eventId: canonicalEventId(r.eventId) }))
      .sort((a, b) => {
        // Ordinal (not locale) order, the same on every runtime.
        const ka = `${a.producerId}\u0000${a.eventId}`;
        const kb = `${b.producerId}\u0000${b.eventId}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    const stored = await db
      .insert(events)
      .values(ordered)
      .onConflictDoNothing({ target: [events.projectId, events.producerId, events.eventId] })
      .returning({ id: events.id });
    return stored.length;
  },

  /**
   * Counts one request in the token's current minute; returns the count and the window end.
   * The window comes from the **database** clock (H6), so instances with skewed clocks share
   * one window. `at` pins the window for tests only.
   */
  async hitRateWindow(tokenId: string, at?: Date) {
    const start = at
      ? sql`${new Date(Math.floor(at.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS).toISOString()}::timestamptz`
      : sql`date_trunc('minute', now())`;
    const [row] = await db
      .insert(ingestRateWindows)
      .values({ tokenId, windowStart: start, count: 1 })
      .onConflictDoUpdate({
        target: [ingestRateWindows.tokenId, ingestRateWindows.windowStart],
        set: { count: sql`${ingestRateWindows.count} + 1` },
      })
      .returning({
        count: ingestRateWindows.count,
        windowStart: ingestRateWindows.windowStart,
        dbNow: sql<Date>`now()`.mapWith(ingestRateWindows.windowStart),
      });
    const resetAt = new Date(row!.windowStart.getTime() + RATE_WINDOW_MS);
    // Retry-After from the same (database) clock as the window, never the instance clock.
    const retryAfterSeconds = Math.min(
      60,
      Math.max(1, Math.ceil((resetAt.getTime() - row!.dbNow.getTime()) / 1000)),
    );
    return { count: row!.count, resetAt, retryAfterSeconds };
  },

  /**
   * Retention (ADR-0008, ADR-0009): deletes events received before `cutoff` in bounded batches
   * (oldest first) until a batch comes back short or the time budget is spent (H3), then stale
   * rate windows. `complete: false` means the next run continues.
   */
  async purgeEventsBefore(
    cutoff: Date,
    now: Date,
    opts: { batchSize?: number; budgetMs?: number; clock?: () => number } = {},
  ) {
    const batchSize = opts.batchSize ?? 5000;
    const budgetMs = opts.budgetMs ?? 20_000;
    const clock = opts.clock ?? Date.now;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50_000) {
      throw new RangeError('batchSize must be an integer between 1 and 50000.');
    }
    const started = clock();
    let deleted = 0;
    let batches = 0;
    let complete = false;
    for (;;) {
      const oldest = db
        .select({ id: events.id })
        .from(events)
        .where(lt(events.receivedAt, cutoff))
        .orderBy(asc(events.receivedAt))
        .limit(batchSize);
      const rows = await db
        .delete(events)
        .where(inArray(events.id, oldest))
        .returning({ id: events.id });
      batches += 1;
      deleted += rows.length;
      if (rows.length < batchSize) {
        complete = true;
        break;
      }
      if (clock() - started >= budgetMs) break;
    }
    await db
      .delete(ingestRateWindows)
      .where(lt(ingestRateWindows.windowStart, new Date(now.getTime() - 60 * RATE_WINDOW_MS)));
    return { deleted, batches, complete };
  },

  /**
   * Marks a verified signal (product rule 2). Forward-only (H2): a slower request or a skewed
   * instance never moves `last_signal_at` backwards.
   */
  async touchSignal(scope: { projectId: string; workspaceId: string }, at: Date) {
    await db
      .update(projects)
      .set({
        // Capped by the database clock: a fast instance clock cannot plant a future value that
        // the forward-only rule would then keep (review m3).
        lastSignalAt: sql`greatest(${projects.lastSignalAt}, least(${at.toISOString()}::timestamptz, now()))`,
      })
      .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  },
});

export type EventRepository = ReturnType<typeof createEventRepository>;
