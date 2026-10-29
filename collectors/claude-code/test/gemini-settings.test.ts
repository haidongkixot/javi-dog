import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GEMINI_HOOK_EVENTS } from '@javis-dog/collector-adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GEMINI_HOOK_TIMEOUT_MS,
  HOOK_MARKER,
  geminiHookCommand,
  geminiHooksInstalled,
  geminiProjectSettingsPath,
  installGeminiHooks,
  uninstallGeminiHooks,
} from '../src/index.ts';

// S5b B1 (TEST_PLAN §S5b): `.gemini/settings.json` hooks — merge, marker, backup, uninstall,
// idempotency, refusal — against temp project dirs.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'javi-gemini-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NODE = '/usr/local/bin/node';
const CLI = "/home/dev/My Tools/it's javi/javi.mjs";
const TOKEN = `jd_it_${'G'.repeat(43)}`;
const path = () => geminiProjectSettingsPath(dir);
const load = async () => JSON.parse(await readFile(path(), 'utf8'));
const seed = async (value: unknown) => {
  await mkdir(join(dir, '.gemini'), { recursive: true });
  await writeFile(path(), typeof value === 'string' ? value : JSON.stringify(value, null, 4));
};

describe('geminiHookCommand', () => {
  it('quotes paths for bash and holds the platform, project and marker', () => {
    expect(geminiHookCommand(NODE, CLI, 'web-app', 'linux')).toBe(
      `/usr/local/bin/node '/home/dev/My Tools/it'\\''s javi/javi.mjs' hook --platform gemini-cli --project web-app --source ${HOOK_MARKER}`,
    );
  });

  it('uses the PowerShell call operator and single quotes on Windows', () => {
    expect(
      geminiHookCommand(
        'C:\\Program Files\\nodejs\\node.exe',
        "C:\\Users\\O'Neil\\.javi\\bin\\0.1.0\\javi.mjs",
        'web-app',
        'win32',
      ),
    ).toBe(
      `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\O''Neil\\.javi\\bin\\0.1.0\\javi.mjs' 'hook' '--platform' 'gemini-cli' '--project' 'web-app' '--source' '${HOOK_MARKER}'`,
    );
  });

  it('refuses paths Gemini would rewrite or a shell would split', () => {
    expect(() => geminiHookCommand(NODE, '/x/$GEMINI_PROJECT_DIR/javi.mjs', 'p')).toThrow(
      /\$GEMINI_/,
    );
    expect(() => geminiHookCommand(NODE, '/x/a\nb', 'p')).toThrow();
  });

  it('bash runs it with exactly the intended argv (real shell, path with space and quote)', async () => {
    const tools = join(dir, "My Tools/it's javi");
    await mkdir(tools, { recursive: true });
    const script = join(tools, 'argv.mjs');
    const out = join(dir, 'argv.json');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    execFileSync('bash', ['-c', geminiHookCommand(process.execPath, script, 'web-app', 'linux')]);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual([
      'hook',
      '--platform',
      'gemini-cli',
      '--project',
      'web-app',
      '--source',
      HOOK_MARKER,
    ]);
  });
});

