import { PassThrough } from 'node:stream';
import { SELF_REPORT } from '@javis-dog/collector-adapters';
import { describe, expect, it, vi } from 'vitest';
import {
  MCP_INSTRUCTIONS,
  MCP_LOG_MESSAGES,
  MCP_RESULT_TEXTS,
  createMcpServer,
  serveStdio,
  type McpServerOptions,
} from '../src/index.ts';

// ADR-0017 decision 1, TEST_PLAN §S5d rows 2–5, 17–18. Expected values are copied from the ADR.

const SENTINEL = 'SENTINEL-ignore-previous-instructions-API_KEY=abc';
const LOGS = new Set<string>(Object.values(MCP_LOG_MESSAGES));
const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const harness = (over: Partial<McpServerOptions> = {}) => {
  const lines: string[] = [];
  const logs: string[] = [];
  const hooksInstalled = vi.fn(over.hooksInstalled ?? (() => true));
  const server = createMcpServer({
    version: '1.2.3',
    hooksInstalled,
    write: (line) => lines.push(line),
    log: (message) => logs.push(message),
  });
  /** Sends lines; returns the parsed messages written in response. */
  const send = async (...input: Array<string | object>) => {
    const start = lines.length;
    for (const item of input) {
      await server.handleLine(typeof item === 'string' ? item : JSON.stringify(item));
    }
    return lines.slice(start).map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const init = () =>
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
  return { server, lines, logs, hooksInstalled, send, init };
};

const rpc = (id: unknown, method: string, params?: unknown) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined && { params }),
});
const call = (id: number, name: string, args?: unknown) =>
  rpc(id, 'tools/call', { name, ...(args !== undefined && { arguments: args }) });
const error = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

