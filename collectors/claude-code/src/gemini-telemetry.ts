import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeTarget } from './claude-env.ts';
import {
  backupOnce,
  backupPath,
  isPlainObject,
  loadSettings,
  sha256,
  writeSettingsFile,
} from './gemini-settings.ts';
import { writeTextAtomic, type GeminiSettingsBefore } from './state.ts';

// Opt-in edit of Gemini CLI's user settings `telemetry` block (`~/.gemini/settings.json`) so
// Gemini exports OTLP/HTTP JSON to the local receiver (ADR-0016 §3). Never takes over an
// existing telemetry setup, and forces prompt logging off.
//
// Sources (google-gemini/gemini-cli at b8fa817, read 2026-10-28/29):
//   docs/cli/telemetry.md: settings `enabled`, `target`, `otlpEndpoint`, `otlpProtocol`
//     ("grpc"/"http"), `otlpHeaders` ("JSON/key=value"), `logPrompts` (default true), `traces`;
//     "Environment variables can override these settings."
//   docs/reference/configuration.md: "`otlpHeaders` (object): Custom headers to send with OTLP
//     Exporter requests."
//   packages/core/src/telemetry/sdk.ts: with "http", `v1/metrics`, `v1/logs`, `v1/traces` are
//     appended to `otlpEndpoint` — metrics, logs and traces all go to the receiver.
//   packages/core/src/telemetry/config.ts: the env keys below override (or merge into) these.

/**
 * Environment variables Gemini CLI reads for telemetry (config.ts ALLOWED_TELEMETRY_ENV_KEYS).
 * The checks use the wider families of `isGeminiTelemetryEnvKey`, which contain all of these.
 */
export const GEMINI_TELEMETRY_ENV_KEYS = [
  'GEMINI_TELEMETRY_ENABLED',
  'GEMINI_TELEMETRY_TRACES_ENABLED',
  'GEMINI_TELEMETRY_TARGET',
  'GEMINI_TELEMETRY_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'GEMINI_TELEMETRY_OTLP_PROTOCOL',
  'GEMINI_TELEMETRY_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'GEMINI_TELEMETRY_LOG_PROMPTS',
  'GEMINI_TELEMETRY_OUTFILE',
  'GEMINI_TELEMETRY_USE_COLLECTOR',
  'GEMINI_TELEMETRY_USE_CLI_AUTH',
] as const;

/**
 * A telemetry variable Gemini CLI or its OTLP exporters may read (ADR-0016 Changes R1): any
 * `GEMINI_TELEMETRY_*` or `OTEL_EXPORTER_OTLP_*` name (the exporters also merge signal-specific
 * `OTEL_EXPORTER_OTLP_*_HEADERS`). Wider than `GEMINI_TELEMETRY_ENV_KEYS` on purpose.
 */
export const isGeminiTelemetryEnvKey = (key: string) =>
  key.startsWith('GEMINI_TELEMETRY_') || key.startsWith('OTEL_EXPORTER_OTLP_');

/**
 * Names of the telemetry variables set (non-empty) in `env`, sorted. A variable whose value is
 * exactly what javi itself wrote (`own`: the Claude Code usage env, which a Gemini CLI started
 * inside Claude Code inherits) points at javi's receiver and is not counted. Values are
 * compared in memory and never returned.
 */
export const telemetryEnvKeys = (
  env: NodeJS.ProcessEnv,
  own: Readonly<Record<string, string>> = {},
): string[] =>
  Object.keys(env)
    .filter((key) => {
      const value = env[key];
      return (
        isGeminiTelemetryEnvKey(key) &&
        value !== undefined &&
        value !== '' &&
        !(Object.hasOwn(own, key) && own[key] === value)
      );
    })
    .sort();

/**
 * The `.env` files Gemini CLI may load for a session started in `cwd`, in its lookup order
 * (google-gemini/gemini-cli `packages/cli/src/config/settings.ts` `findEnvFile`, called by
 * `loadEnvironment` with the workspace dir = cwd): from `cwd` up to the filesystem root, each
 * folder's `.gemini/.env` (trusted folders only) then `.env` (skipped under `--ignore-env` /
 * `advanced.ignoreLocalEnv`, except in the home); then `<home>/.gemini/.env` (trusted) and
 * `<home>/.env`. `home` is Gemini's home (`GEMINI_CLI_HOME`, else the OS home). Gemini loads
 * only the first file that exists, and which one that is depends on folder trust and flags javi
 * cannot see, so the checks read every file of the chain.
 */
export const geminiEnvFileChain = (cwd: string, home: string): string[] => {
  const chain: string[] = [];
  for (let dir = resolve(cwd); ;) {
    chain.push(join(dir, '.gemini', '.env'), join(dir, '.env'));
    const parent = dirname(dir);
    if (parent === dir || !parent) break;
    dir = parent;
  }
  chain.push(join(home, '.gemini', '.env'), join(home, '.env'));
  return chain;
};

