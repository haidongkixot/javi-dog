import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { childEnv } from './child-env.ts';
import { writeTarget } from './claude-env.ts';
import { jsonEqual } from './gemini-telemetry.ts';
import { writeTextAtomic } from './state.ts';

// Codex CLI user configuration (ADR-0016 Changes "S5c design" C3 and "S5c design review" H1,
// H2, H6, M3, M5). javi appends one marked `[otel]` block to `$CODEX_HOME/config.toml` (logs
// exporter only, prompt/response/assessment/SSE-delta logging off) and removes exactly that
// block again. It never takes over an existing `otel` setting, never edits a file that does
// not parse, and never writes `[hooks.state]` (hook approval is the user's decision in Codex).
//
// Sources (openai/codex at fa4ebe8, S5c research): `utils/home-dir` (CODEX_HOME, else
// ~/.codex), `arg0/src/lib.rs` (`$CODEX_HOME/.env` is loaded over the process env, `CODEX_*`
// names filtered), `config/src/types.rs` (`OtelConfigToml`), `hooks/src/lib.rs` `hook_key`
// (`<hooks.json path>:<event label>:<group>:<handler>`), `config/src/project_trust.rs`.

export const CODEX_BLOCK_START = '# >>> javi usage (do not edit)';
export const CODEX_BLOCK_END = '# <<< javi';
/** Receiver path for Codex logs (M1): Codex uses the configured endpoint exactly. */
export const CODEX_LOGS_PATH = '/v1/logs/codex-cli';

const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BACKUP_SUFFIX = '.javi-backup';

/**
 * The folder Codex reads `config.toml` and `.env` from: `CODEX_HOME` when set and non-empty,
 * else `~/.codex`. Tests point `JAVI_CODEX_HOME` (the same kind of folder) at a temp dir.
 */
export const codexHome = (env: NodeJS.ProcessEnv) =>
  env.JAVI_CODEX_HOME?.trim() || env.CODEX_HOME?.trim() || join(homedir(), '.codex');

export const codexConfigPath = (home: string) => join(home, 'config.toml');
export const codexBackupPath = (path: string) => `${path}${BACKUP_SUFFIX}`;

/** The `otel` table javi writes, as smol-toml parses it (used to verify the written file). */
export const codexOtelTable = (port: number, secret: string) => ({
  exporter: {
    'otlp-http': {
      endpoint: `http://127.0.0.1:${port}${CODEX_LOGS_PATH}`,
      protocol: 'json',
      headers: { Authorization: `Bearer ${secret}` },
    },
  },
  log_user_prompt: false,
  log_agent_responses: false,
  log_guardian_assessments: false,
  log_sse_deltas: false,
});

/** The marked block (H6), ending in a newline. Port and secret are validated first. */
export const codexOtelBlock = (port: number, secret: string): string => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RangeError(`Usage port must be an integer between 1024 and 65535, got ${port}.`);
  }
  // Never echo the secret itself in the error.
  if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
    throw new RangeError('Usage secret must be 16–128 characters of [A-Za-z0-9_-].');
  }
  return [
    CODEX_BLOCK_START,
    '[otel]',
    `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${port}${CODEX_LOGS_PATH}", protocol = "json", headers = { Authorization = "Bearer ${secret}" } } }`,
    'log_user_prompt = false',
    'log_agent_responses = false',
    'log_guardian_assessments = false',
    'log_sse_deltas = false',
    CODEX_BLOCK_END,
    '',
  ].join('\n');
};

type TomlTable = Record<string, unknown>;

const tryParse = (text: string): TomlTable | null => {
  try {
    return parseToml(text) as TomlTable;
  } catch {
    return null;
  }
};

const isTable = (value: unknown): value is TomlTable =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** `otel` setting names in a parsed config (table, dotted keys or inline table), or []. */
const otelNames = (config: TomlTable): string[] => {
  if (!Object.hasOwn(config, 'otel')) return [];
  const value = config.otel;
  const names = isTable(value) ? Object.keys(value).sort() : [];
  return names.length ? names.map((n) => `otel.${n}`) : ['otel'];
};

