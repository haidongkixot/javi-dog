// JD-M07 snapshot contract (ADR-0012). Every time is an ISO string from the database clock.

export type Freshness = 'fresh' | 'stale' | 'ended';
export type ProjectFreshness = Freshness | 'never';
export type ThreadStatus = 'working' | 'waiting' | 'idle' | 'blocked' | 'failed' | 'completed';

/**
 * Reasons an agent may give with a self-reported status (ADR-0017 §2 and §6). MUST equal the
 * JD-C02 `SELF_REPORT` reason list; a cross-package test asserts it. Kept here rather than
 * imported, because the reader never depends on a collector package.
 */
export const STATUS_REASONS = Object.freeze([
  'needs_input',
  'needs_approval',
  'missing_credentials',
  'missing_access',
  'tests_failing',
  'ci_failing',
  'rate_limited',
  'dependency_down',
  'conflicting_requirements',
  'other',
] as const);
export type StatusReason = (typeof STATUS_REASONS)[number];

/**
 * Who set a status: `agent` when it is the agent's own report (a `heartbeat` that carries a
 * `tool_name`, ADR-0017 §6), else `collector` (hooks, OTLP, the SDK).
 */
export type StatusSource = 'agent' | 'collector';

export interface ThreadState {
  projectId: string;
  projectSlug: string;
  projectName: string;
  /** Opaque, hashed by the producer (e.g. `cc_…`). */
  threadRef: string;
  /**
   * The agent's latest self-reported status while no later collector activity cleared it
   * (ADR-0017 §6); otherwise the last non-null `status` in the window, or null if none was sent.
   */
  status: ThreadStatus | null;
  /** `agent` when `status` is the agent's self-report, else `collector`. */
  statusSource: StatusSource;
  /** The self-report's reason from `<status>.<reason>`, only when listed; null otherwise. */
  statusReason: StatusReason | null;
  lastType: string;
  firstSignalAt: string;
  lastSignalAt: string;
  freshness: Freshness;
  /** `status` is `waiting`, or `blocked` as reported by the agent (owner, 2026-10-30). */
  attention: boolean;
  /**
   * A human should look at this thread: `attention` and not `ended` (a stale waiting thread
   * still counts). The one rule for every count, sort and label of attention.
   */
  needsAttention: boolean;
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
  /** `agent` when this event is a self-report (a `heartbeat` with a status and a `tool_name`). */
  statusSource: StatusSource;
  /** This event's listed reason, for a self-report only; null otherwise. */
  statusReason: StatusReason | null;
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
