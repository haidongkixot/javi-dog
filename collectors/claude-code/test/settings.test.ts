import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOOK_EVENTS,
  HOOK_MARKER,
  installHooks,
  settingsPath,
  uninstallHooks,
} from '../src/index.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'javi-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'D:\\Claude Projects\\javi-dog\\collectors\\claude-code\\src\\cli.ts';
const load = async () => JSON.parse(await readFile(settingsPath(dir), 'utf8'));

describe('installHooks', () => {
  it('registers every event in exec form, async except SessionEnd', async () => {
    await installHooks(dir, NODE, CLI, 'web-app');
    const s = await load();
    expect(Object.keys(s.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    const pre = s.hooks.PreToolUse[0].hooks[0];
    expect(pre).toEqual({
      type: 'command',
      command: NODE,
      args: [CLI, 'hook', '--project', 'web-app', '--source', HOOK_MARKER],
      async: true,
    });
    expect(s.hooks.SessionEnd[0].hooks[0]).toMatchObject({ timeout: 5 });
    expect(s.hooks.SessionEnd[0].hooks[0].async).toBeUndefined();
    expect(s.hooks.Notification[0].matcher).toBe(
      'permission_prompt|idle_prompt|elicitation_dialog|agent_needs_input',
    );
  });

  it('keeps other settings and other hooks, and is idempotent', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const theirs = { type: 'command', command: 'echo theirs' };
    await writeFile(
      settingsPath(dir),
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [theirs] }] },
      }),
    );
    await installHooks(dir, NODE, CLI, 'web-app');
    await installHooks(dir, NODE, CLI, 'web-app');
    const s = await load();
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [theirs] });
  });

  it('refuses to overwrite a file it cannot parse', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(settingsPath(dir), '{ "hooks": ');
    await expect(installHooks(dir, NODE, CLI, 'web-app')).rejects.toThrow(/Cannot parse/);
    expect(await readFile(settingsPath(dir), 'utf8')).toBe('{ "hooks": ');
  });
});

describe('uninstallHooks', () => {
  it('removes only our entries', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const theirs = { type: 'command', command: 'echo theirs' };
    await writeFile(
      settingsPath(dir),
      JSON.stringify({ hooks: { Stop: [{ hooks: [theirs] }] }, model: 'x' }),
    );
    await installHooks(dir, NODE, CLI, 'web-app');
    expect(await uninstallHooks(dir)).toMatchObject({ removed: true });
    expect(await load()).toEqual({ hooks: { Stop: [{ hooks: [theirs] }] }, model: 'x' });
  });
});