const count = (text: string, part: string) => {
  let n = 0;
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + part.length)) n += 1;
  return n;
};

/** The `otel` keys javi writes, in order (what a user removes by hand after an edit). */
export const CODEX_OTEL_KEYS = [
  'exporter',
  'log_user_prompt',
  'log_agent_responses',
  'log_guardian_assessments',
  'log_sse_deltas',
] as const;

/**
 * javi's block without its end marker: the start marker, `[otel]` and javi's keys, through the
 * `log_sse_deltas = false` line. Codex rewrites `config.toml` with toml_edit, which keeps those
 * lines together but can move the trailing `# <<< javi` comment to the end of the file when
 * Codex appends a table (S5c code review H2), so only this part identifies javi's block.
 */
const blockCore = (block: string) => {
  const end = block.lastIndexOf(`${CODEX_BLOCK_END}\n`);
  return end >= 0 ? block.slice(0, end) : block;
};

/** [start, end) of every line that is exactly `# <<< javi` (with its line break). */
const endMarkerLines = (text: string): Array<[number, number]> => {
  const found: Array<[number, number]> = [];
  for (let i = text.indexOf(CODEX_BLOCK_END); i >= 0; i = text.indexOf(CODEX_BLOCK_END, i + 1)) {
    if (i > 0 && text[i - 1] !== '\n') continue;
    const after = i + CODEX_BLOCK_END.length;
    const rest = text.startsWith('\r\n', after) ? 2 : text.startsWith('\n', after) ? 1 : 0;
    if (rest === 0 && after !== text.length) continue;
    found.push([i, after + rest]);
  }
  return found;
};

/**
 * Where javi's block is in `text`: its core (exactly once, unchanged) and one standalone end
 * marker — right after the core when it is there, else the last one in the file (toml_edit
 * moved it) — or null when the core is not there exactly once.
 */
const locateBlock = (text: string, block: string) => {
  const core = blockCore(block);
  if (count(text, core) !== 1) return null;
  const at = text.indexOf(core);
  const coreEnd = at + core.length;
  const markers = endMarkerLines(text).filter(([s]) => s < at || s >= coreEnd);
  const marker = markers.find(([s]) => s === coreEnd) ?? markers.at(-1) ?? null;
  return { at, coreEnd, marker };
};

/** `text` without the end marker line and with [at, coreEnd) replaced by `replacement`. */
const spliceBlock = (
  text: string,
  found: NonNullable<ReturnType<typeof locateBlock>>,
  from: number,
  replacement: string,
) => {
  const { coreEnd, marker } = found;
  // Cut the marker first when it comes after the block, so the earlier offsets stay valid.
  let rest = text;
  if (marker && marker[0] >= coreEnd) rest = rest.slice(0, marker[0]) + rest.slice(marker[1]);
  rest = rest.slice(0, from) + replacement + rest.slice(coreEnd);
  if (marker && marker[0] < from) rest = rest.slice(0, marker[0]) + rest.slice(marker[1]);
  return rest;
};

/**
 * What happened to `config.toml.javi-backup`: `created` holds the file as it was before this
 * change; `kept` is an earlier backup left as it is; `skipped`: the file already held javi's
 * block (and secret), so no backup was made. `null` when there was no file.
 */
export type CodexBackup = { path: string; status: 'created' | 'kept' | 'skipped' } | null;

export type EnableCodexResult =
  | {
      ok: true;
      path: string;
      backup: CodexBackup;
      block: string;
      separator: string;
      created: boolean;
    }
  | {
      ok: false;
      reason: 'unparsable' | 'conflict';
      /** Conflicting setting names only — never their values. */
      keys?: string[];
    };

/**
 * Appends (or, on a re-run, replaces in place) javi's marked `[otel]` block. Refuses, changing
 * nothing, when the file does not parse as TOML, or when it has any `otel` setting other than
 * javi's own unchanged block (`previous`). The full result is parsed again before an atomic
 * rename; the file's mode is kept (0600 for a new file). A backup of the original is kept once,
 * mode 0600, and never of a file that holds javi's block (H6).
 */
