import { createHmac } from 'node:crypto';
import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import {
  GEMINI_HOOK_EVENTS,
  GEMINI_THREAD_PREFIX,
  geminiThreadRef,
  mapGeminiHook,
} from '../src/index.ts';

const ctx = { projectRef: 'web-app', salt: 'test-salt', collectorVersion: '0.2.0-test' };
const SESSION = 'gemini-session-7f3a';

// Sentinel strings in every content-bearing field; none may reach the output.
const SENTINELS = {
  prompt: 'SENTINEL-prompt-my-private-prompt',
  prompt_response: 'SENTINEL-prompt_response-assistant-text',
  tool_input: 'SENTINEL-tool_input-rm-rf-secret',
  tool_response: 'SENTINEL-tool_response-API_KEY=abc',
  llm_request: 'SENTINEL-llm_request-messages',
  llm_response: 'SENTINEL-llm_response-candidates',
  transcript_path: '/home/hai/.gemini/tmp/SENTINEL-transcript/chats/abc.json',
  cwd: '/home/hai/SENTINEL-cwd-secret-repo',
  message: 'SENTINEL-message-Gemini wants to run rm -rf /secret',
  details: 'SENTINEL-details-/home/hai/secret-repo/a.ts',
  mcp_context: 'SENTINEL-mcp_context-server-url',
  original_request_name: 'SENTINEL-original_request_name',
  timestamp: '2026-10-29T10:00:00.000SENTINEL',
};

// Shapes follow google-gemini/gemini-cli docs/hooks/reference.md (main, fetched 2026-10-29).
// Content fields are included on purpose to prove they never leave the mapper.
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  transcript_path: SENTINELS.transcript_path,
  cwd: SENTINELS.cwd,
  hook_event_name: event,
  timestamp: SENTINELS.timestamp,
  ...extra,
});

const toolFields = {
  tool_input: { command: SENTINELS.tool_input },
  mcp_context: { server_url: SENTINELS.mcp_context },
  original_request_name: SENTINELS.original_request_name,
};

