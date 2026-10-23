// Read-only summary of stored JGR events for one project slug (all workspaces using it).
// Prints counts and timestamps only — no refs, ids or attributes.
// Usage: pnpm --filter @javis-dog/event-store db:events -- --project <slug>
import { sql } from 'drizzle-orm';
import { createDb, type AnyDb } from '../src/index.ts';

export interface EventTypeSummary {
  type: string;
  events: number;
  threads: number;
  first_at: string | Date;
  last_at: string | Date;
}

// neon-http and PGlite both return `{ rows }` (same accessor as client.ts).
const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

export const eventsSummary = async (db: AnyDb, slug: string) => {
  const rows = rowsOf<EventTypeSummary>(
    await db.execute(
      sql`select e.type, count(*)::int as events, count(distinct e.thread_ref)::int as threads,
                 min(e.received_at) as first_at, max(e.received_at) as last_at
            from events e join projects p on p.id = e.project_id
           where p.slug = ${slug}
           group by e.type order by e.type`,
    ),
  );
  const [project] = rowsOf<{ projects: number; last_signal_at: string | Date | null }>(
    await db.execute(
      sql`select count(*)::int as projects, max(last_signal_at) as last_signal_at
            from projects where slug = ${slug}`,
    ),
  );
  return { projects: project?.projects ?? 0, lastSignalAt: project?.last_signal_at ?? null, rows };
};

if (process.argv[1]?.endsWith('events-summary.ts')) {
  const url = process.env.DATABASE_URL;
  const i = process.argv.indexOf('--project');
  const slug = i >= 0 ? process.argv[i + 1] : undefined;
  if (!url || !slug) {
    console.error('Set DATABASE_URL and pass --project <slug>.');
    process.exit(1);
  }
  const summary = await eventsSummary(createDb(url), slug);
  console.log(
    `projects with slug "${slug}": ${summary.projects}; last_signal_at: ${String(summary.lastSignalAt)}`,
  );
  for (const r of summary.rows) {
    console.log(
      `${r.type.padEnd(28)} events=${r.events} sessions=${r.threads} first=${String(r.first_at)} last=${String(r.last_at)}`,
    );
  }
  if (summary.rows.length === 0) console.log('No events stored for this slug.');
}
