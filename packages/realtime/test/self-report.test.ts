import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDashboardReader, type ThreadState } from '../src/index.ts';
import { ago, freshDb, MIN, SEC, seeder, type Scope } from './helpers.ts';

// ADR-0017 decision 6 and TEST_PLAN §S5d (precedence, reader rows), on PGlite with the real
// migrations. A self-report is a `heartbeat` with a status and `attributes.tool_name`
// (decision 3); its reason travels as `attributes.error_code` = `<status>.<reason>`.

const NOW = new Date('2026-10-30T12:00:00.000Z');
const SELF = 'mcp__javi__report_status';

let ctx: Awaited<ReturnType<typeof freshDb>>;
let seed: ReturnType<typeof seeder>;
let reader: ReturnType<typeof createDashboardReader>;

beforeAll(async () => {
  ctx = await freshDb();
  seed = seeder(ctx.db);
  reader = createDashboardReader(ctx.db);
});
beforeEach(async () => {
  await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
});

const oneProject = async () => {
  const ws = await seed.workspace('Self-report team');
  return seed.project(ws, 'Web App', 'web-app');
};

const threadOf = (threads: ThreadState[], ref: string) => {
  const t = threads.find((x) => x.threadRef === ref);
  if (!t) throw new Error(`thread ${ref} missing`);
  return t;
};

/** One event of a scripted sequence; `ageMs` is measured back from NOW. */
interface Step {
  type: string;
  status?: string;
  /** `attributes.tool_name` (a self-report when the event is a heartbeat with a status). */
  tool?: string;
  /** `attributes.error_code` */
  code?: string;
  ageMs: number;
  sequence?: number;
  id?: string;
}

const agent = (status: string, ageMs: number, code?: string, extra: Partial<Step> = {}): Step => ({
  type: 'heartbeat',
  status,
  tool: SELF,
  ...(code ? { code } : {}),
  ageMs,
  ...extra,
});

const play = async (p: Scope, threadRef: string, steps: Step[]) => {
  for (const s of steps) {
    const attributes: Record<string, string> = {};
    if (s.tool) attributes.tool_name = s.tool;
    if (s.code) attributes.error_code = s.code;
    await seed.event(p, {
      threadRef,
      type: s.type,
      status: s.status ?? null,
      attributes: Object.keys(attributes).length ? attributes : null,
      receivedAt: ago(NOW, s.ageMs),
      ...(s.sequence !== undefined ? { sequence: s.sequence } : {}),
      ...(s.id ? { id: s.id } : {}),
    });
  }
};

type Want = Pick<ThreadState, 'status' | 'statusSource' | 'statusReason'> &
  Partial<Pick<ThreadState, 'attention' | 'needsAttention' | 'freshness'>>;

interface Case {
  name: string;
  steps: Step[];
  want: Want;
}

const BLOCKED_CREDS = agent('blocked', 3 * MIN, 'blocked.missing_credentials');

