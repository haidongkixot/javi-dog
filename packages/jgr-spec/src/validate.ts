import { JGR_LIMITS, JgrBatch, JgrEvent, type JgrEvent as Event } from './schema.ts';

/** Stable machine-readable error codes (spec §13). Clients branch on these, not on messages. */
export type IssueCode =
  | 'schema'
  | 'too_large'
  | 'privacy_forbidden_attribute'
  | 'privacy_unhashed_identifier'
  | 'privacy_encrypted_requires_l2'
  | 'privacy_l2_requires_encrypted'
  | 'status_required'
  | 'usage_required'
  | 'clock_skew'
  /** Receiver-side (ADR-0008): `project_ref` is not the ingest token's project. */
  | 'project_mismatch'
  /** Receiver-side (ADR-0008): event privacy class is above the project's opt-in class. */
  | 'privacy_class_not_allowed';

export type Issue = { code: IssueCode; path: string; message: string };
export type EventResult = { ok: true; event: Event } | { ok: false; issues: Issue[] };

/**
 * L0 attribute allowlist (JGR-R09): operational metadata only. Anything else — prompts,
 * file contents, paths, commands — is rejected rather than silently dropped, so producers
 * learn about the violation.
 */
export const L0_ATTRIBUTES = new Set([
  'platform',
  'platform_version',
  'collector_version',
  'provider',
  'model',
  'tool_name',
  'task_kind',
  'duration_ms',
  'exit_code',
  'error_code',
  'retry_count',
  'attempt',
  'context_used_ratio',
  'budget_remaining_ratio',
]);

/** Identifier attributes allowed from L1 upward, only as `sha256:<64 hex>` hashes. */
export const L1_HASHED_ATTRIBUTES = new Set(['repo_hash', 'branch_hash', 'file_hash', 'cwd_hash']);
const SHA256 = /^sha256:[0-9a-f]{64}$/;

/** Types whose meaning requires a status (JGR-R05). */
const STATUS_TYPES = new Set(['heartbeat', 'agent.started', 'agent.stopped']);

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

export const validateEvent = (raw: unknown, now: Date = new Date()): EventResult => {
  if (utf8Bytes(raw) > JGR_LIMITS.maxEventBytes) {
    return {
      ok: false,
      issues: [
        {
          code: 'too_large',
          path: '',
          message: `Event exceeds ${JGR_LIMITS.maxEventBytes} bytes.`,
        },
      ],
    };
  }
  const parsed = JgrEvent.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        code: 'schema',
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const e = parsed.data;
  const issues: Issue[] = [];

  for (const [key, value] of Object.entries(e.attributes ?? {})) {
    if (L0_ATTRIBUTES.has(key)) continue;
    if (L1_HASHED_ATTRIBUTES.has(key) && e.privacy_class !== 'L0') {
      if (typeof value !== 'string' || !SHA256.test(value)) {
        issues.push({
          code: 'privacy_unhashed_identifier',
          path: `attributes.${key}`,
          message: `${key} must be "sha256:<64 hex>".`,
        });
      }
      continue;
    }
    issues.push({
      code: 'privacy_forbidden_attribute',
      path: `attributes.${key}`,
      message: `"${key}" is not allowed in privacy class ${e.privacy_class}.`,
    });
  }
  if (Object.keys(e.attributes ?? {}).length > JGR_LIMITS.maxAttributeKeys) {
    issues.push({
      code: 'schema',
      path: 'attributes',
      message: `At most ${JGR_LIMITS.maxAttributeKeys} attributes.`,
    });
  }
  if (e.encrypted && e.privacy_class !== 'L2') {
    issues.push({
      code: 'privacy_encrypted_requires_l2',
      path: 'encrypted',
      message: 'Encrypted payloads require privacy_class L2.',
    });
  }
  if (e.privacy_class === 'L2' && !e.encrypted) {
    issues.push({
      code: 'privacy_l2_requires_encrypted',
      path: 'encrypted',
      message: 'Privacy class L2 requires an encrypted payload.',
    });
  }
  if (STATUS_TYPES.has(e.type) && !e.status) {
    issues.push({
      code: 'status_required',
      path: 'status',
      message: `"${e.type}" requires a status.`,
    });
  }
  if (e.type === 'usage.reported' && !e.usage_delta) {
    issues.push({
      code: 'usage_required',
      path: 'usage_delta',
      message: '"usage.reported" requires usage_delta.',
    });
  }
  if (Date.parse(e.occurred_at) - now.getTime() > JGR_LIMITS.maxFutureSkewMs) {
    issues.push({
      code: 'clock_skew',
      path: 'occurred_at',
      message: 'occurred_at is more than 5 minutes in the future.',
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true, event: e };
};

export type BatchResult =
  | { ok: false; issues: Issue[] }
  | {
      ok: true;
      accepted: Event[];
      rejected: Array<{ index: number; event_id?: string; issues: Issue[] }>;
    };

/** Validate a batch. Valid events are accepted even when others fail (partial acceptance, JGR-R13). */
export const validateBatch = (raw: unknown, now: Date = new Date()): BatchResult => {
  if (utf8Bytes(raw) > JGR_LIMITS.maxBatchBytes) {
    return {
      ok: false,
      issues: [
        {
          code: 'too_large',
          path: '',
          message: `Batch exceeds ${JGR_LIMITS.maxBatchBytes} bytes.`,
        },
      ],
    };
  }
  const batch = JgrBatch.safeParse(raw);
  if (!batch.success) {
    return {
      ok: false,
      issues: batch.error.issues.map((i) => ({
        code: 'schema',
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const accepted: Event[] = [];
  const rejected: Array<{ index: number; event_id?: string; issues: Issue[] }> = [];
  batch.data.events.forEach((item, index) => {
    const result = validateEvent(item, now);
    if (result.ok) accepted.push(result.event);
    else {
      const id = (item as { event_id?: unknown } | null)?.event_id;
      rejected.push({
        index,
        ...(typeof id === 'string' ? { event_id: id } : {}),
        issues: result.issues,
      });
    }
  });
  return { ok: true, accepted, rejected };
};