/**
 * Variable names assigned in a dotenv text (`KEY=value`, `export KEY=value`, `KEY: value`, as
 * the `dotenv` parser Gemini uses accepts them). Values are never kept. Lines inside a quoted
 * multi-line value may be read as names too: that can only add a refusal, never hide a key.
 */
export const dotenvKeys = (text: string): string[] => {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=|:\s)/.exec(line);
    if (match) keys.add(match[1]!);
  }
  return [...keys];
};

/** One place that can override javi's Gemini telemetry: a file path or `environment`. */
export interface TelemetryOverride {
  source: string;
  /** Variable or setting names only (e.g. `GEMINI_TELEMETRY_OTLP_ENDPOINT`, `telemetry.target`). */
  keys: string[];
}

/** `telemetry` setting names of a workspace settings text, or null when it has none. */
const workspaceTelemetryKeys = (text: string): string[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Gemini strips comments before parsing (strip-json-comments); javi does not parse JSONC,
    // so any `"telemetry":` key in such a file counts as a block.
    return /"telemetry"\s*:/.test(text) ? ['telemetry'] : null;
  }
  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, 'telemetry')) return null;
  const block = parsed.telemetry;
  const names = isPlainObject(block) ? Object.keys(block).sort() : [];
  return names.length ? names.map((n) => `telemetry.${n}`) : ['telemetry'];
};

const readIfFile = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null; // missing, a directory or unreadable: Gemini would not load it either
  }
};

const samePath = async (a: string, b: string) => {
  if (resolve(a) === resolve(b)) return true;
  const real = (p: string) => realpath(p).catch(() => resolve(p));
  return (await real(a)) === (await real(b));
};

/**
 * Everything javi can see that would send a Gemini CLI session started in `cwd` somewhere
 * else (ADR-0016 Changes R1): telemetry variables in `env` (when given), in any file of the
 * `.env` lookup chain, and a `telemetry` block in `<cwd>/.gemini/settings.json` (Gemini
 * deep-merges a workspace block over the user's). The workspace file is skipped when it is
 * the user settings file itself (`cwd` = Gemini's home). Names and paths only.
 */
export const findGeminiTelemetryOverrides = async (opts: {
  cwd: string;
  home: string;
  userSettingsPath: string;
  env?: NodeJS.ProcessEnv;
  own?: Readonly<Record<string, string>>;
}): Promise<TelemetryOverride[]> => {
  const found: TelemetryOverride[] = [];
  if (opts.env) {
    const keys = telemetryEnvKeys(opts.env, opts.own);
    if (keys.length) found.push({ source: 'environment', keys });
  }
  for (const path of geminiEnvFileChain(opts.cwd, opts.home)) {
    const text = await readIfFile(path);
    if (text === null) continue;
    const keys = dotenvKeys(text).filter(isGeminiTelemetryEnvKey).sort();
    if (keys.length) found.push({ source: path, keys });
  }
  const workspace = join(resolve(opts.cwd), '.gemini', 'settings.json');
  if (!(await samePath(workspace, opts.userSettingsPath))) {
    const text = await readIfFile(workspace);
    const keys = text === null ? null : workspaceTelemetryKeys(text);
    if (keys) found.push({ source: workspace, keys });
  }
  return found;
};

const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The `telemetry` block for a port and local secret. */
export const geminiTelemetryBlock = (port: number, secret: string) => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RangeError(`Usage port must be an integer between 1024 and 65535, got ${port}.`);
  }
  // Never echo the secret itself in the error.
  if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
    throw new RangeError('Usage secret must be 16–128 characters of [A-Za-z0-9_-].');
  }
  return {
    enabled: true,
    target: 'local',
    otlpProtocol: 'http',
    otlpEndpoint: `http://127.0.0.1:${port}`,
    otlpHeaders: { Authorization: `Bearer ${secret}` },
    logPrompts: false,
    traces: false,
  };
};

/** Structural equality for JSON values (key order ignored). */
export const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => jsonEqual(v, b[i]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
  );
};

/**
 * What happened to `settings.json.javi-backup` (ADR-0016 Changes R7): `created` holds the file
 * as it was before this change; `kept` is an earlier backup left as it is (not a copy of the
 * file before this change); `skipped`: the file already held javi's block (and secret), so no
 * backup was made. `null` when there was no file.
 */
export type GeminiBackup = { path: string; status: 'created' | 'kept' | 'skipped' } | null;

export type EnableGeminiResult =
  | {
      ok: true;
      path: string;
      backup: GeminiBackup;
      written: Record<string, unknown>;
      sha256: string;
    }
  | {
      ok: false;
      reason: 'unparsable' | 'not_object' | 'conflict';
      /** Conflicting setting / variable names only — never their values. */
      keys?: string[];
    };

