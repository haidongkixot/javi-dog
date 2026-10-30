import { createHmac } from 'node:crypto';
import { createUlid } from '@javis-dog/jgr-sdk';
import { validateEvent } from '@javis-dog/jgr-spec';
import { describe, expect, it } from 'vitest';
import {
  SELF_REPORT,
  mapCodexHook,
  mapGeminiHook,
  matchJaviTool,
  selfReportEventId,
  selfReportRecord,
  validateSelfReport,
  type SelfReportBase,
} from '../src/index.ts';

// ADR-0017 decisions 2–3, TEST_PLAN §S5d rows 1, 6–8, 14–16. Expected values are copied from the
// ADR text, not from the implementation.

const SENTINEL = 'SENTINEL-ignore-previous-instructions-API_KEY=abc';
const SALT = 'test-salt';
const AT = new Date('2026-10-30T12:34:56.789Z');
const ctx = { salt: SALT, at: AT };
const SESSION = 'session-0001';
const CALL = 'toolu_01ABC';
const base: SelfReportBase = {
  project_ref: 'web-app',
  thread_ref: 'cc_0123456789abcdef0123456789abcdef',
  attributes: { platform: 'claude-code', collector_version: '0.1.0' },
};

/** Fills in what the SDK adds, then runs the JGR validator. */
const asEvent = (input: object) => ({
  jgr: '0.1',
  producer_id: 'prod_test',
  sequence: 0,
  event_id: '01J00000000000000000000000',
  ...input,
});

describe('SELF_REPORT contract (ADR-0017 §2)', () => {
  it('has exactly the ADR vocabularies, tool names and server name', () => {
    expect(SELF_REPORT.serverName).toBe('javi');
    expect(SELF_REPORT.tools).toEqual(['report_status', 'report_task']);
    expect(SELF_REPORT.statuses).toEqual([
      'working',
      'waiting',
      'blocked',
      'idle',
      'completed',
      'failed',
    ]);
    expect(SELF_REPORT.reasonStatuses).toEqual(['waiting', 'blocked', 'failed']);
    expect(SELF_REPORT.reasons).toEqual([
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
    ]);
    expect(SELF_REPORT.phases).toEqual(['started', 'completed', 'failed']);
    expect(SELF_REPORT.kinds).toEqual([
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
    ]);
  });

  it('publishes strict JSON Schemas built from the same lists', () => {
    const status = SELF_REPORT.schemas.report_status;
    expect(status.type).toBe('object');
    expect(status.required).toEqual(['status']);
    expect(status.additionalProperties).toBe(false);
    expect(Object.keys(status.properties)).toEqual(['status', 'reason']);
    expect(status.properties.status.enum).toEqual(SELF_REPORT.statuses);
    expect(status.properties.reason.enum).toEqual(SELF_REPORT.reasons);
    const task = SELF_REPORT.schemas.report_task;
    expect(task.type).toBe('object');
    expect(task.required).toEqual(['phase', 'kind']);
    expect(task.additionalProperties).toBe(false);
    expect(Object.keys(task.properties)).toEqual(['phase', 'kind']);
    expect(task.properties.phase.enum).toEqual(SELF_REPORT.phases);
    expect(task.properties.kind.enum).toEqual(SELF_REPORT.kinds);
    // Plain JSON: survives a round trip unchanged.
    expect(JSON.parse(JSON.stringify(SELF_REPORT.schemas))).toEqual(SELF_REPORT.schemas);
  });

  it('is deeply frozen', () => {
    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(SELF_REPORT)).toBe(true);
    expect(() => {
      (SELF_REPORT.statuses as unknown as string[]).push('x');
    }).toThrow(TypeError);
  });
});

