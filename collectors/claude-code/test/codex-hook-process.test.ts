import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexHookGroup, createState, installCodexLauncher } from '../src/index.ts';

// S5c B1 (TEST_PLAN §S5c, H4/H5): a Codex hook as a real process, the way Codex runs it: the
// hooks.json `command` string in a shell (`sh -c`), through the stable launcher, with the hook
// payload on stdin. It must exit 0 with empty stdout and stderr (Codex passes plain stdout to
// the model on SessionStart, and non-JSON stdout on Stop is an error) and reach javi with the
// right project and platform (the last-hook record `javi status` reads).
//
// This runs the real JD-C02 module. Until lane A's Codex adapter is merged, its functions
// throw "not implemented", which runHook swallows: the event is not spooled, but the process
// contract (silence, exit code, launcher wiring) is what this test checks.
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const TOKEN = `jd_it_${'P'.repeat(43)}`;
const BOUND_MS = 2_500;

let home: string;
let command: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-cx-proc-'));
  await createState(home).saveCredentials('web-app', {
    endpoint: 'http://127.0.0.1:9/never',
    token: TOKEN,
  });
  const launchers = await installCodexLauncher(home, process.execPath, CLI);
  command = codexHookGroup('SessionStart', launchers, 'web-app').hooks[0]!.command;
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 500));
  await rm(home, { recursive: true, force: true });
});

const runCommand = (stdin: string, extraEnv: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const started = performance.now();
    // No JAVI_HOME in the environment: the launcher pins it.
    const env = { ...process.env, ...extraEnv };
    delete env.JAVI_HOME;
    const child = spawn('/bin/sh', ['-c', command], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started) }),
    );
    child.stdin.end(stdin);
  });

describe.runIf(process.platform !== 'win32')('javi hook --platform codex-cli as a process', () => {
  it('is silent, exits 0 within the bound, and reaches javi with project and platform', async () => {
    const payload = {
      session_id: 'proc-session',
      hook_event_name: 'SessionStart',
      source: 'startup',
      cwd: '/home/sentinel/private-repo',
      transcript_path: '/home/sentinel/t.jsonl',
      model: 'gpt-5-codex',
      permission_mode: 'default',
    };
    const result = await runCommand(JSON.stringify(payload));
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(result.ms).toBeLessThan(BOUND_MS);
    const seen = JSON.parse(
      await readFile(join(home, 'last-hook', 'web-app.codex-cli.json'), 'utf8'),
    ) as { at: string };
    expect(Date.parse(seen.at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('stays silent and exits 0 on garbage input', async () => {
    const result = await runCommand('not json');
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('stays silent with NODE_USE_ENV_PROXY=1 (the launcher passes --no-warnings)', async () => {
    const result = await runCommand('{"session_id":"s","hook_event_name":"Stop"}', {
      NODE_USE_ENV_PROXY: '1',
    });
    expect(result).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });
});
