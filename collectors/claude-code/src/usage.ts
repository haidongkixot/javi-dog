import { createHmac } from 'node:crypto';
import {
  GEMINI_PLATFORM,
  GEMINI_THREAD_PREFIX,
  geminiUsageDelta,
  type AdapterUsagePoint,
} from '@javis-dog/collector-adapters';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
import type { UsageCounter, UsagePoint } from './otlp.ts';

// Usage points → one `usage.reported` JGR event per (session, model, interval) (ADR-0011).
// Gemini CLI points (ADR-0016 §3) take the same path with `platform: 'gemini-cli'`; the
// receiver keeps a separate baseline map per platform, so series can never collide.

/**
 * Last cumulative value per series (`sessionId \0 model \0 counter`). One map per platform:
 * the receiver never mixes Claude Code and Gemini CLI series in one map.
 */
export type CumulativeBaselines = Map<string, { startNs: string; value: number }>;

/** Platforms whose usage groups differ from Claude Code's (absent = Claude Code). */
export type UsagePlatform = typeof GEMINI_PLATFORM;

export interface UsageGroup {
  sessionId: string;
  model: string;
  startNs: string;
  endNs: string;
  delta: Partial<Record<UsageCounter, number>>;
  /** Absent for Claude Code (unchanged ADR-0011 output); `gemini-cli` for Gemini CLI. */
  platform?: UsagePlatform;
}

const groupKey = (sessionId: string, model: string, startNs: string, endNs: string) =>
  `${sessionId}\0${model}\0${startNs}\0${endNs}`;

/** `sessionId \0 model \0 startNs` of a series: the cumulative "run" it belongs to. */
const runKey = (sessionId: string, model: string, startNs: string) =>
  `${sessionId}\0${model}\0${startNs}`;

/**
 * Runs (session, model, startNs) that already had at least one baseline before this request.
 * A baseline key is `sessionId \0 model \0 counter`; the counter never contains `\0`.
 */
const knownRuns = (baselines: CumulativeBaselines): Set<string> => {
  const runs = new Set<string>();
  for (const [key, { startNs }] of baselines) {
    runs.add(`${key.slice(0, key.lastIndexOf('\0'))}\0${startNs}`);
  }
  return runs;
};

/**
 * The delta a point contributes, or null (cumulative point that only sets a baseline).
 * `runs` (Gemini CLI only, ADR-0016 Changes, QA finding G5): Gemini exports one cumulative
 * series per (session, model, type) with a shared start time, and a series appears only once
 * its type is first counted (e.g. `cache` mid-session). A new series whose run already had
 * baselines before this request has an implicit baseline of 0, so its full value counts.
 */
const pointDelta = (
  point: UsagePoint | AdapterUsagePoint,
  baselines: CumulativeBaselines,
  runs?: Set<string>,
): number | null => {
  if (point.temporality === 'delta') return point.value;
  const key = `${point.sessionId}\0${point.model}\0${point.counter}`;
  const baseline = baselines.get(key);
  baselines.set(key, { startNs: point.startNs, value: point.value });
  if (!baseline) {
    // A new series of a known run started at 0; otherwise the first point only sets a baseline.
    return runs?.has(runKey(point.sessionId, point.model, point.startNs)) ? point.value : null;
  }
  if (baseline.startNs !== point.startNs || point.value < baseline.value) {
    return null; // a reset: new baseline, nothing counted
  }
  return point.value - baseline.value;
};

/**
 * Groups points by (sessionId, model, startNs, endNs). Delta points are summed as-is;
 * cumulative points become deltas against `baselines` (mutated): the first point of a series
 * only sets the baseline, a smaller value or a new startNs starts a new baseline. Groups whose
 * counters are all zero are dropped. `platform` marks Gemini CLI groups; pass a baseline map
 * that only ever sees that platform's points. For Gemini, a series that is new in a run
 * (session, model, startNs) whose other series already had baselines counts in full.
 */
export const toUsageGroups = (
  points: Array<UsagePoint | AdapterUsagePoint>,
  baselines: CumulativeBaselines,
  platform?: UsagePlatform,
): UsageGroup[] => {
  const groups = new Map<string, UsageGroup>();
  // Claude Code keeps the plain ADR-0011 rule; only Gemini series get the implicit-0 rule, and
  // only against runs known before this request (all series new together = first export).
  const runs = platform === GEMINI_PLATFORM ? knownRuns(baselines) : undefined;
  for (const point of points) {
    const delta = pointDelta(point, baselines, runs);
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
        ...(platform && { platform }),
      };
      groups.set(key, group);
    }
    group.delta[point.counter] = (group.delta[point.counter] ?? 0) + delta;
  }
  return [...groups.values()].filter((group) =>
    Object.values(group.delta).some((value) => value > 0),
  );
};

/**
 * Canonical lowercase UUID (version 8 layout) from HMAC-SHA-256(salt, group key). A Gemini
 * group's key is prefixed with its platform, so it never shares an id with a Claude Code group.
 */
export const usageEventId = (group: UsageGroup, salt: string): string => {
  const key = groupKey(group.sessionId, group.model, group.startNs, group.endNs);
  const bytes = createHmac('sha256', salt)
    .update(group.platform ? `${group.platform}\0${key}` : key)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The thread ref a group's session maps to (the same ref its hooks produce). */
export const usageThreadRef = (group: UsageGroup, salt: string): string =>
  opaqueRef(
    group.platform === GEMINI_PLATFORM ? GEMINI_THREAD_PREFIX : 'cc',
    group.sessionId,
    salt,
  );

/**
 * The JGR record for one group: type `usage.reported`, `thread_ref` = `opaqueRef('cc',
 * sessionId, salt)`, `occurred_at` = endNs as ISO time, deterministic `event_id`,
 * `usage_delta` with `model` and `estimated: false`, attributes `platform` + `collector_version`.
 *
 * Gemini CLI groups (ADR-0016 §3–§4): `thread_ref` = `opaqueRef('gm', …)`, attributes
 * `platform: 'gemini-cli'`, and the counters, `cost_usd` and `estimated` that
 * `geminiUsageDelta` returns (input minus cache, estimated cost from the price table).
 */
export const toUsageRecord = (
  group: UsageGroup,
  ctx: { projectRef: string; salt: string },
): RecordInput & { event_id: string; thread_ref: string } => {
  const occurredAt = new Date(Number(BigInt(group.endNs) / 1_000_000n));
  const base = {
    project_ref: ctx.projectRef,
    thread_ref: usageThreadRef(group, ctx.salt),
    type: 'usage.reported',
    event_id: usageEventId(group, ctx.salt),
    occurred_at: occurredAt.toISOString(),
  };
  if (group.platform !== GEMINI_PLATFORM) {
    return {
      ...base,
      usage_delta: { ...group.delta, model: group.model, estimated: false },
      attributes: { platform: 'claude-code', collector_version: COLLECTOR_VERSION },
    };
  }
  const counters = { ...group.delta };
  delete counters.cost_usd; // Gemini exports no cost; only the price table estimates one
  const { estimated, cost_usd, ...tokens } = geminiUsageDelta(counters, group.model, occurredAt);
  return {
    ...base,
    usage_delta: {
      ...tokens,
      ...(cost_usd !== undefined && { cost_usd }),
      model: group.model,
      estimated,
    },
    attributes: { platform: GEMINI_PLATFORM, collector_version: COLLECTOR_VERSION },
  };
};
