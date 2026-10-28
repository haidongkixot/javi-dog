import type { Metadata } from 'next';
import { Card, CardHead, PageHead } from '@javis-dog/ui/components';
import { CreateProjectForm } from '@/components/create-project-form';
import { ProjectsDashboard } from '@/components/dashboard/dashboards';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { dashboardDeps, loadDashboard } from '@/lib/dashboard';
import { getViewer } from '@/lib/viewer';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

// Projects — "Where is risk building?" Real rows of the viewer's workspace (S2c) with the
// freshness of each project's last signal, refreshed every 10 s (ADR-0012).
export default async function ProjectsPage() {
  const viewer = await getViewer();
  const rows = viewer ? await viewer.projects.listProjects(viewer.workspaceId) : [];
  const load = viewer
    ? await loadDashboard({ ...dashboardDeps, getViewer: async () => viewer })
    : null;
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
          <ProjectsDashboard
            rows={rows.map((p) => ({
              id: p.id,
              name: p.name,
              slug: p.slug,
              platforms: p.platforms,
              privacyClass: p.privacyClass,
              createdAt: p.createdAt.toISOString(),
            }))}
            initial={load?.kind === 'ready' ? load.snapshot : null}
          />
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
