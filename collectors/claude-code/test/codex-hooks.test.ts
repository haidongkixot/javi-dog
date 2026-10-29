import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_HOOK_EVENTS } from '@javis-dog/collector-adapters';
import {
  codexHookGroup,
  codexHooksPath,
  codexHooksTracked,
  codexJaviGroups,
  codexLauncherPaths,
  codexLauncherScripts,
  codexProjectConfigHasHooks,
  installCodexHooks,
  installCodexLauncher,
  probeShellOutput,
  uninstallCodexHooks,
  unsafeLauncherPath,
} from '../src/index.ts';

// S5c B1 (TEST_PLAN §S5c, ADR-0016 Changes C1, H4, H5, M3): the stable launcher and the
// append-only `.codex/hooks.json` edit, against temp dirs.

let home: string;
let project: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-cx-home-'));
  project = await mkdtemp(join(tmpdir(), 'javi-cx-project-'));
});
afterEach(async () => {
  for (const dir of [home, project]) await rm(dir, { recursive: true, force: true });
});

/** Launcher scripts, modes and `sh` are POSIX; CI runs on Linux (Windows: UNVERIFIED, ADR-0016). */
const POSIX = process.platform !== 'win32';
const LAUNCHERS = { posix: '/h/.javi/bin/javi-hook', windows: 'C:\\h\\.javi\\bin\\javi-hook.cmd' };
const ARGS = '--platform codex-cli --project web-app --source javi-collector';

describe('launcher (H4)', () => {
  it.runIf(POSIX)(
    'writes an executable POSIX launcher and a .cmd twin that run javi hook with the arguments',
    async () => {
      const paths = await installCodexLauncher(
        home,
        '/usr/bin/node',
        '/opt/javi/javi.mjs',
        'linux',
      );
      expect(paths).toEqual(codexLauncherPaths(home, 'linux'));
      expect(paths.posix).toBe(join(home, 'bin', 'javi-hook'));
      const posix = await readFile(paths.posix, 'utf8');
      expect(posix).toBe(
        [
          '#!/bin/sh',
          '# Written by javi init --platform codex-cli; Codex hooks run this file.',
          `JAVI_HOME='${home}'`,
          'export JAVI_HOME',
          `exec '/usr/bin/node' --no-warnings '/opt/javi/javi.mjs' hook "$@"`,
          '',
        ].join('\n'),
      );
      expect((await stat(paths.posix)).mode & 0o777).toBe(0o755);
      const cmd = await readFile(paths.windows, 'utf8');
      expect(cmd).toBe(
        [
          '@echo off',
          'rem Written by javi init --platform codex-cli; Codex hooks run this file.',
          'setlocal',
          `set "JAVI_HOME=${home}"`,
          '"/usr/bin/node" --no-warnings "/opt/javi/javi.mjs" hook %*',
          '',
        ].join('\r\n'),
      );
    },
  );

  it('quotes awkward node/javi paths inside the scripts (they are not in the hook command)', () => {
    const s = codexLauncherScripts("/opt/it's node/node", '/opt/50% off/javi.mjs', '/h');
    expect(s.posix).toContain(
      `exec '/opt/it'\\''s node/node' --no-warnings '/opt/50% off/javi.mjs' hook "$@"`,
    );
    expect(s.windows).toContain(
      `"/opt/it's node/node" --no-warnings "/opt/50%% off/javi.mjs" hook %*`,
    );
    expect(() => codexLauncherScripts('/opt/no\nde', '/j', '/h')).toThrow(/line break/);
  });

  it.runIf(POSIX)('runs: arguments arrive unchanged after "hook"', async () => {
    const echo = join(home, 'echo-args.mjs');
    await writeFile(
      echo,
      'process.stdout.write(JSON.stringify([process.env.JAVI_HOME, ...process.argv.slice(2)]))',
    );
    const { posix } = await installCodexLauncher(home, process.execPath, echo);
    const out = execFileSync('/bin/sh', ['-c', `${posix} ${ARGS}`], { encoding: 'utf8', env: {} });
    expect(JSON.parse(out)).toEqual([home, 'hook', ...ARGS.split(' ')]);
  });

  it.runIf(POSIX)(
    'refuses a launcher path with spaces or shell metacharacters, naming it and writing nothing',
    async () => {
      for (const bad of ['with space', 'semi;colon', 'dollar$x', 'quote"q', 'amp&', 'paren(']) {
        const dir = join(home, bad);
        await expect(installCodexLauncher(dir, '/usr/bin/node', '/j.mjs', 'linux')).rejects.toThrow(
          `launcher path ${join(dir, 'bin', 'javi-hook')} has spaces or shell metacharacters`,
        );
        await expect(stat(join(dir, 'bin'))).rejects.toThrow();
      }
      expect(unsafeLauncherPath('/home/a.b_c-d/.javi/bin/javi-hook', 'linux')).toBeNull();
      expect(unsafeLauncherPath('C:\\Users\\ab\\.javi\\bin\\javi-hook.cmd', 'win32')).toBeNull();
      expect(
        unsafeLauncherPath('C:\\Users\\a b\\.javi\\bin\\javi-hook.cmd', 'win32'),
      ).not.toBeNull();
      for (const ch of ['&', '|', '<', '>', '^', '%', '!', '"', "'"]) {
        expect(unsafeLauncherPath(`C:\\Users\\a${ch}b\\javi-hook.cmd`, 'win32')).not.toBeNull();
      }
      expect(unsafeLauncherPath('/home/a:b/javi-hook', 'linux')).not.toBeNull();
    },
  );

  it('re-init rewrites only the launcher (atomically, same path)', async () => {
    const first = await installCodexLauncher(home, '/usr/bin/node', '/opt/javi/0.1.0/javi.mjs');
    const second = await installCodexLauncher(home, '/usr/bin/node', '/opt/javi/0.2.0/javi.mjs');
    expect(second).toEqual(first);
    expect(await readFile(first.posix, 'utf8')).toContain('/opt/javi/0.2.0/javi.mjs');
  });
});

