import type { RecordInput } from '@javis-dog/jgr-sdk';
import type { AdapterContext } from './gemini.ts';
import { opaqueRef } from './refs.ts';

// Codex CLI → JGR (ADR-0016 Changes "S5c design" C1–C6 and "S5c design review"). Pure
// functions: hook payloads and OTLP/HTTP JSON **logs** in, operational metadata out. Prompts,
// assistant messages, tool input/output, paths, `user.email`, account ids and any other log
// record are never read into the output.

export const CODEX_PLATFORM = 'codex-cli';

/** Hook events `javi init --platform codex-cli` registers (C2). */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

/** Opaque-ref prefix for Codex session ids (`opaqueRef('cx', session_id, salt)`). */
export const CODEX_THREAD_PREFIX = 'cx';

/** Opaque-ref prefix for Codex sub-agent ids (`opaqueRef('ag', agent_id, salt)`), as JD-C01. */
export const CODEX_AGENT_PREFIX = 'ag';

/**
 * Codex `TelemetryAuthMode` display values (`codex-rs/otel/src/lib.rs`: `ApiKey`, `Chatgpt`;
 * Bedrock maps to `ApiKey`). The parser keeps only these; any other `auth_mode` counts as absent.
 */
export const CODEX_AUTH_MODES = ['ApiKey', 'Chatgpt'] as const;
export type CodexAuthMode = (typeof CODEX_AUTH_MODES)[number];

/** Auth modes whose turn cost is shown (owner: ChatGPT-plan sessions get tokens only). */
export const CODEX_PRICED_AUTH_MODES: readonly string[] = ['ApiKey'];

/** `thread_ref` for a Codex hook `session_id` (= root `conversation.id`): `opaqueRef('cx', …)`. */
export const codexThreadRef = (sessionId: string, salt: string) =>
  opaqueRef(CODEX_THREAD_PREFIX, sessionId, salt);

/** `agent_ref` for a Codex sub-agent `agent_id` (= its `conversation.id`): `opaqueRef('ag', …)`. */
export const codexAgentRef = (agentId: string, salt: string) =>
  opaqueRef(CODEX_AGENT_PREFIX, agentId, salt);

const str = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);

/** JGR attribute string limit (`JGR_LIMITS.maxAttributeStringLength`). */
const MAX_TOOL_NAME_LENGTH = 128;

/** SessionStart `source` values that continue an existing thread (ADR-0016 S5c review, Low). */
const CONTINUING_SOURCES: ReadonlySet<string> = new Set(['compact', 'resume']);

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The JGR record for one Codex hook invocation, or `null` (unknown/dropped event, missing
 * `session_id`). SessionStart with `source` compact/resume → heartbeat, not session.started.
 *
 * Only `session_id`, `hook_event_name`, `source` (SessionStart), `tool_name` (Pre/PostToolUse)
 * and `agent_id` (UserPromptSubmit, Pre/PostToolUse, PermissionRequest, SubagentStart/Stop) are
 * read; `prompt`, `tool_input`, `tool_response`, `last_assistant_message`, `transcript_path`,
 * `agent_transcript_path`, `cwd`, `permission_mode`, `model`, `turn_id` and `agent_type` never
 * are. Statuses match JD-C01's Claude Code mapping. Codex sends the **root** `session_id` on
 * sub-agent hooks too, so a sub-agent's events land on the parent thread and carry
 * `agent_ref = opaqueRef('ag', agent_id, salt)`. `occurred_at` is left to the SDK, as in JD-C01.
 */
