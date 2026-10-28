// JD-M07 public contract. Import from '@javis-dog/realtime' only (ADR-0001).
export {
  ACTIVITY_LIMIT,
  createDashboardReader,
  FRESHNESS_WINDOW_MS,
  SNAPSHOT_WINDOW_HOURS,
  threadFreshness,
  type DashboardReader,
} from './reader.ts';
export type {
  ActivityItem,
  Counter,
  DashboardSnapshot,
  Freshness,
  ProjectFreshness,
  ProjectHealth,
  ThreadState,
  ThreadStatus,
} from './types.ts';
