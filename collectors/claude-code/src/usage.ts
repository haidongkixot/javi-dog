import { createHmac } from 'node:crypto';
import {
  GEMINI_PLATFORM,
  GEMINI_THREAD_PREFIX,
  geminiUsageDelta,
  type AdapterUsagePoint,
  type GeminiAuthType,
} from '@javis-dog/collector-adapters';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
import type { UsageCounter, UsagePoint } from './otlp.ts';

// Usage points → one `usage.reported` JGR event per group (ADR-0011). Claude Code groups by
// (session, model, interval). Gemini CLI points (ADR-0016 §3, Changes R2–R4, R6) take the same
// path with `platform: 'gemini-cli'`, grouped by (session, model, auth type, export end time),
// with baselines per series identity. The receiver keeps a separate baseline map per platform,
// so series can never collide. Baselines live in the receiver's memory only.

/** One cumulative series' last value. */
export interface CumulativeBaseline {
  startNs: string;
  value: number;
  /** Gemini only: the series' run, `sessionId \0 model \0 startNs` (G5 sibling rule). */
  run?: string;
}

/**
 * Last cumulative value per series, in memory only. Claude Code key: `sessionId \0 model \0
 * counter`. Gemini CLI key: the point's in-memory `seriesId` (a hash of all its data-point
 * attributes and start time, ADR-0016 Changes R4). One map per platform: the receiver never
 * mixes Claude Code and Gemini CLI series in one map.
 */
export type CumulativeBaselines = Map<string, CumulativeBaseline>;

/** Platforms whose usage groups differ from Claude Code's (absent = Claude Code). */
export type UsagePlatform = typeof GEMINI_PLATFORM;

export interface UsageGroup {
  sessionId: string;
  model: string;
  /**
   * Claude Code: the interval start (part of the group). Gemini CLI: the earliest start of the
   * series in the group (informational; not part of its identity, ADR-0016 Changes R3).
   */
  startNs: string;
  endNs: string;
  delta: Partial<Record<UsageCounter, number>>;
  /** Absent for Claude Code (unchanged ADR-0011 output); `gemini-cli` for Gemini CLI. */
  platform?: UsagePlatform;
  /**
   * Gemini CLI only, in memory only: the allowlisted `auth_type` of the group's points. It
   * decides whether cost is estimated (ADR-0016 Changes R6) and is never copied into a record.
   */
  authType?: GeminiAuthType;
}

export interface UsageGroupOptions {
  /**
   * Gemini CLI only (ADR-0016 Changes R2): the receiver's own start time (Unix ns, decimal). A
   * cumulative series whose `startNs` is at or after it counts from 0 on its first export,
   * because the receiver has seen every export since the series began.
   */
  receiverStartNs?: string;
}

const groupKey = (sessionId: string, model: string, startNs: string, endNs: string) =>
  `${sessionId}\0${model}\0${startNs}\0${endNs}`;

/** Gemini CLI group identity: (session, model, auth type, export end) — ADR-0016 Changes R3. */
const geminiGroupKey = (
  sessionId: string,
  model: string,
  authType: GeminiAuthType | undefined,
  endNs: string,
) => `${sessionId}\0${model}\0${authType ?? ''}\0${endNs}`;

/** `sessionId \0 model \0 startNs` of a series: the cumulative "run" it belongs to. */
const runKey = (sessionId: string, model: string, startNs: string) =>
  `${sessionId}\0${model}\0${startNs}`;

/** Gemini series key: the parser's in-memory series id (fallback: session, model, type, start). */
const geminiSeriesKey = (point: UsagePoint | AdapterUsagePoint) =>
  ('seriesId' in point && point.seriesId) ||
  `${point.sessionId}\0${point.model}\0${point.counter}\0${point.startNs}`;

const startedAtOrAfter = (startNs: string, sinceNs: string | undefined) => {
  if (sinceNs === undefined) return false;
  try {
    return BigInt(startNs) >= BigInt(sinceNs);
  } catch {
    return false;
  }
};

interface GeminiContext {
  /** Runs with at least one baseline before this request. */
  runs: Set<string>;
  receiverStartNs: string | undefined;
}

/**
 * The delta a point contributes, or null (cumulative point that only sets a baseline, or a
 * reset). Gemini CLI (`gemini`), a series without a baseline (ADR-0016 Changes R2, QA G21):
 * (a) counts from 0 when it started at or after the receiver (no export was missed);
 * (b) else counts from 0 when its run (session, model, startNs) already had baselines before
 *     this request (G5: Gemini creates a series only once its type is first counted, e.g.
 *     `cache` mid-session, so it was not in the earlier exports);
 * (c) else only sets a baseline (ADR-0011: earlier exports may have been missed).
 */