export const mapCodexHook = (raw: unknown, ctx: AdapterContext): RecordInput | null => {
  if (!isObj(raw)) return null;
  const hook = raw;
  const sessionId = str(hook.session_id);
  const event = str(hook.hook_event_name);
  if (!sessionId || !event) return null;

  const attributes: Record<string, string | number> = {
    platform: CODEX_PLATFORM,
    collector_version: ctx.collectorVersion,
  };
  const base = {
    project_ref: ctx.projectRef,
    thread_ref: codexThreadRef(sessionId, ctx.salt),
    attributes,
  };
  // `agent_id` is only read on events whose schema carries it (hooks/schema/generated).
  const agent = () => {
    const agentId = str(hook.agent_id);
    return agentId ? { agent_ref: codexAgentRef(agentId, ctx.salt) } : {};
  };
  const withTool = () => {
    const name = str(hook.tool_name)?.slice(0, MAX_TOOL_NAME_LENGTH);
    return { ...attributes, ...(name && { tool_name: name }) };
  };

  switch (event) {
    case 'SessionStart': {
      // `source` ∈ startup, resume, clear, compact, fork. clear and fork start a new id.
      const source = str(hook.source);
      return source !== null && CONTINUING_SOURCES.has(source)
        ? { ...base, type: 'heartbeat', status: 'working' }
        : { ...base, type: 'session.started', status: 'working' };
    }
    case 'SessionEnd':
      return { ...base, type: 'session.ended', status: 'completed' };
    case 'UserPromptSubmit':
      // `prompt` is never read.
      return { ...base, ...agent(), type: 'heartbeat', status: 'working' };
    case 'PreToolUse':
      return { ...base, ...agent(), type: 'task.started', attributes: withTool() };
    case 'PostToolUse':
      // Failure is only visible inside `tool_response` (content) → always task.completed.
      return { ...base, ...agent(), type: 'task.completed', attributes: withTool() };
    case 'PermissionRequest':
      // `tool_input` (and `tool_name`) are not read; the thread waits for a human.
      return { ...base, ...agent(), type: 'attention.requested', status: 'waiting' };
    case 'Stop':
      // `last_assistant_message` is never read.
      return { ...base, type: 'heartbeat', status: 'idle' };
    case 'SubagentStart': {
      const ref = agent();
      return ref.agent_ref ? { ...base, ...ref, type: 'agent.started', status: 'working' } : null;
    }
    case 'SubagentStop': {
      // `last_assistant_message` and `agent_transcript_path` are never read.
      const ref = agent();
      return ref.agent_ref ? { ...base, ...ref, type: 'agent.stopped', status: 'completed' } : null;
    }
    default:
      // Interrupt, PreCompact, PostCompact, model-request events and unknown events.
      return null;
  }
};

/** Sub-agent link learned from a SubagentStart hook (hashed by the caller before storing). */
export interface CodexSubagentLink {
  agentId: string;
  sessionId: string;
}

/**
 * `SubagentStart` payload → link, or null. Reads only `hook_event_name`, `agent_id` and
 * `session_id` (C6, M4): the sub-agent's `agent_id` is its log `conversation.id`, and its hooks'
 * `session_id` is the root (parent) session id.
 */
export const codexSubagentLink = (raw: unknown): CodexSubagentLink | null => {
  if (!isObj(raw) || raw.hook_event_name !== 'SubagentStart') return null;
  const agentId = str(raw.agent_id);
  const sessionId = str(raw.session_id);
  return agentId && sessionId ? { agentId, sessionId } : null;
};

