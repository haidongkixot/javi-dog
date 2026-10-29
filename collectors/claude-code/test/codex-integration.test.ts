import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_LOGS_PATH,
  createState,
  createUsageReceiver,
  opaqueRef,
  runHook,
  type CollectorState,
  type UsageReceiver,
} from '../src/index.ts';

// S5c code review (test gap): hook → receiver → spool through the REAL JD-C02 adapters
// (`mapCodexHook`, `codexSubagentLink`, `parseCodexLogs`, `codexUsageDelta`, `codexCostDelta`),
// no test doubles. The OTLP body is written by hand in Codex's documented wire form (M2:
// `event.name` / `event.kind` attributes; input/output as `stringValue`, cached/cache write as
// `intValue`, JSON number or string).

const SECRET = 'codex-secret-0123456789abcdef';
const TOKEN = `jd_it_${'I'.repeat(43)}`;
const SENTINELS = {
  email: 'sentinel-user@example.invalid',
  toolArgs: 'SENTINEL_TOOL_ARGS_rm_-rf',
  output: 'SENTINEL_TOOL_OUTPUT',
  account: 'SENTINEL_ACCOUNT_ID',
  prompt: 'SENTINEL_PROMPT',
};
const ROOT = '019a3c5e-root-session';
const CHILD = '019a3c5e-child-agent';

/** A spooled JGR event, as far as this test reads it. */
interface Spooled {
  type: string;
  project_ref: string;
  thread_ref: string;
  agent_ref?: string;
  usage_delta: Record<string, unknown>;
  attributes: Record<string, unknown>;
}

type Value = { stringValue: string } | { intValue: number | string };
const s = (v: string): Value => ({ stringValue: v });
const i = (v: number | string): Value => ({ intValue: v });
const record = (attrs: Record<string, Value>) => ({
  timeUnixNano: '1793280000000000000',
  body: { stringValue: SENTINELS.output },
  attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
});
const identity = {
  'user.email': s(SENTINELS.email),
  'user.account_id': s(SENTINELS.account),
};
const completed = (
  conversation: string,
  counters: { input: Value; cached: Value; cacheWrite: Value; output: Value },
  timestamp: string,
  authMode = 'ApiKey',
) =>
  record({
    'event.name': s('codex.sse_event'),
    'event.kind': s('response.completed'),
    'event.timestamp': s(timestamp),
    'conversation.id': s(conversation),
    model: s('gpt-5.5-codex'),
    auth_mode: s(authMode),
    ...identity,
    input_token_count: counters.input,
    cached_token_count: counters.cached,
    cache_write_token_count: counters.cacheWrite,
    output_token_count: counters.output,
    reasoning_token_count: i(120),
    tool_token_count: s('1250'),
  });
const turnCost = (conversation: string, turn: string, usd: string, authMode: string) =>
  record({
    'event.name': s('codex.turn_cost'),
    'conversation.id': s(conversation),
    'turn.id': s(turn),
    auth_mode: s(authMode),
    'usage.estimated_usd': s(usd),
    ...identity,
  });
const toolResult = () =>
  record({
    'event.name': s('codex.tool_result'),
    'conversation.id': s(ROOT),
    tool_name: s('shell'),
    arguments: s(`{"command":"${SENTINELS.toolArgs}"}`),
    output: s(SENTINELS.output),
    ...identity,
  });
const body = () => ({
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: s('codex_cli_rs') },
          { key: 'user.email', value: s(SENTINELS.email) },
        ],
      },
      scopeLogs: [
        {
          scope: { name: 'codex_otel' },
          logRecords: [
            completed(
              ROOT,
              { input: s('1000'), cached: i(400), cacheWrite: i('100'), output: s('250') },
              '2026-10-29T19:29:00.123Z',
            ),
            toolResult(),
            turnCost(ROOT, 'turn-api', '0.0421', 'ApiKey'),
            turnCost(ROOT, 'turn-plan', '1.5', 'Chatgpt'),
            completed(
              CHILD,
              { input: s('60'), cached: i(10), cacheWrite: i(0), output: s('12') },
              '2026-10-29T19:29:05.000Z',
            ),
            turnCost(CHILD, 'turn-child', '0.003', 'ApiKey'),
          ],
        },
      ],
    },
  ],
});

const post = (port: number, text: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: CODEX_LOGS_PATH,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${SECRET}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(text);
  });

