import Link from 'next/link';
import type { DashboardSnapshot } from '@javis-dog/realtime';
import { Card, CardHead, EmptyState, StatusPill } from '@javis-dog/ui/components';
import { FreshnessPill, SignalTime } from './signal';

/** A workspace project as the server page passes it (dates as ISO strings). */
export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  platforms: string[];
  privacyClass: string;
  createdAt: string;
}

const columns = [
  'Project',
  'Environments',
  'Privacy',
  'Freshness',
  'Last signal',
  'Threads',
  'Created',
] as const;

const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

/** Projects — "Where is risk building?" Rows of the viewer's workspace with their freshness. */
export function ProjectsTable({
  rows,
  snapshot: s,
}: {
  rows: ProjectRow[];
  snapshot: DashboardSnapshot | null;
}) {
  const health = new Map(s?.projects.map((p) => [p.id, p]));
  return (
    <Card labelledBy="all-projects-title">
      <CardHead
        id="all-projects-title"
        title="All projects"
        subtitle="Freshness comes from the last JGR signal of each project"
      />
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-left whitespace-nowrap">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="border-y border-line bg-surface-subtle px-4 py-2.5 text-[11px] font-bold tracking-wide text-muted uppercase"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title="No projects yet">
                    Create your first project below, then issue an ingest token for it.
                  </EmptyState>
                </td>
              </tr>
            ) : (
              rows.map((p) => {
                const h = health.get(p.id);
                return (
                  <tr key={p.id} className="border-b border-line text-sm">
                    <td className="px-4 py-3">
                      <Link href={`/projects/${p.id}`} className="font-bold text-ink underline">
                        {p.name}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-muted">{p.slug}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{p.platforms.join(', ')}</td>
                    <td className="px-4 py-3">
                      <StatusPill tone="protocol">{p.privacyClass}</StatusPill>
                    </td>
                    <td className="px-4 py-3">
                      {s ? (
                        <FreshnessPill freshness={h?.freshness ?? 'never'} />
                      ) : (
                        <span className="text-xs text-muted">Not loaded</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {s && h?.lastSignalAt ? (
                        <SignalTime at={h.lastSignalAt} now={s.generatedAt} />
                      ) : s ? (
                        'No signal yet'
                      ) : (
                        'Not loaded'
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted tabular-nums">
                      {h ? (
                        <span className="inline-flex items-center gap-2">
                          {h.attentionThreads > 0 ? (
                            <StatusPill tone="danger">
                              {h.attentionThreads} waiting for you
                            </StatusPill>
                          ) : null}
                          {h.freshThreads} fresh
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted tabular-nums">
                      {dateFmt.format(new Date(p.createdAt))}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
