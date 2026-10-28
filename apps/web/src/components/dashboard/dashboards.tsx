'use client';

import type { ReactNode } from 'react';
import type { DashboardSnapshot } from '@javis-dog/realtime';
import { PageHead } from '@javis-dog/ui/components';
import { SignInPrompt } from '@/components/sign-in-prompt';
import { AgentsView } from './agents-view';
import { atClientTime } from './aging';
import { OverviewView } from './overview-view';
import { ProjectsTable, type ProjectRow } from './projects-table';
import { RefreshNotice } from './signal';
import { useDashboardSnapshot } from './use-dashboard-snapshot';

// Client wrappers: the server renders the first snapshot, then these poll every 10 s
// (ADR-0012). Ages run on the client clock between reads, so values go stale on screen when
// signals stop. A failed refresh keeps the last data, names it "Not current" and says so in a
// notice; a 401 shows the sign-in prompt.

function useDashboardView(initial: DashboardSnapshot | null) {
  const { snapshot, now, error, signedOut } = useDashboardSnapshot(initial);
  return {
    snapshot,
    view: snapshot && now ? atClientTime(snapshot, now) : snapshot,
    error,
    notCurrent: error !== null,
    signedOut,
  };
}

export function OverviewDashboard({ initial }: { initial: DashboardSnapshot | null }) {
  const { snapshot, view, error, notCurrent, signedOut } = useDashboardView(initial);
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
      snapshot={view}
      notCurrent={notCurrent}
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
  const { snapshot, view, error, notCurrent, signedOut } = useDashboardView(initial);
  if (signedOut) return <SignInPrompt what="your threads" />;
  return (
    <AgentsView
      snapshot={view}
      notCurrent={notCurrent}
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
  const { snapshot, view, error, notCurrent, signedOut } = useDashboardView(initial);
  if (signedOut) return <SignInPrompt what="your projects" />;
  return (
    <>
      <RefreshNotice snapshot={snapshot} error={error} />
      <ProjectsTable rows={rows} snapshot={view} notCurrent={notCurrent} />
    </>
  );
}
