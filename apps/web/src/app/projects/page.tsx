import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardHead, EmptyState, PageHead, StatusPill } from '@javis-dog/ui/components';
import { CreateProjectForm } from '@/components/create-project-form';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { getViewer } from '@/lib/viewer';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

const columns = ['Project', 'Environments', 'Privacy', 'Signal', 'Created'] as const;
const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

// Projects — "Where is risk building?" Real rows of the viewer's workspace (S2c).
export default async function ProjectsPage() {
  const viewer = await getViewer();
  const rows = viewer ? await viewer.projects.listProjects(viewer.workspaceId) : [];
  return (
    <>
      <PageHead
        eyebrow="Project directory"
        title="Projects, all in one place."
        description="See the health, active agents and resource footprint of each vibe coding project."
      />
      {!viewer ? (
        <SignInPrompt what="and create your projects" />
      ) : (
        <>
          <Card labelledBy="all-projects-title">
            <CardHead
              id="all-projects-title"
              title="All projects"
              subtitle="Health and token footprint appear once a verified JGR signal arrives"
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
                    rows.map((p) => (
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
                        <td className="px-4 py-3 text-xs text-muted">
                          {p.lastSignalAt ? dateFmt.format(p.lastSignalAt) : 'No signal yet'}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted tabular-nums">
                          {dateFmt.format(p.createdAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
          <Card labelledBy="create-project-title">
            <CardHead
              id="create-project-title"
              title="Create a project"
              subtitle="Projects belong to your workspace"
            />
            <CreateProjectForm />
          </Card>
        </>
      )}
    </>
  );
}
