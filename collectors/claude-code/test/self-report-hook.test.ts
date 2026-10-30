import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfReportEventId } from '@javis-dog/collector-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createState,
  FLUSH_INTERVAL_MS,
  isUrgent,
  runHook,
  type CollectorState,
  type Platform,
} from '../src/index.ts';

// ADR-0017 §3 hook wiring in JD-C01 (TEST_PLAN §S5d rows "Hook mapping", "One record per javi
// tool call", "Prompt flush"): the real runHook, the real JD-C02 mappers and the real file
// spool in a temp JAVI_HOME. Nothing is mocked but the flush spawner (a spy).

const TOKEN = `jd_it_${'S'.repeat(43)}`;
const CLOCK = new Date('2026-10-30T10:00:00.000Z');
const SENTINEL = 'SENTINEL_S5D_TOOL_INPUT_7c1e';

let home: string;
let state: CollectorState;
let flushes: number;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-sr-hook-'));
  state = createState(home);
  await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
  flushes = 0;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const hook = (platform: Platform, payload: Record<string, unknown>) =>
  runHook({
    state,
    projectRef: 'web-app',
    platform,
    stdin: JSON.stringify(payload),
    now: () => CLOCK,
    spawnFlush: () => {
      flushes += 1;
    },
    env: {},
    cwd: home,
  });

interface Spooled {
  event_id: string;
  type: string;
  status?: string;
  thread_ref: string;
  agent_ref?: string;
  sequence: number;
  occurred_at: string;
  attributes?: Record<string, unknown>;
}

/** Spooled records, oldest sequence first. */
const spooled = async (): Promise<Spooled[]> => {
  const dir = state.spoolDir('web-app');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  const events = await Promise.all(
    names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as Spooled),
  );
  return events.sort((a, b) => a.sequence - b.sequence);
};

/** Every file javi wrote under JAVI_HOME, concatenated. */
const allText = async () => {
  const names = await readdir(home, { recursive: true });
  const texts: string[] = [];
  for (const name of names) {
    const text = await readFile(join(home, name), 'utf8').catch(() => null);
    if (text !== null) texts.push(text);
  }
  return texts.join('\n');
};

// Hook payloads as each CLI sends them (ADR-0017 research table).
const claude = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'cc-session-1',
  transcript_path: '/home/dev/.claude/t.jsonl',
  cwd: '/home/dev/app',
  hook_event_name: event,
  ...extra,
});
const codex = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'cx-session-1',
  cwd: '/home/dev/app',
  model: 'gpt-5.5-codex',
  hook_event_name: event,
  ...extra,
});
const gemini = (event: string, extra: Record<string, unknown> = {}) => ({
  session_id: 'gm-session-1',
  cwd: '/home/dev/app',
  timestamp: '2026-10-30T09:00:00.000Z',
  hook_event_name: event,
  ...extra,
});
const javiCall = (
  platform: Platform,
  phase: 'pre' | 'post',
  tool: 'report_status' | 'report_task',
  input: unknown,
  extra: Record<string, unknown> = {},
) => {
  if (platform === 'gemini-cli') {
    return gemini(phase === 'pre' ? 'BeforeTool' : 'AfterTool', {
      tool_name: `mcp_javi_${tool}`,
      tool_input: input,
      mcp_context: { server_name: 'javi', tool_name: tool, command: '/usr/bin/node', args: [] },
      ...(phase === 'post' && { tool_response: { llmContent: SENTINEL } }),
      ...extra,
    });
  }
  const make = platform === 'codex-cli' ? codex : claude;
  return make(phase === 'pre' ? 'PreToolUse' : 'PostToolUse', {
    tool_name: `mcp__javi__${tool}`,
    tool_input: input,
    tool_use_id: 'call-1',
    ...(phase === 'post' && { tool_response: SENTINEL }),
    ...extra,
  });
};
const sessionOf = (platform: Platform) =>
  platform === 'gemini-cli'
    ? 'gm-session-1'
    : platform === 'codex-cli'
      ? 'cx-session-1'
      : 'cc-session-1';
const promptOf = (platform: Platform) =>
  platform === 'gemini-cli'
    ? gemini('BeforeAgent', { prompt: SENTINEL })
    : platform === 'codex-cli'
      ? codex('UserPromptSubmit', { prompt: SENTINEL })
      : claude('UserPromptSubmit', { prompt: SENTINEL });

