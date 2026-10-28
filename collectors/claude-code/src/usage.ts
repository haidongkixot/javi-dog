import { createHmac } from 'node:crypto';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
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

const groupKey = (sessionId: string, model: string, startNs: string, endNs: string) =>
  `${sessionId}\0${model}\0${startNs}\0${endNs}`;

/** The delta a point contributes, or null (cumulative point that only sets a baseline). */
const pointDelta = (point: UsagePoint, baselines: CumulativeBaselines): number | null => {
  if (point.temporality === 'delta') return point.value;
  const key = `${point.sessionId}\0${point.model}\0${point.counter}`;
  const baseline = baselines.get(key);
  baselines.set(key, { startNs: point.startNs, value: point.value });
  if (!baseline || baseline.startNs !== point.startNs || point.value < baseline.value) {
    return null; // first point of the series, or a reset: new baseline, nothing counted
  }
  return point.value - baseline.value;
};

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
  const groups = new Map<string, UsageGroup>();
  for (const point of points) {
    const delta = pointDelta(point, baselines);
    if (delta === null) continue;
    const key = groupKey(point.sessionId, point.model, point.startNs, point.endNs);
    let group = groups.get(key);
    if (!group) {
      group = {
        sessionId: point.sessionId,
        model: point.model,
        startNs: point.startNs,
        endNs: point.endNs,
        delta: {},
      };
      groups.set(key, group);
    }
    group.delta[point.counter] = (group.delta[point.counter] ?? 0) + delta;
  }
  return [...groups.values()].filter((group) =>
    Object.values(group.delta).some((value) => value > 0),
  );
};

/** Canonical lowercase UUID (version 8 layout) from HMAC-SHA-256(salt, group key). */
export const usageEventId = (group: UsageGroup, salt: string): string => {
  const bytes = createHmac('sha256', salt)
    .update(groupKey(group.sessionId, group.model, group.startNs, group.endNs))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The JGR record for one group: type `usage.reported`, `thread_ref` = `opaqueRef('cc',
 * sessionId, salt)`, `occurred_at` = endNs as ISO time, deterministic `event_id`,
 * `usage_delta` with `model` and `estimated: false`, attributes `platform` + `collector_version`.
 */
export const toUsageRecord = (
  group: UsageGroup,
  ctx: { projectRef: string; salt: string },
): RecordInput & { event_id: string; thread_ref: string } => ({
  project_ref: ctx.projectRef,
  thread_ref: opaqueRef('cc', group.sessionId, ctx.salt),
  type: 'usage.reported',
  event_id: usageEventId(group, ctx.salt),
  occurred_at: new Date(Number(BigInt(group.endNs) / 1_000_000n)).toISOString(),
  usage_delta: { ...group.delta, model: group.model, estimated: false },
  attributes: { platform: 'claude-code', collector_version: COLLECTOR_VERSION },
});
