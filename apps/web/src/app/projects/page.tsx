import type { Metadata } from 'next';
import { MAX_PROJECTS_PER_WORKSPACE } from '@javis-dog/projects';
import { Card, CardHead, PageHead } from '@javis-dog/ui/components';
import { toBudgetCell } from '@/components/budget/budget-cell';
import { CreateProjectForm } from '@/components/create-project-form';
import { ProjectsDashboard } from '@/components/dashboard/dashboards';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { budgetDeps, loadBudgets } from '@/lib/budgets';
import { dashboardDeps, loadDashboard } from '@/lib/dashboard';
import { canManageProject } from '@/lib/permissions';
import { getViewer } from '@/lib/viewer';

export const metadata: Metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

// Projects — "Where is risk building?" Real rows of the viewer's workspace (S2c) with the
// freshness of each project's last signal, refreshed every 10 s (ADR-0012), and the month-to-date
// budget use read once per visit (ADR-0014).
export default async function ProjectsPage() {
  const viewer = await getViewer();
  // The viewer is reused, so every read below is scoped to the same workspace.
  const [rows, load, budgets] = viewer
    ? await Promise.all([
        viewer.projects.listProjects(viewer.workspaceId),
        loadDashboard({ ...dashboardDeps, getViewer: async () => viewer }),
        loadBudgets({ ...budgetDeps, getViewer: async () => viewer }),
      ])
    : [[], null, null];
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
              ...(budgets && { budget: toBudgetCell(budgets, p.id) }),
            }))}
            initial={load?.kind === 'ready' ? load.snapshot : null}
          />
          <Card labelledBy="create-project-title">
            <CardHead
              id="create-project-title"
              title="Create a project"
              subtitle={`Projects belong to your workspace · up to ${MAX_PROJECTS_PER_WORKSPACE}`}
            />
            {canManageProject(viewer.role) ? (
              <CreateProjectForm />
            ) : (
              <p className="px-5 pt-4 pb-5 text-xs text-muted">
                Only workspace owners and admins can create projects. Ask one of them to add the
                project you need.
              </p>
            )}
          </Card>
        </>
      )}
    </>
  );
}
