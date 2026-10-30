import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SELF_REPORT } from '@javis-dog/collector-adapters';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_INSTRUCTIONS, MCP_LOG_MESSAGES, MCP_RESULT_TEXTS } from '../src/index.ts';

// ADR-0017 §1 Tests: the official SDK client (`@modelcontextprotocol/sdk` 1.32.2, dev dependency
// only) against a real `node` process running `serveStdio` on its own stdio, as `javi mcp`
// will. TEST_PLAN §S5d rows 4–5.

const ENTRY = fileURLToPath(new URL('./fixtures/stdio-entry.ts', import.meta.url));
const SENTINEL = 'SENTINEL-ignore-previous-instructions-API_KEY=abc';
const LOGS = new Set<string>(Object.values(MCP_LOG_MESSAGES));
// `--no-warnings`: Node prints an ExperimentalWarning for type stripping on stderr (ADR-0017 §5
// registers the real entry with the same flag).
const ARGS = (hooks: 'installed' | 'missing') => ['--no-warnings', ENTRY, hooks];

const collect = (stream: Readable | null) => {
  let text = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => (text += chunk));
  return () => text;
};

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

const connect = async (hooks: 'installed' | 'missing') => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ARGS(hooks),
    stderr: 'pipe',
  });
  const stderr = collect(transport.stderr as Readable | null);
  client = new Client({ name: 'javi-interop-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr };
};

const textOf = (result: unknown) =>
  ((result as { content: Array<{ type: string; text: string }> }).content[0] ?? { text: '' }).text;

describe('interop with the official MCP SDK client 1.32.2', () => {
  it('handshakes, lists both tools, and calls valid and invalid reports', async () => {
    const { client, stderr } = await connect('installed');
    expect(client.getServerVersion()).toEqual({ name: 'javi', version: '0.0.0-test' });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    await expect(client.ping()).resolves.toEqual({});

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['report_status', 'report_task']);
    expect(tools[0]!.inputSchema).toEqual(SELF_REPORT.schemas.report_status);
    expect(tools[1]!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const ok = await client.callTool({
      name: 'report_status',
      arguments: { status: 'blocked', reason: 'missing_credentials' },
    });
    expect(ok.isError).toBe(false);
    expect(textOf(ok)).toBe(MCP_RESULT_TEXTS.noted.report_status);

    const task = await client.callTool({
      name: 'report_task',
      arguments: { phase: 'started', kind: 'implement' },
    });
    expect(textOf(task)).toBe(MCP_RESULT_TEXTS.noted.report_task);

    const invalid = await client.callTool({
      name: 'report_status',
      arguments: { status: 'blocked', note: SENTINEL },
    });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toBe(MCP_RESULT_TEXTS.invalid.report_status);
    expect(JSON.stringify(invalid)).not.toContain('SENTINEL');

    await expect(client.callTool({ name: SENTINEL, arguments: {} })).rejects.toMatchObject({
      code: -32602,
    });

    await client.close();
    const logged = stderr();
    expect(logged).not.toContain('SENTINEL');
    for (const line of logged.split('\n').filter(Boolean)) expect(LOGS.has(line)).toBe(true);
  });

  it('answers "not recorded" when javi hooks are not installed', async () => {
    const { client } = await connect('missing');
    const result = await client.callTool({ name: 'report_status', arguments: { status: 'idle' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('not recorded: javi hooks are not installed for this project');
  });
});

describe('raw process: stdout carries only JSON-RPC 2.0, stderr only fixed strings', () => {
  it('every stdout line parses as one JSON-RPC 2.0 message; no sentinel anywhere', async () => {
    const child = spawn(process.execPath, ARGS('installed'), { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    const S = SENTINEL;
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { S } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', clientInfo: { name: S, version: S } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'report_status', arguments: { status: 'waiting', reason: 'needs_input' } },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'report_task', arguments: { phase: 'started', kind: S } },
      }),
      `{"jsonrpc":"2.0","id":7,"method":"${S}`,
      JSON.stringify([{ jsonrpc: '2.0', id: 8, method: 'ping' }]),
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: S }),
    ];
    child.stdin.end(`${input.join('\n')}\n`);
    expect(await exited).toBe(0);

    const out = stdout();
    expect(out.endsWith('\n')).toBe(true);
    const lines = out.slice(0, -1).split('\n');
    const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const message of messages) {
      expect(message.jsonrpc).toBe('2.0');
      expect('result' in message !== 'error' in message).toBe(true);
    }
    expect(messages.map((m) => [m.id, (m.error as { code?: number } | undefined)?.code])).toEqual([
      [1, -32601],
      [2, -32600],
      [3, undefined],
      [4, undefined],
      [5, undefined],
      [6, undefined],
      [null, -32700],
      [null, -32600],
      [9, -32601],
    ]);
    expect(out).not.toContain('SENTINEL');
    const logged = stderr();
    expect(logged).not.toContain('SENTINEL');
    const logLines = logged.split('\n').filter(Boolean);
    expect(logLines[0]).toBe(MCP_LOG_MESSAGES.started);
    expect(logLines.at(-1)).toBe(MCP_LOG_MESSAGES.stopped);
    for (const line of logLines) expect(LOGS.has(line)).toBe(true);
  });
});