describe('validateSelfReport (ADR-0017 §2 strict arguments)', () => {
  const valid: ReadonlyArray<readonly [tool: 'report_status' | 'report_task', input: object]> = [
    ...SELF_REPORT.statuses.map((status) => ['report_status', { status }] as const),
    ['report_status', { status: 'blocked', reason: 'missing_credentials' }],
    ['report_status', { status: 'waiting', reason: 'needs_input' }],
    ['report_status', { status: 'failed', reason: 'tests_failing' }],
    ...SELF_REPORT.reasons.map(
      (reason) => ['report_status', { status: 'blocked', reason }] as const,
    ),
    ...SELF_REPORT.phases.flatMap((phase) =>
      SELF_REPORT.kinds.map((kind) => ['report_task', { phase, kind }] as const),
    ),
  ];

  it.each(valid)('%s accepts %j as a fresh copy', (tool, input) => {
    const result = validateSelfReport(tool, input);
    expect(result).toEqual({ ok: true, value: input });
    expect(result.ok && result.value).not.toBe(input);
  });

  it('accepts a null-prototype object (JSON-equivalent)', () => {
    const input = Object.assign(Object.create(null) as object, { status: 'idle' });
    expect(validateSelfReport('report_status', input)).toEqual({
      ok: true,
      value: { status: 'idle' },
    });
  });

  const withSymbol = { status: 'working', [Symbol('x')]: SENTINEL };
  const inherited = Object.assign(Object.create({ evil: SENTINEL }) as object, {
    status: 'working',
  });
  const invalid: Array<[name: string, tool: string, input: unknown]> = [
    ['null', 'report_status', null],
    ['undefined', 'report_status', undefined],
    ['string', 'report_status', SENTINEL],
    ['number', 'report_status', 1],
    ['array', 'report_status', [{ status: 'working' }]],
    ['empty object', 'report_status', {}],
    ['status upper case', 'report_status', { status: 'WORKING' }],
    ['status stale (derived, never sent)', 'report_status', { status: 'stale' }],
    ['status sentinel', 'report_status', { status: SENTINEL }],
    ['status number', 'report_status', { status: 1 }],
    ['status array', 'report_status', { status: ['working'] }],
    ['reason with working', 'report_status', { status: 'working', reason: 'other' }],
    ['reason with idle', 'report_status', { status: 'idle', reason: 'needs_input' }],
    ['reason with completed', 'report_status', { status: 'completed', reason: 'other' }],
    ['reason unknown', 'report_status', { status: 'blocked', reason: SENTINEL }],
    ['reason null', 'report_status', { status: 'blocked', reason: null }],
    ['reason undefined but present', 'report_status', { status: 'blocked', reason: undefined }],
    ['reason without status', 'report_status', { reason: 'other' }],
    ['extra key', 'report_status', { status: 'blocked', note: SENTINEL }],
    ['extra key named like a task', 'report_status', { status: 'blocked', kind: 'plan' }],
    ['symbol key', 'report_status', withSymbol],
    [
      'class instance',
      'report_status',
      new (class {
        status = 'working';
      })(),
    ],
    ['inherited prototype', 'report_status', inherited],
    [
      'own __proto__ key from JSON',
      'report_status',
      JSON.parse('{"status":"working","__proto__":{"x":1}}'),
    ],
    ['task missing kind', 'report_task', { phase: 'started' }],
    ['task missing phase', 'report_task', { kind: 'plan' }],
    ['task phase unknown', 'report_task', { phase: 'done', kind: 'plan' }],
    ['task kind unknown', 'report_task', { phase: 'started', kind: SENTINEL }],
    ['task extra key', 'report_task', { phase: 'started', kind: 'plan', note: SENTINEL }],
    ['task with status input', 'report_task', { status: 'working' }],
    ['status with task input', 'report_status', { phase: 'started', kind: 'plan' }],
    ['unknown tool', 'report_other', { status: 'working' }],
  ];

  it.each(invalid)('rejects %s and returns nothing of the input', (_name, tool, input) => {
    const result = validateSelfReport(tool as 'report_status', input);
    expect(result).toEqual({ ok: false });
    expect(Object.keys(result)).toEqual(['ok']);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });
});