const PLATFORMS: Platform[] = ['claude-code', 'codex-cli', 'gemini-cli'];

describe.each(PLATFORMS)('runHook self-report wiring (%s)', (platform) => {
  it('post-tool javi report_status → exactly one heartbeat on the hook thread, next sequence', async () => {
    expect(await hook(platform, promptOf(platform))).toBe('recorded');
    expect(
      await hook(
        platform,
        javiCall(platform, 'post', 'report_status', {
          status: 'blocked',
          reason: 'missing_credentials',
        }),
      ),
    ).toBe('recorded');
    const [prompt, report, ...rest] = await spooled();
    expect(rest).toEqual([]);
    expect(report).toMatchObject({
      type: 'heartbeat',
      status: 'blocked',
      thread_ref: prompt!.thread_ref,
      sequence: prompt!.sequence + 1,
      occurred_at: CLOCK.toISOString(),
      attributes: {
        platform,
        collector_version: expect.any(String),
        tool_name:
          platform === 'gemini-cli' ? 'mcp_javi_report_status' : 'mcp__javi__report_status',
        error_code: 'blocked.missing_credentials',
      },
    });
    expect(report!.attributes).not.toHaveProperty('task_kind');
    const { salt } = await state.installation();
    if (platform === 'gemini-cli') {
      expect(report!.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } else {
      expect(report!.event_id).toBe(
        selfReportEventId({
          platform,
          sessionId: sessionOf(platform),
          callId: 'call-1',
          at: CLOCK,
          salt,
        }),
      );
    }
  });

  it('post-tool javi report_task → one task.<phase> with task_kind, no generic tool event', async () => {
    await hook(
      platform,
      javiCall(platform, 'post', 'report_task', { phase: 'failed', kind: 'test' }),
    );
    const records = await spooled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'task.failed',
      attributes: { task_kind: 'test', tool_name: expect.stringContaining('report_task') },
    });
    expect(records[0]).not.toHaveProperty('status');
  });

  it('pre-tool hook of a javi tool records nothing (no unmatched task.started)', async () => {
    expect(
      await hook(platform, javiCall(platform, 'pre', 'report_status', { status: 'blocked' })),
    ).toBe('ignored');
    expect(
      await hook(
        platform,
        javiCall(platform, 'pre', 'report_task', { phase: 'started', kind: 'plan' }),
      ),
    ).toBe('ignored');
    expect(await spooled()).toEqual([]);
  });

  it('invalid javi input → no record at all, and its text is nowhere in javi state', async () => {
    for (const input of [
      { status: 'blocked', reason: SENTINEL },
      { status: 'working', reason: 'needs_input' },
      { status: 'blocked', note: SENTINEL },
      { status: 'blocked', reason: null },
      SENTINEL,
      null,
    ]) {
      expect(await hook(platform, javiCall(platform, 'post', 'report_status', input))).toBe(
        'ignored',
      );
    }
    expect(
      await hook(platform, javiCall(platform, 'post', 'report_task', { phase: 'done', kind: 'x' })),
    ).toBe('ignored');
    expect(await spooled()).toEqual([]);
    expect(await allText()).not.toContain(SENTINEL);
    expect(flushes).toBe(0);
  });

  it('other tools map exactly as before, an MCP tool of another server included', async () => {
    const other =
      platform === 'gemini-cli'
        ? gemini('AfterTool', {
            tool_name: 'mcp_javi_x_report_status',
            tool_input: { status: 'blocked', secret: SENTINEL },
            mcp_context: { server_name: 'javi_x', tool_name: 'report_status' },
            tool_response: { llmContent: SENTINEL },
          })
        : (platform === 'codex-cli' ? codex : claude)('PostToolUse', {
            tool_name: 'mcp__javi_x__report_status',
            tool_input: { status: 'blocked', secret: SENTINEL },
            tool_use_id: 'call-2',
            tool_response: SENTINEL,
          });
    const shell =
      platform === 'gemini-cli'
        ? gemini('AfterTool', {
            tool_name: 'run_shell_command',
            tool_input: { command: `echo ${SENTINEL}` },
            tool_response: { llmContent: SENTINEL },
          })
        : (platform === 'codex-cli' ? codex : claude)('PostToolUse', {
            tool_name: 'Bash',
            tool_input: { command: `echo ${SENTINEL}` },
            tool_use_id: 'call-3',
            tool_response: SENTINEL,
          });
    expect(await hook(platform, other)).toBe('recorded');
    expect(await hook(platform, shell)).toBe('recorded');
    const [a, b] = await spooled();
    expect(a).toMatchObject({
      type: 'task.completed',
      attributes: {
        tool_name:
          platform === 'gemini-cli' ? 'mcp_javi_x_report_status' : 'mcp__javi_x__report_status',
      },
    });
    expect(a).not.toHaveProperty('status');
    expect(a!.attributes).not.toHaveProperty('error_code');
    expect(b).toMatchObject({
      type: 'task.completed',
      attributes: { tool_name: platform === 'gemini-cli' ? 'run_shell_command' : 'Bash' },
    });
    // End to end through the real file spool: no other tool's tool_input or response is kept.
    expect(await allText()).not.toContain(SENTINEL);
  });

  it('a sub-agent report_status records nothing; its report_task keeps the agent ref', async () => {
    if (platform === 'gemini-cli') return; // Gemini hooks carry no agent_id.
    expect(
      await hook(
        platform,
        javiCall(platform, 'post', 'report_status', { status: 'blocked' }, { agent_id: 'sub-1' }),
      ),
    ).toBe('ignored');
    expect(
      await hook(
        platform,
        javiCall(
          platform,
          'post',
          'report_task',
          { phase: 'started', kind: 'research' },
          { agent_id: 'sub-1', tool_use_id: 'call-9' },
        ),
      ),
    ).toBe('recorded');
    const records = await spooled();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 'task.started', agent_ref: expect.any(String) });
  });
});

