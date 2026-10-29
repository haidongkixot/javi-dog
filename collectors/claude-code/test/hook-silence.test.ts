import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { geminiHookCommand } from '../src/gemini-settings.ts';
import { hookEntry } from '../src/settings.ts';

// S5a e2e finding: with NODE_USE_ENV_PROXY=1 (proxy users), Node prints an experimental
// warning on stderr at startup, before javi's code runs. Hooks must stay silent (Gemini shows
// hook stderr), so every registered hook command starts Node with --no-warnings.
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const exec = (event: string) =>
  (hookEntry(event, process.execPath, CLI, 'web-app').hooks ?? [])[0] as unknown as {
    command: string;
    args: string[];
  };

describe('registered hook commands stay silent under Node warnings', () => {
  it('Claude Code hook args start with --no-warnings', () => {
    const hook = exec('Stop');
    expect(hook.args[0]).toBe('--no-warnings');
    expect(hook.args[1]).toBe(CLI);
  });

  it('Gemini CLI hook command passes --no-warnings to Node', () => {
    const command = geminiHookCommand('/usr/bin/node', '/opt/javi.mjs', 'web-app', 'linux');
    expect(command.startsWith('/usr/bin/node --no-warnings /opt/javi.mjs hook')).toBe(true);
  });

  it('the registered Claude Code hook prints nothing with NODE_USE_ENV_PROXY=1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'javi-silence-'));
    try {
      const hook = exec('SessionStart');
      const result = spawnSync(hook.command, hook.args, {
        input: '{"session_id":"s","hook_event_name":"SessionStart"}',
        env: { ...process.env, JAVI_HOME: home, NODE_USE_ENV_PROXY: '1' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
