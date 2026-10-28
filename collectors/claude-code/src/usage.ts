import type { RecordInput } from '@javis-dog/jgr-sdk';
import type { UsageCounter, UsagePoint } from './otlp.ts';

// Usage points → one `usage.reported` JGR event per (session, model, interval) (ADR-0011).

/** Last cumulative value per series (`sessionId \0 model \0 counter`). */
export type CumulativeBaselines = Map<string, { startNs: string; value: number }>;

export interface UsageGroup {
  sessionId: string;
  model: string;
  startNs: string;
  endNs: string;
  delta: Partial<Record<UsageCounter, number>>;
}

/**
 * Groups points by (sessionId, model, startNs, endNs). Delta points are summed as-is;
 * cumulative points become deltas against `baselines` (mutated): the first point of a series
 * only sets the baseline, a smaller value or a new startNs starts a new baseline. Groups whose
 * counters are all zero are dropped.
 */
export const toUsageGroups = (
  points: UsagePoint[],
  baselines: CumulativeBaselines,
): UsageGroup[] => {
  void points;
  void baselines;
  throw new Error('not implemented (S3e U1)');
};

/** Canonical lowercase UUID (version 8 layout) from HMAC-SHA-256(salt, group key). */
export const usageEventId = (group: UsageGroup, salt: string): string => {
  void group;
  void salt;
  throw new Error('not implemented (S3e U1)');
};

/**
 * The JGR record for one group: type `usage.reported`, `thread_ref` = `opaqueRef('cc',
 * sessionId, salt)`, `occurred_at` = endNs as ISO time, deterministic `event_id`,
 * `usage_delta` with `model` and `estimated: false`, attributes `platform` + `collector_version`.
 */
export const toUsageRecord = (
  group: UsageGroup,
  ctx: { projectRef: string; salt: string },
): RecordInput & { event_id: string; thread_ref: string } => {
  void group;
  void ctx;
  throw new Error('not implemented (S3e U1)');
};