// Each row is one thread; all rows share one database and one snapshot.
const cases: Case[] = [
  // --- the agent status alone ---
  {
    name: 'agent blocked with a listed reason',
    steps: [{ type: 'heartbeat', status: 'working', ageMs: 4 * MIN }, BLOCKED_CREDS],
    want: {
      status: 'blocked',
      statusSource: 'agent',
      statusReason: 'missing_credentials',
      attention: true,
      needsAttention: true,
    },
  },
  {
    name: 'agent blocked without a reason',
    steps: [agent('blocked', 1 * MIN)],
    want: { status: 'blocked', statusSource: 'agent', statusReason: null, attention: true },
  },
  // --- survives (TEST_PLAN precedence row): collector idle, attention, usage, error ---
  {
    name: 'survives a later collector heartbeat idle (end of turn, review H1)',
    steps: [BLOCKED_CREDS, { type: 'heartbeat', status: 'idle', ageMs: 2 * MIN }],
    want: {
      status: 'blocked',
      statusSource: 'agent',
      statusReason: 'missing_credentials',
      attention: true,
    },
  },
  {
    name: 'survives a later usage.reported',
    steps: [BLOCKED_CREDS, { type: 'usage.reported', ageMs: 2 * MIN }],
    want: { status: 'blocked', statusSource: 'agent', statusReason: 'missing_credentials' },
  },
  {
    name: 'survives a later error',
    steps: [BLOCKED_CREDS, { type: 'error', code: 'E_TOOL', ageMs: 2 * MIN }],
    want: { status: 'blocked', statusSource: 'agent', statusReason: 'missing_credentials' },
  },
  {
    name: 'survives a later status-less heartbeat with no tool_name',
    steps: [BLOCKED_CREDS, { type: 'heartbeat', ageMs: 2 * MIN }],
    want: { status: 'blocked', statusSource: 'agent', statusReason: 'missing_credentials' },
  },
  {
    name: 'survives a later collector heartbeat blocked (only `working` clears)',
    steps: [
      agent('waiting', 3 * MIN, 'waiting.needs_input'),
      { type: 'heartbeat', status: 'blocked', ageMs: 2 * MIN },
    ],
    want: { status: 'waiting', statusSource: 'agent', statusReason: 'needs_input' },
  },
  // --- cleared (TEST_PLAN precedence row): task.*, session.*, agent.*, collector working ---
  {
    name: 'cleared by a later collector heartbeat working (next prompt)',
    steps: [BLOCKED_CREDS, { type: 'heartbeat', status: 'working', ageMs: 2 * MIN }],
    want: {
      status: 'working',
      statusSource: 'collector',
      statusReason: null,
      attention: false,
      needsAttention: false,
    },
  },
  {
    name: 'cleared by a later agent.started',
    steps: [BLOCKED_CREDS, { type: 'agent.started', status: 'working', ageMs: 2 * MIN }],
    want: { status: 'working', statusSource: 'collector', statusReason: null, attention: false },
  },
  {
    name: 'cleared by a later agent.stopped',
    steps: [BLOCKED_CREDS, { type: 'agent.stopped', status: 'idle', ageMs: 2 * MIN }],
    want: { status: 'idle', statusSource: 'collector', statusReason: null, attention: false },
  },
  // Status-less clearing events: the existing rule (latest non-null status) then applies.
  ...(['task.started', 'task.completed', 'task.failed', 'session.started'] as const).map(
    (type): Case => ({
      name: `cleared by a later ${type}`,
      steps: [
        { type: 'heartbeat', status: 'working', ageMs: 5 * MIN },
        agent('waiting', 3 * MIN, 'waiting.needs_approval'),
        { type, ...(type.startsWith('task.') ? { tool: 'Bash' } : {}), ageMs: 2 * MIN },
      ],
      // G6: the status from before the agent's report, never the agent's own.
      want: {
        status: 'working',
        statusSource: 'collector',
        statusReason: null,
        attention: false,
      },
    }),
  ),
  {
    name: 'G8: cleared by a later attention.requested (a real permission prompt)',
    steps: [BLOCKED_CREDS, { type: 'attention.requested', status: 'waiting', ageMs: 2 * MIN }],
    want: {
      status: 'waiting',
      statusSource: 'collector',
      statusReason: null,
      attention: true,
      needsAttention: true,
    },
  },
  {
    name: 'G8: an attention.requested hides an agent working, not the prompt',
    steps: [
      agent('working', 3 * MIN),
      { type: 'attention.requested', status: 'waiting', ageMs: 2 * MIN },
    ],
    want: {
      status: 'waiting',
      statusSource: 'collector',
      statusReason: null,
      attention: true,
    },
  },
  {
    name: 'G6: cleared with no collector status before it gives null',
    steps: [BLOCKED_CREDS, { type: 'task.started', tool: 'Bash', ageMs: 2 * MIN }],
    want: { status: null, statusSource: 'collector', statusReason: null, attention: false },
  },
  {
    name: 'G6: older self-reports never count as the collector status',
    steps: [
      { type: 'heartbeat', status: 'idle', ageMs: 6 * MIN },
      agent('failed', 5 * MIN, 'failed.ci_failing'),
      agent('blocked', 4 * MIN, 'blocked.missing_access'),
      { type: 'task.completed', tool: 'Edit', ageMs: 3 * MIN },
    ],
    want: { status: 'idle', statusSource: 'collector', statusReason: null, attention: false },
  },
  {
    name: 'cleared by a later session.ended',
    steps: [
      agent('waiting', 3 * MIN, 'waiting.needs_input'),
      { type: 'session.ended', ageMs: 2 * MIN },
    ],
    want: {
      status: null,
      statusSource: 'collector',
      statusReason: null,
      freshness: 'ended',
      attention: false,
      needsAttention: false,
    },
  },
  {
    name: 'G7: a self-reported task.* clears an older self-reported status too',
    steps: [
      { type: 'heartbeat', status: 'working', ageMs: 4 * MIN },
      BLOCKED_CREDS,
      { type: 'task.started', tool: 'mcp__javi__report_task', ageMs: 2 * MIN },
    ],
    want: { status: 'working', statusSource: 'collector', statusReason: null, attention: false },
  },
  // --- a clearing event older than the self-report does not clear it ---
  {
    name: 'an older collector working does not clear a newer self-report',
    steps: [
      { type: 'heartbeat', status: 'working', ageMs: 4 * MIN },
      { type: 'task.completed', tool: 'Edit', ageMs: 3 * MIN },
      agent('failed', 2 * MIN, 'failed.tests_failing'),
    ],
    want: {
      status: 'failed',
      statusSource: 'agent',
      statusReason: 'tests_failing',
      attention: false,
    },
  },
  // --- newer self-report replaces older ---
  {
    name: 'a newer self-report replaces an older one, reason included',
    steps: [BLOCKED_CREDS, agent('waiting', 2 * MIN, 'waiting.needs_approval')],
    want: { status: 'waiting', statusSource: 'agent', statusReason: 'needs_approval' },
  },
  {
    name: 'a newer self-reported working replaces blocked and drops the reason',
    steps: [BLOCKED_CREDS, agent('working', 2 * MIN)],
    want: { status: 'working', statusSource: 'agent', statusReason: null, attention: false },
  },
  // --- order ties: same received_at, then sequence, then row id (LATEST_FIRST) ---
  {
    name: 'tie on received_at: the higher sequence (self-report) wins over a clear',
    steps: [
      agent('blocked', 2 * MIN, 'blocked.ci_failing', { sequence: 9 }),
      { type: 'heartbeat', status: 'working', ageMs: 2 * MIN, sequence: 8 },
    ],
    want: { status: 'blocked', statusSource: 'agent', statusReason: 'ci_failing' },
  },
  {
    name: 'tie on received_at: the higher sequence (clear) wins over a self-report',
    steps: [
      { type: 'heartbeat', status: 'working', ageMs: 2 * MIN, sequence: 9 },
      agent('blocked', 2 * MIN, 'blocked.ci_failing', { sequence: 8 }),
    ],
    want: { status: 'working', statusSource: 'collector', statusReason: null },
  },
  {
    name: 'tie on received_at and sequence: the higher row id (self-report) wins',
    steps: [
      {
        type: 'heartbeat',
        status: 'working',
        ageMs: 2 * MIN,
        sequence: 5,
        id: '00000000-0000-4000-8000-000000000001',
      },
      agent('blocked', 2 * MIN, 'blocked.rate_limited', {
        sequence: 5,
        id: '00000000-0000-4000-8000-000000000002',
      }),
    ],
    want: { status: 'blocked', statusSource: 'agent', statusReason: 'rate_limited' },
  },
  {
    name: 'tie on received_at and sequence: the higher row id (clear) wins',
    steps: [
      agent('blocked', 2 * MIN, 'blocked.rate_limited', {
        sequence: 5,
        id: '00000000-0000-4000-8000-000000000003',
      }),
      {
        type: 'heartbeat',
        status: 'working',
        ageMs: 2 * MIN,
        sequence: 5,
        id: '00000000-0000-4000-8000-000000000004',
      },
    ],
    want: { status: 'working', statusSource: 'collector', statusReason: null },
  },
  // --- reason accepted only from the list, with a matching prefix ---
  ...(
    [
      ['needs_input', 'waiting'],
      ['needs_approval', 'waiting'],
      ['missing_credentials', 'blocked'],
      ['missing_access', 'blocked'],
      ['tests_failing', 'failed'],
      ['ci_failing', 'failed'],
      ['rate_limited', 'blocked'],
      ['dependency_down', 'blocked'],
      ['conflicting_requirements', 'blocked'],
      ['other', 'failed'],
    ] as const
  ).map(([reason, status]): Case => ({
    name: `accepts the listed reason ${reason}`,
    steps: [agent(status, 1 * MIN, `${status}.${reason}`)],
    want: { status, statusSource: 'agent', statusReason: reason },
  })),
  {
    name: 'rejects an unknown reason',
    steps: [agent('blocked', 1 * MIN, 'blocked.E_SECRET_SHAPE')],
    want: { status: 'blocked', statusSource: 'agent', statusReason: null },
  },
  {
    name: 'rejects a reason whose prefix is another status',
    steps: [agent('blocked', 1 * MIN, 'waiting.missing_credentials')],
    want: { status: 'blocked', statusSource: 'agent', statusReason: null },
  },
  {
    name: 'rejects an error_code without a status prefix',
    steps: [agent('blocked', 1 * MIN, 'missing_credentials')],
    want: { status: 'blocked', statusSource: 'agent', statusReason: null },
  },
  {
    name: 'rejects a reason on a status that takes none (working, idle, completed)',
    steps: [agent('working', 1 * MIN, 'working.other')],
    want: { status: 'working', statusSource: 'agent', statusReason: null },
  },
  {
    name: 'rejects a reason on completed',
    steps: [agent('completed', 1 * MIN, 'completed.other')],
    want: { status: 'completed', statusSource: 'agent', statusReason: null },
  },
  {
    name: 'rejects a listed reason with a trailing segment',
    steps: [agent('blocked', 1 * MIN, 'blocked.missing_credentials.extra')],
    want: { status: 'blocked', statusSource: 'agent', statusReason: null },
  },
  // --- attention (owner decision 2026-10-30) ---
  {
    name: 'collector-only blocked does not need attention',
    steps: [{ type: 'heartbeat', status: 'blocked', ageMs: 1 * MIN }],
    want: {
      status: 'blocked',
      statusSource: 'collector',
      statusReason: null,
      attention: false,
      needsAttention: false,
    },
  },
  {
    name: 'collector waiting still needs attention',
    steps: [{ type: 'attention.requested', status: 'waiting', ageMs: 1 * MIN }],
    want: { status: 'waiting', statusSource: 'collector', statusReason: null, attention: true },
  },
  {
    name: 'a stale agent waiting still needs attention',
    steps: [agent('waiting', 10 * MIN, 'waiting.needs_input')],
    want: {
      status: 'waiting',
      statusSource: 'agent',
      statusReason: 'needs_input',
      freshness: 'stale',
      attention: true,
      needsAttention: true,
    },
  },
  {
    name: 'a stale agent blocked still needs attention',
    steps: [agent('blocked', 10 * MIN, 'blocked.missing_access')],
    want: {
      status: 'blocked',
      statusSource: 'agent',
      statusReason: 'missing_access',
      freshness: 'stale',
      attention: true,
      needsAttention: true,
    },
  },
  // --- structural rule: tool_name and a status make a self-report, no tool-name list ---
  {
    name: 'a heartbeat with status and any tool_name is a self-report (Gemini spelling)',
    steps: [agent('completed', 1 * MIN, undefined, { tool: 'mcp_javi_report_status' })],
    want: { status: 'completed', statusSource: 'agent', statusReason: null },
  },
  {
    name: 'a non-heartbeat with tool_name and a status is not a self-report',
    steps: [{ type: 'agent.started', status: 'working', tool: SELF, ageMs: 1 * MIN }],
    want: { status: 'working', statusSource: 'collector', statusReason: null },
  },
  {
    name: 'a heartbeat with tool_name and no status is not a self-report',
    steps: [
      { type: 'heartbeat', status: 'idle', ageMs: 2 * MIN },
      { type: 'heartbeat', tool: SELF, ageMs: 1 * MIN },
    ],
    want: { status: 'idle', statusSource: 'collector', statusReason: null },
  },
  {
    name: 'no status ever',
    steps: [{ type: 'session.started', ageMs: 1 * MIN }],
    want: { status: null, statusSource: 'collector', statusReason: null, attention: false },
  },
];

