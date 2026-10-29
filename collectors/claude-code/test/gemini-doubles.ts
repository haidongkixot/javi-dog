import { createHmac } from 'node:crypto';
import type {
  AdapterContext,
  AdapterParseResult,
  AdapterUsagePoint,
  UsageCounters,
} from '@javis-dog/collector-adapters';
import type { RecordInput } from '@javis-dog/jgr-sdk';
import { vi } from 'vitest';

// Local test doubles for the JD-C02 Gemini contract (collectors/adapters/src/gemini.ts), used
// while lane A implements it. They follow the documented contract only, so JD-C01's wiring
// (hook → spool, receiver → baselines → usage.reported) is tested without the real adapter:
//   vi.mock('@javis-dog/collector-adapters', async (orig) => ({ ...(await orig()), ...doubles }))

const ref = (prefix: string, value: string, salt: string) =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;

const HOOKS: Record<string, { type: string; status?: string; tool?: boolean }> = {
  SessionStart: { type: 'session.started', status: 'working' },
  SessionEnd: { type: 'session.ended', status: 'completed' },
  BeforeAgent: { type: 'heartbeat', status: 'working' },
  AfterAgent: { type: 'heartbeat', status: 'idle' },
  BeforeTool: { type: 'task.started', tool: true },
  AfterTool: { type: 'task.completed', tool: true },
};

export const mapGeminiHook = vi.fn((raw: unknown, ctx: AdapterContext): RecordInput | null => {
  if (!raw || typeof raw !== 'object') return null;
  const hook = raw as Record<string, unknown>;
  if (typeof hook.session_id !== 'string' || typeof hook.hook_event_name !== 'string') return null;
  let rule = HOOKS[hook.hook_event_name];
  if (hook.hook_event_name === 'Notification' && hook.notification_type === 'ToolPermission') {
    rule = { type: 'attention.requested', status: 'waiting' };
  }
  if (!rule) return null;
  return {
    project_ref: ctx.projectRef,
    thread_ref: ref('gm', hook.session_id, ctx.salt),
    type: rule.type,
    ...(rule.status && { status: rule.status as 'working' }),
    attributes: {
      platform: 'gemini-cli',
      collector_version: ctx.collectorVersion,
      ...(rule.tool && typeof hook.tool_name === 'string' && { tool_name: hook.tool_name }),
    },
  };
});

const TYPES: Record<string, AdapterUsagePoint['counter']> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cache: 'cache_read_tokens',
  thought: 'reasoning_tokens',
};

type Obj = Record<string, unknown>;
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const attr = (attributes: unknown, key: string) => {
  const found = list(attributes).find((a) => a.key === key);
  const value = (found?.value as Obj | undefined)?.stringValue;
  return typeof value === 'string' ? value : undefined;
};

export const parseGeminiMetrics = vi.fn((body: unknown): AdapterParseResult => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'not an object' };
  }
  const points: AdapterUsagePoint[] = [];
  let ignored = 0;
  for (const rm of list((body as Obj).resourceMetrics)) {
    const resourceSession = attr((rm.resource as Obj | undefined)?.attributes, 'session.id');
    for (const sm of list(rm.scopeMetrics)) {
      for (const metric of list(sm.metrics)) {
        const sum = metric.sum as Obj | undefined;
        if (metric.name !== 'gemini_cli.token.usage' || !sum) continue;
        for (const p of list(sum.dataPoints)) {
          const counter = TYPES[attr(p.attributes, 'type') ?? ''];
          const sessionId = attr(p.attributes, 'session.id') ?? resourceSession;
          const model = attr(p.attributes, 'model');
          if (!counter || !sessionId || !model) {
            ignored += 1;
            continue;
          }
          points.push({
            sessionId,
            model,
            counter,
            value: Number(p.asInt),
            startNs: String(p.startTimeUnixNano),
            endNs: String(p.timeUnixNano),
            temporality: sum.aggregationTemporality === 1 ? 'delta' : 'cumulative',
          });
        }
      }
    }
  }
  return { ok: true, points, ignored };
});

/** Priced model of the double: `cost_usd` = 0.000001 × every counter; others unpriced. */
export const PRICED_MODEL = 'gemini-2.5-pro';

export const geminiUsageDelta = vi.fn((delta: UsageCounters, model: string, at: Date) => {
  void at;
  const out: UsageCounters = { ...delta };
  if (delta.input_tokens !== undefined) {
    out.input_tokens = Math.max(0, delta.input_tokens - (delta.cache_read_tokens ?? 0));
  }
  if (model !== PRICED_MODEL) return { ...out, estimated: false };
  const total = Object.values(out).reduce((n, v) => n + (v ?? 0), 0);
  return { ...out, cost_usd: total / 1_000_000, estimated: true };
});

export const doubles = { mapGeminiHook, parseGeminiMetrics, geminiUsageDelta };

/** Content and identity strings that must never leave the machine. */
export const SENTINELS = ['dev@example.com', 'inst-uuid-777', 'SECRET-PROMPT-TEXT', '/home/dev/x'];

/**
 * A Gemini CLI OTLP/HTTP JSON metrics export (cumulative, like the OTel JS default) with
 * identity attributes on every point and a non-allowlisted metric next to the token counter.
 */
export const geminiExport = (
  sessionId: string,
  opts: {
    startMs: number;
    endMs: number;
    input?: number;
    output?: number;
    cache?: number;
    thought?: number;
    tool?: number;
    model?: string;
  },
) => {
  const ns = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  const a = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const identity = [a('user.email', 'dev@example.com'), a('installation.id', 'inst-uuid-777')];
  const point = (type: string, value: number) => ({
    attributes: [
      a('session.id', sessionId),
      a('model', opts.model ?? PRICED_MODEL),
      a('type', type),
      ...identity,
    ],
    startTimeUnixNano: ns(opts.startMs),
    timeUnixNano: ns(opts.endMs),
    asInt: String(value),
  });
  const counts: Array<[string, number | undefined]> = [
    ['input', opts.input],
    ['output', opts.output],
    ['cache', opts.cache],
    ['thought', opts.thought],
    ['tool', opts.tool],
  ];
  return {
    resourceMetrics: [
      {
        resource: { attributes: [a('service.name', 'gemini-cli'), a('session.id', sessionId)] },
        scopeMetrics: [
          {
            scope: { name: 'gemini-cli' },
            metrics: [
              {
                name: 'gemini_cli.token.usage',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: counts
                    .filter(([, v]) => v !== undefined)
                    .map(([type, v]) => point(type, v!)),
                },
              },
              {
                name: 'gemini_cli.user_prompt.count',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    { attributes: [a('prompt', 'SECRET-PROMPT-TEXT'), ...identity], asInt: '1' },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
};