it('Claude Code PostToolUseFailure of a javi tool maps the self-report too', async () => {
  await hook(
    'claude-code',
    claude('PostToolUseFailure', {
      tool_name: 'mcp__javi__report_status',
      tool_input: { status: 'failed', reason: 'tests_failing' },
      tool_use_id: 'call-f',
      error: SENTINEL,
    }),
  );
  const records = await spooled();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    type: 'heartbeat',
    status: 'failed',
    attributes: { error_code: 'failed.tests_failing' },
  });
  expect(await allText()).not.toContain(SENTINEL);
});

it('a re-run hook of the same javi call gets the same event id (deduped in the spool)', async () => {
  const call = javiCall('codex-cli', 'post', 'report_task', { phase: 'completed', kind: 'build' });
  await hook('codex-cli', call);
  await hook('codex-cli', call);
  const records = await spooled();
  expect(records).toHaveLength(1);
});

// --- Prompt flush (ADR-0017 §3 "Prompt delivery", review H2) ---

describe('prompt flush for self-reports and the end-of-turn idle', () => {
  /** A recent flush and a recent spawn: only an urgent record starts another one. */
  const quiet = async () => {
    await state.markFlushRequested('web-app', CLOCK.getTime());
    await state.saveLastFlush('web-app', { at: CLOCK.toISOString(), status: 'ok' });
  };

  const cases: Array<[string, Platform, Record<string, unknown>, boolean]> = [
    [
      'self-reported blocked',
      'claude-code',
      javiCall('claude-code', 'post', 'report_status', { status: 'blocked' }),
      true,
    ],
    [
      'self-reported waiting',
      'gemini-cli',
      javiCall('gemini-cli', 'post', 'report_status', { status: 'waiting', reason: 'needs_input' }),
      true,
    ],
    [
      'self-reported idle',
      'codex-cli',
      javiCall('codex-cli', 'post', 'report_status', { status: 'idle' }),
      true,
    ],
    [
      'self-reported completed',
      'claude-code',
      javiCall('claude-code', 'post', 'report_status', { status: 'completed' }),
      true,
    ],
    [
      'self-reported failed',
      'gemini-cli',
      javiCall('gemini-cli', 'post', 'report_status', { status: 'failed' }),
      true,
    ],
    [
      'self-reported working',
      'claude-code',
      javiCall('claude-code', 'post', 'report_status', { status: 'working' }),
      false,
    ],
    [
      'self-reported task.failed',
      'codex-cli',
      javiCall('codex-cli', 'post', 'report_task', { phase: 'failed', kind: 'deploy' }),
      true,
    ],
    [
      'self-reported task.started',
      'claude-code',
      javiCall('claude-code', 'post', 'report_task', { phase: 'started', kind: 'test' }),
      false,
    ],
    [
      'self-reported task.completed',
      'gemini-cli',
      javiCall('gemini-cli', 'post', 'report_task', { phase: 'completed', kind: 'test' }),
      false,
    ],
    ['Claude Code Stop (heartbeat idle)', 'claude-code', claude('Stop'), true],
    [
      'Codex CLI Stop (heartbeat idle)',
      'codex-cli',
      codex('Stop', { last_assistant_message: SENTINEL }),
      true,
    ],
    [
      'Gemini CLI AfterAgent (heartbeat idle)',
      'gemini-cli',
      gemini('AfterAgent', { prompt_response: SENTINEL }),
      true,
    ],
    ['Claude Code UserPromptSubmit (working)', 'claude-code', claude('UserPromptSubmit'), false],
    ['Gemini CLI BeforeAgent (working)', 'gemini-cli', gemini('BeforeAgent'), false],
    [
      'Codex CLI resume SessionStart (heartbeat working)',
      'codex-cli',
      codex('SessionStart', { source: 'resume' }),
      false,
    ],
    [
      'collector task.failed (Claude Code PostToolUseFailure)',
      'claude-code',
      claude('PostToolUseFailure', { tool_name: 'Bash' }),
      false,
    ],
    [
      'ordinary tool',
      'codex-cli',
      codex('PostToolUse', { tool_name: 'Bash', tool_use_id: 'c' }),
      false,
    ],
    [
      'look-alike MCP tool with a self-report input',
      'claude-code',
      claude('PostToolUse', {
        tool_name: 'mcp__other__report_status',
        tool_input: { status: 'blocked' },
      }),
      false,
    ],
    [
      'attention.requested (unchanged)',
      'claude-code',
      claude('Notification', { notification_type: 'permission_prompt' }),
      true,
    ],
    ['session.started (unchanged)', 'gemini-cli', gemini('SessionStart'), true],
  ];

  it.each(cases)('%s → flush now: %s', async (_name, platform, payload, urgent) => {
    await quiet();
    expect(await hook(platform, payload)).toBe('recorded');
    expect(flushes).toBe(urgent ? 1 : 0);
  });

  it('non-urgent records keep the interval rule', async () => {
    await state.saveLastFlush('web-app', {
      at: new Date(CLOCK.getTime() - FLUSH_INTERVAL_MS).toISOString(),
    });
    await hook('claude-code', claude('UserPromptSubmit'));
    expect(flushes).toBe(1);
  });
});

