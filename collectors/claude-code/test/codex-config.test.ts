import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  codexBackupPath,
  codexConfigPath,
  codexEnvRisks,
  codexHome,
  codexOtelBlock,
  codexOtelTable,
  disableCodexOtel,
  enableCodexOtel,
  noProxyCoversLoopback,
  parseDotenv,
  readCodexApproval,
} from '../src/index.ts';

// S5c B1 (TEST_PLAN §S5c, ADR-0016 Changes C3, H1, H6, M3, M5): the marked `[otel]` block in
// `$CODEX_HOME/config.toml` and the environment checks, against a temp Codex home.

const SECRET = 'codex-secret-0123456789abcdef';
let home: string;
let path: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-cx-codex-'));
  path = codexConfigPath(home);
});
afterEach(async () => rm(home, { recursive: true, force: true }));

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe('codexHome', () => {
  it('JAVI_CODEX_HOME, then CODEX_HOME, then ~/.codex', () => {
    expect(codexHome({ JAVI_CODEX_HOME: '/t', CODEX_HOME: '/c' })).toBe('/t');
    expect(codexHome({ CODEX_HOME: '/c' })).toBe('/c');
    expect(codexHome({ CODEX_HOME: '' })).toMatch(/\.codex$/);
  });
});

describe('enableCodexOtel / disableCodexOtel (H6)', () => {
  const USER = `# my settings
model = "gpt-5-codex" # inline comment

[mcp_servers.docs]
command = "docs-mcp"
env = { DOCS_TOKEN = "mcp-token-not-javis" }
`;

  it('appends the marked block; the result parses and holds exactly javi otel table; comments kept', async () => {
    await writeFile(path, USER, { mode: 0o640 });
    await chmod(path, 0o640);
    const result = await enableCodexOtel({ path, port: 4319, secret: SECRET });
    expect(result).toMatchObject({ ok: true, separator: '\n', created: false });
    const text = await readFile(path, 'utf8');
    expect(text).toBe(`${USER}\n${codexOtelBlock(4319, SECRET)}`);
    expect(codexOtelBlock(4319, SECRET)).toBe(
      [
        CODEX_BLOCK_START,
        '[otel]',
        `exporter = { otlp-http = { endpoint = "http://127.0.0.1:4319/v1/logs/codex-cli", protocol = "json", headers = { Authorization = "Bearer ${SECRET}" } } }`,
        'log_user_prompt = false',
        'log_agent_responses = false',
        'log_guardian_assessments = false',
        'log_sse_deltas = false',
        CODEX_BLOCK_END,
        '',
      ].join('\n'),
    );
    const parsed = parse(text) as Record<string, unknown>;
    expect(parsed.otel).toEqual(codexOtelTable(4319, SECRET));
    expect(parsed).not.toHaveProperty('otel.metrics_exporter');
    expect(parsed.model).toBe('gpt-5-codex');
    expect((await stat(path)).mode & 0o777).toBe(0o640); // mode preserved
    // Backup: the original, 0600, without javi's secret.
    const backup = codexBackupPath(path);
    expect(await readFile(backup, 'utf8')).toBe(USER);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(result.ok && result.backup).toEqual({ path: backup, status: 'created' });

    // Codex itself adds hook approvals later; usage off removes exactly javi's block.
    const approvals =
      '\n[hooks.state."/p/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:abc"\n';
    await writeFile(path, `${text}${approvals}`);
    const off = await disableCodexOtel({
      path,
      block: codexOtelBlock(4319, SECRET),
      separator: '\n',
      created: false,
    });
    expect(off).toEqual({ path, outcome: 'removed', backupRemoved: backup });
    expect(await readFile(path, 'utf8')).toBe(`${USER}${approvals}`);
    expect(await exists(backup)).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it('a file without a final newline gets a blank line before the block, removed again exactly', async () => {
    await writeFile(path, 'model = "x"');
    const on = await enableCodexOtel({ path, port: 4320, secret: SECRET });
    expect(on).toMatchObject({ ok: true, separator: '\n\n' });
    expect(await readFile(path, 'utf8')).toBe(`model = "x"\n\n${codexOtelBlock(4320, SECRET)}`);
    await disableCodexOtel({
      path,
      block: codexOtelBlock(4320, SECRET),
      separator: '\n\n',
      created: false,
    });
    expect(await readFile(path, 'utf8')).toBe('model = "x"');
  });

  it('creates a missing file at 0600 and removes it again on usage off', async () => {
    const on = await enableCodexOtel({ path, port: 4319, secret: SECRET });
    expect(on).toMatchObject({ ok: true, created: true, backup: null, separator: '' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await exists(codexBackupPath(path))).toBe(false);
    const off = await disableCodexOtel({
      path,
      block: codexOtelBlock(4319, SECRET),
      separator: '',
      created: true,
    });
    expect(off.outcome).toBe('deleted');
    expect(await exists(path)).toBe(false);
  });

  it('refuses any existing otel setting (table, dotted key, inline, sub-table) by name only, untouched', async () => {
    const cases: Array<[string, string[]]> = [
      ['[otel]\nexporter = "none"\n', ['otel.exporter']],
      ['otel.environment = "dev"\n', ['otel.environment']],
      ['otel = { log_user_prompt = true }\n', ['otel.log_user_prompt']],
      [
        '[otel.exporter.otlp-http]\nendpoint = "https://collector.example/v1/logs"\n',
        ['otel.exporter'],
      ],
      ['"otel" = {}\n', ['otel']],
    ];
    for (const [text, keys] of cases) {
      await writeFile(path, text);
      const result = await enableCodexOtel({ path, port: 4319, secret: SECRET });
      expect(result).toEqual({ ok: false, reason: 'conflict', keys });
      expect(JSON.stringify(result)).not.toContain('collector.example');
      expect(await readFile(path, 'utf8')).toBe(text);
      expect(await exists(codexBackupPath(path))).toBe(false);
    }
  });

  it('refuses a file that does not parse, untouched', async () => {
    for (const text of ['model = \n', '[a]\nx = 1\n[a]\nx = 2\n', 'key = "unterminated\n']) {
      await writeFile(path, text);
      expect(await enableCodexOtel({ path, port: 4319, secret: SECRET })).toEqual({
        ok: false,
        reason: 'unparsable',
      });
      expect(await readFile(path, 'utf8')).toBe(text);
    }
  });

  it('re-run with a new port replaces the block in place; no backup of a file with javi block', async () => {
    await writeFile(path, USER);
    const first = await enableCodexOtel({ path, port: 4319, secret: SECRET });
    if (!first.ok) throw new Error('enable failed');
    await writeFile(path, `${await readFile(path, 'utf8')}\n[profiles.fast]\nmodel = "mini"\n`);
    await rm(codexBackupPath(path));
    const second = await enableCodexOtel({ path, port: 4400, secret: SECRET, previous: first });
    expect(second).toMatchObject({ ok: true, backup: { status: 'skipped' }, separator: '\n' });
    const text = await readFile(path, 'utf8');
    expect(text).toBe(
      `${USER}\n${codexOtelBlock(4400, SECRET)}\n[profiles.fast]\nmodel = "mini"\n`,
    );
    expect(await exists(codexBackupPath(path))).toBe(false);
  });

  it('a changed block is refused on usage on and left alone on usage off', async () => {
    await writeFile(path, USER);
    const first = await enableCodexOtel({ path, port: 4319, secret: SECRET });
    if (!first.ok) throw new Error('enable failed');
    const edited = (await readFile(path, 'utf8')).replace(
      'log_user_prompt = false',
      'log_user_prompt = true',
    );
    await writeFile(path, edited);
    expect(
      await enableCodexOtel({ path, port: 4319, secret: SECRET, previous: first }),
    ).toMatchObject({
      ok: false,
      reason: 'conflict',
    });
    expect(await disableCodexOtel(first)).toEqual({ path, outcome: 'changed' });
    expect(await readFile(path, 'utf8')).toBe(edited);
    // Block removed by the user: nothing to do.
    await writeFile(path, USER);
    expect(await disableCodexOtel(first)).toEqual({ path, outcome: 'absent' });
  });

  it('writes through a symlinked config.toml (dotfiles), keeping the link', async () => {
    const real = join(home, 'dotfiles-config.toml');
    await writeFile(real, USER);
    await symlink(real, path);
    expect(await enableCodexOtel({ path, port: 4319, secret: SECRET })).toMatchObject({ ok: true });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toContain(CODEX_BLOCK_START);
  });
});

describe('environment checks (H1, M5, H2)', () => {
  it('parses dotenv the way dotenvy reads it, dropping CODEX_* names', () => {
    const vars = parseDotenv(
      [
        'export HTTP_PROXY=http://proxy:3128 # comment',
        "NO_PROXY='localhost,127.0.0.1'",
        'ALL_PROXY="socks5://p\\"x"',
        'CODEX_HOME=/elsewhere',
        '# OTEL_EXPORTER_OTLP_HEADERS=commented',
        'EMPTY=',
      ].join('\n'),
    );
    expect(Object.fromEntries(vars)).toEqual({
      HTTP_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost,127.0.0.1',
      ALL_PROXY: 'socks5://p"x',
      EMPTY: '',
    });
  });

  it('NO_PROXY covers 127.0.0.1 only with *, the address or a CIDR holding it', () => {
    for (const v of ['*', '127.0.0.1', 'example.com, 127.0.0.1', '127.0.0.0/8', '0.0.0.0/0']) {
      expect(noProxyCoversLoopback(v)).toBe(true);
    }
    for (const v of [
      undefined,
      '',
      'localhost',
      'example.com',
      '10.0.0.0/8',
      '127.0.0.2',
      '127.1.0.0/16',
    ]) {
      expect(noProxyCoversLoopback(v)).toBe(false);
    }
  });

  it('finds uncovered proxies and header overrides in the shell and $CODEX_HOME/.env, names only', async () => {
    expect(await codexEnvRisks({ env: {}, home })).toEqual({
      proxy: [],
      headers: [],
      claudeHeader: false,
    });
    const env = {
      HTTPS_PROXY: 'http://user:pw@proxy:3128',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer theirs',
    };
    await writeFile(
      join(home, '.env'),
      'all_proxy=socks5://p:1\nOTEL_EXPORTER_OTLP_LOGS_HEADERS=x=y\n',
    );
    const risks = await codexEnvRisks({ env, home });
    expect(risks).toEqual({
      proxy: [
        { source: 'environment', keys: ['HTTPS_PROXY'] },
        { source: join(home, '.env'), keys: ['all_proxy'] },
      ],
      headers: [
        { source: 'environment', keys: ['OTEL_EXPORTER_OTLP_HEADERS'] },
        { source: join(home, '.env'), keys: ['OTEL_EXPORTER_OTLP_LOGS_HEADERS'] },
      ],
      claudeHeader: false,
    });
    expect(JSON.stringify(risks)).not.toMatch(/pw@|theirs|socks5/);
    // NO_PROXY for 127.0.0.1, from the shell or from .env (which wins), clears the proxy risk.
    expect((await codexEnvRisks({ env: { ...env, NO_PROXY: '127.0.0.1' }, home })).proxy).toEqual(
      [],
    );
    await writeFile(join(home, '.env'), 'HTTP_PROXY=http://p\nno_proxy=127.0.0.0/8\n');
    expect((await codexEnvRisks({ env, home })).proxy).toEqual([]);
    await writeFile(join(home, '.env'), 'NO_PROXY=localhost\n');
    expect((await codexEnvRisks({ env: { ...env, NO_PROXY: '127.0.0.1' }, home })).proxy).toEqual([
      { source: 'environment', keys: ['HTTPS_PROXY'] },
    ]);
  });

  it("detects javi's own Claude Code header value (compared in memory)", async () => {
    const mine = 'Authorization=Bearer javi-claude-secret';
    expect(
      (
        await codexEnvRisks({
          env: { OTEL_EXPORTER_OTLP_METRICS_HEADERS: mine },
          home,
          claudeHeader: mine,
        })
      ).claudeHeader,
    ).toBe(true);
    expect(
      (
        await codexEnvRisks({
          env: { OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'other' },
          home,
          claudeHeader: mine,
        })
      ).claudeHeader,
    ).toBe(false);
    expect(
      (await codexEnvRisks({ env: { OTEL_EXPORTER_OTLP_METRICS_HEADERS: mine }, home }))
        .claudeHeader,
    ).toBe(false);
  });
});

describe('readCodexApproval (M3), read-only', () => {
  const hooksPath = '/p/.codex/hooks.json';
  const positions = [
    { event: 'SessionStart', index: 0 },
    { event: 'Stop', index: 2 },
  ];
  it('tells untrusted, not approved and approved apart without writing', async () => {
    const read = () =>
      readCodexApproval({ configPath: path, projectDirs: ['/p'], hooksPath, positions });
    expect(await read()).toEqual({ kind: 'ok', trust: null, approved: 0, total: 2, disabled: 0 });
    const base = '[projects."/p"]\ntrust_level = "trusted"\n';
    await writeFile(
      path,
      `${base}[hooks.state."/p/.codex/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:1"\n`,
    );
    expect(await read()).toMatchObject({ trust: 'trusted', approved: 1, total: 2 });
    const all = `${base}[hooks.state."/p/.codex/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:1"\n[hooks.state."/p/.codex/hooks.json:stop:2:0"]\ntrusted_hash = "sha256:2"\nenabled = false\n`;
    await writeFile(path, all);
    expect(await read()).toEqual({
      kind: 'ok',
      trust: 'trusted',
      approved: 2,
      total: 2,
      disabled: 1,
    });
    expect(await readFile(path, 'utf8')).toBe(all);
    await writeFile(path, '[projects."/p"]\ntrust_level = "untrusted"\n');
    expect(await read()).toMatchObject({ trust: 'untrusted' });
    await writeFile(path, 'not toml =');
    expect(await read()).toEqual({ kind: 'unreadable' });
  });
});
