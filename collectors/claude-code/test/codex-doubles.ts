import { createHmac } from 'node:crypto';
import type {
  AdapterContext,
  CodexCostRecord,
  CodexLogsResult,
  CodexSubagentLink,
  CodexTokenRecord,
} from '@javis-dog/collector-adapters';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { vi } from 'vitest';

// Local test doubles for the JD-C02 Codex contract (collectors/adapters/src/codex.ts), used
// while lane A implements it. They follow the documented contract only (ADR-0016 Changes S5c
// C2–C6, H3, M2), so JD-C01's wiring (hook → spool and sub-agent links, receiver → attribution
// → usage.reported) is tested without the real adapter:
//   vi.mock('@javis-dog/collector-adapters', async (orig) => ({ ...(await orig()), ...codexDoubles }))

/** Content a hook payload or a Codex log may carry that must never reach a spool or a file. */
export const SENTINELS = {
  prompt: 'SENTINEL_PROMPT_codex_9f1',
  toolInput: 'SENTINEL_TOOL_INPUT_codex_3c7',
  email: 'sentinel.user@example.invalid',
  toolArgs: 'SENTINEL_TOOL_ARGS_codex_51a',
  cwd: '/home/sentinel/private-repo',
};

const ref = (prefix: string, value: string, salt: string) =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;

const HOOKS: Record<string, { type: string; status?: string; tool?: boolean; agent?: boolean }> = {
  SessionStart: { type: 'session.started', status: 'working' },
  SessionEnd: { type: 'session.ended', status: 'completed' },
  UserPromptSubmit: { type: 'heartbeat', status: 'working' },
  PreToolUse: { type: 'task.started', tool: true },
  PostToolUse: { type: 'task.completed', tool: true },
  PermissionRequest: { type: 'attention.requested', status: 'waiting' },
  Stop: { type: 'heartbeat', status: 'idle' },
  SubagentStart: { type: 'agent.started', status: 'working', agent: true },
  SubagentStop: { type: 'agent.stopped', status: 'completed', agent: true },
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export const mapCodexHook = vi.fn((raw: unknown, ctx: AdapterContext): RecordInput | null => {
  if (!raw || typeof raw !== 'object') return null;
  const hook = raw as Record<string, unknown>;
  const sessionId = str(hook.session_id);
  const event = str(hook.hook_event_name);
  if (!sessionId || !event) return null;
  let rule = HOOKS[event];
  if (event === 'SessionStart' && (hook.source === 'compact' || hook.source === 'resume')) {
    rule = { type: 'heartbeat', status: 'working' };
  }
  if (!rule) return null;
  const agentId = str(hook.agent_id);
  if (rule.agent && !agentId) return null;
  return {
    project_ref: ctx.projectRef,
    thread_ref: ref('cx', sessionId, ctx.salt),
    ...(agentId && { agent_ref: ref('ag', agentId, ctx.salt) }),
    type: rule.type,
    ...(rule.status && { status: rule.status as 'working' }),
    attributes: {
      platform: 'codex-cli',
      collector_version: ctx.collectorVersion,
      ...(rule.tool && typeof hook.tool_name === 'string' && { tool_name: hook.tool_name }),
    },
  };
});

export const codexSubagentLink = vi.fn((raw: unknown): CodexSubagentLink | null => {
  if (!raw || typeof raw !== 'object') return null;
  const hook = raw as Record<string, unknown>;
  const agentId = str(hook.agent_id);
  const sessionId = str(hook.session_id);
  return hook.hook_event_name === 'SubagentStart' && agentId && sessionId
    ? { agentId, sessionId }
    : null;
});

type Obj = Record<string, unknown>;
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const attr = (attributes: unknown, key: string): unknown => {
  const value = list(attributes).find((a) => a.key === key)?.value as Obj | undefined;
  if (!value) return undefined;
  return value.stringValue ?? value.intValue;
};
const count = (v: unknown) => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export const parseCodexLogs = vi.fn((body: unknown): CodexLogsResult => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'not an object' };
  }
  const tokens: CodexTokenRecord[] = [];
  const costs: CodexCostRecord[] = [];
  let ignored = 0;
  for (const rl of list((body as Obj).resourceLogs)) {
    for (const sl of list(rl.scopeLogs)) {
      for (const record of list(sl.logRecords)) {
        const a = record.attributes;
        const name = attr(a, 'event.name');
        const conversationId = str(attr(a, 'conversation.id'));
        const authMode = str(attr(a, 'auth_mode'));
        if (name === 'codex.sse_event' && attr(a, 'event.kind') === 'response.completed') {
          const input = count(attr(a, 'input_token_count'));
          const output = count(attr(a, 'output_token_count'));
          const cached = count(attr(a, 'cached_token_count')) ?? 0;
          const cacheWrite = count(attr(a, 'cache_write_token_count')) ?? 0;
          if (
            conversationId &&
            input !== null &&
            output !== null &&
            attr(a, 'error.message') === undefined
          ) {
            tokens.push({
              conversationId,
              model: str(attr(a, 'model')) ?? 'unknown',
              authMode,
              timestamp: str(attr(a, 'event.timestamp')) ?? '',
              input,
              cached,
              cacheWrite,
              output,
            });
            continue;
          }
        }
        if (name === 'codex.turn_cost') {
          const usd = attr(a, 'usage.estimated_usd');
          const turnId = str(attr(a, 'turn.id'));
          if (conversationId && turnId && typeof usd === 'string' && /^\d+(\.\d+)?$/.test(usd)) {
            costs.push({ conversationId, turnId, authMode, costUsd: Number(usd) });
            continue;
          }
        }
        ignored += 1;
      }
    }
  }
  return { ok: true, tokens, costs, ignored };
});