describe('self-report precedence (ADR-0017 §6)', () => {
  it.each(cases.map((c, i) => [c.name, i] as const))('%s', async (_name, i) => {
    const c = cases[i]!;
    const p = await oneProject();
    const ref = `cc_case_${i}`;
    await play(p, ref, c.steps);
    // A neighbour thread in the same project never leaks its self-report into this one.
    await play(p, `${ref}_other`, [agent('blocked', 30 * SEC, 'blocked.dependency_down')]);
    const s = await reader.snapshot(p.workspaceId, { now: NOW });
    expect(threadOf(s.threads, ref)).toMatchObject(c.want);
  });

  it('counts an agent-blocked thread in project attention and sorts it first', async () => {
    const p = await oneProject();
    await play(p, 'cc_working', [{ type: 'heartbeat', status: 'working', ageMs: 10 * SEC }]);
    await play(p, 'cc_collector_blocked', [
      { type: 'heartbeat', status: 'blocked', ageMs: 20 * SEC },
    ]);
    await play(p, 'cc_agent_blocked', [agent('blocked', 2 * MIN, 'blocked.missing_credentials')]);
    await seed.signal(p, ago(NOW, 10 * SEC));
    const s = await reader.snapshot(p.workspaceId, { now: NOW });
    expect(s.threads.map((t) => t.threadRef)).toEqual([
      'cc_agent_blocked',
      'cc_working',
      'cc_collector_blocked',
    ]);
    expect(s.projects[0]).toMatchObject({ attentionThreads: 1, freshThreads: 3 });
  });
});