describe('initialize (ADR-0017 §1 handshake)', () => {
  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('echoes the known version %s', async (v) => {
    const { send } = harness();
    expect(await send(rpc(1, 'initialize', { protocolVersion: v, capabilities: {} }))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: v,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'javi', version: '1.2.3' },
          instructions: MCP_INSTRUCTIONS,
        },
      },
    ]);
  });

  it.each([['2024-11-05'], ['2026-07-28'], [SENTINEL], [42], [null]])(
    'answers 2025-11-25 to %j',
    async (protocolVersion) => {
      const { send, lines } = harness();
      const [response] = await send(rpc('a', 'initialize', { protocolVersion }));
      expect((response!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
      expect(lines.join('')).not.toContain('SENTINEL');
    },
  );

  it('answers 2025-11-25 without params', async () => {
    const [response] = await harness().send(rpc(1, 'initialize'));
    expect((response!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  it('answers a repeated initialize like the first (G14)', async () => {
    const { send } = harness();
    const [first] = await send(rpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
    const [second] = await send(rpc(2, 'initialize', { protocolVersion: '2025-06-18' }));
    expect({ ...second, id: 1 }).toEqual(first);
  });

  it('tools/list does not depend on the hooks state (G3)', async () => {
    const missing = harness({ hooksInstalled: () => false });
    const installed = harness();
    await missing.init();
    await installed.init();
    const [a] = await missing.send(rpc(1, 'tools/list'));
    const [b] = await installed.send(rpc(1, 'tools/list'));
    expect(a).toEqual(b);
    expect(missing.hooksInstalled).not.toHaveBeenCalled();
  });

  it('instructions are at most 1 000 characters and name both tools', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
    expect(MCP_INSTRUCTIONS).toContain('report_status');
    expect(MCP_INSTRUCTIONS).toContain('report_task');
    expect(MCP_INSTRUCTIONS).toMatch(/never per tool call/);
  });
});

describe('JSON-RPC message rules (ADR-0017 §1)', () => {
  it('echoes id exactly, string or number', async () => {
    const { send } = harness();
    const responses = await send(
      rpc('id-1', 'ping'),
      rpc(7, 'ping'),
      rpc(0, 'ping'),
      rpc(-1.5, 'ping'),
    );
    expect(responses).toEqual([
      { jsonrpc: '2.0', id: 'id-1', result: {} },
      { jsonrpc: '2.0', id: 7, result: {} },
      { jsonrpc: '2.0', id: 0, result: {} },
      { jsonrpc: '2.0', id: -1.5, result: {} },
    ]);
  });

  it('answers ping before initialize', async () => {
    expect(await harness().send(rpc(1, 'ping'))).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('rejects tools/list and tools/call before initialize with -32600', async () => {
    const { send, hooksInstalled } = harness();
    expect(await send(rpc(1, 'tools/list'), call(2, 'report_status', { status: 'idle' }))).toEqual([
      error(1, -32600, 'Server not initialized'),
      error(2, -32600, 'Server not initialized'),
    ]);
    expect(hooksInstalled).not.toHaveBeenCalled();
  });

  it('answers server/discover and unknown methods with -32601, before and after initialize', async () => {
    const { send, init } = harness();
    expect(await send(rpc(1, 'server/discover'), rpc(2, 'resources/list'))).toEqual([
      error(1, -32601, 'Method not found'),
      error(2, -32601, 'Method not found'),
    ]);
    await init();
    expect(
      await send(rpc(3, 'server/discover'), rpc(4, 'prompts/list'), rpc(5, `x/${SENTINEL}`)),
    ).toEqual([
      error(3, -32601, 'Method not found'),
      error(4, -32601, 'Method not found'),
      error(5, -32601, 'Method not found'),
    ]);
  });

  it('never answers notifications, known or unknown, valid or not', async () => {
    const { send, init, hooksInstalled } = harness();
    await init();
    expect(
      await send(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'report_status', arguments: { status: 'idle' } },
        },
        { jsonrpc: '2.0', method: 'initialize' },
        { jsonrpc: '2.0', method: SENTINEL },
        { method: 'notifications/initialized' },
        { jsonrpc: '2.0' },
      ),
    ).toEqual([]);
    expect(hooksInstalled).not.toHaveBeenCalled();
  });

  it('ignores responses (a client answering a request we never sent)', async () => {
    const { send } = harness();
    expect(
      await send(
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: 2, error: { code: 1, message: SENTINEL } },
      ),
    ).toEqual([]);
  });

  it('answers malformed JSON with -32700 and id null', async () => {
    const { send, logs } = harness();
    expect(await send(`{"jsonrpc":"2.0","id":1,"method":"ping"`, `${SENTINEL}`, '{,}')).toEqual([
      error(null, -32700, 'Parse error'),
      error(null, -32700, 'Parse error'),
      error(null, -32700, 'Parse error'),
    ]);
    expect(logs).toEqual(Array(3).fill(MCP_LOG_MESSAGES.malformed));
  });

  it('answers a batch (JSON array) with -32600 and id null, without running it', async () => {
    const { send, init, hooksInstalled } = harness();
    await init();
    expect(await send([rpc(1, 'ping'), call(2, 'report_status', { status: 'idle' })], [])).toEqual([
      error(null, -32600, 'Invalid Request'),
      error(null, -32600, 'Invalid Request'),
    ]);
    expect(hooksInstalled).not.toHaveBeenCalled();
  });

  it.each([['1'], ['"ping"'], ['null'], ['true']])(
    'answers non-object JSON %s with -32600, id null',
    async (line) => {
      expect(await harness().send(line)).toEqual([error(null, -32600, 'Invalid Request')]);
    },
  );

  it('answers a request with a bad jsonrpc field or method with -32600, echoing a valid id', async () => {
    const { send } = harness();
    expect(
      await send(
        { id: 1, method: 'ping' },
        { jsonrpc: '1.0', id: 2, method: 'ping' },
        { jsonrpc: '2.0', id: 3, method: 7 },
        { jsonrpc: '2.0', id: 4 },
        { jsonrpc: '2.0', id: { x: SENTINEL }, method: 9 },
      ),
    ).toEqual([
      error(1, -32600, 'Invalid Request'),
      error(2, -32600, 'Invalid Request'),
      error(3, -32600, 'Invalid Request'),
      error(4, -32600, 'Invalid Request'),
      error(null, -32600, 'Invalid Request'),
    ]);
  });

  it.each([[null], [true], [{ a: 1 }], [[1]]])(
    'answers an invalid id %j with -32600 and id null',
    async (id) => {
      expect(await harness().send(rpc(id, 'ping'))).toEqual([
        error(null, -32600, 'Invalid Request'),
      ]);
    },
  );

  it('skips blank lines and accepts CRLF', async () => {
    const { send } = harness();
    expect(await send('', '   ', `${JSON.stringify(rpc(1, 'ping'))}\r`)).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
    ]);
  });

  it('writes one newline-terminated JSON-RPC 2.0 message per response', async () => {
    const { send, init, lines } = harness();
    await init();
    await send(
      rpc(1, 'tools/list'),
      call(2, 'report_task', { phase: 'started', kind: 'plan' }),
      '{',
      [],
    );
    expect(lines.length).toBe(5);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.indexOf('\n')).toBe(line.length - 1);
      const message = JSON.parse(line) as Record<string, unknown>;
      expect(message.jsonrpc).toBe('2.0');
      expect(has(message, 'result') !== has(message, 'error')).toBe(true);
    }
  });
});

const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

