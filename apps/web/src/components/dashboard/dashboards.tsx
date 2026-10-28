'use client';

import type { ReactNode } from 'react';
import type { DashboardSnapshot } from '@javis-dog/realtime';
import { PageHead } from '@javis-dog/ui/components';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { AgentsView } from './agents-view';
import { OverviewView } from './overview-view';
import { ProjectsTable, type ProjectRow } from './projects-table';
import { RefreshNotice } from './signal';
import { useDashboardSnapshot } from './use-dashboard-snapshot';

// Client wrappers: the server renders the first snapshot, then these poll every 10 s
// (ADR-0012). A failed refresh keeps the last data and says so; a 401 shows the sign-in prompt.

export function OverviewDashboard({ initial }: { initial: DashboardSnapshot | null }) {
  const { snapshot, error, signedOut } = useDashboardSnapshot(initial);
  if (signedOut)
    return (
      <>
        <PageHead
          eyebrow="Pack overview"
          title="Your session ended."
          description="Sign in again to see what your pack is doing."
        />
        <SignInPrompt what="your pack’s signals" />
      </>
    );
  return (
    <OverviewView
      snapshot={snapshot}
      notice={<RefreshNotice snapshot={snapshot} error={error} />}
    />
  );
}

export function AgentsDashboard({
  initial,
  inspector,
}: {
  initial: DashboardSnapshot | null;
  inspector: ReactNode;
}) {
  const { snapshot, error, signedOut } = useDashboardSnapshot(initial);
  if (signedOut) return <SignInPrompt what="your threads" />;
  return (
    <AgentsView
      snapshot={snapshot}
      notice={<RefreshNotice snapshot={snapshot} error={error} />}
      inspector={inspector}
    />
  );
}

export function ProjectsDashboard({
  rows,
  initial,
}: {
  rows: ProjectRow[];
  initial: DashboardSnapshot | null;
}) {
  const { snapshot, error, signedOut } = useDashboardSnapshot(initial);
  if (signedOut) return <SignInPrompt what="your projects" />;
  return (
    <>
      <RefreshNotice snapshot={snapshot} error={error} />
      <ProjectsTable rows={rows} snapshot={snapshot} />
    </>
  );
}
