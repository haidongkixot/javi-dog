// JD-M07 public contract. Import from '@javis-dog/realtime' only (ADR-0001).
export {
  ACTIVITY_LIMIT,
  createDashboardReader,
  FRESHNESS_WINDOW_MS,
  SNAPSHOT_WINDOW_HOURS,
  threadFreshness,
  type DashboardReader,
} from './reader.ts';
export {
  GITHUB_NO_RESULT_AFTER_MS,
  GITHUB_PRODUCER_PREFIX,
  GITHUB_TERMINAL_TYPES,
  githubNoResult,
  STATUS_REASONS,
  THREAD_IDENTITY_TYPE,
} from './types.ts';
export type {
  ActivityItem,
  Counter,
  DashboardSnapshot,
  EncryptedObject,
  Freshness,
  GithubCounts,
  GithubKind,
  ProjectFreshness,
  ProjectHealth,
  StatusReason,
  StatusSource,
  ThreadIdentity,
  ThreadSource,
  ThreadState,
  ThreadStatus,
} from './types.ts';
