import { createHmac } from 'node:crypto';
import {
  CODEX_PLATFORM,
  CODEX_THREAD_PREFIX,
  codexCostDelta,
  codexUsageDelta,
  type CodexCostRecord,
  type CodexTokenRecord,
} from '@javis-dog/collector-adapters';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';

// Codex CLI log records → `usage.reported` (ADR-0016 Changes "S5c design" C5–C6 and "S5c
// design review" H3, M1, M4). JD-C02 parses the allowlisted records and computes the deltas;
// this module attributes them to a thread and gives them deterministic event ids. Raw
// conversation, turn and agent ids stay in memory: only their keyed hashes leave it.

/** Canonical lowercase UUID (version 8 layout) from HMAC-SHA-256(salt, key). */
export const hmacUuid = (salt: string, key: string): string => {
  const bytes = createHmac('sha256', salt).update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Token event id: HMAC(salt, `codex-cli \0 tokens \0 conversation \0 timestamp \0 input \0
 * cached \0 cache_write \0 output`) — C5 plus a record-kind tag, so a token id can never equal
 * a cost id. Deterministic, so a javi-side replay of the same record dedupes.
 */
export const codexTokenEventId = (record: CodexTokenRecord, salt: string) =>
  hmacUuid(
    salt,
    [
      CODEX_PLATFORM,
      'tokens',
      record.conversationId,
      record.timestamp,
      record.input,
      record.cached,
      record.cacheWrite,
      record.output,
    ].join('\0'),
  );

/** Cost event id: HMAC(salt, `codex-cli \0 cost \0 conversation \0 turn.id`) (C5). */
export const codexCostEventId = (record: CodexCostRecord, salt: string) =>
  hmacUuid(salt, [CODEX_PLATFORM, 'cost', record.conversationId, record.turnId].join('\0'));

/** The hashed thread ref of a Codex conversation id (same ref the hooks produce for sessions). */
export const codexThreadRef = (conversationId: string, salt: string) =>
  opaqueRef(CODEX_THREAD_PREFIX, conversationId, salt);

/** Where a record's usage counts: its own session, or a sub-agent's parent session (C6). */
export interface CodexAttribution {
  projectRef: string;
  threadRef: string;
  /** Set for a sub-agent's usage: the ref its SubagentStart hook produced. */
  agentRef?: string;
}

const attributes = () => ({ platform: CODEX_PLATFORM, collector_version: COLLECTOR_VERSION });

const isoOrNow = (timestamp: string, now: Date) => {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? new Date(at).toISOString() : now.toISOString();
};

/**
 * One response's tokens as a `usage.reported` record (H3 counters from `codexUsageDelta`), or
 * null when every counter is 0.
 */
export const codexTokenRecordInput = (
  record: CodexTokenRecord,
  to: CodexAttribution,
  salt: string,
  now: Date,
): (RecordInput & { event_id: string }) | null => {
  const delta = codexUsageDelta(record);
  const total =
    delta.input_tokens + delta.cache_read_tokens + delta.cache_write_tokens + delta.output_tokens;
  if (!(total > 0)) return null;
  return {
    project_ref: to.projectRef,
    thread_ref: to.threadRef,
    ...(to.agentRef && { agent_ref: to.agentRef }),
    type: 'usage.reported',
    event_id: codexTokenEventId(record, salt),
    occurred_at: isoOrNow(record.timestamp, now),
    usage_delta: { ...delta },
    attributes: attributes(),
  };
};

/**
 * One turn's cost as a separate `usage.reported` carrying only `cost_usd`, or null when the
 * auth mode is not priced (ChatGPT plan, unknown: tokens only — a missing cost is never 0).
 */
export const codexCostRecordInput = (
  record: CodexCostRecord,
  to: CodexAttribution,
  salt: string,
  now: Date,
): (RecordInput & { event_id: string }) | null => {
  const cost = codexCostDelta(record);
  if (!cost) return null;
  return {
    project_ref: to.projectRef,
    thread_ref: to.threadRef,
    ...(to.agentRef && { agent_ref: to.agentRef }),
    type: 'usage.reported',
    event_id: codexCostEventId(record, salt),
    occurred_at: now.toISOString(),
    usage_delta: { cost_usd: cost.cost_usd, estimated: cost.estimated },
    attributes: attributes(),
  };
};
