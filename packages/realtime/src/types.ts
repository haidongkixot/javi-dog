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

/**
 * Where a thread comes from (ADR-0019 decision 6, D0 M1, M2): `github` when every event of the
 * thread has a `producer_id` starting with `gh-app_` (a prefix that only the JD-M10 bridge may
 * write; ingest rejects it for everyone else), otherwise `agent`. The label comes from that
 * reserved prefix only, never from a tool name or a thread ref.
 */
export type ThreadSource = 'agent' | 'github';

/** Producer-id prefix reserved for the GitHub App bridge (ADR-0019 D0 M2). */
export const GITHUB_PRODUCER_PREFIX = 'gh-app_';

/**
 * What a GitHub thread is about, from its `task_kind` (`ci.*` → `ci`, `pr` / `pr.*` → `pr`); a
 * thread without one falls back to its type family (`x.github.ci.*`, `x.github.pr.*`).
 */
export type GithubKind = 'ci' | 'pr';

/**
 * Newest event types that end a GitHub thread (ADR-0019 D0 M1): a run or suite result
 * (`task.completed`, `task.failed`, `x.github.ci.cancelled`, `x.github.ci.skipped`) or a PR that
 * was merged or closed. `x.github.ci.attention` is not terminal.
 */
export const GITHUB_TERMINAL_TYPES = Object.freeze([
  'task.completed',
  'task.failed',
  'x.github.ci.cancelled',
  'x.github.ci.skipped',
  'x.github.pr.merged',
  'x.github.pr.closed',
] as const);

/**
 * JGR extension type that carries a thread's L1 hashes and, in an L2 project, its encrypted
 * repo and branch names (ADR-0018 §5). It counts as a signal for freshness, but it is never a
 * status, a task or an activity item.
 */
export const THREAD_IDENTITY_TYPE = 'x.javi.thread.identity';

/** JGR `encrypted` object (spec §7), passed through as opaque strings. Never decrypted here. */
export interface EncryptedObject {
  alg: string;
  kid: string;
  iv: string;
  ciphertext: string;
}

/**
 * The newest `x.javi.thread.identity` event of a thread (ADR-0018 §8). Opaque data for the
 * browser: the reader neither decrypts nor derives anything. `eventId`, `producerId`,
 * `threadRef`, `type` and `projectSlug` are the AAD parts the browser needs; the `kid` is
 * `encrypted.kid`.
 */
export interface ThreadIdentity {
  /** Canonical `event_id` as stored (JD-M06 accepts canonical ids only). */
  eventId: string;
  producerId: string;
  threadRef: string;
  type: typeof THREAD_IDENTITY_TYPE;
  /** The project slug, never the UUID (ADR-0018 §4, review H3). */
  projectSlug: string;
  /** The event's own privacy class. */
  privacyClass: 'L0' | 'L1' | 'L2';
  /** When the identity event was received. */
  at: string;
  /** `sha256:<64 hex>` keyed hashes (L1), or null when absent or not that shape. */
  repoHash: string | null;
  branchHash: string | null;
  cwdHash: string | null;
  /** The L2 ciphertext, or null when the event carries none (or not a well-shaped one). */
  encrypted: EncryptedObject | null;
}

export interface ThreadState {
  projectId: string;
  projectSlug: string;
  projectName: string;
  /** Opaque, hashed by the producer (e.g. `cc_…`, `gh_…` for GitHub). */
  threadRef: string;
  /**
   * `github` for a JD-M10 bridge thread (see `ThreadSource`). A GitHub thread is never an agent:
   * its `status` is always null, it never needs attention, and the overview's agent counters and
   * the squad leave it out.
   */
  source: ThreadSource;
  /** `ci` or `pr` for a GitHub thread (null when neither can be told); always null for agents. */
  githubKind: GithubKind | null;
  /**
   * The agent's latest self-reported status while no later activity cleared it (ADR-0017 §6);
   * otherwise the last non-null `status` of an event that is not a self-report, or null.
   */
  status: ThreadStatus | null;
  /** `agent` when `status` is the agent's self-report, else `collector`. */
  statusSource: StatusSource;
  /** The self-report's reason from `<status>.<reason>`, only when listed; null otherwise. */
  statusReason: StatusReason | null;
  /**
   * Type of the newest event that is not an identity event (an identity event follows a status
   * event and must not hide it); the identity type only when the thread sent nothing else.
   * For a GitHub thread, "newest" is the highest `sequence` (strictly increasing per thread,
   * D0 M3), because GitHub may deliver out of order.
   */
  lastType: string;
  firstSignalAt: string;
  lastSignalAt: string;
  /** `ended` for a GitHub thread whose `lastType` is in `GITHUB_TERMINAL_TYPES`. */
  freshness: Freshness;
  /** `status` is `waiting`, or `blocked` as reported by the agent (owner, 2026-10-30). */
  attention: boolean;
  /**
   * A human should look at this thread: `attention` and not `ended` (a stale waiting thread
   * still counts). The one rule for every count, sort and label of attention.
   */
  needsAttention: boolean;
  agents: number;
  /** `task.completed` events of agents; GitHub CI results never count (0 for a GitHub thread). */
  tasksCompleted: number;
  inputTokens: number;
  outputTokens: number;
  /** The newest identity event in the window, or null when the thread sent none. */
  identity: ThreadIdentity | null;
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

/**
 * GitHub counts (ADR-0019 D0 M1), from GitHub threads with a signal in the snapshot window.
 * GitHub sends no heartbeat, so `lastSignalAt` is the time of the newest delivery that counted.
 */
export interface GithubCounts {
  /** CI threads (`ci`) whose newest event is `task.started` (requested or in progress). */
  ciRunning: Counter;
  /** CI threads whose newest event is `task.failed`. */
  ciFailed24h: Counter;
  /** PR threads that are not ended (newest event opened, updated or ready for review). */
  prsOpen: Counter;
}

export interface DashboardSnapshot {
  generatedAt: string;
  freshnessWindowMs: number;
  windowHours: number;
  overview: {
    /**
     * Projects with a fresh thread of either source: a GitHub delivery is a verified signal of
     * the project (the bridge also touches its `last_signal_at`), just not an agent.
     */
    activeProjects: Counter;
    /** Fresh agent threads reporting `working`; GitHub threads never count. */
    agentsWorking: Counter;
    /** Input + output tokens reported in the last 60 min. */
    tokensLastHour: Counter & { reports: number };
    /** Agent `task.completed` events in the window; GitHub CI results never count. */
    tasksCompleted24h: Counter;
  };
  github: GithubCounts;
  threads: ThreadState[];
  activity: ActivityItem[];
  projects: ProjectHealth[];
}
