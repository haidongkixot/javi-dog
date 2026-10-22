import { projects } from '@javis-dog/projects';
import { and, eq, lt, sql } from 'drizzle-orm';
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
    index('events_project_thread_received_idx').on(t.projectId, t.threadRef, t.receivedAt),
    index('events_received_idx').on(t.receivedAt),
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

type EventsDb = PgDatabase<PgQueryResultHKT, typeof eventTables & { projects: typeof projects }>;

/**
 * Persistence for the ingest path. Single statements only (neon-http has no interactive
 * transactions); every write is idempotent or atomic on its own.
 */
export const createEventRepository = (db: EventsDb) => ({
  /** Stores new events; duplicates (also within one call) are skipped. Returns the stored count. */
  async insertEvents(rows: NewEvent[]): Promise<number> {
    if (rows.length === 0) return 0;
    const stored = await db
      .insert(events)
      .values(rows)
      .onConflictDoNothing({ target: [events.projectId, events.producerId, events.eventId] })
      .returning({ id: events.id });
    return stored.length;
  },

  /** Counts one request in the token's current minute; returns the count and the window end. */
  async hitRateWindow(tokenId: string, now: Date) {
    const start = new Date(Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS);
    const [row] = await db
      .insert(ingestRateWindows)
      .values({ tokenId, windowStart: start, count: 1 })
      .onConflictDoUpdate({
        target: [ingestRateWindows.tokenId, ingestRateWindows.windowStart],
        set: { count: sql`${ingestRateWindows.count} + 1` },
      })
      .returning({ count: ingestRateWindows.count });
    return { count: row!.count, resetAt: new Date(start.getTime() + RATE_WINDOW_MS) };
  },

  /** Retention (ADR-0008): deletes events received before `cutoff` and stale rate windows. */
  async purgeEventsBefore(cutoff: Date, now: Date) {
    const deleted = await db
      .delete(events)
      .where(lt(events.receivedAt, cutoff))
      .returning({ id: events.id });
    await db
      .delete(ingestRateWindows)
      .where(lt(ingestRateWindows.windowStart, new Date(now.getTime() - 60 * RATE_WINDOW_MS)));
    return deleted.length;
  },

  /** Marks a verified signal: written only after at least one event was stored (product rule 2). */
  async touchSignal(scope: { projectId: string; workspaceId: string }, at: Date) {
    await db
      .update(projects)
      .set({ lastSignalAt: at })
      .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  },
});

export type EventRepository = ReturnType<typeof createEventRepository>;