export const enableCodexOtel = async (opts: {
  path: string;
  port: number;
  secret: string;
  /** The block javi wrote earlier (from usage.json), if any. */
  previous?: { block: string; separator: string; created: boolean };
}): Promise<EnableCodexResult> => {
  const { path, previous } = opts;
  const block = codexOtelBlock(opts.port, opts.secret);
  let text: string | null;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
    text = null;
  }
  const current = text ?? '';
  const found = previous ? locateBlock(current, previous.block) : null;
  const ours = Boolean(found);
  // The user's own text: the file without javi's earlier block (end marker wherever it is).
  const userText = found ? spliceBlock(current, found, found.at, '') : current;
  const parsed = tryParse(userText);
  if (!parsed) return { ok: false, reason: 'unparsable' };
  const conflicts = otelNames(parsed);
  if (conflicts.length) return { ok: false, reason: 'conflict', keys: conflicts };

  let next: string;
  let separator: string;
  if (found && previous) {
    // The new block, end marker included, where the old core was; a moved marker goes.
    next = spliceBlock(current, found, found.at, block);
    separator = previous.separator;
  } else {
    separator = current === '' ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    next = `${current}${separator}${block}`;
  }
  const check = tryParse(next);
  if (!check || !jsonEqual(check.otel, codexOtelTable(opts.port, opts.secret))) {
    return { ok: false, reason: 'unparsable' };
  }

  let backup: CodexBackup = null;
  let mode = 0o600;
  if (text !== null) {
    mode = (await stat(path)).mode & 0o777;
    if (ours) backup = { path: codexBackupPath(path), status: 'skipped' };
    else {
      try {
        await writeFile(codexBackupPath(path), text, { mode: 0o600, flag: 'wx' });
        backup = { path: codexBackupPath(path), status: 'created' };
      } catch (e) {
        if ((e as { code?: string }).code !== 'EEXIST') throw e;
        backup = { path: codexBackupPath(path), status: 'kept' };
      }
    }
  } else {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  await writeTextAtomic(await writeTarget(path), next, mode);
  return {
    ok: true,
    path,
    backup,
    block,
    separator,
    created: found && previous ? previous.created : text === null,
  };
};

export interface DisableCodexResult {
  path: string;
  /**
   * `removed`: javi's unchanged block (and the separator javi added) is gone, and so is one
   * standalone `# <<< javi` line wherever Codex's toml_edit rewrite left it; everything else is
   * kept as it is. `deleted`: javi had created the file and nothing else was left in it, so the
   * file is gone. `changed`: javi's block was edited (its start marker or exporter line is still
   * there): nothing was touched, so usage stays on. `absent`: no block of javi's (or no file).
   */
  outcome: 'removed' | 'deleted' | 'changed' | 'absent';
  /** After `removed` / `deleted`: the `config.toml.javi-backup` that was removed, if any. */
  backupRemoved?: string;
}

/** Removes exactly the block `enableCodexOtel` wrote, if it is still there unchanged. */
export const disableCodexOtel = async (opts: {
  path: string;
  block: string;
  separator: string;
  created: boolean;
}): Promise<DisableCodexResult> => {
  const { path, block, separator } = opts;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
    return { path, outcome: 'absent' };
  }
  const found = locateBlock(text, block);
  if (!found) {
    // javi's start marker or its exporter line still there: the block was edited.
    const exporterLine = block.split('\n').find((line) => line.startsWith('exporter = '));
    const edited =
      text.includes(CODEX_BLOCK_START) ||
      (exporterLine !== undefined && text.includes(exporterLine));
    return { path, outcome: edited ? 'changed' : 'absent' };
  }
  const { at } = found;
  const from = separator && text.slice(0, at).endsWith(separator) ? at - separator.length : at;
  const next = spliceBlock(text, found, from, '');
  const target = await writeTarget(path);
  let outcome: DisableCodexResult['outcome'] = 'removed';
  if (opts.created && next.trim() === '') {
    await rm(target, { force: true });
    outcome = 'deleted';
  } else {
    await writeTextAtomic(target, next, (await stat(path)).mode & 0o777);
  }
  // The block is gone, so the backup has done its job; Codex rewrites config.toml itself (hook
  // approvals), so a byte-exact restore from it is not possible anyway (H6).
  const backup = codexBackupPath(path);
  const hadBackup = await stat(backup).then(
    () => true,
    () => false,
  );
  if (hadBackup) await rm(backup, { force: true });
  return { path, outcome, ...(hadBackup && { backupRemoved: backup }) };
};

