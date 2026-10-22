import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import { mapHook, opaqueRef } from '../src/index.ts';

const ctx = { projectRef: 'web-app', salt: 'test-salt' };
const SECRETS = ['rm -rf /secret', 'my private prompt', '/home/hai/secret-repo', 'API_KEY=abc'];

// Shapes follow code.claude.com/docs/en/hooks (verified 2026-10-23); content fields included
// on purpose to prove they never leave the mapper.
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'abc123-session',
  transcript_path: '/home/hai/.claude/projects/secret-repo/abc.jsonl',
  cwd: '/home/hai/secret-repo',
  permission_mode: 'default',
  hook_event_name: event,
  ...extra,
});

const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['SessionStart', { source: 'startup' }, { type: 'session.started', status: 'working' }],
  ['SessionEnd', { reason: 'prompt_input_exit' }, { type: 'session.ended', status: 'completed' }],
  ['UserPromptSubmit', { prompt: 'my private prompt' }, { type: 'heartbeat', status: 'working' }],
  [
    'PreToolUse',
    { tool_name: 'Bash', tool_input: { command: 'rm -rf /secret' }, tool_use_id: 't1' },
    { type: 'task.started', attributes: { tool_name: 'Bash' } },
  ],
  [
    'PostToolUse',
    {
      tool_name: 'Edit',
      tool_input: { file_path: '/home/hai/secret-repo/a.ts' },
      tool_response: 'API_KEY=abc',
      duration_ms: 812.4,
    },
    { type: 'task.completed', attributes: { tool_name: 'Edit', duration_ms: 812 } },
  ],
  [
    'PostToolUseFailure',
    { tool_name: 'Bash', error: 'API_KEY=abc leaked', is_interrupt: false },
    { type: 'task.failed', attributes: { tool_name: 'Bash' } },
  ],
  [
    'Notification',
    {
      notification_type: 'permission_prompt',
      message: 'Claude needs permission to run rm -rf /secret',
    },
    { type: 'attention.requested', status: 'waiting' },
  ],
  [
    'Stop',
    { last_assistant_message: 'my private prompt', stop_hook_active: false },
    { type: 'heartbeat', status: 'idle' },
  ],
  [
    'SubagentStart',
    { agent_id: 'agent-1', agent_type: 'Explore' },
    { type: 'agent.started', status: 'working' },
  ],
  [
    'SubagentStop',
    { agent_id: 'agent-1', agent_type: 'Explore', last_assistant_message: 'my private prompt' },
    { type: 'agent.stopped', status: 'completed' },
  ],
];

describe('mapHook', () => {
  it.each(cases)('maps %s to a valid L0 JGR event without content', (event, extra, expected) => {
    const mapped = mapHook(hook(event, extra), ctx);
    expect(mapped).toMatchObject({ project_ref: 'web-app', ...expected });
    const full = {
      ...mapped,
      jgr: '0.1',
      event_id: '01JBZ4XQ800000000000000001',
      producer_id: 'prod_test',
      sequence: 0,
      occurred_at: '2026-10-23T00:00:00Z',
    };
    // Pinned clock: with the real clock this fixed time can be "in the future" (clock_skew).
    expect(validateEvent(full, new Date('2026-10-23T00:01:00Z'))).toMatchObject({ ok: true });
    const json = JSON.stringify(mapped);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
    expect(json).not.toContain('abc123-session');
    expect(json).not.toContain('secret-repo');
  });

  it('hashes the session and agent ids with the installation salt', () => {
    const a = mapHook(hook('SubagentStart', { agent_id: 'agent-1' }), ctx)!;
    const b = mapHook(hook('SubagentStart', { agent_id: 'agent-1' }), { ...ctx, salt: 'other' })!;
    expect(a.thread_ref).toBe(opaqueRef('cc', 'abc123-session', 'test-salt'));
    expect(a.thread_ref).toMatch(/^cc_[0-9a-f]{32}$/);
    expect(a.agent_ref).toMatch(/^ag_[0-9a-f]{32}$/);
    expect(b.thread_ref).not.toBe(a.thread_ref);
  });

  it('keeps the subagent identity on tool events inside a subagent', () => {
    const mapped = mapHook(
      hook('PreToolUse', { tool_name: 'Read', agent_id: 'agent-1', agent_type: 'Explore' }),
      ctx,
    );
    expect(mapped?.agent_ref).toBe(opaqueRef('ag', 'agent-1', 'test-salt'));
  });

  it('ignores unknown events, other notifications and malformed input', () => {
    expect(mapHook(hook('PreCompact', { trigger: 'auto' }), ctx)).toBeNull();
    expect(mapHook(hook('Notification', { notification_type: 'auth_success' }), ctx)).toBeNull();
    expect(mapHook(hook('SubagentStart', {}), ctx)).toBeNull();
    expect(mapHook({ hook_event_name: 'Stop' }, ctx)).toBeNull();
    expect(mapHook(null, ctx)).toBeNull();
    expect(mapHook('Stop', ctx)).toBeNull();
  });

  it('caps very long tool names to the attribute limit', () => {
    const mapped = mapHook(hook('PreToolUse', { tool_name: `mcp__${'x'.repeat(300)}` }), ctx);
    expect(String(mapped?.attributes?.tool_name).length).toBe(128);
  });
});
