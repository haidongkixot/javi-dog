// JD-M07 snapshot contract (ADR-0012). Every time is an ISO string from the database clock.

export type Freshness = 'fresh' | 'stale' | 'ended';
export type ProjectFreshness = Freshness | 'never';
export type ThreadStatus = 'working' | 'waiting' | 'idle' | 'blocked' | 'failed' | 'completed';

export interface ThreadState {
  projectId: string;
  projectSlug: string;
  projectName: string;
  /** Opaque, hashed by the producer (e.g. `cc_…`). */
  threadRef: string;
  /** Last non-null `status` in the window, or null if none was sent. */
  status: ThreadStatus | null;
  lastType: string;
  firstSignalAt: string;
  lastSignalAt: string;
  freshness: Freshness;
  /** The latest status-bearing event says `waiting`. */
  attention: boolean;
  agents: number;
  tasksCompleted: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ActivityItem {
  at: string;
  projectSlug: string;
  threadRef: string;
  type: string;
  status: ThreadStatus | null;
  toolName: string | null;
}

export interface ProjectHealth {
  id: string;
  slug: string;
  name: string;
  lastSignalAt: string | null;
  freshness: ProjectFreshness;
  freshThreads: number;
  attentionThreads: number;
}

export interface Counter {
  value: number;
  /** Newest signal that contributed, or null when nothing did. */
  lastSignalAt: string | null;
}

export interface DashboardSnapshot {
  generatedAt: string;
  freshnessWindowMs: number;
  windowHours: number;
  overview: {
    activeProjects: Counter;
    agentsWorking: Counter;
    /** Input + output tokens reported in the last 60 min. */
    tokensLastHour: Counter & { reports: number };
    tasksCompleted24h: Counter;
  };
  threads: ThreadState[];
  activity: ActivityItem[];
  projects: ProjectHealth[];
}
