#!/usr/bin/env node
// `javi` — Javi's Dog collector for Claude Code (JD-C01, ADR-0010).
//   javi init --project <slug> [--endpoint <url>] [--dir <project dir>] [--no-verify] [--usage]
//            token from JAVI_INGEST_TOKEN or piped stdin; never from argv (shell history)
//   javi hook --project <slug>      (called by Claude Code; silent, always exits 0)
//   javi flush --project <slug>     javi status --project <slug>
//   javi uninstall --project <slug> [--dir <project dir>] [--forget-token]
// Token usage (opt-in, ADR-0011; machine-wide, so no --project):
//   javi usage on [--port <n>]      writes the OTel exporter env into ~/.claude/settings.json
//   javi usage off                  removes exactly what `usage on` wrote, stops the receiver
//   javi receive                    local OTLP receiver on 127.0.0.1 (hooks start it detached)
//   `init --usage` runs `usage on` after a verified init.
// Gemini CLI (ADR-0016): `--platform gemini-cli` on init, uninstall, status, hook and usage on|off
//   registers hooks in the project's .gemini/settings.json and edits the telemetry block of
//   ~/.gemini/settings.json; without --platform every command is the Claude Code one.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileSpool, createJgrClient } from '@javis-dog/jgr-sdk';
import {
  DEFAULT_USAGE_PORT,
  claudeUserSettingsPath,
  disableUsageEnv,
  enableUsageEnv,
  usageEnv,
  type EnableResult,
} from './claude-env.ts';
import {
  geminiHome,
  geminiHooksInstalled,
  geminiProjectSettingsPath,
  geminiUserSettingsPath,
  installGeminiHooks,
  uninstallGeminiHooks,
} from './gemini-settings.ts';
import {
  disableGeminiTelemetry,
  enableGeminiTelemetry,
  geminiTelemetryBlock,
  type EnableGeminiResult,
} from './gemini-telemetry.ts';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
import { PLATFORM_NAMES, PLATFORMS, platformFlag, type Platform } from './platform.ts';
import {
  RECEIVER_IDLE_MS,
  createUsageReceiver,
  ensureReceiver,
  isPidAlive,
  liveReceiver,
  probeReceiver,
} from './receiver.ts';
import { runFlush, runHook } from './run.ts';
import { installHooks, settingsPath, uninstallHooks } from './settings.ts';
import { createState, javiHome, type CollectorState, type UsageConfig } from './state.ts';

/** Replaced with `true` by scripts/build.mjs (esbuild define); undeclared when run from .ts. */
declare const __JAVI_BUNDLED__: boolean | undefined;
const BUNDLED = typeof __JAVI_BUNDLED__ !== 'undefined' && __JAVI_BUNDLED__ === true;

export const DEFAULT_ENDPOINT = 'https://javisdog.vercel.app/api/v1/events';
const TOKEN = /^jd_it_[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_:-]{1,128}$/;

export interface Io {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  spawnFlush: (projectRef: string) => void;
  /** Starts `javi receive` in the background (detached in the CLI). */
  spawnReceiver: () => void;
  fetch?: typeof fetch;
}

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const masked = (token: string) => `${token.slice(0, 10)}…`;

const validEndpoint = (value: string) => {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (local && url.protocol === 'http:');
  } catch {
    return false;
  }
};

/**
 * Keeps a file (default `.claude/settings.local.json`) out of commits via the repo-local
 * exclude file; `entry` is its path relative to the repository root as javi writes it.
 */
const ensureIgnored = async (
  projectDir: string,
  file: string,
  entry = '.claude/settings.local.json',
) => {
  try {
    execFileSync('git', ['-C', projectDir, 'check-ignore', '-q', file], { stdio: 'ignore' });
    return 'already ignored';
  } catch (e) {
    if ((e as { status?: number }).status !== 1) return 'not a git repository';
  }
  try {
    const gitDir = execFileSync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
    }).trim();
    const exclude = join(resolve(projectDir, gitDir), 'info', 'exclude');
    const current = await readFile(exclude, 'utf8').catch(() => '');
    if (!current.split(/\r?\n/).includes(entry)) {
      await appendFile(exclude, `${current.endsWith('\n') || !current ? '' : '\n'}${entry}\n`);
    }
    return 'added to .git/info/exclude';
  } catch {
    return `could not update git excludes — add ${entry} to .gitignore`;
  }
};