describe('self-report in the activity feed', () => {
  it('labels each row with its own source and reason; other attributes stay unread', async () => {
    const p = await oneProject();
    await play(p, 'cc_feed', [
      { type: 'heartbeat', status: 'working', ageMs: 6 * SEC },
      agent('blocked', 5 * SEC, 'blocked.missing_credentials'),
      { type: 'heartbeat', status: 'idle', code: 'idle.missing_credentials', ageMs: 4 * SEC },
      agent('waiting', 3 * SEC, 'blocked.needs_input'),
      { type: 'task.started', tool: 'Bash', code: 'E_TASK_CODE', ageMs: 2 * SEC },
      { type: 'error', code: 'E_SECRET_SHAPE', ageMs: 1 * SEC },
    ]);
    const s = await reader.snapshot(p.workspaceId, { now: NOW });
    expect(
      s.activity.map(({ type, status, toolName, statusSource, statusReason }) => ({
        type,
        status,
        toolName,
        statusSource,
        statusReason,
      })),
    ).toEqual([
      {
        type: 'error',
        status: null,
        toolName: null,
        statusSource: 'collector',
        statusReason: null,
      },
      {
        type: 'task.started',
        status: null,
        toolName: 'Bash',
        statusSource: 'collector',
        statusReason: null,
      },
      // Prefix mismatch: source still agent, reason dropped.
      {
        type: 'heartbeat',
        status: 'waiting',
        toolName: SELF,
        statusSource: 'agent',
        statusReason: null,
      },
      // A collector heartbeat never reads its error_code, even a well-formed one.
      {
        type: 'heartbeat',
        status: 'idle',
        toolName: null,
        statusSource: 'collector',
        statusReason: null,
      },
      {
        type: 'heartbeat',
        status: 'blocked',
        toolName: SELF,
        statusSource: 'agent',
        statusReason: 'missing_credentials',
      },
      {
        type: 'heartbeat',
        status: 'working',
        toolName: null,
        statusSource: 'collector',
        statusReason: null,
      },
    ]);
    const json = JSON.stringify(s);
    expect(json).not.toContain('E_SECRET_SHAPE');
    expect(json).not.toContain('E_TASK_CODE');
    expect(json).not.toContain('blocked.');
  });
});
