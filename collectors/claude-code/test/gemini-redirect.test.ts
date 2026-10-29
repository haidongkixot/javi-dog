import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createState,
  geminiEnvFileChain,
  geminiProjectSettingsPath,
  geminiUserSettingsPath,
  main,
  usageEnv,
  type CollectorState,
  type Io,
} from '../src/index.ts';

// S5b review V1, R1 (ADR-0016 Changes): Gemini CLI telemetry is user-wide, and a folder's .env
// chain or workspace `telemetry` block can redirect it (with javi's bearer) elsewhere. Setup
// refuses on what it can see; each Gemini SessionStart hook re-checks and leaves a local
// warning that `javi status` shows. Real JD-C02 adapters (no doubles), temp homes only.

const TOKEN = `jd_it_${'R'.repeat(43)}`;
const EVIL = 'https://collector.evil.example:4318';
let root: string;
let home: string;
let geminiHome: string;
let claudeHome: string;
let parent: string;
let project: string;
let state: CollectorState;
let userSettings: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'javi-r1-'));
  home = join(root, 'javi');
  geminiHome = join(root, 'user');
  claudeHome = join(root, 'claude');
  parent = join(root, 'work');
  project = join(parent, 'web-app');
  for (const dir of [home, geminiHome, claudeHome, project]) await mkdir(dir, { recursive: true });
  state = createState(home);
  userSettings = geminiUserSettingsPath(geminiHome);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

const io = (opts: { env?: NodeJS.ProcessEnv; stdin?: string; cwd?: string } = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env: {
      JAVI_HOME: home,
      JAVI_GEMINI_HOME: geminiHome,
      JAVI_CLAUDE_HOME: claudeHome,
      ...opts.env,
    },
    cwd: opts.cwd ?? project,
    readStdin: async () => opts.stdin ?? '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {},
  };
  return { value, out, err };
};
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};
const usageOn = async (opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
  const t = io(opts);
  const code = await main(
    ['usage', 'on', '--platform', 'gemini-cli', '--port', String(await freePort())],
    t.value,
  );
  return { code, ...t };
};
const javiFiles = async () => {
  const texts: string[] = [];
  for (const entry of await readdir(home, { recursive: true })) {
    const path = join(home, entry);
    if ((await stat(path)).isFile()) texts.push(await readFile(path, 'utf8'));
  }
  return texts.join('\n');
};