describe('tools/list (ADR-0017 §2)', () => {
  it('lists exactly the two tools with the SELF_REPORT schemas and the ADR annotations', async () => {
    const { send, init } = harness();
    await init();
    const [response] = await send(rpc(1, 'tools/list', { cursor: SENTINEL }));
    const tools = (response!.result as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['report_status', 'report_task']);
    expect(tools[0]!.inputSchema).toEqual(SELF_REPORT.schemas.report_status);
    expect(tools[1]!.inputSchema).toEqual(SELF_REPORT.schemas.report_task);
    for (const tool of tools) {
      expect(tool.annotations).toEqual(ANNOTATIONS);
      expect(typeof tool.description).toBe('string');
      expect(Object.keys(tool).sort()).toEqual([
        'annotations',
        'description',
        'inputSchema',
        'name',
      ]);
    }
    expect(JSON.stringify(response)).not.toContain('SENTINEL');
    expect(response).not.toHaveProperty('result.nextCursor');
  });
});

describe('tools/call (ADR-0017 §2 honest answer)', () => {
  const result = (text: string, isError: boolean) => ({
    content: [{ type: 'text', text }],
    isError,
  });

  it('valid report_status / report_task → constant "noted" without a delivery claim', async () => {
    const { send, init } = harness();
    await init();
    expect(
      await send(
        call(1, 'report_status', { status: 'blocked', reason: 'missing_credentials' }),
        call(2, 'report_task', { phase: 'completed', kind: 'test' }),
      ),
    ).toEqual([
      { jsonrpc: '2.0', id: 1, result: result(MCP_RESULT_TEXTS.noted.report_status, false) },
      { jsonrpc: '2.0', id: 2, result: result(MCP_RESULT_TEXTS.noted.report_task, false) },
    ]);
    for (const text of Object.values(MCP_RESULT_TEXTS.noted)) {
      expect(text).toMatch(/^noted/);
      expect(text).not.toMatch(/deliver|sent|live|dashboard shows/i);
    }
  });

  it('hooks not installed → isError with the exact ADR text', async () => {
    const { send, init } = harness({ hooksInstalled: () => Promise.resolve(false) });
    await init();
    expect(await send(call(1, 'report_status', { status: 'idle' }))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: result('not recorded: javi hooks are not installed for this project', true),
      },
    ]);
  });

  it('a hooks check that throws counts as not installed and logs a fixed string', async () => {
    const { send, init, logs } = harness({
      hooksInstalled: () => {
        throw new Error(SENTINEL);
      },
    });
    await init();
    const [response] = await send(call(1, 'report_task', { phase: 'started', kind: 'plan' }));
    expect(response!.result).toEqual(result(MCP_RESULT_TEXTS.hooksMissing, true));
    expect(logs).toEqual([MCP_LOG_MESSAGES.hooksCheckFailed]);
  });

  it.each([
    ['report_status', { status: 'blocked', note: SENTINEL }],
    ['report_status', { status: 'working', reason: 'other' }],
    ['report_status', { status: SENTINEL }],
    ['report_status', [SENTINEL]],
    ['report_status', SENTINEL],
    ['report_status', undefined],
    ['report_status', null],
    ['report_status', 42],
    ['report_status', {}],
    ['report_status', { status: 'blocked', reason: null }],
    ['report_status', { reason: 'other' }],
    ['report_task', { phase: 'started' }],
    ['report_task', { kind: 'plan' }],
    ['report_task', { phase: 'started', kind: SENTINEL }],
  ])(
    'invalid %s arguments %j → isError with the constant text, hooks not consulted',
    async (name, args) => {
      const { send, init, hooksInstalled } = harness();
      await init();
      const [response] = await send(call(1, name, args));
      expect(response!.result).toEqual(
        result(MCP_RESULT_TEXTS.invalid[name as 'report_status' | 'report_task'], true),
      );
      expect(hooksInstalled).not.toHaveBeenCalled();
    },
  );

  it('invalid-argument texts name the allowed values', () => {
    for (const value of [...SELF_REPORT.statuses, ...SELF_REPORT.reasons]) {
      expect(MCP_RESULT_TEXTS.invalid.report_status).toContain(value);
    }
    for (const value of [...SELF_REPORT.phases, ...SELF_REPORT.kinds]) {
      expect(MCP_RESULT_TEXTS.invalid.report_task).toContain(value);
    }
  });

  it.each([
    ['unknown tool', { name: 'report_other', arguments: {} }],
    ['sentinel tool', { name: SENTINEL, arguments: { status: 'idle' } }],
    ['prefixed name', { name: 'mcp__javi__report_status', arguments: { status: 'idle' } }],
    ['name missing', { arguments: { status: 'idle' } }],
    ['name not a string', { name: 1 }],
    ['inherited name', { name: 'constructor' }],
  ])('%s → -32602', async (_name, params) => {
    const { send, init, lines } = harness();
    await init();
    expect(await send(rpc(9, 'tools/call', params))).toEqual([error(9, -32602, 'Invalid params')]);
    expect(lines.join('')).not.toContain('SENTINEL');
  });

  it.each([[undefined], [null], [[{ name: 'report_status' }]], ['report_status']])(
    'params %j → -32602',
    async (params) => {
      const { send, init } = harness();
      await init();
      expect(await send(rpc(9, 'tools/call', params))).toEqual([
        error(9, -32602, 'Invalid params'),
      ]);
    },
  );
});

