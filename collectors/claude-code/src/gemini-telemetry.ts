import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeTarget } from './claude-env.ts';
import {
  backupOnce,
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

/** Environment variables Gemini CLI reads for telemetry (config.ts ALLOWED_TELEMETRY_ENV_KEYS). */
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

export type EnableGeminiResult =
  | {
      ok: true;
      path: string;
      backup: string | null;
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
 * would override the file). Before the first write (`previous` absent) the exact file text is
 * handed to `saveBefore`, so `usage off` can restore it; a backup is kept once next to the file.
 */
export const enableGeminiTelemetry = async (opts: {
  path: string;
  port: number;
  secret: string;
  shellEnv: NodeJS.ProcessEnv;
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
  for (const key of GEMINI_TELEMETRY_ENV_KEYS) {
    const value = shellEnv[key];
    if (value !== undefined && value !== '') conflicts.add(key);
  }
  if (conflicts.size) return { ok: false, reason: 'conflict', keys: [...conflicts].sort() };

  if (!previous) {
    await opts.saveBefore(
      loaded.kind === 'ok' ? { path, existed: true, text: loaded.text } : { path, existed: false },
    );
  }
  let backup: string | null = null;
  if (loaded.kind === 'ok') backup = await backupOnce(path, loaded.text);
  else await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
    return { path, outcome: 'restored' };
  }

  const loaded = await loadSettings(path);
  if (loaded.kind !== 'ok') return { path, outcome: 'unreadable' };
  if (!jsonEqual(loaded.settings.telemetry, written)) return { path, outcome: 'changed' };
  const next = { ...loaded.settings };
  delete next.telemetry;
  await writeSettingsFile(path, next, 0o600);
  return { path, outcome: 'removed' };
};