describe('isUrgent', () => {
  const ctx = (platform: Platform, hookEvent: string, selfReported: boolean) => ({
    platform,
    hookEvent,
    selfReported,
  });
  it('needs the self-report path for status and task.failed, never the record shape alone', () => {
    // A heartbeat that looks like a self-report but came from the collector path.
    expect(isUrgent({ type: 'heartbeat', status: 'blocked' }, ctx('claude-code', 'X', false))).toBe(
      false,
    );
    expect(isUrgent({ type: 'task.failed' }, ctx('claude-code', 'PostToolUseFailure', false))).toBe(
      false,
    );
    expect(
      isUrgent({ type: 'heartbeat', status: 'blocked' }, ctx('claude-code', 'PostToolUse', true)),
    ).toBe(true);
  });
  it('end-of-turn idle only on that platform’s end-of-turn hook', () => {
    expect(isUrgent({ type: 'heartbeat', status: 'idle' }, ctx('gemini-cli', 'Stop', false))).toBe(
      false,
    );
    expect(
      isUrgent({ type: 'heartbeat', status: 'idle' }, ctx('gemini-cli', 'AfterAgent', false)),
    ).toBe(true);
    expect(isUrgent({ type: 'heartbeat', status: 'idle' }, ctx('codex-cli', 'Stop', false))).toBe(
      true,
    );
    expect(
      isUrgent({ type: 'heartbeat', status: 'idle' }, ctx('claude-code', 'AfterAgent', false)),
    ).toBe(false);
  });
});