export const codexUsageDelta = vi.fn((r: CodexTokenRecord) => ({
  input_tokens: Math.max(0, r.input - r.cached - r.cacheWrite),
  cache_read_tokens: r.cached,
  cache_write_tokens: r.cacheWrite,
  output_tokens: r.output,
  model: r.model,
  estimated: false as const,
}));

export const codexCostDelta = vi.fn((r: CodexCostRecord) =>
  r.authMode === 'ApiKey' ? { cost_usd: r.costUsd, estimated: false as const } : null,
);

export const codexDoubles = {
  mapCodexHook,
  codexSubagentLink,
  parseCodexLogs,
  codexUsageDelta,
  codexCostDelta,
};

// --- OTLP/HTTP JSON logs bodies the way Codex exports them (M2 wire types) ---

const kv = (key: string, value: string | number) => ({
  key,
  value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
});

/** One `codex.sse_event` / `response.completed` record, with the content Codex attaches. */
export const tokenLog = (opts: {
  conversationId: string;
  input: number;
  cached?: number;
  cacheWrite?: number;
  output: number;
  authMode?: string;
  timestamp?: string;
  model?: string;
  error?: boolean;
}) => ({
  attributes: [
    kv('event.name', 'codex.sse_event'),
    kv('event.kind', 'response.completed'),
    kv('event.timestamp', opts.timestamp ?? '2026-10-29T12:00:00.000Z'),
    kv('conversation.id', opts.conversationId),
    kv('auth_mode', opts.authMode ?? 'ApiKey'),
    kv('model', opts.model ?? 'gpt-5-codex'),
    kv('user.email', SENTINELS.email),
    ...(opts.error
      ? [kv('error.message', 'stream failed')]
      : [
          kv('input_token_count', String(opts.input)),
          kv('output_token_count', String(opts.output)),
          kv('cached_token_count', opts.cached ?? 0),
          kv('cache_write_token_count', opts.cacheWrite ?? 0),
          kv('reasoning_token_count', 7),
          kv('tool_token_count', String(opts.input + opts.output)),
        ]),
  ],
});

/** One `codex.turn_cost` record. */
export const costLog = (opts: {
  conversationId: string;
  turnId: string;
  usd: string;
  authMode?: string;
}) => ({
  attributes: [
    kv('event.name', 'codex.turn_cost'),
    kv('conversation.id', opts.conversationId),
    kv('turn.id', opts.turnId),
    kv('usage.estimated_usd', opts.usd),
    kv('auth_mode', opts.authMode ?? 'ApiKey'),
    kv('user.email', SENTINELS.email),
  ],
});

/** A content-bearing record javi must drop (`codex.tool_result`). */
export const toolResultLog = () => ({
  attributes: [
    kv('event.name', 'codex.tool_result'),
    kv('arguments', SENTINELS.toolArgs),
    kv('user.email', SENTINELS.email),
  ],
});

export const logsBody = (records: unknown[]) => ({
  resourceLogs: [{ scopeLogs: [{ logRecords: records }] }],
});