/** Where `javi init` installs a bundle: one folder per version (S3f review finding 2). */
export const installTarget = (home: string, version: string) =>
  join(home, 'bin', version, 'javi.mjs');

/** Rename errors Windows reports while an antivirus scanner or the indexer holds the file. */
const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 5;

export interface InstallOptions {
  /** Injectable for tests (simulates Windows' transient rename errors). */
  rename?: (from: string, to: string) => Promise<void>;
  /** First retry delay; doubles on each retry (default 25 ms: 25, 50, 100, 200, 400). */
  retryDelayMs?: number;
}

/**
 * Copies the running bundle to `<JAVI_HOME>/bin/<version>/javi.mjs` (temp file + rename) and
 * returns that path, so hooks never point into an `npx` cache that may be cleared later (S3f
 * P3), each project keeps the version it was set up with, and an older tarball cannot replace
 * the copy other projects use. A byte-identical copy is kept as it is.
 */
export const installSelf = async (
  home: string,
  source: string,
  version: string,
  { rename: move = rename, retryDelayMs = 25 }: InstallOptions = {},
): Promise<{ path: string; copied: boolean }> => {
  const target = installTarget(home, version);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const d of [join(home, 'bin'), dir]) await chmod(d, 0o700).catch(() => {});
  const bytes = await readFile(source);
  const current = await readFile(target).catch(() => null);
  if (current?.equals(bytes)) return { path: target, copied: false };

  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o755 });
    await chmod(temp, 0o755);
    for (let retry = 0; ; retry++) {
      try {
        await move(temp, target);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if (!TRANSIENT_RENAME.has(code) || retry >= RENAME_RETRIES) throw e;
        await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** retry));
      }
    }
  } catch (e) {
    // Never leave a half-written .tmp copy behind; the original error is the one to report.
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
  return { path: target, copied: true };
};

// --- Token usage (ADR-0011) ---

/** `~/.claude` lives under this home; tests point JAVI_CLAUDE_HOME at a temp dir. */
const claudeSettings = (env: NodeJS.ProcessEnv) =>
  claudeUserSettingsPath(env.JAVI_CLAUDE_HOME?.trim() || homedir());

/** True when nothing listens on 127.0.0.1:port. */
const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });

/**
 * Stops the receiver (SIGTERM, then waits up to 5 s for it to exit) — only one the probe
 * confirmed. An unconfirmed receiver.json (stale, or a recycled pid) is just marked stopped.
 */