// --- Environment checks (H1 proxy redirection, M5 header override, H2 header leak) ---

/** Proxy variables Codex's HTTP client follows (H1). */
export const CODEX_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;
/** Header variables merged over javi's bearer (M5): the receiver then answers 401. */
export const CODEX_HEADER_ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
] as const;
/** The Claude Code usage header javi writes (H2); compared in memory, never returned. */
const CLAUDE_HEADER_KEY = 'OTEL_EXPORTER_OTLP_METRICS_HEADERS';

/**
 * `KEY=value` pairs of a dotenv text, as `dotenvy` (Codex) reads them: optional `export`,
 * single or double quotes, `#` comments after unquoted values. Values stay in memory only.
 */
export const parseDotenv = (text: string): Map<string, string> => {
  const vars = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let raw = match[2]!.trim();
    if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      raw = end > 0 ? raw.slice(1, end) : raw.slice(1);
    } else if (raw.startsWith('"')) {
      let end = 1;
      while (end < raw.length && raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1;
      raw = raw.slice(1, end).replace(/\\(.)/g, '$1');
    } else {
      raw = raw.replace(/\s+#.*$/, '').trim();
    }
    // Codex filters CODEX_* names from its .env (arg0/src/lib.rs).
    if (!key.toUpperCase().startsWith('CODEX_')) vars.set(key, raw);
  }
  return vars;
};