/** One `codex.sse_event` / `response.completed` record (C4, M2). Raw ids stay in memory. */
export interface CodexTokenRecord {
  /** `conversation.id`: the root session id, or a sub-agent's `agent_id`. */
  conversationId: string;
  model: string;
  authMode: string | null;
  /** `event.timestamp` as given (ISO string); part of the deterministic event id. */
  timestamp: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

/** One `codex.turn_cost` record. */
export interface CodexCostRecord {
  conversationId: string;
  turnId: string;
  authMode: string | null;
  /** Parsed from `usage.estimated_usd` (`^\d+(\.\d+)?$`). */
  costUsd: number;
}

export type CodexLogsResult =
  | { ok: true; tokens: CodexTokenRecord[]; costs: CodexCostRecord[]; ignored: number }
  | { ok: false; error: string };

/** Log-record attribute names (ADR-0016 Changes M2: `event.name`/`event.kind` are attributes). */
export const CODEX_SSE_EVENT = 'codex.sse_event';
export const CODEX_RESPONSE_COMPLETED = 'response.completed';
export const CODEX_TURN_COST_EVENT = 'codex.turn_cost';

/** Constant parse error: never echoes body content (ADR-0016 Changes M1). */
export const CODEX_LOGS_PARSE_ERROR = 'Expected an OTLP ExportLogsServiceRequest (resourceLogs).';

const EVENT_NAME = 'event.name';
const ERROR_MESSAGE = 'error.message';
const TOKEN_KEYS = [
  'event.kind',
  'conversation.id',
  'model',
  'auth_mode',
  'event.timestamp',
  'input_token_count',
  'cached_token_count',
  'cache_write_token_count',
  'output_token_count',
] as const;
const COST_KEYS = ['conversation.id', 'turn.id', 'auth_mode', 'usage.estimated_usd'] as const;

/** JGR `usage_delta.model` limit (jgr-spec UsageDelta); longer names are not truncated. */
const MAX_MODEL_LENGTH = 64;
/** Ids are hashed by the caller; this only bounds memory and keeps key material unambiguous. */
const MAX_ID_LENGTH = 256;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const USD = /^\d+(?:\.\d+)?$/;
const UNSIGNED = /^\d{1,16}$/;

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The `value` (OTLP `AnyValue`) of the first attribute for each wanted key. Every attribute's
 * `key` is looked at, but a `value` is read only for a wanted key, so the values of
 * `user.email`, `user.account_id`, tool arguments and every other attribute are never touched.
 * `hasError` says whether an `error.message` key is present (its value is not read).
 */
const pickValues = (attributes: unknown, wanted: readonly string[]) => {
  const values = new Map<string, unknown>();
  let hasError = false;
  for (const attr of list(attributes)) {
    if (!isObj(attr)) continue;
    const key = attr.key;
    if (typeof key !== 'string') continue;
    if (key === ERROR_MESSAGE) hasError = true;
    else if (wanted.includes(key) && !values.has(key)) values.set(key, attr.value);
  }
  return { values, hasError };
};

/** `AnyValue.stringValue`, non-empty. */
const text = (value: unknown) => (isObj(value) ? str(value.stringValue) : null);

/** A string id: non-empty, bounded, no NUL (NUL separates the event-id key material). */
const id = (value: unknown) => {
  const s = text(value);
  return s !== null && s.length <= MAX_ID_LENGTH && !s.includes('\0') ? s : null;
};

/**
 * A token counter given as `stringValue` (decimal string: input, output) or `intValue` (int64:
 * JSON string or number; cached, cache write), M2 → non-negative safe integer, or null. Both
 * forms are accepted for every counter; `doubleValue` and anything else are not.
 */
const counter = (value: unknown): number | null => {
  if (!isObj(value)) return null;
  const raw = value.stringValue !== undefined ? value.stringValue : value.intValue;
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string' || !UNSIGNED.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

const authMode = (value: unknown): CodexAuthMode | null => {
  const s = text(value);
  return s !== null && (CODEX_AUTH_MODES as readonly string[]).includes(s)
    ? (s as CodexAuthMode)
    : null;
};

const toTokenRecord = (attributes: unknown): CodexTokenRecord | null => {
  const { values, hasError } = pickValues(attributes, TOKEN_KEYS);
  // The failure variant has the same name and kind, an `error.message` and no counters.
  if (hasError || text(values.get('event.kind')) !== CODEX_RESPONSE_COMPLETED) return null;
  const conversationId = id(values.get('conversation.id'));
  const model = text(values.get('model'));
  const timestamp = id(values.get('event.timestamp'));
  if (!conversationId || !model || model.length > MAX_MODEL_LENGTH) return null;
  if (!timestamp || !RFC3339.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    return null;
  }
  const input = counter(values.get('input_token_count'));
  const cached = counter(values.get('cached_token_count'));
  const cacheWrite = counter(values.get('cache_write_token_count'));
  const output = counter(values.get('output_token_count'));
  if (input === null || cached === null || cacheWrite === null || output === null) return null;
  return {
    conversationId,
    model,
    authMode: authMode(values.get('auth_mode')),
    timestamp,
    input,
    cached,
    cacheWrite,
    output,
  };
};

const toCostRecord = (attributes: unknown): CodexCostRecord | null => {
  const { values } = pickValues(attributes, COST_KEYS);
  const conversationId = id(values.get('conversation.id'));
  const turnId = id(values.get('turn.id'));
  const usd = text(values.get('usage.estimated_usd'));
  if (!conversationId || !turnId || usd === null || !USD.test(usd)) return null;
  const costUsd = Number(usd);
  if (!Number.isFinite(costUsd)) return null;
  return { conversationId, turnId, authMode: authMode(values.get('auth_mode')), costUsd };
};

/**
 * Allowlist parser for an OTLP/HTTP JSON logs body (`resourceLogs[].scopeLogs[].logRecords[]`).
 *
 * Per record, only `attributes` is read (never `body`, the resource or the scope), and of the
 * attributes only the `event.name` value first (C4: everything else is drained unparsed beyond
 * the record name). Then:
 * - `codex.sse_event` with `event.kind` = `response.completed`, **no** `error.message`, and
 *   `input_token_count`, `cached_token_count`, `cache_write_token_count`, `output_token_count`
 *   all present as non-negative safe integers (`stringValue` or `intValue`) → token record with
 *   `conversation.id`, `model` (≤ 64 chars), `auth_mode` (allowlisted, else null) and
 *   `event.timestamp` (RFC 3339 with offset);
 * - `codex.turn_cost` with `usage.estimated_usd` matching `^\d+(\.\d+)?$`, `turn.id` and
 *   `conversation.id` → cost record (`auth_mode` allowlisted, else null).
 *
 * `tool_token_count` (= total tokens), `reasoning_token_count`, `user.email`,
 * `user.account_id` and every other attribute or record (`codex.tool_result`,
 * `codex.user_prompt`, …) are never read. `ignored` counts log records that produced nothing.
 * `ok: false` (with the constant `CODEX_LOGS_PARSE_ERROR`) only when the body is not a JSON
 * object or `resourceLogs` is not an array; an absent or null `resourceLogs` is an empty request.
 */
export const parseCodexLogs = (body: unknown): CodexLogsResult => {
  const resourceLogsList = isObj(body) ? (body.resourceLogs ?? []) : null;
  if (!Array.isArray(resourceLogsList)) return { ok: false, error: CODEX_LOGS_PARSE_ERROR };
  const tokens: CodexTokenRecord[] = [];
  const costs: CodexCostRecord[] = [];
  let ignored = 0;

  for (const resourceLogs of resourceLogsList) {
    if (!isObj(resourceLogs)) continue;
    for (const scopeLogs of list(resourceLogs.scopeLogs)) {
      if (!isObj(scopeLogs)) continue;
      for (const logRecord of list(scopeLogs.logRecords)) {
        const attributes = isObj(logRecord) ? logRecord.attributes : undefined;
        const name = text(pickValues(attributes, [EVENT_NAME]).values.get(EVENT_NAME));
        if (name === CODEX_SSE_EVENT) {
          const record = toTokenRecord(attributes);
          if (record) {
            tokens.push(record);
            continue;
          }
        } else if (name === CODEX_TURN_COST_EVENT) {
          const record = toCostRecord(attributes);
          if (record) {
            costs.push(record);
            continue;
          }
        }
        ignored += 1;
      }
    }
  }
  return { ok: true, tokens, costs, ignored };
};

/**
 * `usage_delta` counters for one token record (H3: input − cached − cache_write, clamped).
 *
 * Codex's `input_token_count` includes both cached reads and cache writes (official test:
 * input 100 = cached 40 + cache write 60), so `input_tokens` = max(0, input − cached −
 * cacheWrite), `cache_read_tokens` = cached, `cache_write_tokens` = cacheWrite,
 * `output_tokens` = output (reasoning is a subset of output and is not added). `estimated` is
 * `false`: the counts are exact (JGR §6). Zero counters are kept; dropping a record with no
 * counter > 0 is the caller's job.
 */
export const codexUsageDelta = (
  record: CodexTokenRecord,
): {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  model: string;
  estimated: false;
} => ({
  input_tokens: Math.max(0, record.input - record.cached - record.cacheWrite),
  cache_read_tokens: record.cached,
  cache_write_tokens: record.cacheWrite,
  output_tokens: record.output,
  model: record.model,
  estimated: false,
});

/**
 * Cost delta for one cost record, or null when its auth mode is not priced.
 *
 * Only `authMode` in `CODEX_PRICED_AUTH_MODES` (`ApiKey`) yields `{ cost_usd, estimated: false }`
 * with `cost_usd` rounded to 1e-9 USD (the same precision as the Gemini estimate). `Chatgpt`, a
 * missing or any other auth mode → null: tokens only, no cost and no budget impact (a missing
 * cost is never zero). `estimated: false` because the tokens are not estimated (JGR §6); the
 * figure is OpenAI's (or the provider's) turn-cost estimate and the UI labels every cost
 * estimated (ADR-0013).
 */
export const codexCostDelta = (
  record: CodexCostRecord,
): { cost_usd: number; estimated: false } | null => {
  if (record.authMode === null || !CODEX_PRICED_AUTH_MODES.includes(record.authMode)) return null;
  if (!Number.isFinite(record.costUsd) || record.costUsd < 0) return null;
  return { cost_usd: Math.round(record.costUsd * 1e9) / 1e9, estimated: false };
};

/**
 * Deterministic key material for JD-C01's `usage.reported` event id (HMAC with the salt, as
 * `usageEventId`), NUL-separated so it never collides with a Claude Code or Gemini key:
 * - token record: `codex-cli \0 conversationId \0 timestamp \0 input \0 cached \0 cacheWrite \0
 *   output` (raw counters, before the H3 rule);
 * - cost record: `codex-cli \0 conversationId \0 turnId`.
 *
 * The parser rejects ids containing NUL, so the two shapes cannot collide either. The raw ids
 * are in the key only; JD-C01 hashes it and never stores it.
 */
export const codexEventIdInput = (record: CodexTokenRecord | CodexCostRecord): string =>
  'turnId' in record
    ? [CODEX_PLATFORM, record.conversationId, record.turnId].join('\0')
    : [
        CODEX_PLATFORM,
        record.conversationId,
        record.timestamp,
        record.input,
        record.cached,
        record.cacheWrite,
        record.output,
      ].join('\0');