const stopReceiver = async (state: CollectorState) => {
  const live = await liveReceiver(state);
  if (!live) {
    const info = await state.receiverInfo();
    if (info && info.pid !== 0) await state.saveReceiverInfo({ ...info, pid: 0 });
    return false;
  }
  try {
    process.kill(live.pid, 'SIGTERM');
  } catch {
    return false;
  }
  const until = Date.now() + 5_000;
  while (isPidAlive(live.pid) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(live.pid);
};

/** After a successful `usage on` (any platform): one receiver on the configured port. */
const afterUsageOn = async (
  state: CollectorState,
  live: Awaited<ReturnType<typeof liveReceiver>>,
  port: number,
) => {
  // A receiver still listening on the previous port would never get exports again.
  if (live && live.port !== port) await stopReceiver(state);
  // The port was free (or ours) a moment ago: an older conflict no longer applies.
  const info = await state.receiverInfo();
  if (info?.portConflict) {
    const cleared = { ...info };
    delete cleared.portConflict;
    await state.saveReceiverInfo(cleared);
  }
};

const usageOn = async (
  argv: string[],
  io: Io,
  state: CollectorState,
  platform: Platform = 'claude-code',
): Promise<number> => {
  const portFlag = flag(argv, 'port');
  const requested = portFlag === undefined ? undefined : Number(portFlag);
  if (
    requested !== undefined &&
    (!/^\d{4,5}$/.test(portFlag ?? '') || requested < 1024 || requested > 65535)
  ) {
    io.err('The usage port must be a number between 1024 and 65535.');
    return 2;
  }
  const config = await state.usageConfig();
  const port = requested ?? config?.port ?? DEFAULT_USAGE_PORT;
  // One receiver and one port serve every platform: moving it would strand the other one.
  const other: Platform = platform === 'gemini-cli' ? 'claude-code' : 'gemini-cli';
  const otherOn = other === 'gemini-cli' ? Boolean(config?.gemini) : Boolean(config?.written);
  if (config && otherOn && port !== config.port) {
    io.err(
      `javi uses one usage port for all platforms, and ${PLATFORM_NAMES[other]} usage export is on at port ${config.port}.`,
    );
    io.err(`Nothing was changed. Run javi usage off --platform ${other} first, or omit --port.`);
    return 1;
  }
  // Generated once; `usage on` again (or with a new port) keeps the same secret.
  const secret = config?.secret ?? randomBytes(24).toString('base64url');

  const live = await liveReceiver(state);
  if (!(live && live.port === port) && !(await portFree(port))) {
    io.err(
      `Port ${port} on 127.0.0.1 is taken by another program. Pick a free one: javi usage on --port <n>`,
    );
    return 1;
  }
  if (platform === 'gemini-cli') return geminiUsageOn(io, state, config, port, secret, live);

  const path = claudeSettings(io.env);
  // usage.json first, with the values about to be written: settings never hold keys javi has
  // forgotten. Restored (or removed) below when the settings edit is refused or fails.
  const next: UsageConfig = {
    port,
    secret,
    written: usageEnv(port, secret),
    ...(config?.gemini && { gemini: config.gemini }),
  };
  try {
    await state.saveUsageConfig(next);
  } catch {
    io.err(
      `Token usage not enabled: could not save ${join(state.home, 'usage.json')}. Nothing was changed in ${path}.`,
    );
    return 1;
  }
  const restore = () => (config ? state.saveUsageConfig(config) : state.removeUsageConfig());
  let result: EnableResult;
  try {
    result = await enableUsageEnv({
      path,
      port,
      secret,
      shellEnv: io.env,
      ...(config?.written && { previous: config.written }),
    });
  } catch (e) {
    await restore();
    throw e;
  }
  if (!result.ok) {
    await restore();
    if (result.reason === 'conflict') {
      // Key names only: the values can hold someone else's endpoint or credentials.
      io.err(
        `Token usage not enabled: telemetry is already configured (${(result.keys ?? []).join(', ')}).`,
      );
      io.err(`javi never takes over an existing telemetry setup. Nothing was changed in ${path}.`);
    } else {
      io.err(
        `Token usage not enabled: ${path} is not a JSON object javi can read. Nothing was changed.`,
      );
    }
    return 1;
  }

  await afterUsageOn(state, live, port);
  io.out(`Token usage export enabled in ${result.path}:`);
  io.out(`  ${Object.keys(result.written).join(', ')}`);
  io.out(
    result.backup
      ? `Your previous settings are backed up in ${result.backup}.`
      : 'There was no settings file before, so there was nothing to back up.',
  );
  io.out(
    `Claude Code sessions started from now on export token usage to 127.0.0.1:${port} about once a minute; sessions already running are not affected.`,
  );
  io.out('Usage of projects without javi init stays on this machine and is dropped.');
  if (!(await liveReceiver(state))) io.spawnReceiver();
  return 0;
};

/** `javi usage on --platform gemini-cli`: the `telemetry` block of ~/.gemini/settings.json. */
const geminiUsageOn = async (
  io: Io,
  state: CollectorState,
  config: UsageConfig | null,
  port: number,
  secret: string,
  live: Awaited<ReturnType<typeof liveReceiver>>,
): Promise<number> => {
  // usage off edits the file usage on edited, even if GEMINI_CLI_HOME changed meanwhile.
  const path = config?.gemini?.path ?? geminiUserSettingsPath(geminiHome(io.env));
  const pending: UsageConfig = {
    port,
    secret,
    ...(config?.written && { written: config.written }),
    gemini: { path, written: geminiTelemetryBlock(port, secret), sha256: '' },
  };
  // usage.json first (as for Claude Code): the settings never hold a secret javi forgot.
  try {
    await state.saveUsageConfig(pending);
  } catch {
    io.err(
      `Gemini CLI token usage not enabled: could not save ${join(state.home, 'usage.json')}. Nothing was changed in ${path}.`,
    );
    return 1;
  }
  const restore = () => (config ? state.saveUsageConfig(config) : state.removeUsageConfig());
  let result: EnableGeminiResult;
  try {
    result = await enableGeminiTelemetry({
      path,
      port,
      secret,
      shellEnv: io.env,
      ...(config?.gemini && { previous: config.gemini.written }),
      saveBefore: (before) => state.saveGeminiSettingsBefore(before),
    });
  } catch (e) {
    await restore();
    throw e;
  }
  if (!result.ok) {
    await restore();
    if (result.reason === 'conflict') {
      // Names only: the values can hold someone else's endpoint or credentials.
      io.err(
        `Gemini CLI token usage not enabled: telemetry is already configured (${(result.keys ?? []).join(', ')}).`,
      );
      io.err(`javi never takes over an existing telemetry setup. Nothing was changed in ${path}.`);
    } else {
      io.err(
        `Gemini CLI token usage not enabled: ${path} is not a plain JSON object javi can read (javi does not edit files with comments). Nothing was changed.`,
      );
    }
    return 1;
  }
  // The hash lets `usage off` restore the exact previous file; without it off still removes
  // javi's block, so a failure here is not worth undoing the edit.
  await state
    .saveUsageConfig({ ...pending, gemini: { ...pending.gemini!, sha256: result.sha256 } })
    .catch(() => {});

  await afterUsageOn(state, live, port);
  io.out(`Gemini CLI telemetry export enabled in ${result.path}:`);
  io.out(`  telemetry: ${Object.keys(result.written).join(', ')}`);
  io.out('Prompt logging is off (logPrompts: false) and so are traces (traces: false).');
  io.out(
    result.backup
      ? `Your previous settings are backed up in ${result.backup}.`
      : 'There was no settings file before, so there was nothing to back up.',
  );
  io.out(
    `Gemini CLI sessions started from now on send metrics, logs and traces to 127.0.0.1:${port} about every 10 seconds; sessions already running are not affected.`,
  );
  io.out(
    'javi reads only token counts from the metrics; logs and traces are answered and dropped unread.',
  );
  io.out('Gemini CLI reports no cost: javi estimates it from a dated price table (estimated).');
  io.out(
    'Usage of projects without javi init --platform gemini-cli stays on this machine and is dropped.',
  );
  io.out(
    "A project's own .gemini/settings.json telemetry block and GEMINI_TELEMETRY_* variables override this file.",
  );
  if (!(await liveReceiver(state))) io.spawnReceiver();
  return 0;
};

/** Stops the receiver and forgets the secret, unless another platform still uses them. */
const releaseUsage = async (state: CollectorState, rest: UsageConfig | null) => {
  if (rest) {
    await state.saveUsageConfig(rest);
    return 'kept';
  }
  const stopped = await stopReceiver(state);
  await state.removeUsageConfig();
  if (!(await liveReceiver(state))) await state.removeReceiverInfo();
  return stopped ? 'stopped' : 'none';
};

const usageOff = async (
  io: Io,
  state: CollectorState,
  platform: Platform = 'claude-code',
): Promise<number> => {
  if (platform === 'gemini-cli') return geminiUsageOff(io, state);
  const config = await state.usageConfig();
  if (!config) {
    io.out('Token usage export is already off.');
    return 0;
  }
  if (!config.written) {
    io.out('Token usage export for Claude Code is already off.');
    return 0;
  }
  const { path, removed, unreadable } = await disableUsageEnv({
    path: claudeSettings(io.env),
    written: config.written,
  });
  if (unreadable) {
    // The keys may still point Claude Code at the receiver: keep usage.json (it remembers which
    // values are ours) and the receiver, and claim nothing. File name only, never values.
    io.err(`Token usage is still on: javi cannot read ${path} (not valid JSON settings).`);
    io.err('Nothing was removed. Fix that file, then run javi usage off again to remove the keys.');
    return 1;
  }
  let rest: UsageConfig | null = null;
  if (config.gemini) {
    rest = { ...config };
    delete rest.written;
  }
  const receiver = await releaseUsage(state, rest);
  io.out(
    removed.length
      ? `Removed from ${path}: ${removed.join(', ')}.`
      : `Nothing to remove from ${path} (those keys were already changed or removed).`,
  );
  io.out(
    receiver === 'kept'
      ? 'The usage receiver keeps running for Gemini CLI.'
      : receiver === 'stopped'
        ? 'Usage receiver stopped.'
        : 'No usage receiver was running.',
  );
  io.out('New Claude Code sessions no longer export token usage.');
  return 0;
};

const geminiUsageOff = async (io: Io, state: CollectorState): Promise<number> => {
  const config = await state.usageConfig();
  if (!config?.gemini) {
    io.out('Token usage export for Gemini CLI is already off.');
    return 0;
  }
  const { path, written, sha256 } = config.gemini;
  const before = await state.geminiSettingsBefore();
  const { outcome } = await disableGeminiTelemetry({ path, written, sha256, before });
  if (outcome === 'unreadable') {
    // javi's block may still point Gemini CLI at the receiver: keep usage.json and the receiver.
    io.err(
      `Gemini CLI token usage is still on: javi cannot read ${path} (not a plain JSON object).`,
    );
    io.err(
      'Nothing was removed. Fix that file, then run javi usage off --platform gemini-cli again.',
    );
    return 1;
  }
  await state.removeGeminiSettingsBefore();
  let rest: UsageConfig | null = null;
  if (config.written) {
    rest = { ...config };
    delete rest.gemini;
  }
  const receiver = await releaseUsage(state, rest);
  io.out(
    outcome === 'restored'
      ? before?.existed
        ? `Restored ${path} to exactly what it was before javi usage on.`
        : `Removed ${path}: javi had created it for usage on.`
      : outcome === 'removed'
        ? `Removed javi's telemetry block from ${path}; your other changes since usage on are kept.`
        : `Nothing to remove from ${path} (its telemetry block was changed or removed since javi wrote it).`,
  );
  io.out(
    receiver === 'kept'
      ? 'The usage receiver keeps running for Claude Code.'
      : receiver === 'stopped'
        ? 'Usage receiver stopped.'
        : 'No usage receiver was running.',
  );
  io.out('New Gemini CLI sessions no longer export telemetry to javi.');
  return 0;
};

const usageStatus = async (io: Io, state: CollectorState) => {
  const config = await state.usageConfig();
  if (!config) {
    io.out('Usage: off');
    return;
  }
  const info = await state.receiverInfo();
  // Running means confirmed by a probe, not just a live pid.
  const live = await liveReceiver(state);
  io.out(`Usage: on (port ${config.port})`);
  // Claude Code-only setups keep their exact output; per-platform lines once Gemini is involved.
  if (config.gemini || !config.written) {
    io.out(`Claude Code usage: ${config.written ? 'on' : 'off'}`);
    io.out(`Gemini CLI usage: ${config.gemini ? `on (${config.gemini.path})` : 'off'}`);
  }
  io.out(`Usage receiver: ${live ? `running (pid ${live.pid})` : 'not running'}`);
  io.out(
    `Usage forwarded: ${info?.forwarded ?? 0}, dropped (unattributed session, project without token, or invalid): ${info?.dropped ?? 0}`,
  );
  io.out(`Last usage export: ${info?.lastRequestAt ?? 'never'}`);
  if (info?.portConflict && !live) {
    io.out(
      `Warning: another program holds 127.0.0.1:${config.port} (seen ${info.portConflict.at}), so the usage receiver cannot start.`,
    );
    io.out(
      '  Claude Code sends its usage exports to that program, and they include identity attributes (such as your email and organisation id).',
    );
    io.out('  Run javi usage off, or move to a free port: javi usage on --port <n>');
  }
};

/** `javi receive`: the receiver in the foreground until it idles out or gets SIGTERM. */
const receive = async (io: Io, state: CollectorState): Promise<number> => {
  const config = await state.usageConfig();
  if (!config) {
    io.err('Token usage export is off (run javi usage on).');
    return 1;
  }
  const { salt } = await state.installation();
  const idleMs = Number(io.env.JAVI_RECEIVER_IDLE_MS);
  const receiver = createUsageReceiver({
    state,
    port: config.port,
    secret: config.secret,
    salt,
    idleMs: Number.isFinite(idleMs) && idleMs > 0 ? idleMs : RECEIVER_IDLE_MS,
    ...(io.fetch && { fetch: io.fetch }),
  });
  try {
    await receiver.listen();
  } catch (e) {
    if ((e as { code?: string }).code !== 'EADDRINUSE') throw e;
    // Another javi receiver already holds the port: that one does the work.
    if ((await probeReceiver(config.port, config.secret)) !== null) return 0;
    // No answer in time, but the recorded receiver is alive on this port: ours, just busy (a
    // loaded machine can delay the probe). Never record that as a foreign program.
    const previous = await state.receiverInfo();
    if (previous && previous.port === config.port && isPidAlive(previous.pid)) return 0;
    // Another program holds it and gets Claude Code's exports: record it for `javi status` and
    // the hooks' back-off. Still silent and exit 0: hooks must stay neutral.
    await state.saveReceiverInfo({
      forwarded: 0,
      dropped: 0,
      lastRequestAt: null,
      startedAt: '',
      ...previous,
      pid: 0,
      port: config.port,
      portConflict: { at: new Date().toISOString() },
    });
    return 0;
  }
  let onSignal = () => {};
  const signalled = new Promise<void>((r) => (onSignal = r));
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await Promise.race([receiver.idle, signalled]);
    await receiver.close();
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  return 0;
};

/** `javi init --platform gemini-cli`: hooks + the notices ADR-0016 §2 requires. */
const initGeminiHooks = async (
  io: Io,
  projectDir: string,
  cliPath: string,
  projectRef: string,
): Promise<boolean> => {
  let result: Awaited<ReturnType<typeof installGeminiHooks>>;
  try {
    result = await installGeminiHooks(projectDir, process.execPath, cliPath, projectRef);
  } catch (e) {
    io.err(`javi init failed: ${(e as Error).message} No token saved.`);
    return false;
  }
  io.out(`Gemini CLI hooks registered in ${result.path}.`);
  if (result.backup) {
    const ignored = await ensureIgnored(
      projectDir,
      result.backup,
      '.gemini/settings.json.javi-backup',
    );
    io.out(`Your previous settings are backed up in ${result.backup} (${ignored}).`);
  } else {
    io.out('There was no Gemini settings file before, so there was nothing to back up.');
  }
  io.out(
    'Gemini CLI loads .gemini/settings.json only in a trusted folder: trust this folder in Gemini CLI, or no events arrive (javi status --platform gemini-cli then says "no events yet").',
  );
  io.out('Gemini CLI may warn before it runs new or changed project hooks; these hold no token.');
  io.out(
    'Gemini CLI does not wait for SessionEnd hooks, so the end of a session is reported on a best-effort basis.',
  );
  io.out(
    "If you commit .gemini/settings.json, javi's entries (paths on this machine, no token) go with it.",
  );
  if (result.projectTelemetry) {
    io.out(
      "Warning: this project's .gemini/settings.json has its own telemetry block, which overrides javi usage on --platform gemini-cli for sessions in this folder.",
    );
  }
  return true;
};

/** `javi status --platform gemini-cli`: are the hooks there, and has Gemini ever run them? */
const geminiHookStatus = async (
  io: Io,
  state: CollectorState,
  projectDir: string,
  projectRef: string,
) => {
  const path = geminiProjectSettingsPath(projectDir);
  io.out(
    (await geminiHooksInstalled(projectDir))
      ? `Gemini CLI hooks: registered in ${path}`
      : `Gemini CLI hooks: not found in ${path} (run javi init --platform gemini-cli in that folder)`,
  );
  const last = await state.lastHookAt(projectRef, 'gemini-cli');
  io.out(
    last
      ? `Last Gemini CLI hook event: ${last}`
      : 'Gemini CLI hook events: no events yet. Gemini CLI runs project hooks only in a trusted folder.',
  );
};

export const main = async (argv: string[], io: Io): Promise<number> => {
  const [command] = argv;
  const projectRef = flag(argv, 'project');
  const state = createState(javiHome(io.env));
  const platform = platformFlag(argv);

  if (command === 'hook') {
    // Claude Code / Gemini CLI hook: no output on stdout or stderr, exit 0 whatever happens (a
    // hook must stay neutral; Gemini waits for it and parses its output).
    if (projectRef && REF.test(projectRef) && platform) {
      await runHook({
        state,
        projectRef,
        platform,
        stdin: await io.readStdin().catch(() => ''),
        spawnFlush: () => io.spawnFlush(projectRef),
        ensureReceiver: async () => {
          await ensureReceiver({ state, spawnReceiver: io.spawnReceiver });
        },
      });
    }
    return 0;
  }

  if (!platform) {
    io.err(`Unknown --platform: use one of ${PLATFORMS.join(', ')} (default claude-code).`);
    return 2;
  }

  if (command === 'usage') {
    if (argv[1] === 'on') return usageOn(argv, io, state, platform);
    if (argv[1] === 'off') return usageOff(io, state, platform);
    io.err(
      'Usage: javi usage on [--port <n>] [--platform <claude-code|gemini-cli>] | javi usage off [--platform <claude-code|gemini-cli>]',
    );
    return 2;
  }

  if (command === 'receive') return receive(io, state);

  if (!projectRef || !REF.test(projectRef)) {
    io.err(
      'Usage: javi <init|flush|status|uninstall> --project <project slug> [--platform <claude-code|gemini-cli>]',
    );
    return 2;
  }

  switch (command) {
    case 'init': {
      const token = (io.env.JAVI_INGEST_TOKEN ?? (await io.readStdin())).trim();
      if (!TOKEN.test(token)) {
        io.err('Provide the project ingest token via JAVI_INGEST_TOKEN or stdin (jd_it_…).');
        return 2;
      }
      const endpoint = flag(argv, 'endpoint') ?? DEFAULT_ENDPOINT;
      if (!validEndpoint(endpoint)) {
        io.err('The endpoint must be an https:// URL (http:// only for localhost).');
        return 2;
      }
      const projectDir = resolve(io.cwd, flag(argv, 'dir') ?? '.');
      // From the bundle: hooks run a stable, versioned copy. From a repo checkout: this .ts file,
      // as before. The copy comes first: if it fails, no token is saved and no hook registered.
      let cliPath = fileURLToPath(import.meta.url);
      if (BUNDLED) {
        try {
          const installed = await installSelf(state.home, cliPath, COLLECTOR_VERSION);
          cliPath = installed.path;
          io.out(
            installed.copied
              ? `javi ${COLLECTOR_VERSION} installed in ${cliPath}.`
              : `javi ${COLLECTOR_VERSION} already installed in ${cliPath}.`,
          );
        } catch (e) {
          // The error code only: the target path is named here, nothing else is echoed.
          const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
          io.err(
            `javi init failed: could not install javi in ${installTarget(state.home, COLLECTOR_VERSION)} (${code}). Nothing was changed: no token saved, no hooks registered.`,
          );
          return 1;
        }
      }
      if (platform === 'gemini-cli') {
        // Hooks first: a settings file javi cannot edit stops init before the token is saved.
        if (!(await initGeminiHooks(io, projectDir, cliPath, projectRef))) return 1;
        await state.saveCredentials(projectRef, { endpoint, token });
      } else {
        await state.saveCredentials(projectRef, { endpoint, token });
        const path = await installHooks(projectDir, process.execPath, cliPath, projectRef);
        io.out(
          `Hooks registered in ${path} (${await ensureIgnored(projectDir, settingsPath(projectDir))}).`,
        );
      }
      const installation = await state.installation();
      io.out(`Token stored in ${join(state.home, 'credentials.json')} as ${masked(token)}`);
      io.out(`Producer id: ${installation.producer_id}`);

      if (argv.includes('--no-verify')) {
        if (argv.includes('--usage')) {
          io.out('Token usage needs a verified connection: run javi usage on once it works.');
        }
        return 0;
      }
      const client = createJgrClient({
        endpoint,
        token,
        producerId: installation.producer_id,
        spool: createFileSpool(state.spoolDir(projectRef)),
        maxAttempts: 2,
        ...(io.fetch && { fetch: io.fetch }),
      });
      const recorded = await client.record({
        project_ref: projectRef,
        thread_ref: opaqueRef('init', installation.producer_id, installation.salt),
        type: 'x.javi.collector.installed',
        attributes: { platform, collector_version: COLLECTOR_VERSION },
      });
      if (!recorded.ok) {
        io.err(`Could not build the check event: ${recorded.issues.map((i) => i.code).join(', ')}`);
        return 1;
      }
      const result = await runFlush({ state, projectRef, ...(io.fetch && { fetch: io.fetch }) });
      if ('accepted' in result && result.status === 'ok' && result.rejected === 0) {
        io.out("Connection verified: Javi's Dog accepted a check event.");
        return argv.includes('--usage') ? usageOn(argv, io, state, platform) : 0;
      }
      io.err(
        `Connection NOT verified (${JSON.stringify(result)}). Events stay spooled and retry on the next hook.`,
      );
      return 1;
    }

    case 'flush': {
      const result = await runFlush({ state, projectRef, ...(io.fetch && { fetch: io.fetch }) });
      if (!argv.includes('--quiet')) io.out(JSON.stringify(result));
      return 'accepted' in result && result.status !== 'ok' ? 1 : 0;
    }

    case 'status': {
      const creds = await state.credentials(projectRef);
      if (!creds) {
        io.out(`Project ${projectRef}: not configured (run javi init).`);
        await usageStatus(io, state);
        return 1;
      }
      const spooled = await createFileSpool(state.spoolDir(projectRef)).count();
      io.out(`Project ${projectRef}: endpoint ${creds.endpoint}, token ${masked(creds.token)}`);
      io.out(`Spooled events: ${spooled}`);
      io.out(`Last flush: ${JSON.stringify((await state.lastFlush(projectRef)) ?? 'never')}`);
      if (platform === 'gemini-cli') {
        await geminiHookStatus(io, state, resolve(io.cwd, flag(argv, 'dir') ?? '.'), projectRef);
      }
      await usageStatus(io, state);
      return 0;
    }

    case 'uninstall': {
      const projectDir = resolve(io.cwd, flag(argv, 'dir') ?? '.');
      let path: string;
      let removed: boolean;
      if (platform === 'gemini-cli') {
        try {
          ({ path, removed } = await uninstallGeminiHooks(projectDir));
        } catch (e) {
          io.err((e as Error).message);
          return 1;
        }
      } else {
        ({ path, removed } = await uninstallHooks(projectDir));
      }
      io.out(removed ? `Removed javi hooks from ${path}.` : `No hooks found in ${path}.`);
      if (argv.includes('--forget-token')) {
        await state.removeCredentials(projectRef);
        io.out('Token removed from this machine.');
      }
      return 0;
    }

    default:
      io.err(`Unknown command "${command ?? ''}".`);
      return 2;
  }
};

const readAllStdin = async () => {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * True when this file is the program Node started. npm/npx run the bin through a symlink in
 * node_modules/.bin, while import.meta.url is the real path, so compare real paths, except under
 * --preserve-symlinks-main, where import.meta.url keeps the symlink path: accept either.
 */
const isEntryPoint = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  const candidates = [resolve(entry)];
  try {
    candidates.push(realpathSync(entry));
  } catch {
    // argv[1] does not exist as a path: only its resolved form can match.
  }
  return candidates.some((path) => pathToFileURL(path).href === import.meta.url);
};

if (isEntryPoint()) {
  const cliPath = fileURLToPath(import.meta.url);
  const detached = (args: string[]) =>
    spawn(process.execPath, [cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: readAllStdin,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    spawnFlush: (projectRef) => detached(['flush', '--project', projectRef, '--quiet']),
    spawnReceiver: () => detached(['receive']),
  }).then(
    (code) => process.exit(code),
    () => process.exit(process.argv[2] === 'hook' ? 0 : 1),
  );
}
