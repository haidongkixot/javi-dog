import { createHmac } from 'node:crypto';
import type { RecordInput } from '@javis-dog/jgr-sdk';

// Agent self-report (ADR-0017 decisions 2–3). Pure functions shared by the JD-C03 MCP server
// and the JD-C01 hook mappers: fixed vocabularies, a strict validator, the matcher that
// recognises javi's own two tools in a hook payload, and the mapper to one JGR record. No free
// text ever leaves these functions: a valid input is rebuilt from the fixed lists, an invalid
// one yields `{ ok: false }` or `null` with nothing of the input in it.

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value))
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
};

const STATUSES = ['working', 'waiting', 'blocked', 'idle', 'completed', 'failed'] as const;
const REASON_STATUSES = ['waiting', 'blocked', 'failed'] as const;
const REASONS = [
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
] as const;
const PHASES = ['started', 'completed', 'failed'] as const;
const KINDS = [
  'plan',
  'research',
  'implement',
  'test',
  'debug',
  'review',
  'docs',
  'build',
  'deploy',
  'other',
] as const;

export type SelfReportStatus = (typeof STATUSES)[number];
export type SelfReportReason = (typeof REASONS)[number];
export type SelfReportPhase = (typeof PHASES)[number];
export type SelfReportKind = (typeof KINDS)[number];
export type SelfReportToolName = 'report_status' | 'report_task';

/**
 * The self-report contract (ADR-0017 §2), deeply frozen. `schemas` are the MCP `inputSchema`
 * objects for `tools/list`; Gemini strips `additionalProperties`, so `validateSelfReport` is
 * the real gate on both sides.
 */
export const SELF_REPORT = deepFreeze({
  serverName: 'javi',
  tools: ['report_status', 'report_task'] as const,
  statuses: STATUSES,
  reasons: REASONS,
  /** The only statuses a `reason` may accompany. */
  reasonStatuses: REASON_STATUSES,
  phases: PHASES,
  kinds: KINDS,
  schemas: {
    report_status: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: STATUSES,
          description: 'Your current state. Report only real changes.',
        },
        reason: {
          type: 'string',
          enum: REASONS,
          description: 'Why; only with status waiting, blocked or failed.',
        },
      },
      required: ['status'],
      additionalProperties: false,
    },
    report_task: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          enum: PHASES,
          description: 'Phase change of a meaningful unit of work.',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description: 'What kind of work the unit is.',
        },
      },
      required: ['phase', 'kind'],
      additionalProperties: false,
    },
  },
} as const);

export interface ReportStatusInput {
  status: SelfReportStatus;
  reason?: SelfReportReason;
}
export interface ReportTaskInput {
  phase: SelfReportPhase;
  kind: SelfReportKind;
}
/** Never carries any part of a rejected input. */
export type SelfReportValidation<T> = { ok: true; value: T } | { ok: false };

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** A JSON object: not null, not an array, prototype `Object.prototype` or `null`. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Every own key (symbols and non-enumerables included) must be in `allowed`. */
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key));

const has = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const FAIL = Object.freeze({ ok: false }) as { ok: false };

/**
 * Strict argument check (ADR-0017 §2): unknown keys, wrong types, values outside the lists, a
 * `reason` with a status other than waiting/blocked/failed, or a missing required key → not ok.
 * On success `value` is a fresh object built from the fixed lists, never the input itself.
 */
export function validateSelfReport(
  tool: 'report_status',
  input: unknown,
): SelfReportValidation<ReportStatusInput>;
export function validateSelfReport(
  tool: 'report_task',
  input: unknown,
): SelfReportValidation<ReportTaskInput>;
export function validateSelfReport(
  tool: SelfReportToolName,
  input: unknown,
): SelfReportValidation<ReportStatusInput | ReportTaskInput>;
export function validateSelfReport(
  tool: SelfReportToolName,
  input: unknown,
): SelfReportValidation<ReportStatusInput | ReportTaskInput> {
  if (!isPlainObject(input)) return FAIL;
  if (tool === 'report_status') {
    if (!onlyKeys(input, ['status', 'reason'])) return FAIL;
    const status = input.status;
    if (!oneOf(STATUSES, status)) return FAIL;
    if (!has(input, 'reason')) return { ok: true, value: { status } };
    const reason = input.reason;
    if (!oneOf(REASONS, reason) || !oneOf(REASON_STATUSES, status)) return FAIL;
    return { ok: true, value: { status, reason } };
  }
  if (tool === 'report_task') {
    if (!onlyKeys(input, ['phase', 'kind'])) return FAIL;
    const phase = input.phase;
    const kind = input.kind;
    if (!oneOf(PHASES, phase) || !oneOf(KINDS, kind)) return FAIL;
    return { ok: true, value: { phase, kind } };
  }
  return FAIL;
}