const pointDelta = (
  point: UsagePoint | AdapterUsagePoint,
  baselines: CumulativeBaselines,
  gemini?: GeminiContext,
): number | null => {
  if (point.temporality === 'delta') return point.value;
  const key = gemini
    ? geminiSeriesKey(point)
    : `${point.sessionId}\0${point.model}\0${point.counter}`;
  const run = runKey(point.sessionId, point.model, point.startNs);
  const baseline = baselines.get(key);
  baselines.set(key, { startNs: point.startNs, value: point.value, ...(gemini && { run }) });
  if (!baseline) {
    if (!gemini) return null; // ADR-0011: the first point only sets a baseline
    if (startedAtOrAfter(point.startNs, gemini.receiverStartNs)) return point.value;
    return gemini.runs.has(run) ? point.value : null;
  }
  if (baseline.startNs !== point.startNs || point.value < baseline.value) {
    return null; // a reset: new baseline, nothing counted
  }
  return point.value - baseline.value;
};

/**
 * Groups usage points. Delta points are summed as-is; cumulative points become deltas against
 * `baselines` (mutated): the first point of a series only sets the baseline, a smaller value or
 * a new startNs starts a new baseline. Groups whose counters are all zero are dropped.
 *
 * - Claude Code (no `platform`): groups by (sessionId, model, startNs, endNs), series by
 *   (sessionId, model, counter) — ADR-0011, unchanged.
 * - Gemini CLI (`platform: 'gemini-cli'`; pass a baseline map that only ever sees Gemini
 *   points): series by the parser's in-memory `seriesId` (R4); groups by (sessionId, model,
 *   authType, endNs), because the points of one export share their end time (R3) and a group
 *   must never mix an auth type that is billed per token with one that is not (R6). Every
 *   series' delta is summed into its group. New series count from 0 per R2 and G5.
 */
export const toUsageGroups = (
  points: Array<UsagePoint | AdapterUsagePoint>,
  baselines: CumulativeBaselines,
  platform?: UsagePlatform,
  opts: UsageGroupOptions = {},
): UsageGroup[] => {
  const groups = new Map<string, UsageGroup>();
  const isGemini = platform === GEMINI_PLATFORM;
  // Runs known before this request (all series new together = a first export).
  const gemini: GeminiContext | undefined = isGemini
    ? {
        runs: new Set([...baselines.values()].flatMap((b) => (b.run ? [b.run] : []))),
        receiverStartNs: opts.receiverStartNs,
      }
    : undefined;
  for (const point of points) {
    const delta = pointDelta(point, baselines, gemini);
    if (delta === null) continue;
    const authType = isGemini && 'authType' in point ? point.authType : undefined;
    const key = isGemini
      ? geminiGroupKey(point.sessionId, point.model, authType, point.endNs)
      : groupKey(point.sessionId, point.model, point.startNs, point.endNs);
    let group = groups.get(key);
    if (!group) {
      group = {
        sessionId: point.sessionId,
        model: point.model,
        startNs: point.startNs,
        endNs: point.endNs,
        delta: {},
        ...(platform && { platform }),
        ...(authType && { authType }),
      };
      groups.set(key, group);
    } else if (isGemini && BigInt(point.startNs) < BigInt(group.startNs)) {
      group.startNs = point.startNs;
    }
    group.delta[point.counter] = (group.delta[point.counter] ?? 0) + delta;
  }
  return [...groups.values()].filter((group) =>
    Object.values(group.delta).some((value) => value > 0),
  );
};

/**
 * Canonical lowercase UUID (version 8 layout) from HMAC-SHA-256(salt, group identity).
 * Claude Code: `sessionId \0 model \0 startNs \0 endNs` (unchanged). Gemini CLI: `gemini-cli \0
 * sessionId \0 model \0 authType \0 endNs` (ADR-0016 Changes R3), so a retried export gets the
 * same id and a Gemini group never shares an id with a Claude Code group.
 */
export const usageEventId = (group: UsageGroup, salt: string): string => {
  const key =
    group.platform === GEMINI_PLATFORM
      ? `${GEMINI_PLATFORM}\0${geminiGroupKey(group.sessionId, group.model, group.authType, group.endNs)}`
      : groupKey(group.sessionId, group.model, group.startNs, group.endNs);
  const bytes = createHmac('sha256', salt).update(key).digest().subarray(0, 16);
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
 * Gemini CLI groups (ADR-0016 §3–§4, Changes R5–R6): `thread_ref` = `opaqueRef('gm', …)`,
 * attributes `platform: 'gemini-cli'`, and the counters and `cost_usd` that `geminiUsageDelta`
 * returns (input minus cache; a cost only for per-token-billed auth types), always with
 * `estimated: false`. The group's `authType` is never copied into the record.
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
  const { estimated, cost_usd, ...tokens } = geminiUsageDelta(
    counters,
    group.model,
    occurredAt,
    group.authType,
  );
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