/** Every file under `dir` (spool, sessions, sub-agent links, warnings, receiver info…). */
const allText = async (dir: string) => {
  const names = await readdir(dir, { recursive: true });
  const texts: string[] = [];
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8').catch(() => null);
    if (text !== null) texts.push(text);
  }
  return texts.join('\n');
};

let home: string;
let state: CollectorState;
let receiver: UsageReceiver;
let port: number;
let salt: string;

const hook = (payload: Record<string, unknown>) =>
  runHook({
    state,
    projectRef: 'web-app',
    platform: 'codex-cli',
    stdin: JSON.stringify(payload),
    spawnFlush: () => {},
    env: {},
  });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-cx-int-'));
  state = createState(home);
  await state.saveCredentials('web-app', { endpoint: 'http://127.0.0.1:9/never', token: TOKEN });
  await state.saveUsageConfig({
    port: 4319,
    secret: SECRET,
    codex: { path: join(home, 'codex', 'config.toml'), block: '', separator: '', created: false },
  });
  ({ salt } = await state.installation());
  receiver = createUsageReceiver({ state, port: 0, secret: SECRET, salt, flush: async () => {} });
  port = await receiver.listen();
});
afterEach(async () => {
  await receiver.close();
  await rm(home, { recursive: true, force: true });
});

describe('Codex CLI usage through the real JD-C02 adapters (S5c code review test gap)', () => {
  it('hooks + one logs request → exact deltas (H3), cost only for ApiKey, sub-agent attribution; no sentinel kept', async () => {
    await hook({ session_id: ROOT, hook_event_name: 'SessionStart', source: 'startup' });
    await hook({
      session_id: ROOT,
      hook_event_name: 'SubagentStart',
      agent_id: CHILD,
      prompt: SENTINELS.prompt,
    });
    expect(await post(port, JSON.stringify(body()))).toBe(200);

    const dir = state.spoolDir('web-app');
    const events = await Promise.all(
      (await readdir(dir))
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as Spooled),
    );
    const usage = events.filter((e) => e.type === 'usage.reported');
    const thread = opaqueRef('cx', ROOT, salt);
    const agentRef = opaqueRef('ag', CHILD, salt);
    const pick = (e: Spooled) => ({
      thread_ref: e.thread_ref,
      agent_ref: e.agent_ref,
      usage_delta: e.usage_delta,
    });
    expect(usage.map(pick)).toEqual(
      expect.arrayContaining([
        {
          thread_ref: thread,
          agent_ref: undefined,
          // H3: input = 1000 − 400 cached − 100 cache write.
          usage_delta: {
            input_tokens: 500,
            cache_read_tokens: 400,
            cache_write_tokens: 100,
            output_tokens: 250,
            model: 'gpt-5.5-codex',
            estimated: false,
          },
        },
        {
          thread_ref: thread,
          agent_ref: undefined,
          usage_delta: { cost_usd: 0.0421, estimated: false },
        },
        {
          thread_ref: thread,
          agent_ref: agentRef,
          usage_delta: {
            input_tokens: 50,
            cache_read_tokens: 10,
            cache_write_tokens: 0,
            output_tokens: 12,
            model: 'gpt-5.5-codex',
            estimated: false,
          },
        },
        {
          thread_ref: thread,
          agent_ref: agentRef,
          usage_delta: { cost_usd: 0.003, estimated: false },
        },
      ]),
    );
    // Exactly those four: the ChatGPT-plan turn cost and the tool result produce nothing.
    expect(usage).toHaveLength(4);
    expect(usage.filter((e) => 'cost_usd' in e.usage_delta)).toHaveLength(2);
    for (const e of usage) {
      expect(e).toMatchObject({ project_ref: 'web-app', attributes: { platform: 'codex-cli' } });
    }
    // The hooks' own events are on the same thread; the sub-agent start carries its agent_ref.
    expect(events.find((e) => e.type === 'agent.started')).toMatchObject({
      thread_ref: thread,
      agent_ref: agentRef,
    });
    expect(await state.receiverInfo()).toMatchObject({ forwarded: 4, dropped: 0 });

    // Nothing of the content or identity is kept anywhere in javi's state (spool, sessions,
    // sub-agent links, warnings, receiver info, accepted ids), nor any raw id.
    const kept = await allText(home);
    for (const sentinel of [
      ...Object.values(SENTINELS),
      ROOT,
      CHILD,
      'turn-api',
      'turn-plan',
      'turn-child',
      'Chatgpt',
      'ApiKey',
    ]) {
      expect(kept, sentinel).not.toContain(sentinel);
    }
    expect(await state.codexEnvWarnings()).toEqual([]);
  });
});