/** The three agent CLIs whose post-tool hooks emit self-reports (`HookDeps.platform` values). */
export type SelfReportPlatform = 'claude-code' | 'codex-cli' | 'gemini-cli';

export interface SelfReportMatch {
  tool: SelfReportToolName;
  /** `pre`: the pre-tool hook (emits nothing); `post`: the post-tool hook (emits the record). */
  phase: 'pre' | 'post';
}

/** Hook event → phase, per platform (ADR-0017 §3). */
const HOOK_PHASES: Readonly<Record<SelfReportPlatform, Readonly<Record<string, 'pre' | 'post'>>>> =
  deepFreeze({
    'claude-code': { PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'post' },
    'codex-cli': { PreToolUse: 'pre', PostToolUse: 'post' },
    'gemini-cli': { BeforeTool: 'pre', AfterTool: 'post' },
  });

/** Claude Code and Codex name MCP tools `mcp__<server>__<tool>`. */
const PREFIXED_TOOLS: Readonly<Record<string, SelfReportToolName>> = deepFreeze({
  mcp__javi__report_status: 'report_status',
  mcp__javi__report_task: 'report_task',
});

const own = (value: Record<string, unknown>, key: string): unknown =>
  has(value, key) ? value[key] : undefined;

/**
 * Is this hook payload a call of javi's own `report_status` / `report_task`? (ADR-0017 §3.)
 *
 * - Claude Code (`PreToolUse` → pre; `PostToolUse`, `PostToolUseFailure` → post) and Codex
 *   (`PreToolUse` → pre, `PostToolUse` → post): `tool_name` is exactly `mcp__javi__<tool>`.
 * - Gemini (`BeforeTool` → pre, `AfterTool` → post): only `mcp_context.server_name === 'javi'`
 *   and `mcp_context.tool_name` ∈ the two names; Gemini's `tool_name` is not used to match.
 *
 * Reads only `hook_event_name`, `tool_name` (Claude Code, Codex) and `mcp_context.server_name`
 * then `mcp_context.tool_name` (Gemini; the second only when the first is `javi`).
 */
export const matchJaviTool = (platform: string, payload: unknown): SelfReportMatch | null => {
  if (!isPlainObject(payload) || !has(HOOK_PHASES, platform)) return null;
  const phases = HOOK_PHASES[platform as SelfReportPlatform];
  const event = own(payload, 'hook_event_name');
  if (typeof event !== 'string' || !has(phases, event)) return null;
  const phase = phases[event]!;
  if (platform === 'gemini-cli') {
    const mcp = own(payload, 'mcp_context');
    if (!isPlainObject(mcp) || own(mcp, 'server_name') !== SELF_REPORT.serverName) return null;
    const tool = own(mcp, 'tool_name');
    return oneOf(SELF_REPORT.tools, tool) ? { tool, phase } : null;
  }
  const name = own(payload, 'tool_name');
  if (typeof name !== 'string' || !has(PREFIXED_TOOLS, name)) return null;
  return { tool: PREFIXED_TOOLS[name]!, phase };
};

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_ULID_TIME = 2 ** 48 - 1;

export interface SelfReportEventIdInput {
  platform: string;
  /** The hook's raw session id (never leaves this function). */
  sessionId: string;
  /** The hook's call id (Claude Code and Codex `tool_use_id`); absent for Gemini. */
  callId?: string | null | undefined;
  /** Hook time: the ULID's 48-bit time part. */
  at: Date;
  /** Per-installation salt. */
  salt: string;
}

/**
 * Deterministic ULID for a self-report (ADR-0017 §3, review M5): time part = `at` (ms), 80
 * random bits = first 10 bytes of HMAC-SHA-256(salt, platform ‖ 0x00 ‖ sessionId ‖ 0x00 ‖
 * callId), Crockford base32 as in jgr-sdk `createUlid`. The same call re-run by a hook gets the
 * same id (deduped at ingest) and it sorts in the spool by hook time. Returns `null` when there
 * is no call id, so the caller lets the SDK assign a fresh ULID. Throws `RangeError` when `at`
 * is not a 48-bit millisecond time (as `createUlid` does).
 */
export const selfReportEventId = (input: SelfReportEventIdInput): string | null => {
  const { platform, sessionId, callId, at, salt } = input;
  if (typeof callId !== 'string' || callId.length === 0) return null;
  const ms = at.getTime();
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_ULID_TIME) {
    throw new RangeError('ULID time must be a 48-bit millisecond timestamp.');
  }
  let time = '';
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  const digest = createHmac('sha256', salt)
    .update(`${platform}\u0000${sessionId}\u0000${callId}`)
    .digest()
    .subarray(0, 10);
  let bits = 0n;
  for (const byte of digest) bits = (bits << 8n) | BigInt(byte);
  let random = '';
  for (let i = 0; i < 16; i++, bits >>= 5n) random = ALPHABET[Number(bits & 31n)] + random;
  return time + random;
};

