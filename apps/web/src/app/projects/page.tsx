import type { Metadata } from 'next';
import { Card, CardHead, EmptyState, PageHead } from '@javis-dog/ui/components';

export const metadata: Metadata = { title: 'Projects' };

const columns = ['Project', 'Platform', 'Health', 'Progress', 'Agents', '24h tokens'] as const;

// Projects — "Where is risk building?" Registry UI shell; persistence arrives with JD-M04 in S2.
export default function ProjectsPage() {
  return (
    <>
      <PageHead
        eyebrow="Project directory"
        title="Projects, all in one place."
        description="See the health, active agents and resource footprint of each vibe coding project."
        actions={
          <button
            type="button"
            aria-disabled="true"
            aria-describedby="create-project-note"
            className="cursor-not-allowed rounded-control bg-primary px-4 py-2.5 text-xs font-bold text-on-primary opacity-60"
          >
            Create project
          </button>
        }
      />
      <p id="create-project-note" className="-mt-3 text-xs text-muted">
        Project creation arrives in the next sprint. Sign in now to set up your workspace.
      </p>

      <Card labelledBy="all-projects-title">
        <CardHead
          id="all-projects-title"
          title="All projects"
          subtitle="Select a project to inspect its telemetry and active threads"
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
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState title="No projects registered">
                    Each project will show its platform, health, active agents and token footprint —
                    all derived from verified JGR signals.
                  </EmptyState>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