const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['SessionStart', { source: 'startup' }, { type: 'session.started', status: 'working' }],
  ['SessionEnd', { reason: 'exit' }, { type: 'session.ended', status: 'completed' }],
  ['BeforeAgent', { prompt: SENTINELS.prompt }, { type: 'heartbeat', status: 'working' }],
  [
    'AfterAgent',
    {
      prompt: SENTINELS.prompt,
      prompt_response: SENTINELS.prompt_response,
      stop_hook_active: false,
    },
    { type: 'heartbeat', status: 'idle' },
  ],
  [
    'BeforeTool',
    { tool_name: 'run_shell_command', ...toolFields },
    { type: 'task.started', attributes: { tool_name: 'run_shell_command' } },
  ],
  [
    'AfterTool',
    {
      tool_name: 'read_file',
      ...toolFields,
      tool_response: {
        llmContent: SENTINELS.tool_response,
        returnDisplay: SENTINELS.tool_response,
      },
    },
    { type: 'task.completed', attributes: { tool_name: 'read_file' } },
  ],
  [
    'AfterTool',
    {
      tool_name: 'run_shell_command',
      tool_response: { llmContent: '', error: SENTINELS.tool_response },
    },
    // Failure is only visible in tool_response (content) → still task.completed (ADR-0016 §2).
    { type: 'task.completed', attributes: { tool_name: 'run_shell_command' } },
  ],
  [
    'Notification',
    {
      notification_type: 'ToolPermission',
      message: SENTINELS.message,
      details: { tool_name: 'run_shell_command', file_path: SENTINELS.details },
    },
    { type: 'attention.requested', status: 'waiting' },
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

describe('mapGeminiHook — event table (ADR-0016 §2)', () => {
  it.each(cases)('maps %s to a valid L0 JGR event without content', (event, extra, expected) => {
    const mapped = mapGeminiHook(hook(event, extra), ctx);
    expect(mapped).toMatchObject({ project_ref: 'web-app', ...expected });
    // Pinned clock: with the real clock this fixed time can be "in the future" (clock_skew).
    expect(validateEvent(envelope(mapped!), new Date('2026-10-29T00:01:00Z'))).toMatchObject({
      ok: true,
    });
    const json = JSON.stringify(mapped);
    expect(json).not.toContain('SENTINEL');
    expect(json).not.toContain(SESSION);
    expect(json).not.toContain('secret');
  });

  it('emits exactly the platform, collector version and (tool events only) tool name', () => {
    for (const [event, extra] of cases) {
      const mapped = mapGeminiHook(hook(event, { tool_name: 'write_file', ...extra }), ctx)!;
      const isTool = event === 'BeforeTool' || event === 'AfterTool';
      expect(Object.keys(mapped).sort()).toEqual(
        ['attributes', 'project_ref', 'thread_ref', 'type', ...(isTool ? [] : ['status'])].sort(),
      );
      expect(mapped.attributes).toEqual({
        platform: 'gemini-cli',
        collector_version: '0.2.0-test',
        ...(isTool && { tool_name: (extra.tool_name as string | undefined) ?? 'write_file' }),
      });
    }
  });

  it('reads only session_id, hook_event_name, tool_name and notification_type', () => {
    const allowed = new Set(['session_id', 'hook_event_name', 'tool_name', 'notification_type']);
    for (const [event, extra] of cases) {
      const read = new Set<string | symbol>();
      const payload = new Proxy(hook(event, { ...SENTINELS, ...extra }), {
        get(target, key, receiver) {
          read.add(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      mapGeminiHook(payload, ctx);
      for (const key of read) expect(allowed, `${event} read ${String(key)}`).toContain(key);
    }
  });

  it('covers every registered hook event', () => {
    const mapped = new Set(cases.map(([event]) => event));
    expect([...GEMINI_HOOK_EVENTS].every((event) => mapped.has(event))).toBe(true);
  });
});

describe('mapGeminiHook — refs', () => {
  it('hashes the session id with the installation salt (same HMAC scheme as JD-C01)', () => {
    const a = mapGeminiHook(hook('SessionStart'), ctx)!;
    const b = mapGeminiHook(hook('SessionStart'), { ...ctx, salt: 'other-salt' })!;
    const expected = `gm_${createHmac('sha256', 'test-salt').update(SESSION).digest('hex').slice(0, 32)}`;
    expect(GEMINI_THREAD_PREFIX).toBe('gm');
    expect(a.thread_ref).toBe(expected);
    expect(geminiThreadRef(SESSION, 'test-salt')).toBe(expected);
    expect(a.thread_ref).toMatch(/^gm_[0-9a-f]{32}$/);
    expect(b.thread_ref).not.toBe(a.thread_ref);
    expect(a).not.toHaveProperty('agent_ref');
  });
});

describe('mapGeminiHook — dropped and malformed input', () => {
  it.each([
    ['BeforeModel', { llm_request: { model: 'gemini-2.5-pro', messages: SENTINELS.llm_request } }],
    ['AfterModel', { llm_request: {}, llm_response: SENTINELS.llm_response }],
    ['BeforeToolSelection', { llm_request: {} }],
    ['PreCompress', { trigger: 'auto' }],
    ['SomethingNew', {}],
    ['Notification', { notification_type: 'Other', message: SENTINELS.message }],
    ['Notification', { notification_type: 'toolpermission' }],
    ['Notification', { message: SENTINELS.message }],
  ])('%s → null', (event, extra) => {
    expect(mapGeminiHook(hook(event, extra), ctx)).toBeNull();
  });

  it('needs a session id and an event name', () => {
    expect(mapGeminiHook({ hook_event_name: 'SessionStart' }, ctx)).toBeNull();
    expect(mapGeminiHook({ session_id: '', hook_event_name: 'SessionStart' }, ctx)).toBeNull();
    expect(mapGeminiHook({ session_id: 42, hook_event_name: 'SessionStart' }, ctx)).toBeNull();
    expect(mapGeminiHook({ session_id: SESSION }, ctx)).toBeNull();
    expect(mapGeminiHook(null, ctx)).toBeNull();
    expect(mapGeminiHook('SessionStart', ctx)).toBeNull();
    expect(mapGeminiHook([hook('SessionStart')], ctx)).toBeNull();
  });

  it('caps long tool names and skips non-string ones', () => {
    const long = mapGeminiHook(hook('BeforeTool', { tool_name: `mcp_${'x'.repeat(300)}` }), ctx);
    expect(String(long?.attributes?.tool_name).length).toBe(128);
    const odd = mapGeminiHook(hook('AfterTool', { tool_name: { name: 'x' } }), ctx);
    expect(odd).toMatchObject({ type: 'task.completed' });
    expect(odd?.attributes).not.toHaveProperty('tool_name');
  });
});