describe('.codex/hooks.json (C1, M3)', () => {
  const path = () => codexHooksPath(project);
  const seed = async (text: string) => {
    await mkdir(join(project, '.codex'), { recursive: true });
    await writeFile(path(), text);
  };
  const read = async () => JSON.parse(await readFile(path(), 'utf8'));

  it('creates the file with one group per event; timeouts in seconds, SessionEnd 3', async () => {
    const result = await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect(result.appended).toEqual([...CODEX_HOOK_EVENTS]);
    const file = await read();
    expect(Object.keys(file.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    for (const event of CODEX_HOOK_EVENTS) {
      expect(file.hooks[event]).toEqual([
        {
          hooks: [
            {
              type: 'command',
              command: `${LAUNCHERS.posix} ${ARGS}`,
              commandWindows: `${LAUNCHERS.windows} ${ARGS}`,
              timeout: event === 'SessionEnd' ? 3 : 5,
            },
          ],
        },
      ]);
    }
    expect(JSON.stringify(file)).not.toMatch(/trusted_hash|"state"/);
  });

  it("appends after the user's groups, keeps their order and their bytes, and is idempotent", async () => {
    const user = `{
    "description": "team hooks",
    "hooks": {
        "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ],
        "PreToolUse": [
            { "matcher": "Bash", "hooks": [ { "type": "command", "command": "audit.sh", "timeout": 30 } ] },
            { "matcher": "Edit", "hooks": [ { "type": "command", "command": "lint.sh" } ] }
        ],
        "PreCompact": []
    }
}
`;
    await seed(user);
    await installCodexHooks(project, LAUNCHERS, 'web-app');
    const text = await readFile(path(), 'utf8');
    // Every byte of the user's groups is still there, in the same order.
    const groups = [
      '{ "hooks": [ { "type": "command", "command": "say done" } ] }',
      '{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "audit.sh", "timeout": 30 } ] },\n            { "matcher": "Edit", "hooks": [ { "type": "command", "command": "lint.sh" } ] }',
      '"description": "team hooks",',
      '"PreCompact": []',
    ];
    for (const group of groups) expect(text).toContain(group);
    expect(text.indexOf('audit.sh')).toBeLessThan(text.indexOf('lint.sh'));
    const file = await read();
    expect(file.description).toBe('team hooks');
    expect(file.hooks.PreCompact).toEqual([]);
    expect(file.hooks.PreToolUse.map((g: { matcher?: string }) => g.matcher)).toEqual([
      'Bash',
      'Edit',
      undefined,
    ]);
    expect(file.hooks.Stop[0].hooks[0].command).toBe('say done');
    expect(file.hooks.Stop[1]).toEqual(codexHookGroup('Stop', LAUNCHERS, 'web-app'));
    expect(await codexJaviGroups(project, 'web-app')).toEqual(
      expect.arrayContaining([
        { event: 'PreToolUse', index: 2 },
        { event: 'Stop', index: 1 },
        { event: 'SessionStart', index: 0 },
      ]),
    );

    const again = await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect(again.appended).toEqual([]);
    expect(again.kept).toEqual([...CODEX_HOOK_EVENTS]);
    expect(await readFile(path(), 'utf8')).toBe(text); // not moved, not duplicated, not rewritten
  });

  it('a changed command is updated in place (same position), never moved to the end', async () => {
    await seed(
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }),
    );
    await installCodexHooks(project, LAUNCHERS, 'web-app');
    const user2 = { hooks: [{ type: 'command', command: 'added later' }] };
    const file = await read();
    file.hooks.Stop.push(user2); // the user adds a group after javi's
    await writeFile(path(), JSON.stringify(file, null, 2));
    const result = await installCodexHooks(project, LAUNCHERS, 'other-slug');
    expect(result.updated).toContain('Stop');
    const after = await read();
    expect(after.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'x' }] },
      codexHookGroup('Stop', LAUNCHERS, 'other-slug'),
      user2,
    ]);
  });

  it('refuses a file that does not parse, or has another shape, and leaves it untouched', async () => {
    for (const text of [
      '{ "hooks": { // comment\n } }',
      '[]',
      '{"hooks": []}',
      '{"hooks": {"Stop": {}}}',
    ]) {
      await seed(text);
      await expect(installCodexHooks(project, LAUNCHERS, 'web-app')).rejects.toThrow(
        /Cannot read .*hooks\.json as Codex hooks.*nothing was changed/,
      );
      expect(await readFile(path(), 'utf8')).toBe(text);
    }
  });

  it("uninstall removes only javi's groups and reports the user's groups that change position", async () => {
    await seed(
      JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine-1' }] }] } },
        null,
        2,
      ),
    );
    await installCodexHooks(project, LAUNCHERS, 'web-app');
    const file = await read();
    file.hooks.Stop.push(
      { hooks: [{ type: 'command', command: 'mine-2' }] },
      { hooks: [{ type: 'command', command: 'mine-3' }] },
    );
    file.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'mine-4' }] });
    await writeFile(path(), `${JSON.stringify(file, null, 2)}\n`);

    const result = await uninstallCodexHooks(project);
    expect(result.removed).toBe(CODEX_HOOK_EVENTS.length);
    expect([...result.shifts].sort((a, b) => a.event.localeCompare(b.event))).toEqual([
      { event: 'PreToolUse', groups: 1 },
      { event: 'Stop', groups: 2 },
    ]);
    expect(await read()).toEqual({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'mine-1' }] },
          { hooks: [{ type: 'command', command: 'mine-2' }] },
          { hooks: [{ type: 'command', command: 'mine-3' }] },
        ],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'mine-4' }] }],
      },
    });
    expect(await codexJaviGroups(project)).toEqual([]);
  });

  it('uninstall restores the original bytes when the user changed nothing; removes a file javi created', async () => {
    const user =
      '{\n  "hooks": {\n    "Stop": [\n      { "hooks": [ { "type": "command", "command": "mine" } ] }\n    ]\n  }\n}\n';
    await seed(user);
    await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect((await uninstallCodexHooks(project)).shifts).toEqual([]);
    expect(await readFile(path(), 'utf8')).toBe(user);

    await rm(path());
    const created = await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect(created.origin).toEqual({ created: true, events: [], hooksKey: false });
    expect(await uninstallCodexHooks(project, created.origin)).toMatchObject({ deleted: true });
    await expect(stat(path())).rejects.toThrow();
    expect(await uninstallCodexHooks(project)).toMatchObject({ removed: 0 });
  });

  it("uninstall never deletes a hooks.json javi did not create; the user's empty events stay (review L5)", async () => {
    const user = '{ "hooks": { "Stop": [] } }\n';
    await seed(user);
    const first = await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect(first.origin).toEqual({ created: false, events: ['Stop'], hooksKey: true });
    // Re-init keeps the record of what was the user's.
    const again = await installCodexHooks(project, LAUNCHERS, 'web-app', first.origin);
    expect(again.origin).toEqual(first.origin);
    expect(await uninstallCodexHooks(project, first.origin)).toMatchObject({
      removed: CODEX_HOOK_EVENTS.length,
      deleted: false,
    });
    expect(await readFile(path(), 'utf8')).toBe(user);

    // Without a record (lost state), javi treats the file as the user's: it is never deleted.
    await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect(await uninstallCodexHooks(project)).toMatchObject({ deleted: false });
    expect(await read()).toEqual({ hooks: {} });

    // A file javi created that the user then added to keeps the user's part.
    await rm(path());
    const mine = await installCodexHooks(project, LAUNCHERS, 'web-app');
    const file = await read();
    file.x = 1;
    await writeFile(path(), `${JSON.stringify(file, null, 2)}\n`);
    expect(await uninstallCodexHooks(project, mine.origin)).toMatchObject({ deleted: false });
    expect(await read()).toEqual({ x: 1 });
  });
});