describe('installGeminiHooks', () => {
  it('creates .gemini/settings.json with one marked hook per GEMINI_HOOK_EVENTS event, no token', async () => {
    const result = await installGeminiHooks(dir, NODE, CLI, 'web-app');
    expect(result).toEqual({ path: path(), backup: null, projectTelemetry: false });
    const s = await load();
    expect(Object.keys(s)).toEqual(['hooks']);
    expect(Object.keys(s.hooks).sort()).toEqual([...GEMINI_HOOK_EVENTS].sort());
    for (const event of GEMINI_HOOK_EVENTS) {
      expect(s.hooks[event]).toEqual([
        {
          hooks: [
            {
              name: HOOK_MARKER,
              type: 'command',
              command: geminiHookCommand(NODE, CLI, 'web-app'),
              timeout: GEMINI_HOOK_TIMEOUT_MS,
            },
          ],
        },
      ]);
    }
    expect(await readFile(path(), 'utf8')).not.toContain(TOKEN.slice(0, 6));
    expect(await geminiHooksInstalled(dir)).toBe(true);
  });

  it('merges with other keys and user hooks, backs the original up once, and is idempotent', async () => {
    const theirs = { name: 'security-check', type: 'command', command: 'echo theirs', timeout: 5 };
    const original = {
      model: { name: 'gemini-2.5-pro' },
      hooksConfig: { enabled: true },
      hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [theirs] }], PreCompress: [] },
    };
    await seed(original);
    const originalText = await readFile(path(), 'utf8');
    const first = await installGeminiHooks(dir, NODE, CLI, 'web-app');
    expect(first.backup).toBe(`${path()}.javi-backup`);
    expect(await readFile(first.backup!, 'utf8')).toBe(originalText);
    const afterFirst = await readFile(path(), 'utf8');

    await installGeminiHooks(dir, NODE, CLI, 'web-app');
    expect(await readFile(path(), 'utf8')).toBe(afterFirst); // idempotent
    // The backup is the user's original, not javi's first edit.
    expect(await readFile(first.backup!, 'utf8')).toBe(originalText);

    const s = await load();
    expect(s.model).toEqual(original.model);
    expect(s.hooksConfig).toEqual(original.hooksConfig);
    expect(s.hooks.PreCompress).toEqual([]);
    expect(s.hooks.BeforeTool).toHaveLength(2);
    expect(s.hooks.BeforeTool[0]).toEqual({ matcher: 'write_file', hooks: [theirs] });
  });

  it('a re-init for another project or javi path replaces only its own entries', async () => {
    await installGeminiHooks(dir, NODE, CLI, 'web-app');
    await installGeminiHooks(dir, NODE, '/opt/javi/0.2.0/javi.mjs', 'other-app');
    const s = await load();
    for (const event of GEMINI_HOOK_EVENTS) {
      expect(s.hooks[event]).toHaveLength(1);
      expect(s.hooks[event][0].hooks[0].command).toContain('--project other-app');
    }
  });

  it('keeps the file mode, and reports a project telemetry block', async () => {
    await seed({ telemetry: { enabled: false } });
    await chmod(path(), 0o640);
    const result = await installGeminiHooks(dir, NODE, CLI, 'web-app');
    expect(result.projectTelemetry).toBe(true);
    expect((await stat(path())).mode & 0o777).toBe(0o640);
    expect((await load()).telemetry).toEqual({ enabled: false });
  });

  it.each([
    ['comments (Gemini strips them; javi does not)', '{\n  // mine\n  "model": {}\n}'],
    ['invalid JSON', '{ "hooks": '],
    ['a JSON array', '[]'],
    ['hooks that are not an object', '{"hooks": []}'],
    ['an event that is not an array', '{"hooks": {"BeforeTool": {"x": 1}}}'],
  ])('refuses %s and leaves the file untouched', async (_name, text) => {
    await seed(text);
    await expect(installGeminiHooks(dir, NODE, CLI, 'web-app')).rejects.toThrow(
      /plain JSON object.*nothing was changed/,
    );
    expect(await readFile(path(), 'utf8')).toBe(text);
    await expect(stat(`${path()}.javi-backup`)).rejects.toThrow();
  });
});

describe('uninstallGeminiHooks', () => {
  it('removes only javi entries, drops events javi emptied, keeps everything else', async () => {
    const theirs = { type: 'command', command: 'echo theirs' };
    await seed({ hooks: { AfterAgent: [{ hooks: [theirs] }], PreCompress: [] }, ui: { x: 1 } });
    await installGeminiHooks(dir, NODE, CLI, 'web-app');
    expect(await uninstallGeminiHooks(dir)).toEqual({ path: path(), removed: true });
    expect(await load()).toEqual({
      hooks: { AfterAgent: [{ hooks: [theirs] }], PreCompress: [] },
      ui: { x: 1 },
    });
    expect(await geminiHooksInstalled(dir)).toBe(false);
  });

  it('drops the hooks key when only javi used it, and is a no-op the second time', async () => {
    await seed({ general: { vimMode: true } });
    await installGeminiHooks(dir, NODE, CLI, 'web-app');
    await uninstallGeminiHooks(dir);
    expect(await load()).toEqual({ general: { vimMode: true } });
    const text = await readFile(path(), 'utf8');
    expect(await uninstallGeminiHooks(dir)).toEqual({ path: path(), removed: false });
    expect(await readFile(path(), 'utf8')).toBe(text);
  });

  it('reports a missing file and refuses an unreadable one', async () => {
    expect(await uninstallGeminiHooks(dir)).toEqual({ path: path(), removed: false });
    await seed('{ nope');
    await expect(uninstallGeminiHooks(dir)).rejects.toThrow(/plain JSON object/);
    expect(await readFile(path(), 'utf8')).toBe('{ nope');
  });
});
