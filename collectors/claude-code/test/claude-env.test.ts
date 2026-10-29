import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  USAGE_ENV_KEYS,
  claudeUserSettingsPath,
  disableUsageEnv,
  enableUsageEnv,
  usageEnv,
} from '../src/claude-env.ts';

// Every test works in a fresh temp "home"; the real ~/.claude is never touched.
let home: string;
let path: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-claude-env-'));
  path = claudeUserSettingsPath(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const SECRET = 'sEcReT_0123456789-abc';
const PORT = 4319;
const ours = usageEnv(PORT, SECRET);
const backupPath = () => `${path}.javi-backup`;
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const load = async () => JSON.parse(await readFile(path, 'utf8'));
const seed = async (text: string) => {
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(path, text);
};
const enable = (extra: Partial<Parameters<typeof enableUsageEnv>[0]> = {}) =>
  enableUsageEnv({ path, port: PORT, secret: SECRET, shellEnv: {}, ...extra });

describe('claudeUserSettingsPath', () => {
  it('is <home>/.claude/settings.json', () => {
    expect(claudeUserSettingsPath('/h')).toBe(join('/h', '.claude', 'settings.json'));
  });
});

describe('usageEnv', () => {
  it('returns exactly the six managed keys', () => {
    expect(Object.keys(ours).sort()).toEqual([...USAGE_ENV_KEYS].sort());
    expect(ours).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:4319/v1/metrics',
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: `Authorization=Bearer ${SECRET}`,
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
    });
  });

  it('accepts the port bounds', () => {
    expect(usageEnv(1024, SECRET).OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toContain(':1024/');
    expect(usageEnv(65535, SECRET).OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toContain(':65535/');
  });

  it.each([0, 80, 1023, 65536, 4319.5, Number.NaN])('rejects port %s', (port) => {
    expect(() => usageEnv(port, SECRET)).toThrow(RangeError);
  });

  it.each(['short', 'a'.repeat(15), 'a'.repeat(129), 'has space 0123456', 'semi;colon012345', ''])(
    'rejects secret %j',
    (secret) => {
      expect(() => usageEnv(PORT, secret)).toThrow(RangeError);
    },
  );

  it('accepts 16 and 128 character secrets', () => {
    expect(() => usageEnv(PORT, 'a'.repeat(16))).not.toThrow();
    expect(() => usageEnv(PORT, 'a'.repeat(128))).not.toThrow();
  });

  it('enableUsageEnv rejects invalid input before touching the file', async () => {
    await expect(enable({ port: 80 })).rejects.toThrow(RangeError);
    await expect(enable({ secret: 'nope' })).rejects.toThrow(RangeError);
    expect(await exists(path)).toBe(false);
  });
});

describe('enableUsageEnv', () => {
  it('creates the file (no backup) when it does not exist', async () => {
    const r = await enable();
    expect(r).toEqual({ ok: true, path, backup: null, written: ours });
    expect(await load()).toEqual({ env: ours });
    expect(await exists(backupPath())).toBe(false);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, '.claude'))).mode & 0o777).toBe(0o700);
    }
  });

  it('merges into env, keeping other keys, their order and other env keys', async () => {
    const original = {
      model: 'opus',
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls)'] },
    };
    await seed(JSON.stringify(original));
    const r = await enable();
    expect(r.ok).toBe(true);
    const s = await load();
    expect(Object.keys(s)).toEqual(['model', 'env', 'permissions']);
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.env).toEqual({ FOO: 'bar', ...ours });
  });

  it('backs the original bytes up once, mode 0600', async () => {
    const original = '{ "model": "opus" ,\n  "env": {} }\n';
    await seed(original);
    const first = await enable();
    expect(first).toMatchObject({ ok: true, backup: { path: backupPath(), status: 'created' } });
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
    if (process.platform !== 'win32') {
      expect((await stat(backupPath())).mode & 0o777).toBe(0o600);
    }

    // A second enable (new port) keeps the first backup: the file now holds javi's keys.
    const second = await enable({ port: 5000, previous: ours });
    expect(second).toMatchObject({ ok: true, backup: { path: backupPath(), status: 'skipped' } });
    expect(await readFile(backupPath(), 'utf8')).toBe(original);
    expect((await load()).env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      'http://127.0.0.1:5000/v1/metrics',
    );
  });

  it('is idempotent with the same port/secret and previous = last written', async () => {
    await seed('{"env":{"FOO":"bar"}}');
    const first = await enable();
    if (!first.ok) throw new Error('first enable refused');
    const afterFirst = await readFile(path, 'utf8');
    const second = await enable({ previous: first.written });
    expect(second).toEqual({
      ok: true,
      path,
      backup: { path: backupPath(), status: 'skipped' },
      written: ours,
    });
    expect(await readFile(path, 'utf8')).toBe(afterFirst);
  });

  it('never backs up a file that holds javi’s own keys and secret (R7 twin)', async () => {
    // usage on created the file; a second usage on must not copy javi's secret into a backup.
    expect(await enable()).toMatchObject({ ok: true, backup: null });
    const second = await enable({ port: 5000, previous: ours });
    expect(second).toMatchObject({ ok: true, backup: { path: backupPath(), status: 'skipped' } });
    expect(await exists(backupPath())).toBe(false);
    // Other edits since do not make javi's keys worth a backup either.
    const s = await load();
    await writeFile(path, JSON.stringify({ ...s, model: 'opus' }));
    expect(await enable({ previous: usageEnv(5000, SECRET) })).toMatchObject({ ok: true });
    expect(await exists(backupPath())).toBe(false);
  });

  it('reports an earlier backup it kept, which is not a copy of the file before this change', async () => {
    // A backup left from an earlier usage on whose keys the user had partly edited.
    await seed('{"model":"sonnet"}');
    await writeFile(backupPath(), '{"model":"opus"}');
    const again = await enable();
    expect(again).toMatchObject({ ok: true, backup: { path: backupPath(), status: 'kept' } });
    expect(await readFile(backupPath(), 'utf8')).toBe('{"model":"opus"}');
  });

  describe('refusals leave the file byte-identical and write no backup', () => {
    const refuses = async (
      text: string,
      expected: { reason: string; keys?: string[] },
      extra: Partial<Parameters<typeof enableUsageEnv>[0]> = {},
    ) => {
      await seed(text);
      const r = await enable(extra);
      expect(r).toEqual({ ok: false, ...expected });
      expect(await readFile(path, 'utf8')).toBe(text);
      expect(await exists(backupPath())).toBe(false);
    };

    it('unparsable JSON', () => refuses('{ "env": { ', { reason: 'unparsable' }));

    it.each(['[]', 'null', '"text"', '42'])('top level %s is not an object', (text) =>
      refuses(text, { reason: 'not_object' }),
    );

    it.each(['[]', '"x"', 'null'])('env %s is not an object', (env) =>
      refuses(`{"env":${env}}`, { reason: 'not_object' }),
    );

    it('a managed key already set in the file without previous', () =>
      refuses('{"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"1"}}', {
        reason: 'conflict',
        keys: ['CLAUDE_CODE_ENABLE_TELEMETRY'],
      }));

    it('a foreign OTEL_EXPORTER_OTLP_ENDPOINT in the file', () =>
      refuses(
        '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"https://collector.example:4318","FOO":"1"}}',
        { reason: 'conflict', keys: ['OTEL_EXPORTER_OTLP_ENDPOINT'] },
        { previous: ours },
      ));

    it('a managed key the user changed since javi wrote it', () =>
      refuses(
        JSON.stringify({ env: { ...ours, OTEL_METRICS_EXPORTER: 'console' } }),
        { reason: 'conflict', keys: ['OTEL_METRICS_EXPORTER'] },
        { previous: ours },
      ));

    it('telemetry keys set in the shell, reported sorted and deduplicated', () =>
      refuses(
        '{"env":{"OTEL_SERVICE_NAME":"mine"}}',
        {
          reason: 'conflict',
          keys: ['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_LOGS_EXPORTER', 'OTEL_SERVICE_NAME'],
        },
        {
          shellEnv: {
            OTEL_SERVICE_NAME: 'other',
            OTEL_LOGS_EXPORTER: 'otlp',
            CLAUDE_CODE_ENABLE_TELEMETRY: 'yes',
            PATH: '/usr/bin',
          },
        },
      ));

    it('a shell value matching neither previous nor the new value', () =>
      refuses(
        '{}',
        { reason: 'conflict', keys: ['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] },
        { shellEnv: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:4318/v1/metrics' } },
      ));
  });

  it('refuses on a shell conflict even when the file is missing, creating nothing', async () => {
    const r = await enable({ shellEnv: { OTEL_METRICS_EXPORTER: 'prometheus' } });
    expect(r).toEqual({ ok: false, reason: 'conflict', keys: ['OTEL_METRICS_EXPORTER'] });
    expect(await exists(join(home, '.claude'))).toBe(false);
  });

  it('allows shell values equal to the new values (session started with our env)', async () => {
    const r = await enable({ shellEnv: { ...ours, HOME: home } });
    expect(r.ok).toBe(true);
  });

  it('allows shell values equal to previous, and ignores empty shell values', async () => {
    const previous = usageEnv(5000, SECRET);
    await seed(JSON.stringify({ env: previous }));
    const r = await enable({
      previous,
      shellEnv: { ...previous, OTEL_RESOURCE_ATTRIBUTES: '', OTEL_LOGS_EXPORTER: undefined },
    });
    expect(r.ok).toBe(true);
    expect((await load()).env).toEqual(ours);
  });
});

describe('disableUsageEnv', () => {
  it('missing file: nothing removed, nothing created', async () => {
    expect(await disableUsageEnv({ path, written: ours })).toEqual({ path, removed: [] });
    expect(await exists(path)).toBe(false);
  });

  // S3e review #1: an unreadable file must be signalled, so `usage off` does not claim success.
  it.each(['{ nope', '[]', '"text"', '{"env":[]}', '{"env":null}', '{"env":"x"}'])(
    'unreadable file %s: left untouched and reported as unreadable',
    async (text) => {
      await seed(text);
      expect(await disableUsageEnv({ path, written: ours })).toEqual({
        path,
        removed: [],
        unreadable: true,
      });
      expect(await readFile(path, 'utf8')).toBe(text);
    },
  );

  it('removes only unchanged own keys and keeps everything else', async () => {
    await seed('{"model":"opus","env":{"FOO":"bar"},"theme":"dark"}');
    const r = await enable();
    expect(r.ok).toBe(true);
    const s = await load();
    s.env.OTEL_METRICS_EXPORTER = 'console'; // user changed this one after enabling
    await writeFile(path, JSON.stringify(s));

    const out = await disableUsageEnv({ path, written: ours });
    expect(out.removed.sort()).toEqual(
      USAGE_ENV_KEYS.filter((k) => k !== 'OTEL_METRICS_EXPORTER').sort(),
    );
    const after = await load();
    expect(Object.keys(after)).toEqual(['model', 'env', 'theme']);
    expect(after.env).toEqual({ FOO: 'bar', OTEL_METRICS_EXPORTER: 'console' });
    // Not fully restored (a javi key is still there): the backup is kept.
    expect(await exists(backupPath())).toBe(true);
    expect(out).not.toHaveProperty('backupRemoved');
  });

  it('deletes env when it becomes empty; a full restore removes the backup (R7 twin)', async () => {
    await seed('{"model":"opus"}');
    await enable();
    expect(await exists(backupPath())).toBe(true);
    const out = await disableUsageEnv({ path, written: ours });
    expect(out.removed.sort()).toEqual([...USAGE_ENV_KEYS].sort());
    expect(out.backupRemoved).toBe(backupPath());
    expect(await load()).toEqual({ model: 'opus' });
    expect(await exists(backupPath())).toBe(false);
  });

  it('does not write when nothing matches', async () => {
    const text = '{"env":{"OTEL_METRICS_EXPORTER":"console"}}';
    await seed(text);
    const before = (await stat(path)).mtimeMs;
    expect(await disableUsageEnv({ path, written: ours })).toEqual({ path, removed: [] });
    expect(await readFile(path, 'utf8')).toBe(text);
    expect((await stat(path)).mtimeMs).toBe(before);
  });

  it('enable → disable round-trips a missing file to an empty object', async () => {
    await enable();
    await disableUsageEnv({ path, written: ours });
    expect(await load()).toEqual({});
  });
});

// S3e review #4: a dotfiles symlink stays a symlink; javi writes the file it points to.
describe('symlinked settings', () => {
  it('enable and disable write the target and keep the link; the backup sits next to the link', async () => {
    const dotfile = join(home, 'dotfiles', 'claude-settings.json');
    await mkdir(join(home, 'dotfiles'), { recursive: true });
    await writeFile(dotfile, '{"model":"opus"}\n');
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(dotfile, path);

    const r = await enable();
    expect(r).toMatchObject({ ok: true, path, backup: { path: backupPath(), status: 'created' } });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(dotfile, 'utf8'))).toEqual({ model: 'opus', env: ours });
    expect(await readFile(backupPath(), 'utf8')).toBe('{"model":"opus"}\n');
    expect((await lstat(backupPath())).isSymbolicLink()).toBe(false);

    const off = await disableUsageEnv({ path, written: ours });
    expect(off.removed.sort()).toEqual([...USAGE_ENV_KEYS].sort());
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(dotfile, 'utf8'))).toEqual({ model: 'opus' });
    // No temp file is left in either directory.
    expect((await readdir(join(home, 'dotfiles'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(join(home, '.claude'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