describe('matchJaviTool (ADR-0017 §3)', () => {
  const cases: Array<[name: string, platform: string, payload: unknown, expected: unknown]> = [
    // Claude Code
    [
      'cc pre status',
      'claude-code',
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__javi__report_status' },
      { tool: 'report_status', phase: 'pre' },
    ],
    [
      'cc post status',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javi__report_status' },
      { tool: 'report_status', phase: 'post' },
    ],
    [
      'cc failure task',
      'claude-code',
      { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__javi__report_task' },
      { tool: 'report_task', phase: 'post' },
    ],
    [
      'cc permission prompt',
      'claude-code',
      { hook_event_name: 'PermissionRequest', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    ['cc other tool', 'claude-code', { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, null],
    [
      'cc suffix look-alike',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javi__report_status_x' },
      null,
    ],
    [
      'cc server look-alike',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javix__report_status' },
      null,
    ],
    [
      'cc prefix look-alike',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'xmcp__javi__report_status' },
      null,
    ],
    [
      'cc case look-alike',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__Javi__report_status' },
      null,
    ],
    [
      'cc Gemini-style name',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp_javi_report_status' },
      null,
    ],
    [
      'cc mcp_context only',
      'claude-code',
      {
        hook_event_name: 'PostToolUse',
        mcp_context: { server_name: 'javi', tool_name: 'report_status' },
      },
      null,
    ],
    [
      'cc Gemini event name',
      'claude-code',
      { hook_event_name: 'AfterTool', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    // Codex
    [
      'codex pre task',
      'codex-cli',
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__javi__report_task' },
      { tool: 'report_task', phase: 'pre' },
    ],
    [
      'codex post status',
      'codex-cli',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javi__report_status' },
      { tool: 'report_status', phase: 'post' },
    ],
    [
      'codex has no PostToolUseFailure',
      'codex-cli',
      { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    [
      'codex look-alike',
      'codex-cli',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javix__report_task' },
      null,
    ],
    ['codex other tool', 'codex-cli', { hook_event_name: 'PostToolUse', tool_name: 'shell' }, null],
    // Gemini
    [
      'gemini before status',
      'gemini-cli',
      {
        hook_event_name: 'BeforeTool',
        tool_name: 'mcp_javi_report_status',
        mcp_context: { server_name: 'javi', tool_name: 'report_status' },
      },
      { tool: 'report_status', phase: 'pre' },
    ],
    [
      'gemini after task',
      'gemini-cli',
      {
        hook_event_name: 'AfterTool',
        tool_name: 'mcp_javi_report_task',
        mcp_context: { server_name: 'javi', tool_name: 'report_task' },
      },
      { tool: 'report_task', phase: 'post' },
    ],
    [
      'gemini matches on mcp_context, not tool_name',
      'gemini-cli',
      {
        hook_event_name: 'AfterTool',
        tool_name: 'anything',
        mcp_context: { server_name: 'javi', tool_name: 'report_task' },
      },
      { tool: 'report_task', phase: 'post' },
    ],
    [
      'gemini server javi_x',
      'gemini-cli',
      {
        hook_event_name: 'AfterTool',
        tool_name: 'mcp_javi_x_report_status',
        mcp_context: { server_name: 'javi_x', tool_name: 'report_status' },
      },
      null,
    ],
    [
      'gemini server absent',
      'gemini-cli',
      {
        hook_event_name: 'AfterTool',
        tool_name: 'mcp_javi_report_status',
        mcp_context: { tool_name: 'report_status' },
      },
      null,
    ],
    [
      'gemini mcp_context absent',
      'gemini-cli',
      { hook_event_name: 'AfterTool', tool_name: 'mcp_javi_report_status' },
      null,
    ],
    [
      'gemini mcp_context not an object',
      'gemini-cli',
      { hook_event_name: 'AfterTool', mcp_context: 'javi' },
      null,
    ],
    [
      'gemini unknown javi tool',
      'gemini-cli',
      {
        hook_event_name: 'AfterTool',
        mcp_context: { server_name: 'javi', tool_name: 'report_other' },
      },
      null,
    ],
    [
      'gemini Claude-style name only',
      'gemini-cli',
      { hook_event_name: 'AfterTool', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    [
      'gemini Claude event name',
      'gemini-cli',
      {
        hook_event_name: 'PostToolUse',
        mcp_context: { server_name: 'javi', tool_name: 'report_status' },
      },
      null,
    ],
    // Anything else
    [
      'unknown platform',
      'cursor',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    [
      'inherited platform key',
      'toString',
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    [
      'inherited event key',
      'claude-code',
      { hook_event_name: 'constructor', tool_name: 'mcp__javi__report_status' },
      null,
    ],
    [
      'inherited tool key',
      'claude-code',
      { hook_event_name: 'PostToolUse', tool_name: 'hasOwnProperty' },
      null,
    ],
    ['null payload', 'claude-code', null, null],
    ['array payload', 'claude-code', [], null],
    ['string payload', 'claude-code', 'mcp__javi__report_status', null],
  ];

  it.each(cases)('%s', (_name, platform, payload, expected) => {
    expect(matchJaviTool(platform, payload)).toEqual(expected);
  });
});

describe('selfReportEventId (ADR-0017 §3, review M5)', () => {
  const id = (over: Partial<Parameters<typeof selfReportEventId>[0]> = {}) =>
    selfReportEventId({
      platform: 'claude-code',
      sessionId: SESSION,
      callId: CALL,
      at: AT,
      salt: SALT,
      ...over,
    });
  const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const decodeTime = (ulid: string) =>
    [...ulid.slice(0, 10)].reduce((t, c) => t * 32 + ALPHABET.indexOf(c), 0);

  it('is a 26-char Crockford base32 ULID whose time part is the hook time', () => {
    const value = id()!;
    expect(value).toMatch(ULID);
    expect(decodeTime(value)).toBe(AT.getTime());
    expect(value.slice(0, 10)).toBe(createUlid()(AT.getTime()).slice(0, 10));
  });

  it('takes its 80 random bits from the first 10 bytes of HMAC-SHA-256(salt, platform‖0‖session‖0‖call)', () => {
    const hex = createHmac('sha256', SALT)
      .update(`claude-code\u0000${SESSION}\u0000${CALL}`)
      .digest('hex')
      .slice(0, 20);
    const expected = BigInt(`0x${hex}`).toString(32).toUpperCase().padStart(16, '0');
    // BigInt base-32 digits use 0-9A-V; map to Crockford.
    const crockford = [...expected].map((d) => ALPHABET[Number.parseInt(d, 32)]).join('');
    expect(id()!.slice(10)).toBe(crockford);
  });

  it('is stable for the same call and distinct across platform, session, call and salt', () => {
    expect(id()).toBe(id());
    const ids = [
      id(),
      id({ platform: 'codex-cli' }),
      id({ sessionId: 'session-0002' }),
      id({ callId: 'toolu_01ABD' }),
      id({ salt: 'other-salt' }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // Same call at another time: same random part, other time part.
    const later = id({ at: new Date(AT.getTime() + 1) })!;
    expect(later.slice(10)).toBe(id()!.slice(10));
    expect(later > id()!).toBe(true);
  });

  it('sorts with createUlid ids by time, and only by randomness within the same ms', () => {
    const t = AT.getTime();
    const derived = id()!;
    expect(createUlid()(t - 1) < derived).toBe(true);
    expect(derived < createUlid()(t + 1)).toBe(true);
    const sameMs = createUlid()(t);
    expect(sameMs.slice(0, 10)).toBe(derived.slice(0, 10));
  });

  it('contains no raw id and is accepted by the JGR validator', () => {
    const value = id({ sessionId: SENTINEL, callId: SENTINEL })!;
    expect(value).not.toContain('SENTINEL');
    const event = asEvent({
      event_id: value,
      project_ref: 'web-app',
      thread_ref: 'cc_x',
      type: 'heartbeat',
      status: 'idle',
      occurred_at: AT.toISOString(),
    });
    const result = validateEvent(event, AT);
    expect(result.ok).toBe(true);
    expect(result.ok && result.event.event_id).toBe(value);
  });

  it('returns null without a call id (the caller uses a fresh ULID)', () => {
    expect(id({ callId: undefined })).toBeNull();
    expect(id({ callId: null })).toBeNull();
    expect(id({ callId: '' })).toBeNull();
  });

  it('rejects a time outside 48 bits like createUlid', () => {
    expect(() => id({ at: new Date(Number.NaN) })).toThrow(RangeError);
    expect(() => id({ at: new Date(-1) })).toThrow(RangeError);
  });
});

describe('selfReportRecord (ADR-0017 §3 mapping)', () => {
  const cc = (event: string, tool: string, input: unknown, extra: object = {}) => ({
    session_id: SESSION,
    transcript_path: `/home/hai/${SENTINEL}.jsonl`,
    cwd: `/home/hai/${SENTINEL}`,
    hook_event_name: event,
    tool_name: `mcp__javi__${tool}`,
    tool_input: input,
    tool_response: { content: [{ type: 'text', text: SENTINEL }] },
    tool_use_id: CALL,
    ...extra,
  });
  const gemini = (event: string, tool: string, input: unknown, extra: object = {}) => ({
    session_id: SESSION,
    cwd: `/home/hai/${SENTINEL}`,
    hook_event_name: event,
    tool_name: `mcp_javi_${tool}`,
    tool_input: input,
    tool_response: { llmContent: SENTINEL },
    mcp_context: {
      server_name: 'javi',
      tool_name: tool,
      command: SENTINEL,
      args: [SENTINEL],
      cwd: SENTINEL,
    },
    ...extra,
  });

  const valid = (record: unknown) => {
    const result = validateEvent(asEvent(record as object), AT);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
  };

  it('report_status with a reason → heartbeat + status + error_code <status>.<reason>', () => {
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUse', 'report_status', { status: 'blocked', reason: 'missing_credentials' }),
      ctx,
      base,
    );
    expect(record).toEqual({
      project_ref: 'web-app',
      thread_ref: base.thread_ref,
      event_id: selfReportEventId({
        platform: 'claude-code',
        sessionId: SESSION,
        callId: CALL,
        at: AT,
        salt: SALT,
      }),
      occurred_at: AT.toISOString(),
      type: 'heartbeat',
      status: 'blocked',
      attributes: {
        platform: 'claude-code',
        collector_version: '0.1.0',
        tool_name: 'mcp__javi__report_status',
        error_code: 'blocked.missing_credentials',
      },
    });
    valid(record);
  });

  it('report_status without a reason → no error_code', () => {
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUse', 'report_status', { status: 'completed' }),
      ctx,
      base,
    );
    expect(record?.type).toBe('heartbeat');
    expect(record?.status).toBe('completed');
    expect(record?.attributes).toEqual({
      platform: 'claude-code',
      collector_version: '0.1.0',
      tool_name: 'mcp__javi__report_status',
    });
    valid(record);
  });

  it.each(SELF_REPORT.phases)('report_task phase %s → task.%s + task_kind', (phase) => {
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUse', 'report_task', { phase, kind: 'test' }),
      ctx,
      base,
    );
    expect(record?.type).toBe(`task.${phase}`);
    expect(record).not.toHaveProperty('status');
    expect(record?.attributes).toEqual({
      platform: 'claude-code',
      collector_version: '0.1.0',
      tool_name: 'mcp__javi__report_task',
      task_kind: 'test',
    });
    valid(record);
  });

  it('maps Claude Code PostToolUseFailure too (ADR-0017 §3, review L5)', () => {
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUseFailure', 'report_status', { status: 'failed', reason: 'ci_failing' }),
      ctx,
      base,
    );
    expect(record?.attributes?.error_code).toBe('failed.ci_failing');
  });

  it('Codex: id from tool_use_id with the codex-cli platform, base from mapCodexHook as is', () => {
    const payload = {
      ...cc('PostToolUse', 'report_task', { phase: 'failed', kind: 'build' }),
      turn_id: SENTINEL,
      model: SENTINEL,
    };
    const codexBase = mapCodexHook(payload, {
      projectRef: 'web-app',
      salt: SALT,
      collectorVersion: '0.3.0',
    })!;
    expect(codexBase.type).toBe('task.completed');
    const record = selfReportRecord('codex-cli', payload, ctx, codexBase);
    expect(record).toEqual({
      project_ref: 'web-app',
      thread_ref: codexBase.thread_ref,
      event_id: selfReportEventId({
        platform: 'codex-cli',
        sessionId: SESSION,
        callId: CALL,
        at: AT,
        salt: SALT,
      }),
      occurred_at: AT.toISOString(),
      type: 'task.failed',
      attributes: {
        platform: 'codex-cli',
        collector_version: '0.3.0',
        tool_name: 'mcp__javi__report_task',
        task_kind: 'build',
      },
    });
    valid(record);
  });

  it('Gemini: no call id → no event_id (fresh ULID); tool_name as the agent saw it', () => {
    const payload = gemini('AfterTool', 'report_status', {
      status: 'waiting',
      reason: 'needs_approval',
    });
    const geminiBase = mapGeminiHook(payload, {
      projectRef: 'web-app',
      salt: SALT,
      collectorVersion: '0.3.0',
    })!;
    const record = selfReportRecord(
      'gemini-cli',
      { ...payload, tool_use_id: CALL },
      ctx,
      geminiBase,
    );
    expect(record).toEqual({
      project_ref: 'web-app',
      thread_ref: geminiBase.thread_ref,
      occurred_at: AT.toISOString(),
      type: 'heartbeat',
      status: 'waiting',
      attributes: {
        platform: 'gemini-cli',
        collector_version: '0.3.0',
        tool_name: 'mcp_javi_report_status',
        error_code: 'waiting.needs_approval',
      },
    });
    valid(record);
  });

  it('Gemini: tool_name is taken as given (G19): never invented, capped at 128 chars', () => {
    const noName: Record<string, unknown> = gemini('AfterTool', 'report_task', {
      phase: 'started',
      kind: 'plan',
    });
    delete noName.tool_name;
    expect(selfReportRecord('gemini-cli', noName, ctx, base)).toBeNull();
    const odd = gemini(
      'AfterTool',
      'report_task',
      { phase: 'started', kind: 'plan' },
      {
        tool_name: 'Some_Other-Name',
      },
    );
    expect(selfReportRecord('gemini-cli', odd, ctx, base)?.attributes?.tool_name).toBe(
      'Some_Other-Name',
    );
    const long = gemini(
      'AfterTool',
      'report_task',
      { phase: 'started', kind: 'plan' },
      {
        tool_name: 'x'.repeat(300),
      },
    );
    expect(selfReportRecord('gemini-cli', long, ctx, base)?.attributes?.tool_name).toBe(
      'x'.repeat(128),
    );
  });

  it('time is the caller clock, never a payload timestamp (G12)', () => {
    const payload = cc(
      'PostToolUse',
      'report_status',
      { status: 'idle' },
      { timestamp: '2001-01-01T00:00:00.000Z', occurred_at: '2001-01-01T00:00:00.000Z' },
    );
    const record = selfReportRecord('claude-code', payload, ctx, base);
    expect(record?.occurred_at).toBe(AT.toISOString());
    expect(record?.event_id?.slice(0, 10)).toBe(createUlid()(AT.getTime()).slice(0, 10));
  });

  it('keeps base.occurred_at when the caller sets it', () => {
    const occurred = '2026-10-30T12:00:00.000Z';
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUse', 'report_status', { status: 'idle' }),
      ctx,
      { ...base, occurred_at: occurred },
    );
    expect(record?.occurred_at).toBe(occurred);
  });

  it('replaces stale self-report keys in base.attributes and ignores base type/status/sequence', () => {
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUse', 'report_status', { status: 'idle' }),
      ctx,
      {
        ...base,
        type: 'task.completed',
        status: 'working',
        sequence: 7,
        attributes: { ...base.attributes, tool_name: 'old', error_code: 'old', task_kind: 'old' },
      } as SelfReportBase,
    );
    expect(record).not.toHaveProperty('sequence');
    expect(record?.type).toBe('heartbeat');
    expect(record?.status).toBe('idle');
    expect(record?.attributes).toEqual({
      platform: 'claude-code',
      collector_version: '0.1.0',
      tool_name: 'mcp__javi__report_status',
    });
  });

  it('sub-agent: report_status → null; report_task keeps base.agent_ref', () => {
    const sub = { agent_id: 'agent-7' };
    expect(
      selfReportRecord(
        'claude-code',
        cc('PostToolUse', 'report_status', { status: 'blocked' }, sub),
        ctx,
        base,
      ),
    ).toBeNull();
    const record = selfReportRecord(
      'claude-code',
      cc('PostToolUse', 'report_task', { phase: 'completed', kind: 'review' }, sub),
      ctx,
      { ...base, agent_ref: 'ag_0123456789abcdef0123456789abcdef' },
    );
    expect(record?.agent_ref).toBe('ag_0123456789abcdef0123456789abcdef');
    expect(record?.type).toBe('task.completed');
    valid(record);
  });

  it.each([
    [
      'claude-code PreToolUse',
      'claude-code',
      cc('PreToolUse', 'report_status', { status: 'idle' }),
    ],
    [
      'codex-cli PreToolUse',
      'codex-cli',
      cc('PreToolUse', 'report_task', { phase: 'started', kind: 'plan' }),
    ],
    [
      'gemini-cli BeforeTool',
      'gemini-cli',
      gemini('BeforeTool', 'report_status', { status: 'idle' }),
    ],
  ])('%s → null (pre-tool hooks stay silent)', (_name, platform, payload) => {
    expect(selfReportRecord(platform, payload, ctx, base)).toBeNull();
  });

  it.each([
    ['invalid input', cc('PostToolUse', 'report_status', { status: 'blocked', note: SENTINEL })],
    [
      'reason with working',
      cc('PostToolUse', 'report_status', { status: 'working', reason: 'other' }),
    ],
    ['input missing', cc('PostToolUse', 'report_task', undefined)],
    ['input as a JSON string', cc('PostToolUse', 'report_status', '{"status":"idle"}')],
    ['no session id', cc('PostToolUse', 'report_status', { status: 'idle' }, { session_id: '' })],
    [
      'other tool',
      { ...cc('PostToolUse', 'report_status', { status: 'idle' }), tool_name: 'Bash' },
    ],
    [
      'look-alike tool',
      {
        ...cc('PostToolUse', 'report_status', { status: 'idle' }),
        tool_name: 'mcp__javi__report_status_x',
      },
    ],
  ])('%s → null', (_name, payload) => {
    expect(selfReportRecord('claude-code', payload, ctx, base)).toBeNull();
  });
});

/**
 * Records every property access (get, has, own-property lookups, key enumeration) on a payload
 * and its nested objects, by dotted path. `*keys` marks an enumeration of an object's keys.
 */
const recordReads = (target: object) => {
  const reads = new Set<string>();
  const wrap = (obj: object, prefix: string): object =>
    new Proxy(obj, {
      get(t, key, receiver) {
        const path = `${prefix}${String(key)}`;
        reads.add(path);
        const value: unknown = Reflect.get(t, key, receiver);
        return value !== null && typeof value === 'object' ? wrap(value, `${path}.`) : value;
      },
      has(t, key) {
        reads.add(`${prefix}${String(key)}`);
        return Reflect.has(t, key);
      },
      getOwnPropertyDescriptor(t, key) {
        reads.add(`${prefix}${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      ownKeys(t) {
        reads.add(`${prefix}*keys`);
        return Reflect.ownKeys(t);
      },
    });
  return { proxy: wrap(target, ''), reads };
};

describe('read trap: what the matcher and mapper may read (TEST_PLAN §S5d row 7)', () => {
  const MATCH_READS = new Set([
    'hook_event_name',
    'tool_name',
    'mcp_context',
    'mcp_context.server_name',
    'mcp_context.tool_name',
  ]);
  const secretInput = { command: `curl -H "Authorization: ${SENTINEL}"`, password: SENTINEL };
  const content = {
    session_id: SESSION,
    agent_id: 'agent-1',
    tool_use_id: CALL,
    tool_input: secretInput,
    tool_response: { output: SENTINEL },
    prompt: SENTINEL,
    cwd: SENTINEL,
    transcript_path: SENTINEL,
  };

  const others: Array<[name: string, platform: string, payload: object]> = [
    [
      'cc Bash post',
      'claude-code',
      { ...content, hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    ],
    [
      'cc third-party MCP post',
      'claude-code',
      { ...content, hook_event_name: 'PostToolUse', tool_name: 'mcp__github__create_issue' },
    ],
    [
      'cc look-alike',
      'claude-code',
      { ...content, hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__javix__report_status' },
    ],
    ['cc Stop', 'claude-code', { ...content, hook_event_name: 'Stop' }],
    [
      'codex shell post',
      'codex-cli',
      { ...content, hook_event_name: 'PostToolUse', tool_name: 'shell' },
    ],
    [
      'codex look-alike pre',
      'codex-cli',
      { ...content, hook_event_name: 'PreToolUse', tool_name: 'mcp__javi__report_status_x' },
    ],
    [
      'gemini other server',
      'gemini-cli',
      {
        ...content,
        hook_event_name: 'AfterTool',
        tool_name: 'mcp_github_x',
        mcp_context: { server_name: 'github', tool_name: 'x', command: SENTINEL, args: [SENTINEL] },
      },
    ],
    [
      'gemini javi_x',
      'gemini-cli',
      {
        ...content,
        hook_event_name: 'AfterTool',
        tool_name: 'mcp_javi_x_report_status',
        mcp_context: { server_name: 'javi_x', tool_name: 'report_status', env: { KEY: SENTINEL } },
      },
    ],
    [
      'gemini built-in tool',
      'gemini-cli',
      { ...content, hook_event_name: 'AfterTool', tool_name: 'run_shell_command' },
    ],
    [
      'gemini javi unknown tool',
      'gemini-cli',
      {
        ...content,
        hook_event_name: 'AfterTool',
        mcp_context: { server_name: 'javi', tool_name: 'report_other', url: SENTINEL },
      },
    ],
  ];

  it.each(others)('%s: only the match fields are read', (_name, platform, payload) => {
    for (const fn of [
      (p: object) => matchJaviTool(platform, p),
      (p: object) => selfReportRecord(platform, p, ctx, base),
    ]) {
      const { proxy, reads } = recordReads(payload);
      expect(fn(proxy)).toBeNull();
      expect([...reads].filter((path) => !MATCH_READS.has(path))).toEqual([]);
      expect(reads.has('tool_input')).toBe(false);
    }
  });

  it('gemini: mcp_context.tool_name is not read unless server_name is javi', () => {
    const { proxy, reads } = recordReads(others[7]![2]);
    matchJaviTool('gemini-cli', proxy);
    expect(reads.has('mcp_context.server_name')).toBe(true);
    expect(reads.has('mcp_context.tool_name')).toBe(false);
    expect(reads.has('tool_name')).toBe(false);
  });

  const MAPPER_READS = new Set([
    ...MATCH_READS,
    'session_id',
    'agent_id',
    'tool_use_id',
    'tool_input',
  ]);
  const allowed = (path: string) => MAPPER_READS.has(path) || path.startsWith('tool_input.');
  const javi: Array<[name: string, platform: string, payload: object]> = [
    [
      'cc status',
      'claude-code',
      {
        ...content,
        agent_id: undefined,
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__javi__report_status',
        tool_input: { status: 'blocked', reason: 'missing_access' },
      },
    ],
    [
      'cc task (sub-agent)',
      'claude-code',
      {
        ...content,
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'mcp__javi__report_task',
        tool_input: { phase: 'failed', kind: 'test' },
      },
    ],
    [
      'cc invalid input',
      'claude-code',
      {
        ...content,
        agent_id: undefined,
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__javi__report_status',
        tool_input: { status: 'blocked', note: SENTINEL },
      },
    ],
    [
      'codex task',
      'codex-cli',
      {
        ...content,
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__javi__report_task',
        tool_input: { phase: 'started', kind: 'debug' },
      },
    ],
    [
      'gemini status',
      'gemini-cli',
      {
        ...content,
        agent_id: undefined,
        hook_event_name: 'AfterTool',
        tool_name: 'mcp_javi_report_status',
        tool_input: { status: 'idle' },
        mcp_context: {
          server_name: 'javi',
          tool_name: 'report_status',
          command: SENTINEL,
          args: [SENTINEL],
          cwd: SENTINEL,
          env: { K: SENTINEL },
          url: SENTINEL,
        },
      },
    ],
  ];

  it.each(javi)(
    '%s: tool_response and other mcp_context fields are never read',
    (_name, platform, payload) => {
      const { proxy, reads } = recordReads(payload);
      selfReportRecord(platform, proxy, ctx, base);
      expect([...reads].filter((path) => !allowed(path))).toEqual([]);
      expect([...reads].some((path) => path.startsWith('tool_response'))).toBe(false);
      if (platform === 'gemini-cli') expect(reads.has('tool_use_id')).toBe(false);
    },
  );

  it('pre-tool hooks of javi tools never read tool_input', () => {
    const { proxy, reads } = recordReads({
      ...content,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__javi__report_status',
      tool_input: { status: 'idle' },
    });
    expect(selfReportRecord('claude-code', proxy, ctx, base)).toBeNull();
    expect([...reads].filter((path) => !MATCH_READS.has(path))).toEqual([]);
  });

  it('the recorder itself sees a tool_response read (trap self-check)', () => {
    const { proxy, reads } = recordReads(content);
    void (proxy as { tool_response?: unknown }).tool_response;
    expect(reads.has('tool_response')).toBe(true);
  });
});
