import { createHmac } from 'node:crypto';
import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import {
  CODEX_HOOK_EVENTS,
  CODEX_THREAD_PREFIX,
  codexAgentRef,
  codexSubagentLink,
  codexThreadRef,
  mapCodexHook,
} from '../src/index.ts';

const ctx = { projectRef: 'web-app', salt: 'test-salt', collectorVersion: '0.3.0-test' };
const SESSION = '019a3c5e-7f3a-7c11-9d2e-codex-root';
const AGENT = '019a3c5e-aaaa-7c11-9d2e-codex-child';

const hmac = (prefix: string, value: string, salt = 'test-salt') =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;

// Sentinel strings in every content-bearing or identifying field; none may reach the output.
const SENTINELS = {
  prompt: 'SENTINEL-prompt-my-private-prompt',
  tool_input: 'SENTINEL-tool_input-rm-rf-secret',
  tool_response: 'SENTINEL-tool_response-API_KEY=abc',
  last_assistant_message: 'SENTINEL-last_assistant_message-text',
  transcript_path: '/home/hai/.codex/sessions/SENTINEL-transcript.jsonl',
  agent_transcript_path: '/home/hai/.codex/sessions/SENTINEL-agent-transcript.jsonl',
  cwd: '/home/hai/SENTINEL-cwd-secret-repo',
  permission_mode: 'SENTINEL-permission_mode',
  model: 'SENTINEL-model-gpt',
  turn_id: 'SENTINEL-turn_id',
  tool_use_id: 'SENTINEL-tool_use_id',
  agent_type: 'SENTINEL-agent_type',
};

// Shapes follow openai/codex codex-rs/hooks/schema/generated/*.command.input.schema.json (main,
// fetched 2026-10-29). Content fields are included on purpose to prove they never leave the mapper.
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  transcript_path: SENTINELS.transcript_path,
  cwd: SENTINELS.cwd,
  hook_event_name: event,
  model: SENTINELS.model,
  permission_mode: SENTINELS.permission_mode,
  ...extra,
});

const turn = { turn_id: SENTINELS.turn_id };
const tool = {
  ...turn,
  tool_name: 'shell',
  tool_input: { command: ['bash', '-lc', SENTINELS.tool_input] },
  tool_use_id: SENTINELS.tool_use_id,
};
const sub = { agent_id: AGENT, agent_type: SENTINELS.agent_type };

const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
  [
    'SessionStart startup',
    'SessionStart',
    { source: 'startup' },
    { type: 'session.started', status: 'working' },
  ],
  [
    'SessionStart clear',
    'SessionStart',
    { source: 'clear' },
    { type: 'session.started', status: 'working' },
  ],
  [
    'SessionStart fork',
    'SessionStart',
    { source: 'fork' },
    { type: 'session.started', status: 'working' },
  ],
  [
    'SessionStart resume',
    'SessionStart',
    { source: 'resume' },
    { type: 'heartbeat', status: 'working' },
  ],
  [
    'SessionStart compact',
    'SessionStart',
    { source: 'compact' },
    { type: 'heartbeat', status: 'working' },
  ],
  ['SessionEnd', 'SessionEnd', { reason: 'other' }, { type: 'session.ended', status: 'completed' }],
  [
    'UserPromptSubmit',
    'UserPromptSubmit',
    { ...turn, prompt: SENTINELS.prompt },
    { type: 'heartbeat', status: 'working' },
  ],
  ['PreToolUse', 'PreToolUse', tool, { type: 'task.started', attributes: { tool_name: 'shell' } }],
  [
    'PostToolUse',
    'PostToolUse',
    { ...tool, tool_response: { output: SENTINELS.tool_response, exit_code: 1 } },
    { type: 'task.completed', attributes: { tool_name: 'shell' } },
  ],
  [
    'PermissionRequest',
    'PermissionRequest',
    { ...turn, tool_name: 'shell', tool_input: { command: SENTINELS.tool_input } },
    { type: 'attention.requested', status: 'waiting' },
  ],
  [
    'Stop',
    'Stop',
    { ...turn, last_assistant_message: SENTINELS.last_assistant_message, stop_hook_active: false },
    { type: 'heartbeat', status: 'idle' },
  ],
  [
    'SubagentStart',
    'SubagentStart',
    { ...turn, ...sub },
    { type: 'agent.started', status: 'working', agent_ref: hmac('ag', AGENT) },
  ],
  [
    'SubagentStop',
    'SubagentStop',
    {
      ...turn,
      ...sub,
      agent_transcript_path: SENTINELS.agent_transcript_path,
      last_assistant_message: SENTINELS.last_assistant_message,
      stop_hook_active: false,
    },
    { type: 'agent.stopped', status: 'completed', agent_ref: hmac('ag', AGENT) },
  ],
  [
    'sub-agent PreToolUse',
    'PreToolUse',
    { ...tool, ...sub },
    { type: 'task.started', agent_ref: hmac('ag', AGENT), attributes: { tool_name: 'shell' } },
  ],
  [
    'sub-agent PostToolUse',
    'PostToolUse',
    { ...tool, ...sub, tool_response: SENTINELS.tool_response },
    { type: 'task.completed', agent_ref: hmac('ag', AGENT), attributes: { tool_name: 'shell' } },
  ],
  [
    'sub-agent UserPromptSubmit',
    'UserPromptSubmit',
    { ...turn, ...sub, prompt: SENTINELS.prompt },
    { type: 'heartbeat', status: 'working', agent_ref: hmac('ag', AGENT) },
  ],
  [
    'sub-agent PermissionRequest',
    'PermissionRequest',
    { ...turn, ...sub, tool_name: 'apply_patch', tool_input: SENTINELS.tool_input },
    { type: 'attention.requested', status: 'waiting', agent_ref: hmac('ag', AGENT) },
  ],
];

