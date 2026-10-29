import type { RecordInput } from '@javis-dog/jgr-sdk';
import type { AdapterContext } from './gemini.ts';

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

/** Auth modes whose turn cost is shown (owner: ChatGPT-plan sessions get tokens only). */
export const CODEX_PRICED_AUTH_MODES: readonly string[] = ['ApiKey'];

/**
 * The JGR record for one Codex hook invocation, or `null` (unknown/dropped event, missing
 * `session_id`). SessionStart with `source` compact/resume → heartbeat, not session.started.
 */
export const mapCodexHook = (_raw: unknown, _ctx: AdapterContext): RecordInput | null => {
  void [_raw, _ctx];
  throw new Error('not implemented (S5c lane A)');
};

/** Sub-agent link learned from a SubagentStart hook (hashed by the caller before storing). */
export interface CodexSubagentLink {
  agentId: string;
  sessionId: string;
}

/** `SubagentStart` payload → link, or null. */
export const codexSubagentLink = (_raw: unknown): CodexSubagentLink | null => {
  void _raw;
  throw new Error('not implemented (S5c lane A)');
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

/** Allowlist parser for an OTLP/HTTP JSON logs body (`resourceLogs[].scopeLogs[].logRecords[]`). */
export const parseCodexLogs = (_body: unknown): CodexLogsResult => {
  void _body;
  throw new Error('not implemented (S5c lane A)');
};

/** `usage_delta` counters for one token record (H3: input − cached − cache_write, clamped). */
export const codexUsageDelta = (
  _record: CodexTokenRecord,
): {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  model: string;
  estimated: false;
} => {
  void _record;
  throw new Error('not implemented (S5c lane A)');
};

/** Cost delta for one cost record, or null when its auth mode is not priced. */
export const codexCostDelta = (
  _record: CodexCostRecord,
): { cost_usd: number; estimated: false } | null => {
  void _record;
  throw new Error('not implemented (S5c lane A)');
};
