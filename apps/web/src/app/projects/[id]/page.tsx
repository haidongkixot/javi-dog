import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardHead, EmptyState, PageHead, StatusPill } from '@javis-dog/ui/components';
import { revokeTokenAction } from '@/app/projects/actions';
import { ProjectUsage } from '@/components/analytics/usage-panels';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { IssueTokenForm } from '@/components/token-panel';
import { analyticsDeps, loadUsage } from '@/lib/analytics';
import { getViewer, isUuid } from '@/lib/viewer';

export const metadata: Metadata = { title: 'Project' };
export const dynamic = 'force-dynamic';

const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  if (!viewer) return <SignInPrompt what="this project" />;
  // Scoped by the viewer's workspace: another workspace's project id is simply not found.
  const project = isUuid(id) ? await viewer.projects.getProject(viewer.workspaceId, id) : null;
  if (!project) notFound();
  const [tokens, usage] = await Promise.all([
    viewer.projects.listTokens(viewer.workspaceId, project.id),
    // The project id comes from the workspace-scoped lookup above, never from the URL directly;
    // the viewer is reused, so the reader is scoped to the same workspace (ADR-0013).
    loadUsage({ ...analyticsDeps, getViewer: async () => viewer }, { projectId: project.id }),
  ]);

  return (
    <>
      <PageHead
        eyebrow="Project"
        title={project.name}
        description={project.description ?? 'No description.'}
        actions={
          <Link href="/projects" className="text-xs font-bold text-ink underline">
            All projects
          </Link>
        }
      />
      <Card labelledBy="tokens-title">
        <CardHead
          id="tokens-title"
          title="Ingest tokens"
          subtitle="Collectors use a token to send JGR signals for this project. Up to 5 active."
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm whitespace-nowrap">
            <thead>
              <tr>
                {['Name', 'Token', 'Created', 'Last used', 'Status', ''].map((c) => (
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
              {tokens.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title="No tokens yet">
                      Issue a token below. It is shown once, so keep it somewhere safe.
                    </EmptyState>
                  </td>
                </tr>
              ) : (
                tokens.map((t) => (
                  <tr key={t.id} className="border-b border-line">
                    <td className="px-4 py-3 font-bold text-ink">{t.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      jd_it_{t.displayPrefix}…
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{dateFmt.format(t.createdAt)}</td>
                    <td className="px-4 py-3 text-xs text-muted">
                      {t.lastUsedAt ? dateFmt.format(t.lastUsedAt) : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      {t.revokedAt ? (
                        <StatusPill tone="danger">Revoked</StatusPill>
                      ) : (
                        <StatusPill tone="ok">Active</StatusPill>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {t.revokedAt ? null : (
                        <form action={revokeTokenAction.bind(null, project.id)}>
                          <input type="hidden" name="tokenId" value={t.id} />
                          <button
                            type="submit"
                            className="rounded-control border border-line px-3 py-1.5 text-xs font-bold text-danger"
                          >
                            Revoke
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <IssueTokenForm projectId={project.id} />
      </Card>
      <Card labelledBy="project-usage-title">
        <CardHead
          id="project-usage-title"
          title="Usage (last 14 days)"
          subtitle="Input and output tokens per UTC day, usage by model and task outcomes for this project"
        />
        <ProjectUsage load={usage} />
      </Card>
    </>
  );
}