const envelope = (mapped: object) => ({
  ...mapped,
  jgr: '0.1',
  event_id: '01JBZ4XQ800000000000000001',
  producer_id: 'prod_test',
  sequence: 0,
  occurred_at: '2026-10-29T00:00:00Z',
});

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const AGENT_EVENTS = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
]);

describe('mapCodexHook — event table (ADR-0016 C2 + review Low)', () => {
  it.each(cases)('maps %s to a valid L0 JGR event without content', (_, event, extra, expected) => {
    const mapped = mapCodexHook(hook(event, extra), ctx);
    expect(mapped).toMatchObject({
      project_ref: 'web-app',
      thread_ref: hmac('cx', SESSION),
      ...expected,
    });
    // Pinned clock: with the real clock this fixed time can be "in the future" (clock_skew).
    expect(validateEvent(envelope(mapped!), new Date('2026-10-29T00:01:00Z'))).toMatchObject({
      ok: true,
    });
    const json = JSON.stringify(mapped);
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain(SESSION);
    expect(json).not.toContain(AGENT);
    expect(json).not.toContain('secret');
  });

  it('emits exactly platform, collector version and (Pre/PostToolUse only) tool name', () => {
    for (const [, event, extra] of cases) {
      const mapped = mapCodexHook(hook(event, extra), ctx)!;
      const isTool = TOOL_EVENTS.has(event);
      const hasAgent = AGENT_EVENTS.has(event) && 'agent_id' in extra;
      expect(Object.keys(mapped).sort()).toEqual(
        [
          'attributes',
          'project_ref',
          'thread_ref',
          'type',
          ...(isTool ? [] : ['status']),
          ...(hasAgent ? ['agent_ref'] : []),
        ].sort(),
      );
      expect(mapped.attributes).toEqual({
        platform: 'codex-cli',
        collector_version: '0.3.0-test',
        ...(isTool && { tool_name: 'shell' }),
      });
    }
  });

  it('reads only session_id, hook_event_name, source, tool_name and agent_id', () => {
    const allowed = new Set(['session_id', 'hook_event_name', 'source', 'tool_name', 'agent_id']);
    for (const [name, event, extra] of cases) {
      const read = new Set<string | symbol>();
      const payload = new Proxy(hook(event, { ...SENTINELS, ...extra }), {
        get(target, key, receiver) {
          read.add(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      mapCodexHook(payload, ctx);
      for (const key of read) expect(allowed, `${name} read ${String(key)}`).toContain(key);
    }
  });

  it('SessionStart, SessionEnd and Stop never carry agent_ref (their schemas have no agent_id)', () => {
    for (const event of ['SessionStart', 'SessionEnd', 'Stop']) {
      const mapped = mapCodexHook(hook(event, sub), ctx)!;
      expect(mapped).not.toHaveProperty('agent_ref');
    }
  });

  it('covers every registered hook event', () => {
    const mapped = new Set(cases.map(([, event]) => event));
    expect([...CODEX_HOOK_EVENTS].every((event) => mapped.has(event))).toBe(true);
    expect(CODEX_HOOK_EVENTS).toHaveLength(9);
  });

  it('SessionStart without a source or with an unknown source starts a session', () => {
    expect(mapCodexHook(hook('SessionStart'), ctx)).toMatchObject({ type: 'session.started' });
    expect(mapCodexHook(hook('SessionStart', { source: 'Resume' }), ctx)).toMatchObject({
      type: 'session.started',
    });
    expect(mapCodexHook(hook('SessionStart', { source: 42 }), ctx)).toMatchObject({
      type: 'session.started',
    });
  });
});

describe('mapCodexHook — refs', () => {
  it('hashes session and agent ids with the installation salt (same HMAC scheme as JD-C01)', () => {
    const a = mapCodexHook(hook('SessionStart'), ctx)!;
    const b = mapCodexHook(hook('SessionStart'), { ...ctx, salt: 'other-salt' })!;
    expect(CODEX_THREAD_PREFIX).toBe('cx');
    expect(a.thread_ref).toBe(hmac('cx', SESSION));
    expect(codexThreadRef(SESSION, 'test-salt')).toBe(hmac('cx', SESSION));
    expect(codexAgentRef(AGENT, 'test-salt')).toBe(hmac('ag', AGENT));
    expect(a.thread_ref).toMatch(/^cx_[0-9a-f]{32}$/);
    expect(b.thread_ref).not.toBe(a.thread_ref);
    expect(a).not.toHaveProperty('agent_ref');
  });

  it('a sub-agent tool event lands on the parent thread with the agent ref of SubagentStart', () => {
    const start = mapCodexHook(hook('SubagentStart', { ...turn, ...sub }), ctx)!;
    const toolEvent = mapCodexHook(hook('PreToolUse', { ...tool, ...sub }), ctx)!;
    expect(toolEvent.thread_ref).toBe(start.thread_ref);
    expect(toolEvent.agent_ref).toBe(start.agent_ref);
    expect(toolEvent.agent_ref).toMatch(/^ag_[0-9a-f]{32}$/);
  });
});

describe('mapCodexHook — dropped and malformed input', () => {
  it.each([
    ['Interrupt', { ...turn }],
    ['PreCompact', { ...turn, trigger: 'auto' }],
    ['PostCompact', { ...turn, trigger: 'manual' }],
    ['PreModelRequest', { ...turn }],
    ['PostModelRequest', { ...turn }],
    ['Notification', { message: 'SENTINEL' }],
    ['SomethingNew', {}],
    ['SubagentStart', { ...turn }],
    ['SubagentStop', { ...turn, agent_id: '' }],
    ['SubagentStart', { ...turn, agent_id: 7 }],
  ])('%s → null', (event, extra) => {
    expect(mapCodexHook(hook(event, extra), ctx)).toBeNull();
  });

  it('needs a session id and an event name', () => {
    expect(mapCodexHook({ hook_event_name: 'SessionStart' }, ctx)).toBeNull();
    expect(mapCodexHook({ session_id: '', hook_event_name: 'SessionStart' }, ctx)).toBeNull();
    expect(mapCodexHook({ session_id: 42, hook_event_name: 'SessionStart' }, ctx)).toBeNull();
    expect(mapCodexHook({ session_id: SESSION }, ctx)).toBeNull();
    expect(mapCodexHook(null, ctx)).toBeNull();
    expect(mapCodexHook('SessionStart', ctx)).toBeNull();
    expect(mapCodexHook([hook('SessionStart')], ctx)).toBeNull();
  });

  it('caps long tool names and skips non-string ones', () => {
    const long = mapCodexHook(hook('PreToolUse', { tool_name: `mcp__${'x'.repeat(300)}` }), ctx);
    expect(String(long?.attributes?.tool_name).length).toBe(128);
    const odd = mapCodexHook(hook('PostToolUse', { tool_name: { name: 'x' } }), ctx);
    expect(odd).toMatchObject({ type: 'task.completed' });
    expect(odd?.attributes).not.toHaveProperty('tool_name');
  });

  it('ignores an empty or non-string agent_id on tool events', () => {
    const empty = mapCodexHook(hook('PreToolUse', { ...tool, agent_id: '' }), ctx)!;
    const num = mapCodexHook(hook('PreToolUse', { ...tool, agent_id: 3 }), ctx)!;
    expect(empty).not.toHaveProperty('agent_ref');
    expect(num).not.toHaveProperty('agent_ref');
  });
});

describe('codexSubagentLink (ADR-0016 C6, M4)', () => {
  it('SubagentStart → { agentId, sessionId } (raw, for the caller to hash)', () => {
    expect(codexSubagentLink(hook('SubagentStart', { ...turn, ...sub }))).toEqual({
      agentId: AGENT,
      sessionId: SESSION,
    });
  });

  it('reads only hook_event_name, agent_id and session_id', () => {
    const allowed = new Set(['hook_event_name', 'agent_id', 'session_id']);
    const read = new Set<string | symbol>();
    const payload = new Proxy(hook('SubagentStart', { ...SENTINELS, ...turn, ...sub }), {
      get(target, key, receiver) {
        read.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(codexSubagentLink(payload)).not.toBeNull();
    for (const key of read) expect(allowed, `read ${String(key)}`).toContain(key);
  });

  it.each([
    ['SubagentStop', hook('SubagentStop', { ...turn, ...sub })],
    ['PreToolUse with agent_id', hook('PreToolUse', { ...tool, ...sub })],
    ['missing agent_id', hook('SubagentStart', { ...turn })],
    ['empty agent_id', hook('SubagentStart', { ...turn, agent_id: '' })],
    ['missing session_id', { hook_event_name: 'SubagentStart', agent_id: AGENT }],
    ['null', null],
    ['array', [hook('SubagentStart', sub)]],
    ['string', 'SubagentStart'],
  ])('%s → null', (_, raw) => {
    expect(codexSubagentLink(raw)).toBeNull();
  });
});
