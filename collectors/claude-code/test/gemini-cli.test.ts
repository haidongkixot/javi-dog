import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeUserSettingsPath,
  createState,
  geminiProjectSettingsPath,
  geminiTelemetryBlock,
  geminiUserSettingsPath,
  main,
  settingsPath,
  type CollectorState,
  type Io,
} from '../src/index.ts';
import { SENTINELS, mapGeminiHook } from './gemini-doubles.ts';

// S5b B1 (TEST_PLAN §S5b): `javi … --platform gemini-cli` in-process against temp JAVI_HOME,
// Gemini home and project dirs (never the real ~/.gemini). JD-C02 is replaced by local test
// doubles of its documented contract until lane A's implementation is merged.
vi.mock('@javis-dog/collector-adapters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import('./gemini-doubles.ts')).doubles,
}));

const TOKEN = `jd_it_${'G'.repeat(43)}`;
let home: string;
let geminiHome: string;
let claudeHome: string;
let project: string;
let state: CollectorState;
let userSettings: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-gm-home-'));
  geminiHome = await mkdtemp(join(tmpdir(), 'javi-gm-user-'));
  claudeHome = await mkdtemp(join(tmpdir(), 'javi-gm-claude-'));
  project = await mkdtemp(join(tmpdir(), 'javi-gm-project-'));
  state = createState(home);
  userSettings = geminiUserSettingsPath(geminiHome);
});
afterEach(async () => {
  for (const dir of [home, geminiHome, claudeHome, project]) {
    await rm(dir, { recursive: true, force: true });
  }
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const io = (opts: { env?: NodeJS.ProcessEnv; stdin?: string } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const flushes: string[] = [];
  let receivers = 0;
  const value: Io = {
    env: {
      JAVI_HOME: home,
      JAVI_GEMINI_HOME: geminiHome,
      JAVI_CLAUDE_HOME: claudeHome,
      ...opts.env,
    },
    cwd: project,
    readStdin: async () => opts.stdin ?? '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: (ref) => flushes.push(ref),
    spawnReceiver: () => {
      receivers += 1;
    },
  };
  return { value, out, err, flushes, receivers: () => receivers };
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const usageOn = async (extra: string[] = [], env: NodeJS.ProcessEnv = {}) => {
  const t = io({ env });
  const code = await main(['usage', 'on', '--platform', 'gemini-cli', ...extra], t.value);
  return { code, ...t };
};
const usageOff = async (platform = 'gemini-cli') => {
  const t = io();
  const code = await main(['usage', 'off', '--platform', platform], t.value);
  return { code, ...t };
};
const seedUser = async (text: string) => {
  await mkdir(join(geminiHome, '.gemini'), { recursive: true });
  await writeFile(userSettings, text);
};

describe('javi usage on|off --platform gemini-cli', () => {
  it('writes the telemetry block (logPrompts and traces off), names keys only, starts the receiver', async () => {
    const port = await freePort();
    const on = await usageOn(['--port', String(port)]);
    expect(on.code).toBe(0);
    const config = await state.usageConfig();
    expect(config).toMatchObject({ port, gemini: { path: userSettings } });
    expect(config!.written).toBeUndefined(); // Claude Code usage stays off
    const settings = JSON.parse(await readFile(userSettings, 'utf8'));
    expect(settings).toEqual({
      telemetry: {
        enabled: true,
        target: 'local',
        otlpProtocol: 'http',
        otlpEndpoint: `http://127.0.0.1:${port}`,
        otlpHeaders: { Authorization: `Bearer ${config!.secret}` },
        logPrompts: false,
        traces: false,
      },
    });
    expect(settings.telemetry).toEqual(geminiTelemetryBlock(port, config!.secret));
    expect((await stat(userSettings)).mode & 0o777).toBe(0o600);
    const text = [...on.out, ...on.err].join('\n');
    expect(text).not.toContain(config!.secret);
    expect(text).toContain(
      'telemetry: enabled, target, otlpProtocol, otlpEndpoint, otlpHeaders, logPrompts, traces',
    );
    expect(text).toMatch(/logPrompts: false/);
    expect(text).toMatch(/logs and traces are answered and dropped unread/);
    expect(text).toMatch(/estimated/);
    expect(on.receivers()).toBe(1);
    // Claude Code's settings are not touched.
    expect(await exists(claudeUserSettingsPath(claudeHome))).toBe(false);
  });

  it('usage off restores the previous file byte for byte; the backup keeps the original', async () => {
    const original =
      '{\n    "model": { "name": "gemini-2.5-pro" },\n    "ui": { "theme": "GitHub" }\n}';
    await seedUser(original);
    expect((await usageOn(['--port', String(await freePort())])).code).toBe(0);
    const edited = JSON.parse(await readFile(userSettings, 'utf8'));
    expect(edited.model).toEqual({ name: 'gemini-2.5-pro' });
    expect(edited.ui).toEqual({ theme: 'GitHub' });
    expect(await readFile(`${userSettings}.javi-backup`, 'utf8')).toBe(original);
    // Re-running is idempotent: same secret, same block, still restorable.
    const secret = (await state.usageConfig())!.secret;
    expect((await usageOn()).code).toBe(0);
    expect((await state.usageConfig())!.secret).toBe(secret);

    const off = await usageOff();
    expect(off.code).toBe(0);
    expect(off.out.join('\n')).toMatch(/Restored .* to exactly what it was before/);
    expect(await readFile(userSettings, 'utf8')).toBe(original);
    expect(await state.usageConfig()).toBeNull();
    expect(await exists(join(home, 'gemini-settings.before.json'))).toBe(false);
    expect(await readFile(`${userSettings}.javi-backup`, 'utf8')).toBe(original);
  });

  it('usage off removes a settings file javi created', async () => {
    expect((await usageOn(['--port', String(await freePort())])).code).toBe(0);
    const off = await usageOff();
    expect(off.out.join('\n')).toMatch(/javi had created it/);
    expect(await exists(userSettings)).toBe(false);
  });

  it('after other edits, usage off removes only javi’s unchanged block', async () => {
    await seedUser('{"ui": {"theme": "GitHub"}}');
    await usageOn(['--port', String(await freePort())]);
    const s = JSON.parse(await readFile(userSettings, 'utf8'));
    await writeFile(userSettings, JSON.stringify({ ...s, general: { vimMode: true } }));
    const off = await usageOff();
    expect(off.out.join('\n')).toMatch(/Removed javi's telemetry block/);
    expect(JSON.parse(await readFile(userSettings, 'utf8'))).toEqual({
      ui: { theme: 'GitHub' },
      general: { vimMode: true },
    });
  });

  it('a block the user changed is refused on re-run and left alone by usage off', async () => {
    await usageOn(['--port', String(await freePort())]);
    const s = JSON.parse(await readFile(userSettings, 'utf8'));
    s.telemetry.logPrompts = true;
    const changed = JSON.stringify(s);
    await writeFile(userSettings, changed);
    const again = await usageOn();
    expect(again.code).toBe(1);
    expect(again.err.join('\n')).toMatch(/telemetry is already configured/);
    expect(await readFile(userSettings, 'utf8')).toBe(changed);
    const off = await usageOff();
    expect(off.code).toBe(0);
    expect(off.out.join('\n')).toMatch(/Nothing to remove/);
    expect(await readFile(userSettings, 'utf8')).toBe(changed);
  });

  it('refuses an existing telemetry block that is not javi’s, naming keys only', async () => {
    const theirs = JSON.stringify({
      telemetry: { enabled: true, target: 'gcp', otlpHeaders: { 'x-api-key': 'THEIR-KEY' } },
    });
    await seedUser(theirs);
    const on = await usageOn(['--port', String(await freePort())]);
    expect(on.code).toBe(1);
    const text = on.err.join('\n');
    expect(text).toContain('telemetry.enabled, telemetry.otlpHeaders, telemetry.target');
    expect(text).not.toContain('THEIR-KEY');
    expect(text).toMatch(/never takes over an existing telemetry setup/);
    expect(await readFile(userSettings, 'utf8')).toBe(theirs);
    expect(await exists(`${userSettings}.javi-backup`)).toBe(false);
    expect(await state.usageConfig()).toBeNull();
    expect(on.receivers()).toBe(0);
  });

  it.each([
    ['GEMINI_TELEMETRY_OTLP_ENDPOINT', 'http://collector:4318'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318'],
    ['GEMINI_TELEMETRY_LOG_PROMPTS', 'true'],
  ])('refuses while %s is set in the shell (it would override the file)', async (key, value) => {
    const on = await usageOn(['--port', String(await freePort())], { [key]: value });
    expect(on.code).toBe(1);
    expect(on.err.join('\n')).toContain(key);
    expect(on.err.join('\n')).not.toContain(value);
    expect(await exists(userSettings)).toBe(false);
    expect(await state.usageConfig()).toBeNull();
  });

  it('refuses a settings file with comments, changing nothing', async () => {
    const text = '{\n  // my settings\n  "ui": {}\n}';
    await seedUser(text);
    const on = await usageOn(['--port', String(await freePort())]);
    expect(on.code).toBe(1);
    expect(on.err.join('\n')).toMatch(/not a plain JSON object .*comments/);
    expect(await readFile(userSettings, 'utf8')).toBe(text);
    expect(await state.usageConfig()).toBeNull();
  });

  it('usage off keeps everything when the file became unreadable', async () => {
    await usageOn(['--port', String(await freePort())]);
    await writeFile(userSettings, '{ broken');
    const off = await usageOff();
    expect(off.code).toBe(1);
    expect(off.err.join('\n')).toMatch(/still on/);
    expect(await state.usageConfig()).not.toBeNull();
    expect(await readFile(userSettings, 'utf8')).toBe('{ broken');
  });

  it('shares one port and secret with Claude Code; each off keeps what the other needs', async () => {
    const port = await freePort();
    const claude = io();
    expect(await main(['usage', 'on', '--port', String(port)], claude.value)).toBe(0);
    const { secret } = (await state.usageConfig())!;
    expect((await usageOn()).code).toBe(0);
    const both = (await state.usageConfig())!;
    expect(both).toMatchObject({ port, secret, gemini: { path: userSettings } });
    expect(both.written).toBeDefined();
    expect(JSON.parse(await readFile(userSettings, 'utf8')).telemetry.otlpEndpoint).toBe(
      `http://127.0.0.1:${port}`,
    );

    // Moving the port would strand the other platform: refused, nothing changed.
    const move = await usageOn(['--port', String(await freePort())]);
    expect(move.code).toBe(1);
    expect(move.err.join('\n')).toMatch(/one usage port for all platforms.*Claude Code/);
    const claudeMove = io();
    expect(await main(['usage', 'on', '--port', String(await freePort())], claudeMove.value)).toBe(
      1,
    );
    expect(claudeMove.err.join('\n')).toMatch(/Gemini CLI usage export is on/);
    expect(await state.usageConfig()).toEqual(both);

    const status = io();
    await main(['status', '--project', 'web-app'], status.value);
    expect(status.out).toEqual(
      expect.arrayContaining([
        `Usage: on (port ${port})`,
        'Claude Code usage: on',
        `Gemini CLI usage: on (${userSettings})`,
      ]),
    );

    const offClaude = io();
    expect(await main(['usage', 'off'], offClaude.value)).toBe(0);
    expect(offClaude.out).toContain('The usage receiver keeps running for Gemini CLI.');
    const geminiOnly = (await state.usageConfig())!;
    expect(geminiOnly.written).toBeUndefined();
    expect(geminiOnly.gemini).toEqual(both.gemini);
    const again = io();
    expect(await main(['usage', 'off'], again.value)).toBe(0);
    expect(again.out).toEqual(['Token usage export for Claude Code is already off.']);

    const offGemini = await usageOff();
    expect(offGemini.code).toBe(0);
    expect(await state.usageConfig()).toBeNull();
    expect((await usageOff()).out).toEqual(['Token usage export for Gemini CLI is already off.']);
  });

  it('Gemini off while Claude Code stays on keeps the Claude settings and the secret', async () => {
    const port = await freePort();
    await main(['usage', 'on', '--port', String(port)], io().value);
    await usageOn();
    const off = await usageOff();
    expect(off.out).toContain('The usage receiver keeps running for Claude Code.');
    const config = (await state.usageConfig())!;
    expect(config.gemini).toBeUndefined();
    expect(config.written).toBeDefined();
    const claudeEnv = JSON.parse(await readFile(claudeUserSettingsPath(claudeHome), 'utf8')).env;
    expect(claudeEnv.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      `http://127.0.0.1:${port}/v1/metrics`,
    );
  });
});

describe('javi init|status|hook|uninstall --platform gemini-cli', () => {
  const init = async (extra: string[] = []) => {
    const t = io({ env: { JAVI_INGEST_TOKEN: TOKEN } });
    const code = await main(
      ['init', '--project', 'web-app', '--platform', 'gemini-cli', '--no-verify', ...extra],
      t.value,
    );
    return { code, ...t };
  };

  it('init registers Gemini hooks, says what folder trust and SessionEnd mean, keeps the token out', async () => {
    const result = await init();
    expect(result.code).toBe(0);
    const text = result.out.join('\n');
    expect(text).toContain(`Gemini CLI hooks registered in ${geminiProjectSettingsPath(project)}.`);
    expect(text).toMatch(/only in a trusted folder/);
    expect(text).toMatch(/SessionEnd .*best-effort/);
    expect(text).not.toContain(TOKEN);
    const settings = await readFile(geminiProjectSettingsPath(project), 'utf8');
    expect(settings).not.toContain(TOKEN);
    expect(settings).toContain('hook --platform gemini-cli --project web-app');
    expect(await exists(settingsPath(project))).toBe(false); // no Claude Code hooks
    expect(await state.credentials('web-app')).toEqual({
      endpoint: 'https://javisdog.vercel.app/api/v1/events',
      token: TOKEN,
    });
  });

  it('init stops before saving the token when the Gemini settings cannot be edited', async () => {
    await mkdir(join(project, '.gemini'), { recursive: true });
    await writeFile(geminiProjectSettingsPath(project), '{ // comment\n}');
    const result = await init();
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/javi init failed: .*No token saved/);
    expect(await state.credentials('web-app')).toBeNull();
  });

  it('init warns when the project settings carry their own telemetry block', async () => {
    await mkdir(join(project, '.gemini'), { recursive: true });
    await writeFile(geminiProjectSettingsPath(project), '{"telemetry": {"logPrompts": true}}');
    const result = await init();
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toMatch(/own telemetry block, which overrides/);
  });

  it('status says "no events yet" until a Gemini hook ran, then when it last did', async () => {
    await init();
    const before = io();
    expect(
      await main(['status', '--project', 'web-app', '--platform', 'gemini-cli'], before.value),
    ).toBe(0);
    expect(before.out).toContain(
      `Gemini CLI hooks: registered in ${geminiProjectSettingsPath(project)}`,
    );
    expect(before.out.join('\n')).toMatch(/no events yet.*trusted folder/);

    const hook = io({
      stdin: JSON.stringify({
        session_id: 'gm-sess-1',
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd: SENTINELS[3],
        transcript_path: `${SENTINELS[3]}/t.json`,
        prompt: SENTINELS[2],
      }),
    });
    expect(
      await main(
        ['hook', '--platform', 'gemini-cli', '--project', 'web-app', '--source', 'javi-collector'],
        hook.value,
      ),
    ).toBe(0);
    expect([...hook.out, ...hook.err]).toEqual([]);
    expect(hook.flushes).toEqual(['web-app']); // session.started is urgent
    expect(mapGeminiHook).toHaveBeenCalled();

    const spool = state.spoolDir('web-app');
    const files = (await readdir(spool, { recursive: true })).filter((f) => f.endsWith('.json'));
    const events = await Promise.all(
      files.map(async (f) => JSON.parse(await readFile(join(spool, f), 'utf8'))),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.started',
      thread_ref: expect.stringMatching(/^gm_[0-9a-f]{32}$/),
      attributes: { platform: 'gemini-cli' },
    });
    const raw = JSON.stringify(events);
    for (const s of [...SENTINELS, 'gm-sess-1']) expect(raw).not.toContain(s);

    const after = io();
    await main(['status', '--project', 'web-app', '--platform', 'gemini-cli'], after.value);
    expect(after.out.join('\n')).toMatch(/Last Gemini CLI hook event: \d{4}-\d\d-\d\dT/);
  });

  it('a Gemini hook registers its session for usage attribution while usage is on', async () => {
    await init();
    await usageOn(['--port', String(await freePort())]);
    const hook = io({
      stdin: JSON.stringify({ session_id: 'gm-s2', hook_event_name: 'BeforeAgent' }),
    });
    await main(['hook', '--platform', 'gemini-cli', '--project', 'web-app'], hook.value);
    expect([...hook.out, ...hook.err]).toEqual([]);
    const sessions = (await readdir(join(home, 'sessions'))).filter((f) => !f.startsWith('.'));
    expect(sessions).toEqual([expect.stringMatching(/^gm_[0-9a-f]{32}\.json$/)]);
    expect(hook.receivers()).toBe(1);
  });

  it('uninstall removes only the Gemini hooks; an unknown platform is refused', async () => {
    await init();
    const t = io();
    expect(
      await main(['uninstall', '--project', 'web-app', '--platform', 'gemini-cli'], t.value),
    ).toBe(0);
    expect(t.out).toEqual([`Removed javi hooks from ${geminiProjectSettingsPath(project)}.`]);
    expect(await readFile(geminiProjectSettingsPath(project), 'utf8')).not.toContain(
      'javi-collector',
    );

    const bad = io();
    expect(await main(['init', '--project', 'web-app', '--platform', 'codex'], bad.value)).toBe(2);
    expect(bad.err.join('\n')).toMatch(/Unknown --platform/);
    const badHook = io({ stdin: '{"session_id":"x","hook_event_name":"SessionStart"}' });
    expect(await main(['hook', '--project', 'web-app', '--platform', 'codex'], badHook.value)).toBe(
      0,
    );
    expect([...badHook.out, ...badHook.err]).toEqual([]);
  });
});
