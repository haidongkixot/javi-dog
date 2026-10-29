import { mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeJsonPrivate } from './state.ts';

// Opt-in edit of Claude Code's user settings `env` (`~/.claude/settings.json`) to export
// metrics to the local receiver (ADR-0011). Never takes over an existing telemetry setup.
//
// Claude Code reads OTel exporter variables only from managed settings, the shell or this
// user file (project settings are ignored for them), and a settings `env` value overrides
// the same shell variable — hence the shell check before writing.

/** Keys `javi usage on` writes; anything else starting with `OTEL_` counts as foreign. */
export const USAGE_ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_METRICS_EXPORTER',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
] as const;

export const DEFAULT_USAGE_PORT = 4319;

const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const BACKUP_SUFFIX = '.javi-backup';

/** `~/.claude/settings.json` for a home directory. */
export const claudeUserSettingsPath = (home: string): string =>
  join(home, '.claude', 'settings.json');

/** The env values for a port and local secret. */
export const usageEnv = (port: number, secret: string): Record<string, string> => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new RangeError(`Usage port must be an integer between 1024 and 65535, got ${port}.`);
  }
  // Never echo the secret itself in the error.
  if (typeof secret !== 'string' || !SECRET_PATTERN.test(secret)) {
    throw new RangeError('Usage secret must be 16–128 characters of [A-Za-z0-9_-].');
  }
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: `Authorization=Bearer ${secret}`,
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: 'false',
  };
};

export type EnableResult =
  | { ok: true; path: string; backup: string | null; written: Record<string, string> }
  | { ok: false; reason: 'unparsable' | 'not_object' | 'conflict'; keys?: string[] };

type JsonObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A key `javi` manages or any other OTel variable. */
const isTelemetryKey = (key: string) =>
  (USAGE_ENV_KEYS as readonly string[]).includes(key) || key.startsWith('OTEL_');

type Loaded =
  | { kind: 'missing' }
  | { kind: 'unparsable' }
  | { kind: 'not_object' }
  | { kind: 'ok'; text: string; settings: JsonObject; env: JsonObject };

const load = async (path: string): Promise<Loaded> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return { kind: 'missing' };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unparsable' };
  }
  if (!isPlainObject(parsed)) return { kind: 'not_object' };
  // A present `env` must be an object; `null` counts as present.
  const env = Object.hasOwn(parsed, 'env') ? parsed.env : {};
  if (!isPlainObject(env)) return { kind: 'not_object' };
  return { kind: 'ok', text, settings: parsed, env };
};

/**
 * The file a write must replace: a symlinked settings file (dotfiles) is written through, so the
 * link stays a link. A dangling link resolves to where it points.
 */
export const writeTarget = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  try {
    return resolve(dirname(path), await readlink(path));
  } catch {
    return path; // no file and no link: create it at path
  }
};

/** Atomic write (temp file in the target's directory + rename onto the target). */
const writeSettings = async (path: string, value: unknown) =>
  writeJsonPrivate(await writeTarget(path), value);

/**
 * Backs the file up once (`settings.json.javi-backup`), then merges `usageEnv` into `env`.
 * Refuses, changing nothing, when the file cannot be parsed, is not an object, or when any
 * `CLAUDE_CODE_ENABLE_TELEMETRY` / `OTEL_*` key is already set — in the file with a value
 * javi did not write (`previous`), or in `shellEnv`.
 */
export const enableUsageEnv = async (opts: {
  path: string;
  port: number;
  secret: string;
  shellEnv: NodeJS.ProcessEnv;
  previous?: Record<string, string>;
}): Promise<EnableResult> => {
  const { path, shellEnv, previous } = opts;
  const next = usageEnv(opts.port, opts.secret);

  const loaded = await load(path);
  if (loaded.kind === 'unparsable') return { ok: false, reason: 'unparsable' };
  if (loaded.kind === 'not_object') return { ok: false, reason: 'not_object' };
  const settings: JsonObject = loaded.kind === 'ok' ? loaded.settings : {};
  const env: JsonObject = loaded.kind === 'ok' ? loaded.env : {};

  const conflicts = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (isTelemetryKey(key) && value !== previous?.[key]) conflicts.add(key);
  }
  for (const [key, value] of Object.entries(shellEnv)) {
    if (value === undefined || value === '' || !isTelemetryKey(key)) continue;
    // Inside a Claude Code session whose env already came from us, the shell carries our values.
    if (value === previous?.[key] || value === next[key]) continue;
    conflicts.add(key);
  }
  if (conflicts.size) return { ok: false, reason: 'conflict', keys: [...conflicts].sort() };

  let backup: string | null = null;
  if (loaded.kind === 'ok') {
    backup = `${path}${BACKUP_SUFFIX}`;
    try {
      // `wx`: the first backup is the user's original; never overwrite it.
      await writeFile(backup, loaded.text, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
    }
  } else {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }

  await writeSettings(path, { ...settings, env: { ...env, ...next } });
  return { ok: true, path, backup, written: next };
};

export interface DisableResult {
  path: string;
  removed: string[];
  /**
   * The file exists but is unparsable, not an object, or its `env` is not an object: nothing
   * was removed, and the keys javi wrote may still be there until the user fixes the file.
   */
  unreadable?: true;
}

/** Removes the keys in `written` whose value is unchanged; returns the removed keys. */
export const disableUsageEnv = async (opts: {
  path: string;
  written: Record<string, string>;
}): Promise<DisableResult> => {
  const { path, written } = opts;
  const loaded = await load(path);
  // Missing, unparsable or foreign-shaped files are left exactly as they are.
  if (loaded.kind === 'missing') return { path, removed: [] };
  if (loaded.kind !== 'ok') return { path, removed: [], unreadable: true };

  const env = { ...loaded.env };
  const removed: string[] = [];
  for (const [key, value] of Object.entries(written)) {
    if (Object.hasOwn(env, key) && env[key] === value) {
      delete env[key];
      removed.push(key);
    }
  }
  if (!removed.length) return { path, removed };

  const settings = { ...loaded.settings };
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  await writeSettings(path, settings);
  return { path, removed };
};