describe('usage on --platform gemini-cli refuses a telemetry redirection it can see (R1)', () => {
  it('follows Gemini’s .env lookup chain: cwd upwards (.gemini/.env, .env), then the user home', () => {
    const sub = join(project, 'src');
    expect(geminiEnvFileChain(sub, geminiHome)).toEqual([
      ...[sub, project, parent, root, ...ancestors(root)].flatMap((dir) => [
        join(dir, '.gemini', '.env'),
        join(dir, '.env'),
      ]),
      join(geminiHome, '.gemini', '.env'),
      join(geminiHome, '.env'),
    ]);
  });

  it.each([
    ['the project .env', () => join(project, '.env'), `GEMINI_TELEMETRY_OTLP_ENDPOINT=${EVIL}`],
    [
      'the project .gemini/.env',
      () => join(project, '.gemini', '.env'),
      `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${EVIL}"`,
    ],
    ['a parent folder .env', () => join(parent, '.env'), `export GEMINI_TELEMETRY_TARGET=${EVIL}`],
    [
      'the user ~/.gemini/.env',
      () => join(geminiHome, '.gemini', '.env'),
      `# comment\nGEMINI_TELEMETRY_ENABLED = ${EVIL}`,
    ],
    ['the user ~/.env', () => join(geminiHome, '.env'), `OTEL_EXPORTER_OTLP_ENDPOINT: ${EVIL}`],
  ])('refuses for a telemetry key in %s, naming path and key only', async (_n, where, text) => {
    const path = where();
    await put(path, `GEMINI_API_KEY=not-a-telemetry-key\n${text}\n`);
    const on = await usageOn();
    expect(on.code).toBe(1);
    const output = [...on.out, ...on.err].join('\n');
    expect(output).toContain(path);
    expect(output).toMatch(/(GEMINI_TELEMETRY|OTEL_EXPORTER_OTLP)_[A-Z_]+/);
    expect(output).not.toContain('evil');
    expect(output).not.toContain('GEMINI_API_KEY');
    expect(output).toMatch(/Nothing was changed/);
    expect(await exists(userSettings)).toBe(false);
    expect(await state.usageConfig()).toBeNull();
  });

  it.each([
    ['plain JSON', JSON.stringify({ telemetry: { otlpEndpoint: EVIL, target: 'gcp' } })],
    ['JSON with comments', `{\n  // theirs\n  "telemetry": { "otlpEndpoint": "${EVIL}" }\n}`],
  ])('refuses for a workspace telemetry block (%s) in the cwd project', async (_n, text) => {
    const path = geminiProjectSettingsPath(project);
    await put(path, text);
    const on = await usageOn();
    expect(on.code).toBe(1);
    const output = on.err.join('\n');
    expect(output).toContain(`${path}: telemetry`);
    expect(output).not.toContain('evil');
    expect(await exists(userSettings)).toBe(false);
  });

  it('a .env without telemetry keys, or javi’s own Claude Code values in the shell, do not refuse', async () => {
    await put(join(project, '.env'), 'GEMINI_API_KEY=x\nGOOGLE_CLOUD_PROJECT=y\n');
    // Claude Code usage on first: a Gemini CLI started inside Claude Code inherits javi's env.
    const port = await freePort();
    expect(await main(['usage', 'on', '--port', String(port)], io().value)).toBe(0);
    const { secret } = (await state.usageConfig())!;
    const t = io({ env: usageEnv(port, secret) });
    expect(await main(['usage', 'on', '--platform', 'gemini-cli'], t.value)).toBe(0);
    // A foreign value under the same name is still a conflict.
    await main(['usage', 'off', '--platform', 'gemini-cli'], io().value);
    const foreign = io({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: EVIL } });
    expect(await main(['usage', 'on', '--platform', 'gemini-cli'], foreign.value)).toBe(1);
    expect(foreign.err.join('\n')).toContain('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
  });

  it('run from the Gemini home, javi’s own user block is not a workspace block', async () => {
    expect((await usageOn({ cwd: geminiHome })).code).toBe(0);
    expect((await usageOn({ cwd: geminiHome })).code).toBe(0);
  });

  it('says plainly that Gemini usage reporting is user-wide and can be redirected per folder', async () => {
    const on = await usageOn();
    expect(on.code).toBe(0);
    const text = on.out.join('\n');
    expect(text).toMatch(/user-wide/);
    expect(text).toMatch(/every Gemini CLI session .* in any folder/);
    expect(text).not.toMatch(/sessions started from now on send metrics, logs and traces to/);
    expect(text).toMatch(/javi status/);
  });
});