describe('sentinel: no input text ever reaches stdout or stderr (TEST_PLAN §S5d row 18)', () => {
  it('a sentinel anywhere except id appears in no written line and no log', async () => {
    const { send, lines, logs } = harness({ hooksInstalled: () => false });
    const S = SENTINEL;
    const inputs: Array<string | object> = [
      `{"jsonrpc":"2.0","id":1,"method":"${S}"`,
      `${S}\u0000\u001b[31m`,
      [S],
      S.length.toString(),
      `"${S}"`,
      { jsonrpc: S, id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: S },
      { jsonrpc: '2.0', id: { S }, method: 'ping' },
      rpc(4, 'tools/list'),
      rpc(5, 'initialize', {
        protocolVersion: S,
        clientInfo: { name: S, version: S },
        capabilities: { S },
      }),
      rpc(6, 'tools/list', { cursor: S, _meta: { S } }),
      rpc(7, 'tools/call', { name: S, arguments: { status: S } }),
      rpc(8, 'tools/call', { name: 'report_status', arguments: { status: 'blocked', reason: S } }),
      rpc(9, 'tools/call', { name: 'report_status', arguments: { status: 'blocked', [S]: S } }),
      rpc(10, 'tools/call', {
        name: 'report_task',
        arguments: { phase: 'started', kind: 'plan', note: S },
      }),
      rpc(11, 'tools/call', {
        name: 'report_task',
        arguments: { phase: 'started', kind: 'plan' },
        _meta: { sessionId: S },
      }),
      rpc(12, 'tools/call', { name: 'report_status', arguments: { status: 'idle' }, [S]: S }),
      rpc(13, 'server/discover', { S }),
      { jsonrpc: '2.0', id: 14, result: S },
      { jsonrpc: '2.0', method: 'notifications/message', params: { data: S } },
      { jsonrpc: '2.0', id: 15, method: 'ping', params: { S }, extra: S },
    ];
    await send(...inputs);
    const out = lines.join('');
    expect(out).not.toContain('SENTINEL');
    expect(logs.join('\n')).not.toContain('SENTINEL');
    expect(logs.every((message) => LOGS.has(message))).toBe(true);
    expect(lines.length).toBeGreaterThan(10);
  });
});

describe('serveStdio over in-memory streams', () => {
  const run = async (chunks: Array<string | Buffer>, maxLineLength?: number) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    const done = serveStdio(stdin, stdout, stderr, {
      version: '1.2.3',
      hooksInstalled: async () => true,
      ...(maxLineLength !== undefined && { maxLineLength }),
    });
    for (const chunk of chunks) stdin.write(chunk);
    stdin.end();
    await done;
    return { out, err };
  };

  it('reassembles lines split across chunks (including a split UTF-8 character) and answers in order', async () => {
    const init = `${JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-03-26' }))}\n`;
    const ping = JSON.stringify(rpc('ü-é', 'ping'));
    const bytes = Buffer.from(
      `${init}${ping}\n${JSON.stringify(call(3, 'report_status', { status: 'idle' }))}`,
    );
    const cut = bytes.indexOf(0xc3) + 1; // inside the 2-byte 'ü'
    const { out, err } = await run([
      bytes.subarray(0, 5),
      bytes.subarray(5, cut),
      bytes.subarray(cut),
    ]);
    const messages = out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: unknown });
    expect(messages.map((m) => m.id)).toEqual([1, 'ü-é', 3]);
    expect(out.endsWith('\n')).toBe(true);
    expect(err).toBe(`${MCP_LOG_MESSAGES.started}\n${MCP_LOG_MESSAGES.stopped}\n`);
  });

  it('drops an oversized line unread, answers -32700, and keeps serving', async () => {
    const big = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${SENTINEL}${'a'.repeat(5000)}"}}`;
    const { out, err } = await run(
      [big.slice(0, 3000), big.slice(3000), `\n${JSON.stringify(rpc(2, 'ping'))}\n`],
      1024,
    );
    expect(
      out
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([error(null, -32700, 'Parse error'), { jsonrpc: '2.0', id: 2, result: {} }]);
    expect(out).not.toContain('SENTINEL');
    expect(err.trimEnd().split('\n')).toEqual([
      MCP_LOG_MESSAGES.started,
      MCP_LOG_MESSAGES.tooLarge,
      MCP_LOG_MESSAGES.stopped,
    ]);
  });

  it('handles a final line without a newline at end of input', async () => {
    const { out } = await run([JSON.stringify(rpc(1, 'ping'))]);
    expect(out).toBe(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`);
  });
});