/**
 * Writes `telemetry` = `geminiTelemetryBlock(port, secret)`. Refuses, changing nothing, when
 * the file is not a plain JSON object, when a `telemetry` block exists that is not exactly the
 * one javi wrote (`previous`), or when a Gemini telemetry variable is set in `shellEnv` (it
 * would override the file; values equal to javi's own `ownEnv` are not counted). Before the
 * first write (`previous` absent) the exact file text is handed to `saveBefore`, so `usage off`
 * can restore it. A backup is kept once next to the file, and only of a file without javi's
 * block, so it never holds javi's secret (R7).
 */
export const enableGeminiTelemetry = async (opts: {
  path: string;
  port: number;
  secret: string;
  shellEnv: NodeJS.ProcessEnv;
  ownEnv?: Readonly<Record<string, string>>;
  previous?: Record<string, unknown>;
  saveBefore: (before: GeminiSettingsBefore) => Promise<void>;
}): Promise<EnableGeminiResult> => {
  const { path, shellEnv, previous } = opts;
  const block = geminiTelemetryBlock(opts.port, opts.secret);
  const loaded = await loadSettings(path);
  if (loaded.kind === 'unparsable') return { ok: false, reason: 'unparsable' };
  if (loaded.kind === 'not_object') return { ok: false, reason: 'not_object' };
  const settings = loaded.kind === 'ok' ? loaded.settings : {};

  const conflicts = new Set<string>();
  if (Object.hasOwn(settings, 'telemetry') && !jsonEqual(settings.telemetry, previous)) {
    const existing = settings.telemetry;
    const names = isPlainObject(existing) ? Object.keys(existing) : [];
    for (const name of names.length ? names : ['']) {
      conflicts.add(name ? `telemetry.${name}` : 'telemetry');
    }
  }
  for (const key of telemetryEnvKeys(shellEnv, opts.ownEnv)) conflicts.add(key);
  if (conflicts.size) return { ok: false, reason: 'conflict', keys: [...conflicts].sort() };

  if (!previous) {
    await opts.saveBefore(
      loaded.kind === 'ok' ? { path, existed: true, text: loaded.text } : { path, existed: false },
    );
  }
  let backup: GeminiBackup = null;
  if (loaded.kind === 'ok') {
    // Past the conflict check, any `telemetry` block left is javi's own (with the secret).
    if (Object.hasOwn(settings, 'telemetry')) {
      backup = { path: backupPath(path), status: 'skipped' };
    } else {
      const made = await backupOnce(path, loaded.text);
      backup = { path: made.path, status: made.created ? 'created' : 'kept' };
    }
  } else await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // 0600 like Claude Code's settings edit: the file now holds the receiver secret.
  const digest = await writeSettingsFile(path, { ...settings, telemetry: block }, 0o600);
  return { ok: true, path, backup, written: block, sha256: digest };
};

export interface DisableGeminiResult {
  path: string;
  /**
   * `restored`: the file was exactly as javi left it, so its text before `usage on` is back
   * (or the file is gone again, if javi created it). `removed`: other settings changed since,
   * so only javi's unchanged `telemetry` block was removed. `changed`: the block is no longer
   * javi's (or is gone): nothing was touched. `unreadable`: the file is not a plain JSON
   * object: nothing was touched and javi's block may still be there.
   */
  outcome: 'restored' | 'removed' | 'changed' | 'unreadable';
  /** After `restored`: the `settings.json.javi-backup` that was removed, if there was one. */
  backupRemoved?: string;
}

/** Undoes `enableGeminiTelemetry` as exactly as the file allows. */
export const disableGeminiTelemetry = async (opts: {
  path: string;
  written: Record<string, unknown>;
  sha256: string;
  before: GeminiSettingsBefore | null;
}): Promise<DisableGeminiResult> => {
  const { path, written, before } = opts;
  let text: string | null;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
    text = null;
  }
  if (text === null) return { path, outcome: 'changed' };

  if (before && before.path === path && opts.sha256 && sha256(text) === opts.sha256) {
    if (before.existed && typeof before.text === 'string') {
      await writeTextAtomic(await writeTarget(path), before.text, 0o600);
    } else {
      await rm(await writeTarget(path), { force: true });
    }
    // The file is exactly as it was, so its backup has done its job (R7).
    const backup = backupPath(path);
    const hadBackup = await readFile(backup).then(
      () => true,
      () => false,
    );
    if (hadBackup) await rm(backup, { force: true });
    return { path, outcome: 'restored', ...(hadBackup && { backupRemoved: backup }) };
  }

  const loaded = await loadSettings(path);
  if (loaded.kind !== 'ok') return { path, outcome: 'unreadable' };
  if (!jsonEqual(loaded.settings.telemetry, written)) return { path, outcome: 'changed' };
  const next = { ...loaded.settings };
  delete next.telemetry;
  await writeSettingsFile(path, next, 0o600);
  return { path, outcome: 'removed' };
};