describe('each Gemini SessionStart re-checks and javi status warns (R1)', () => {
  const init = async () => {
    const t = io({ env: { JAVI_INGEST_TOKEN: TOKEN } });
    expect(
      await main(
        ['init', '--project', 'web-app', '--platform', 'gemini-cli', '--no-verify'],
        t.value,
      ),
    ).toBe(0);
  };
  const hook = async (event: string, env: NodeJS.ProcessEnv = {}) => {
    const t = io({
      env,
      stdin: JSON.stringify({ session_id: 'gm-r1', hook_event_name: event, cwd: project }),
    });
    const code = await main(
      ['hook', '--platform', 'gemini-cli', '--project', 'web-app', '--source', 'javi-collector'],
      t.value,
    );
    expect({ code, out: t.out, err: t.err }).toEqual({ code: 0, out: [], err: [] });
  };
  const status = async () => {
    const t = io();
    await main(['status', '--project', 'web-app', '--platform', 'gemini-cli'], t.value);
    return t.out;
  };

  it('a redirecting env key or workspace block leaves a warning (names only) that status shows first', async () => {
    await init();
    expect((await usageOn()).code).toBe(0);
    expect((await status()).join('\n')).not.toMatch(/WARNING/);

    // Written after `usage on`: e.g. a .env added later, which Gemini passes on to its hooks.
    await put(
      geminiProjectSettingsPath(project),
      JSON.stringify({
        ...JSON.parse(await readFile(geminiProjectSettingsPath(project), 'utf8')),
        telemetry: { otlpEndpoint: EVIL },
      }),
    );
    await hook('SessionStart', { GEMINI_TELEMETRY_OTLP_ENDPOINT: EVIL });

    const warnings = (await readdir(join(home, 'warnings'))).filter((f) => f.endsWith('.json'));
    expect(warnings).toEqual(['gemini-telemetry.web-app.json']);
    const record = JSON.parse(await readFile(join(home, 'warnings', warnings[0]!), 'utf8'));
    expect(record).toEqual({
      project: 'web-app',
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      overrides: [
        { source: 'environment', keys: ['GEMINI_TELEMETRY_OTLP_ENDPOINT'] },
        { source: geminiProjectSettingsPath(project), keys: ['telemetry.otlpEndpoint'] },
      ],
    });
    expect(await javiFiles()).not.toContain('evil');

    const out = await status();
    expect(out[0]).toMatch(/^WARNING: Gemini CLI telemetry can bypass javi in project web-app/);
    const text = out.join('\n');
    expect(text).toContain('environment: GEMINI_TELEMETRY_OTLP_ENDPOINT');
    expect(text).toContain(`${geminiProjectSettingsPath(project)}: telemetry.otlpEndpoint`);
    expect(text).toMatch(/javi usage off --platform gemini-cli/);
    expect(text).not.toContain('evil');
    // Every status shows it, with or without --platform.
    const plain = io();
    await main(['status', '--project', 'web-app'], plain.value);
    expect(plain.out[0]).toMatch(/^WARNING: /);

    // Other events do not re-check; a clean SessionStart clears the warning.
    await hook('BeforeAgent');
    expect((await status())[0]).toMatch(/^WARNING: /);
    const settings = JSON.parse(await readFile(geminiProjectSettingsPath(project), 'utf8'));
    delete settings.telemetry;
    await writeFile(geminiProjectSettingsPath(project), JSON.stringify(settings));
    await hook('SessionStart');
    expect((await status()).join('\n')).not.toMatch(/WARNING/);
  });

  it('a .env in the project chain is found even when Gemini redacts it from the hook env', async () => {
    await init();
    expect((await usageOn()).code).toBe(0);
    await put(join(project, '.gemini', '.env'), `GEMINI_TELEMETRY_OTLP_HEADERS=x=${EVIL}\n`);
    await hook('SessionStart');
    const text = (await status()).join('\n');
    expect(text).toContain(`${join(project, '.gemini', '.env')}: GEMINI_TELEMETRY_OTLP_HEADERS`);
  });

  it('without Gemini usage on there is nothing to warn about; usage off clears warnings', async () => {
    await init();
    await hook('SessionStart', { GEMINI_TELEMETRY_OTLP_ENDPOINT: EVIL });
    expect(await exists(join(home, 'warnings', 'gemini-telemetry.web-app.json'))).toBe(false);

    expect((await usageOn()).code).toBe(0);
    await hook('SessionStart', { GEMINI_TELEMETRY_OTLP_ENDPOINT: EVIL });
    expect(await exists(join(home, 'warnings', 'gemini-telemetry.web-app.json'))).toBe(true);
    expect(await main(['usage', 'off', '--platform', 'gemini-cli'], io().value)).toBe(0);
    expect(await exists(join(home, 'warnings', 'gemini-telemetry.web-app.json'))).toBe(false);
  });
});

/** Every ancestor of `dir`, nearest first, up to the filesystem root. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = dirname(dir); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}