export interface SelfReportContext {
  /** Per-installation salt (event-id key; never sent). */
  salt: string;
  /** Hook time: event-id time part and, unless `base.occurred_at` is set, `occurred_at`. */
  at: Date;
}

/**
 * What the caller's platform mapper already derived for this hook (JD-C01 `mapHook`, JD-C02
 * `mapGeminiHook` / `mapCodexHook` return a `RecordInput` that fits as is): `project_ref`,
 * `thread_ref`, `agent_ref` (sub-agents), the platform `attributes` (`platform`,
 * `collector_version`) and optionally `occurred_at`. Only these five fields are read; `type`,
 * `status`, `sequence` and `event_id` of a passed record are ignored, and the self-report keys
 * (`tool_name`, `error_code`, `task_kind`) in `attributes` are replaced.
 */
export type SelfReportBase = Pick<
  RecordInput,
  'project_ref' | 'thread_ref' | 'agent_ref' | 'attributes' | 'occurred_at'
>;

/** JGR attribute string limit (`JGR_LIMITS.maxAttributeStringLength`). */
const MAX_TOOL_NAME_LENGTH = 128;
const SELF_REPORT_KEYS: ReadonlySet<string> = new Set(['tool_name', 'error_code', 'task_kind']);

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * The one JGR record for a post-tool hook call of javi's own tool, or `null` (ADR-0017 §3):
 *
 * - not javi's tool, a pre-tool hook, no `session_id`, no `tool_name`, or `tool_input` invalid
 *   → `null`;
 * - `report_status` → `heartbeat` + `status` (+ `attributes.error_code` = `<status>.<reason>`),
 *   but `null` from a sub-agent (`agent_id` present: a sub-agent never sets the thread status);
 * - `report_task` → `task.<phase>` + `attributes.task_kind`, keeping `base.agent_ref`.
 *
 * Both carry `attributes.tool_name` = the payload's `tool_name` as given (≤ 128 chars, QA gap
 * G19) and, when the payload has a call id, a deterministic `event_id` (`selfReportEventId`).
 * The mapping does not depend on registration (G11), and its time is the caller's clock
 * (`ctx.at` / `base.occurred_at`), never a time inside the payload (G12). Reads only what
 * `matchJaviTool` reads, plus
 * `session_id`, `agent_id`, `tool_input` and `tool_use_id` (Claude Code, Codex) on a post
 * match; `tool_response` and the rest of `mcp_context` are never read.
 */
export const selfReportRecord = (
  platform: string,
  payload: unknown,
  ctx: SelfReportContext,
  base: SelfReportBase,
): RecordInput | null => {
  const match = matchJaviTool(platform, payload);
  if (!match || match.phase !== 'post') return null;
  const hook = payload as Record<string, unknown>;
  const sessionId = str(own(hook, 'session_id'));
  if (!sessionId) return null;
  const subagent = str(own(hook, 'agent_id')) !== null;
  if (match.tool === 'report_status' && subagent) return null;

  const input = own(hook, 'tool_input');
  const checked = validateSelfReport(match.tool, input);
  if (!checked.ok) return null;

  // Provenance is the tool name as the agent's CLI gave it (QA gap G19); never invented.
  const toolName = str(own(hook, 'tool_name'))?.slice(0, MAX_TOOL_NAME_LENGTH);
  if (!toolName) return null;
  const callId = platform === 'gemini-cli' ? null : str(own(hook, 'tool_use_id'));
  const eventId = selfReportEventId({ platform, sessionId, callId, at: ctx.at, salt: ctx.salt });
  const platformAttributes = Object.fromEntries(
    Object.entries(base.attributes ?? {}).filter(([key]) => !SELF_REPORT_KEYS.has(key)),
  );
  const common = {
    project_ref: base.project_ref,
    thread_ref: base.thread_ref,
    ...(base.agent_ref !== undefined && { agent_ref: base.agent_ref }),
    ...(eventId && { event_id: eventId }),
    occurred_at: base.occurred_at ?? ctx.at.toISOString(),
  };

  if (match.tool === 'report_status') {
    const { status, reason } = checked.value as ReportStatusInput;
    return {
      ...common,
      type: 'heartbeat',
      status,
      attributes: {
        ...platformAttributes,
        tool_name: toolName,
        ...(reason && { error_code: `${status}.${reason}` }),
      },
    };
  }
  const { phase, kind } = checked.value as ReportTaskInput;
  return {
    ...common,
    type: `task.${phase}`,
    attributes: { ...platformAttributes, tool_name: toolName, task_kind: kind },
  };
};