describe('init warnings (H5, Low)', () => {
  it('finds a tracked hooks.json and a [hooks] table in the project config.toml', async () => {
    expect(codexHooksTracked(project)).toBe(false);
    execFileSync('git', ['init', '-q', project]);
    await installCodexHooks(project, LAUNCHERS, 'web-app');
    expect(codexHooksTracked(project)).toBe(false);
    execFileSync('git', ['-C', project, 'add', '.codex/hooks.json']);
    expect(codexHooksTracked(project)).toBe(true);

    expect(await codexProjectConfigHasHooks(project)).toBe(false);
    await writeFile(join(project, '.codex', 'config.toml'), 'model = "x"\n');
    expect(await codexProjectConfigHasHooks(project)).toBe(false);
    await writeFile(join(project, '.codex', 'config.toml'), '[[hooks.Stop]]\nmatcher = "x"\n');
    expect(await codexProjectConfigHasHooks(project)).toBe(true);
    await writeFile(join(project, '.codex', 'config.toml'), '[hooks]\nbroken = \n');
    expect(await codexProjectConfigHasHooks(project)).toBe(true);
  });

  it.runIf(POSIX)(
    'reports shells that print at startup (stdout or stderr) or hang, without their output',
    async () => {
      const script = async (name: string, body: string) => {
        const file = join(home, name);
        await writeFile(file, `#!/bin/sh\n${body}\n`);
        await chmod(file, 0o755);
        return file;
      };
      const quiet = await script('quiet.sh', 'exit 0');
      expect(probeShellOutput({ SHELL: quiet }, project, 'linux')).toEqual([]);
      const loud = await script(
        'loud.sh',
        'case "$1" in -lc) echo "welcome SECRETVALUE";; esac\nexit 0',
      );
      const found = probeShellOutput({ SHELL: loud }, project, 'linux');
      expect(found).toEqual([{ command: `${loud} -lc true`, problem: 'stdout' }]);
      expect(JSON.stringify(found)).not.toContain('SECRETVALUE');
      const noisy = await script('noisy.sh', 'echo warn >&2\nexit 0');
      expect(probeShellOutput({ SHELL: noisy }, project, 'linux').map((f) => f.problem)).toEqual([
        'stderr',
        'stderr',
      ]);
      const slow = await script('slow.sh', 'sleep 5');
      expect(probeShellOutput({ SHELL: slow }, project, 'linux').map((f) => f.problem)).toEqual([
        'timeout',
        'timeout',
      ]);
      expect(probeShellOutput({ SHELL: loud }, project, 'win32')).toEqual([]);
    },
    15_000,
  );
});