const OCTET = '(0|[1-9]\\d{0,2})';
const IPV4_ENTRY = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}(?:/(\\d{1,2}))?$`);

/**
 * True when a NO_PROXY value exempts 127.0.0.1 for Codex's proxy matcher (hyper-util
 * `NoProxy::from_string`, S5c code review H1): only an entry that parses as the IPv4 address
 * `127.0.0.1` or as an IPv4 network holding it (`127.0.0.0/8`, `0.0.0.0/0`). `*`, `localhost`
 * and every other name are domain entries there, and a domain entry never matches an IP host.
 */
export const noProxyCoversLoopback = (value: string | undefined): boolean => {
  if (!value) return false;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .some((entry) => {
      const m = IPV4_ENTRY.exec(entry);
      if (!m) return false;
      const octets = m.slice(1, 5).map(Number);
      const bits = m[5] === undefined ? 32 : Number(m[5]);
      if (bits > 32 || octets.some((o) => o > 255)) return false;
      const ip = (octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]! | 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) | 0;
      return (ip & mask) === (((127 << 24) | 1) & mask);
    });
};

// --- System proxy settings (S5c code review M3) ---

/** Runs a command (2 s timeout); null when it cannot run, fails or times out. */
export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stdout: string } | null>;

/** Where Codex's reqwest/hyper-util `system-proxy` reads OS proxy settings. */
export interface SystemProxyProbe {
  platform: NodeJS.Platform;
  run: CommandRunner;
}

const SYSTEM_PROBE_TIMEOUT_MS = 2_000;
export const SYSTEM_PROXY_SOURCE = 'system settings';
const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** The real runner: `execFile` without a shell, output kept in memory only. */
export const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env: childEnv(),
      },
      (error, stdout) => {
        resolvePromise(error ? null : { code: 0, stdout: String(stdout) });
      },
    );
  });

/** `key : value` lines of `scutil --proxy` (top-level dictionary only). */
const scutilValues = (text: string) => {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {2}([A-Za-z]+) : (.*)$/.exec(line);
    if (m) values.set(m[1]!, m[2]!.trim());
  }
  return values;
};

/**
 * OS proxy settings Codex's HTTP client would apply to its loopback log export (names only,
 * never values): macOS `scutil --proxy` with `HTTPEnable : 1` and an `HTTPProxy`, or proxy
 * auto-configuration enabled; Windows Internet Settings with `ProxyEnable` non-zero and a
 * `ProxyServer`. The macOS bypass list and Windows `<local>` never match an IP host, so they do
 * not count as a cover. A probe that cannot run finds nothing.
 */
export const systemProxyFindings = async (probe: SystemProxyProbe): Promise<string[]> => {
  try {
    if (probe.platform === 'darwin') {
      const out = await probe.run('scutil', ['--proxy'], SYSTEM_PROBE_TIMEOUT_MS);
      if (!out) return [];
      const v = scutilValues(out.stdout);
      const found: string[] = [];
      if (v.get('HTTPEnable') === '1' && v.get('HTTPProxy')) found.push('macOS system HTTP proxy');
      if (v.get('ProxyAutoConfigEnable') === '1' || v.get('ProxyAutoDiscoveryEnable') === '1') {
        found.push('macOS proxy auto-configuration');
      }
      return found;
    }
    if (probe.platform === 'win32') {
      const query = (name: string) =>
        probe.run('reg', ['query', WINDOWS_INTERNET_SETTINGS, '/v', name], SYSTEM_PROBE_TIMEOUT_MS);
      const enable = await query('ProxyEnable');
      const flag = enable && /\bProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(enable.stdout);
      if (!flag || Number.parseInt(flag[1]!, 16) === 0) return [];
      const server = await query('ProxyServer');
      const value = server && /\bProxyServer\s+REG_SZ\s+(\S.*)$/im.exec(server.stdout);
      return value ? ['Windows Internet Settings proxy'] : [];
    }
  } catch {
    // A probe that cannot run must never block or break the caller.
  }
  return [];
};

/** A source (`environment` or a `.env` path) and the variable names found there. */
export interface EnvFinding {
  source: string;
  keys: string[];
}

export interface CodexEnvRisks {
  /** Proxy variables (by source) that apply because NO_PROXY does not cover 127.0.0.1 (H1). */
  proxy: EnvFinding[];
  /** OTLP header variables (by source) that would replace javi's bearer (M5). */
  headers: EnvFinding[];
  /** javi's own Claude Code header value is in `env` (H2). Only with `claudeHeader`. */
  claudeHeader: boolean;
}

const set = (value: string | undefined) => value !== undefined && value !== '';

/**
 * What in `env` and `$CODEX_HOME/.env` would send Codex's logs (with the user's email and tool
 * arguments) and javi's bearer through a proxy, or replace the bearer. Codex loads `.env` over
 * its process env, so `.env` values win. Names and paths only; values are compared in memory.
 * `claudeHeader` is the value javi wrote for Claude Code usage, if that is on.
 */
export const codexEnvRisks = async (opts: {
  env: NodeJS.ProcessEnv;
  home: string;
  claudeHeader?: string;
  /** OS proxy settings to look at as well (M3); left out in tests that do not inject one. */
  system?: SystemProxyProbe;
}): Promise<CodexEnvRisks> => {
  const dotenvPath = join(opts.home, '.env');
  const dotenv = await readFile(dotenvPath, 'utf8').then(
    parseDotenv,
    () => new Map<string, string>(),
  );
  const effective = (key: string) => (dotenv.has(key) ? dotenv.get(key) : opts.env[key]);
  // First set wins, as hyper-util's `get_first_env(["NO_PROXY", "no_proxy"])`: a NO_PROXY that
  // is set, even to '', hides no_proxy (H1). It applies to system proxies as well.
  const noProxy = effective('NO_PROXY') ?? effective('no_proxy');
  const proxy: EnvFinding[] = [];
  const headers: EnvFinding[] = [];
  if (!noProxyCoversLoopback(noProxy)) {
    const fromEnv = CODEX_PROXY_ENV_KEYS.filter((k) => !dotenv.has(k) && set(opts.env[k]));
    const fromFile = CODEX_PROXY_ENV_KEYS.filter((k) => set(dotenv.get(k)));
    if (fromEnv.length) proxy.push({ source: 'environment', keys: [...fromEnv] });
    if (fromFile.length) proxy.push({ source: dotenvPath, keys: [...fromFile] });
    const fromSystem = opts.system ? await systemProxyFindings(opts.system) : [];
    if (fromSystem.length) proxy.push({ source: SYSTEM_PROXY_SOURCE, keys: fromSystem });
  }
  const headersEnv = CODEX_HEADER_ENV_KEYS.filter((k) => !dotenv.has(k) && set(opts.env[k]));
  const headersFile = CODEX_HEADER_ENV_KEYS.filter((k) => set(dotenv.get(k)));
  if (headersEnv.length) headers.push({ source: 'environment', keys: [...headersEnv] });
  if (headersFile.length) headers.push({ source: dotenvPath, keys: [...headersFile] });
  const claudeHeader =
    opts.claudeHeader !== undefined &&
    opts.claudeHeader !== '' &&
    effective(CLAUDE_HEADER_KEY) === opts.claudeHeader;
  return { proxy, headers, claudeHeader };
};

// --- Approval state (M3), read-only ---

/** Codex's persisted hook-state labels (`hooks/src/lib.rs` `hook_event_key_label`). */
export const CODEX_EVENT_LABELS: Readonly<Record<string, string>> = {
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
};

export type CodexApproval =
  | { kind: 'unreadable' }
  | {
      kind: 'ok';
      /** `trusted`, `untrusted` or null (no entry for this folder or its repository root). */
      trust: string | null;
      /** javi handlers with a recorded `trusted_hash`, and how many javi handlers there are. */
      approved: number;
      total: number;
      /** javi handlers the user disabled in Codex (`enabled = false`). */
      disabled: number;
    };

/**
 * Reads (never writes) `[projects."<dir>"].trust_level` and `[hooks.state."<key>"]` from the
 * user `config.toml`. `positions` are javi's groups in `.codex/hooks.json` (event, index);
 * Codex keys them `<hooks.json path>:<label>:<group>:0`. javi cannot recompute Codex's hash, so a
 * recorded hash counts as approved; a hook changed since is shown by "no events yet".
 */
export const readCodexApproval = async (opts: {
  configPath: string;
  projectDirs: string[];
  hooksPath: string;
  positions: Array<{ event: string; index: number }>;
}): Promise<CodexApproval> => {
  let config: TomlTable = {};
  try {
    const parsed = tryParse(await readFile(opts.configPath, 'utf8'));
    if (!parsed) return { kind: 'unreadable' };
    config = parsed;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') return { kind: 'unreadable' };
  }
  const projects = isTable(config.projects) ? config.projects : {};
  let trust: string | null = null;
  for (const dir of opts.projectDirs) {
    const entry = projects[dir];
    if (isTable(entry) && typeof entry.trust_level === 'string') {
      trust = entry.trust_level;
      break;
    }
  }
  const hooks = isTable(config.hooks) ? config.hooks : {};
  const states = isTable(hooks.state) ? hooks.state : {};
  const real = await realpath(opts.hooksPath).catch(() => resolve(opts.hooksPath));
  const sources = [...new Set([resolve(opts.hooksPath), real])];
  let approved = 0;
  let disabled = 0;
  for (const { event, index } of opts.positions) {
    const label = CODEX_EVENT_LABELS[event] ?? event;
    const state = sources
      .map((source) => states[`${source}:${label}:${index}:0`])
      .find((s) => isTable(s));
    if (!isTable(state)) continue;
    if (state.enabled === false) disabled += 1;
    if (typeof state.trusted_hash === 'string' && state.trusted_hash) approved += 1;
  }
  return { kind: 'ok', trust, approved, total: opts.positions.length, disabled };
};
