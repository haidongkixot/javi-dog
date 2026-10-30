#!/usr/bin/env node
// `javi` — Javi's Dog collector for Claude Code (JD-C01, ADR-0010).
//   javi init --project <slug> [--endpoint <url>] [--dir <project dir>] [--no-verify] [--usage]
//            token from JAVI_INGEST_TOKEN or piped stdin; never from argv (shell history)
//   javi init … --privacy L1|L2 [--privacy-key-file <path>]   (ADR-0018 §6)
//            recovery key from a hidden prompt on the terminal (/dev/tty, CONIN$), the key file
//            or JAVI_PRIVACY_KEY (deleted from the environment at once); never from argv. The
//            canary is checked before anything is written. `--privacy L0` removes a stored key.
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
// Codex CLI (ADR-0016 Changes S5c): `--platform codex-cli` on the same commands installs the
//   stable launcher ~/.javi/bin/javi-hook, appends javi's groups to the project's
//   .codex/hooks.json and appends a marked [otel] block (logs only) to $CODEX_HOME/config.toml.
// Agent self-report (ADR-0017): `init --self-report [--allow-self-report] [--allow-tracked-config]`
//   registers javi's MCP server (`javi mcp`) for the platform in the project and installs the
//   hooks; `javi mcp --platform <p> --project <slug>` serves it on stdin/stdout (MCP clients
//   start it through ~/.javi/bin/javi-mcp.mjs); uninstall removes the entry before the hooks.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStdio } from '@javis-dog/collector-mcp-server';
import {
  createFileSpool,
  createJgrClient,
  createMemorySpool,
  createUlid,
} from '@javis-dog/jgr-sdk';
import { childEnv, takePrivacyKeyEnv } from './child-env.ts';
import { loadCrypto } from './crypto-loader.ts';
import {
  DEFAULT_USAGE_PORT,
  claudeUserSettingsPath,
  disableUsageEnv,
  enableUsageEnv,
  usageEnv,
  type EnableResult,
  type SettingsBackup,
} from './claude-env.ts';
import {
  CODEX_BLOCK_END,
  CODEX_BLOCK_START,
  CODEX_LOGS_PATH,
  codexConfigPath,
  codexEnvRisks,
  codexHome,
  codexOtelBlock,
  disableCodexOtel,
  enableCodexOtel,
  readCodexApproval,
  runCommand,
  SYSTEM_PROXY_SOURCE,
  CODEX_OTEL_KEYS,
  type CodexBackup,
  type SystemProxyProbe,
  type EnableCodexResult,
  type EnvFinding,
} from './codex-config.ts';
import {
  codexHooksInstalled,
  codexHooksPath,
  codexHooksTracking,
  codexJaviGroups,
  codexProjectConfigHasHooks,
  installCodexHooks,
  installCodexLauncher,
  probeShellOutput,
  uninstallCodexHooks,
  type CodexShift,
} from './codex-hooks.ts';
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
  findGeminiTelemetryOverrides,
  geminiTelemetryBlock,
  type EnableGeminiResult,
  type GeminiBackup,
} from './gemini-telemetry.ts';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
import {
  CLAUDE_SELF_REPORT_ALLOW,
  SELF_REPORT_BLOCK_START,
  checkSelfReport,
  excludeFromGit,
  installMcpLauncher,
  keysAfterBlockMessage,
  mcpLauncherPath,
  readSelfReport,
  registerSelfReport,
  registrationPath,
  removeExcludeLine,
  unregisterSelfReport,
  type GitRunner,
} from './mcp-registration.ts';
import { PLATFORM_NAMES, PLATFORMS, platformFlag, type Platform } from './platform.ts';
import {
  buildCanaryRecord,
  isPrivacyClass,
  loadProjectKeys,
  PRIVACY_GUIDANCE,
  promptHiddenFromTerminal,
  readKeyFile,
  storedPrivacy,
  UUID_LIKE,
  type HiddenPrompt,
  type KeyedClass,
  type LoadedKeys,
  type StoredPrivacy,
} from './privacy.ts';
import {
  RECEIVER_IDLE_MS,
  createUsageReceiver,
  ensureReceiver,
  isPidAlive,
  liveReceiver,
  probeReceiver,
} from './receiver.ts';
import { runFlush, runHook } from './run.ts';
import { claudeHooksInstalled, installHooks, settingsPath, uninstallHooks } from './settings.ts';
import {
  createState,
  javiHome,
  newInstallation,
  type CollectorState,
  type Installation,
  type ProjectCredentials,
  type UsageConfig,
} from './state.ts';

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
  /**
   * OS proxy settings to check for Codex CLI (S5c code review M3): the CLI passes the real
   * `scutil` / `reg` runner; tests inject one (none means no OS check).
   */
  systemProxy?: SystemProxyProbe;
  /** `init --self-report`: runs git for the tracked check (code review M3); tests inject one. */
  git?: GitRunner;
  /**
   * `init --privacy L1|L2`: the hidden prompt on the terminal (ADR-0018 §6). The CLI passes
   * `promptHiddenFromTerminal`; without one there is no terminal to ask.
   */
  promptHidden?: HiddenPrompt;
  /**
   * `javi mcp` only: the streams the MCP server speaks on (the CLI passes process.stdin,
   * process.stdout and process.stderr for that command only).
   */
  stdio?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
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
    execFileSync('git', ['-C', projectDir, 'check-ignore', '-q', file], {
      stdio: 'ignore',
      env: childEnv(),
    });
    return 'already ignored';
  } catch (e) {
    if ((e as { status?: number }).status !== 1) return 'not a git repository';
  }
  try {
    const gitDir = execFileSync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
      env: childEnv(),
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
  // One receiver and one port serve every platform: moving it would strand the other ones.
  const others = config ? platformsOn(config).filter((p) => p !== platform) : [];
  if (config && others.length && port !== config.port) {
    io.err(
      `javi uses one usage port for all platforms, and ${platformList(others)} usage export is on at port ${config.port}.`,
    );
    io.err(
      `Nothing was changed. Run javi usage off --platform ${others[0]} first, or omit --port.`,
    );
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
  if (platform === 'codex-cli') return codexUsageOn(io, state, config, port, secret, live);

  const path = claudeSettings(io.env);
  // usage.json first, with the values about to be written: settings never hold keys javi has
  // forgotten. Restored (or removed) below when the settings edit is refused or fails.
  const next: UsageConfig = {
    ...config,
    port,
    secret,
    written: usageEnv(port, secret),
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
  io.out(backupLine(result.path, result.backup, "javi's usage keys"));
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
  // R1: a .env of this folder's lookup chain or its workspace telemetry block would send
  // Gemini's logs and javi's bearer elsewhere. Refuse before anything is written.
  const overrides = await findGeminiTelemetryOverrides({
    cwd: io.cwd,
    home: geminiHome(io.env),
    userSettingsPath: path,
  });
  if (overrides.length) {
    io.err(
      'Gemini CLI token usage not enabled: Gemini telemetry settings that override the user settings were found (names only):',
    );
    for (const { source, keys } of overrides) io.err(`  ${source}: ${keys.join(', ')}`);
    io.err(
      "With them, Gemini CLI would send its logs (tool arguments, response text, your email) and javi's receiver token wherever they point. Remove them, then run javi usage on --platform gemini-cli again.",
    );
    io.err(`Nothing was changed in ${path}.`);
    return 1;
  }
  const pending: UsageConfig = {
    ...config,
    port,
    secret,
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
      ...(config?.written && { ownEnv: config.written }),
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
  io.out(`Gemini CLI telemetry export enabled in ${result.path} (user-wide):`);
  io.out(`  telemetry: ${Object.keys(result.written).join(', ')}`);
  io.out('Prompt logging is off (logPrompts: false) and so are traces (traces: false).');
  io.out(backupLine(result.path, result.backup, "javi's telemetry block"));
  io.out(
    'This is user-wide: every Gemini CLI session of this user started from now on, in any folder, exports metrics, logs and traces about every 10 seconds; sessions already running are not affected.',
  );
  io.out(
    `They go to javi at 127.0.0.1:${port} unless that folder overrides it: a GEMINI_TELEMETRY_* or OTEL_EXPORTER_OTLP_* variable (in the shell, a .env or .gemini/.env in the folder or above, ~/.gemini/.env, ~/.env) or a telemetry block in its .gemini/settings.json.`,
  );
  io.out(
    'javi checked this folder just now and re-checks folders with javi hooks at every Gemini CLI session start (javi status shows a warning), but it cannot stop Gemini CLI from following an override.',
  );
  io.out(
    'javi reads only token counts from the metrics; logs and traces are answered and dropped unread.',
  );
  io.out(
    'Gemini CLI reports no cost: javi estimates it from a dated price table (estimated), only for API-key and Vertex AI sign-ins.',
  );
  io.out(
    'Usage of projects without javi init --platform gemini-cli stays on this machine and is dropped.',
  );
  if (!(await liveReceiver(state))) io.spawnReceiver();
  return 0;
};

/** Which platforms export usage to javi's receiver under `config`. */
const platformsOn = (config: UsageConfig): Platform[] =>
  PLATFORMS.filter((p) =>
    p === 'claude-code'
      ? Boolean(config.written)
      : p === 'gemini-cli'
        ? Boolean(config.gemini)
        : Boolean(config.codex),
  );

const platformList = (platforms: Platform[]) =>
  platforms.map((p) => PLATFORM_NAMES[p]).join(' and ');

/** `config` without `platform`'s usage, or null when no platform uses the receiver any more. */
const withoutPlatform = (config: UsageConfig, platform: Platform): UsageConfig | null => {
  const rest = { ...config };
  if (platform === 'claude-code') delete rest.written;
  else if (platform === 'gemini-cli') delete rest.gemini;
  else delete rest.codex;
  return platformsOn(rest).length ? rest : null;
};

const receiverLine = (receiver: 'kept' | 'stopped' | 'none', rest: UsageConfig | null) =>
  receiver === 'kept'
    ? `The usage receiver keeps running for ${platformList(rest ? platformsOn(rest) : [])}.`
    : receiver === 'stopped'
      ? 'Usage receiver stopped.'
      : 'No usage receiver was running.';

const findings = (list: EnvFinding[]) =>
  list.map(({ source, keys }) => `${source}: ${keys.join(', ')}`).join('; ');

/** `a, b and c` */
const listAnd = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');

/** Why a finding counts although it may look harmless (S5c code review H1, M3). */
const proxyNotes = (list: EnvFinding[]) => {
  const notes: string[] = [];
  const keys = list.filter((f) => f.source !== SYSTEM_PROXY_SOURCE).flatMap((f) => f.keys);
  const https = keys.filter((k) => k.toLowerCase() === 'https_proxy');
  if (https.length && https.length === keys.length) {
    notes.push(
      `Only ${https.join(' and ')} is set: javi's endpoint is plain http, so Codex may not use it, but javi refuses to be safe.`,
    );
  }
  if (list.some((f) => f.source === SYSTEM_PROXY_SOURCE)) {
    notes.push(
      "Codex applies the system proxy to 127.0.0.1 too: the macOS bypass list and Windows <local> do not cover 127.0.0.1, only NO_PROXY=127.0.0.1 in Codex's environment does.",
    );
  }
  notes.push(
    "NO_PROXY counts only with 127.0.0.1 or a range holding it (such as 127.0.0.0/8): '*' and 'localhost' do not cover an IP address for Codex.",
  );
  return notes;
};

/** `javi usage on --platform codex-cli`: javi's marked `[otel]` block in Codex's config.toml. */
const codexUsageOn = async (
  io: Io,
  state: CollectorState,
  config: UsageConfig | null,
  port: number,
  secret: string,
  live: Awaited<ReturnType<typeof liveReceiver>>,
): Promise<number> => {
  // usage off edits the file usage on edited, even if CODEX_HOME changed meanwhile.
  const path = config?.codex?.path ?? codexConfigPath(codexHome(io.env));
  // H1: a proxy not bypassed for 127.0.0.1 would carry Codex's logs and javi's bearer away.
  const risks = await codexEnvRisks({
    env: io.env,
    home: dirname(path),
    ...(io.systemProxy && { system: io.systemProxy }),
  });
  if (risks.proxy.length) {
    io.err(
      `Codex CLI token usage not enabled: a proxy is set and NO_PROXY does not cover 127.0.0.1 (names only): ${findings(risks.proxy)}.`,
    );
    for (const line of proxyNotes(risks.proxy)) io.err(line);
    io.err(
      "Codex would send its logs (your email, tool arguments) and javi's receiver token through that proxy. Add 127.0.0.1 to NO_PROXY (or unset the proxy), then run javi usage on --platform codex-cli again.",
    );
    io.err(`Nothing was changed in ${path}.`);
    return 1;
  }
  const pending: UsageConfig = {
    ...config,
    port,
    secret,
    codex: { path, block: codexOtelBlock(port, secret), separator: '', created: false },
  };
  // usage.json first (as for the other platforms): config.toml never holds a secret javi forgot.
  try {
    await state.saveUsageConfig(pending);
  } catch {
    io.err(
      `Codex CLI token usage not enabled: could not save ${join(state.home, 'usage.json')}. Nothing was changed in ${path}.`,
    );
    return 1;
  }
  const restore = () => (config ? state.saveUsageConfig(config) : state.removeUsageConfig());
  let result: EnableCodexResult;
  try {
    result = await enableCodexOtel({
      path,
      port,
      secret,
      ...(config?.codex && { previous: config.codex }),
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
        `Codex CLI token usage not enabled: OpenTelemetry is already configured in ${path} (${(result.keys ?? []).join(', ')}).`,
      );
      io.err('javi never takes over an existing telemetry setup. Nothing was changed.');
    } else {
      io.err(
        `Codex CLI token usage not enabled: ${path} does not parse as TOML, and javi does not edit a file it cannot read. Nothing was changed.`,
      );
    }
    return 1;
  }
  // The separator lets usage off remove exactly what javi added; without it off still removes
  // the block, so a failure here is not worth undoing the edit.
  await state
    .saveUsageConfig({
      ...pending,
      codex: { path, block: result.block, separator: result.separator, created: result.created },
    })
    .catch(() => {});

  await afterUsageOn(state, live, port);
  io.out(`Codex CLI log export enabled in ${result.path} (user-wide):`);
  io.out(
    `  [otel] exporter = otlp-http to 127.0.0.1:${port}${CODEX_LOGS_PATH}; log_user_prompt, log_agent_responses, log_guardian_assessments and log_sse_deltas are false.`,
  );
  io.out(
    "  It sits between '# >>> javi usage (do not edit)' and '# <<< javi'; javi usage off removes exactly that block. metrics_exporter is left as it is.",
  );
  io.out(backupLine(result.path, result.backup, "javi's [otel] block"));
  io.out(
    'This is user-wide: every Codex CLI session of this user started from now on, in any folder, sends its logs to javi; sessions already running are not affected.',
  );
  io.out(
    "With a log exporter set, Codex asks OpenAI for each turn's cost estimate (about every 150 s, best effort).",
  );
  io.out(
    "Codex's logs carry your email and tool arguments. They go only to javi's local receiver, which keeps token counts and cost and drops everything else unread.",
  );
  io.out(
    'Cost is shown only for API-key sign-ins; ChatGPT-plan sessions report tokens only. Codex sends each log batch once: while the receiver is down, those token counts are lost.',
  );
  io.out('A Codex version that does not know one of these keys can fail with --strict-config.');
  if (risks.headers.length) {
    io.out(
      `Warning: ${findings(risks.headers)} replace javi's receiver token in Codex's log export, so javi would reject those logs and count no usage. Unset them for Codex.`,
    );
  }
  if (config?.written) {
    io.out(
      "Note: a Codex session started inside Claude Code inherits javi's Claude Code usage header, and Codex adds it to its default metrics export to OpenAI. javi status warns when a Codex session starts that way.",
    );
  }
  io.out(
    'Usage of projects without javi init --platform codex-cli stays on this machine and is dropped.',
  );
  if (!(await liveReceiver(state))) io.spawnReceiver();
  return 0;
};

/**
 * What `usage on` (any platform) did with the settings backup (ADR-0016 Changes R7 and its
 * Claude Code twin); `ours` names what javi writes into that file.
 */
const backupLine = (
  path: string,
  backup: GeminiBackup | SettingsBackup | CodexBackup,
  ours: string,
) => {
  if (!backup) return 'There was no settings file before, so there was nothing to back up.';
  if (backup.status === 'created') {
    return `A copy of ${path} as it was before this change is in ${backup.path}.`;
  }
  if (backup.status === 'kept') {
    return `An earlier backup in ${backup.path} was kept as it is; it is not a copy of the file before this change.`;
  }
  return `No new backup: ${path} already holds ${ours}.`;
};

/**
 * `javi status`, first lines: Gemini CLI sessions whose telemetry can bypass javi (R1), from the
 * SessionStart checks. Only while Gemini CLI usage is on.
 */
const geminiTelemetryWarnings = async (io: Io, state: CollectorState) => {
  if (!(await state.usageConfig())?.gemini) return;
  for (const warning of await state.geminiTelemetryWarnings()) {
    io.out(
      `WARNING: Gemini CLI telemetry can bypass javi in project ${warning.project} (seen at session start ${warning.at}):`,
    );
    for (const { source, keys } of warning.overrides) io.out(`  ${source}: ${keys.join(', ')}`);
    io.out(
      "  Gemini CLI then sends its logs (tool arguments, response text, your email) and javi's receiver token to that endpoint instead of javi.",
    );
    io.out(
      '  Fix: remove those variables and that telemetry block, or run javi usage off --platform gemini-cli.',
    );
  }
};

/**
 * `javi status`, first lines: what Codex CLI SessionStart hooks found in Codex's environment
 * (H1 proxy, M5 headers, H2 javi's Claude Code header). Names only.
 */
const codexEnvWarnings = async (io: Io, state: CollectorState) => {
  for (const w of await state.codexEnvWarnings()) {
    if (w.proxy.length) {
      io.out(
        `WARNING: Codex CLI logs can bypass javi in project ${w.project} (seen at session start ${w.at}): a proxy without NO_PROXY for 127.0.0.1 (${findings(w.proxy)}).`,
      );
      io.out(
        "  Codex then sends its logs (your email, tool arguments) and javi's receiver token through that proxy.",
      );
      io.out(
        '  Fix: add 127.0.0.1 to NO_PROXY or unset the proxy, or run javi usage off --platform codex-cli.',
      );
    }
    if (w.headers.length) {
      io.out(
        `WARNING: Codex CLI sessions in project ${w.project} replace javi's receiver token (seen at session start ${w.at}): ${findings(w.headers)}.`,
      );
      io.out(
        "  javi's receiver then rejects their logs and counts no usage. Fix: unset them for Codex.",
      );
    }
    if (w.claudeHeader) {
      io.out(
        `WARNING: a Codex CLI session in project ${w.project} started with javi's Claude Code usage header in its environment (seen at session start ${w.at}).`,
      );
      io.out(
        "  Codex adds OTEL_EXPORTER_OTLP_METRICS_HEADERS to its default metrics export to OpenAI, so javi's receiver token (it opens only javi's local receiver) leaves this machine.",
      );
      io.out(
        '  Fix: start Codex outside Claude Code or unset that variable first, or run javi usage off for Claude Code.',
      );
    }
  }
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
  if (platform === 'codex-cli') return codexUsageOff(io, state);
  const config = await state.usageConfig();
  if (!config) {
    io.out('Token usage export is already off.');
    return 0;
  }
  if (!config.written) {
    io.out('Token usage export for Claude Code is already off.');
    return 0;
  }
  const { path, removed, unreadable, backupRemoved } = await disableUsageEnv({
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
  const rest = withoutPlatform(config, 'claude-code');
  const receiver = await releaseUsage(state, rest);
  io.out(
    removed.length
      ? `Removed from ${path}: ${removed.join(', ')}.`
      : `Nothing to remove from ${path} (those keys were already changed or removed).`,
  );
  if (backupRemoved) io.out(`Removed the backup ${backupRemoved}: it is no longer needed.`);
  io.out(receiverLine(receiver, rest));
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
  const { outcome, backupRemoved } = await disableGeminiTelemetry({
    path,
    written,
    sha256,
    before,
  });
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
  await state.clearGeminiTelemetryWarnings();
  const rest = withoutPlatform(config, 'gemini-cli');
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
  if (backupRemoved) io.out(`Removed the backup ${backupRemoved}: it is no longer needed.`);
  io.out(receiverLine(receiver, rest));
  io.out('New Gemini CLI sessions no longer export telemetry to javi.');
  return 0;
};

const codexUsageOff = async (io: Io, state: CollectorState): Promise<number> => {
  const config = await state.usageConfig();
  if (!config?.codex) {
    io.out('Token usage export for Codex CLI is already off.');
    return 0;
  }
  const { path, outcome, backupRemoved } = await disableCodexOtel(config.codex);
  if (outcome === 'changed') {
    // Usage stays on: Codex keeps exporting to javi until the user removes javi's lines, so
    // usage.json, the receiver and the warnings stay as they are (S5c code review H2).
    io.err(
      `Codex CLI token usage is still on: javi's block in ${path} was changed since usage on, so javi left the file as it is.`,
    );
    io.err(
      `Remove javi's lines yourself: the line '${CODEX_BLOCK_START}', the [otel] table header and its keys ${listAnd([...CODEX_OTEL_KEYS])}, and the line '${CODEX_BLOCK_END}' (Codex may have moved it to the end of the file). Keep every other table as it is.`,
    );
    io.err('Then run javi usage off --platform codex-cli again.');
    return 1;
  }
  await state.clearCodexEnvWarnings();
  const rest = withoutPlatform(config, 'codex-cli');
  const receiver = await releaseUsage(state, rest);
  io.out(
    outcome === 'removed'
      ? `Removed javi's [otel] block from ${path}; everything else in it is kept as it is.`
      : outcome === 'deleted'
        ? `Removed ${path}: javi had created it for usage on and nothing else is in it.`
        : `Nothing to remove from ${path} (javi's block is no longer there).`,
  );
  if (backupRemoved) io.out(`Removed the backup ${backupRemoved}: it is no longer needed.`);
  io.out(receiverLine(receiver, rest));
  io.out('New Codex CLI sessions no longer export logs to javi.');
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
  if (config.gemini || config.codex || !config.written) {
    io.out(`Claude Code usage: ${config.written ? 'on' : 'off'}`);
    io.out(`Gemini CLI usage: ${config.gemini ? `on (${config.gemini.path})` : 'off'}`);
    io.out(`Codex CLI usage: ${config.codex ? `on (${config.codex.path})` : 'off'}`);
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

const shiftLines = (shifts: CodexShift[]) =>
  shifts.map(
    ({ event, groups }) =>
      `  ${event}: ${groups} of your hook group${groups === 1 ? '' : 's'} changed position; Codex trusts hooks by position, so it will ask you to review ${groups === 1 ? 'it' : 'them'} again.`,
  );

/** `javi init --platform codex-cli`: launcher, hooks and the notices ADR-0016 S5c requires. */
const initCodexHooks = async (
  io: Io,
  state: CollectorState,
  projectDir: string,
  cliPath: string,
  projectRef: string,
): Promise<boolean> => {
  let result: Awaited<ReturnType<typeof installCodexHooks>>;
  let launchers: Awaited<ReturnType<typeof installCodexLauncher>>;
  try {
    // The launcher first: hooks.json only ever names it, never a versioned path (H4).
    launchers = await installCodexLauncher(state.home, process.execPath, cliPath);
    const hooksPath = codexHooksPath(projectDir);
    result = await installCodexHooks(
      projectDir,
      launchers,
      projectRef,
      await state.codexHooksOrigin(hooksPath),
    );
    // What the file was before javi, so uninstall restores it (L5).
    await state.saveCodexHooksOrigin(hooksPath, result.origin);
  } catch (e) {
    io.err(`javi init failed: ${(e as Error).message} No token saved.`);
    return false;
  }
  io.out(`Codex CLI hook launcher written: ${launchers.posix} (Windows: ${launchers.windows}).`);
  io.out(
    `  It runs ${cliPath} with ${process.execPath}; javi init rewrites it, the hook commands stay the same.`,
  );
  const changed = [...result.appended, ...result.updated];
  io.out(
    changed.length
      ? `Codex CLI hooks added to ${result.path} for ${changed.length} events; your own hook groups keep their positions.`
      : `Codex CLI hooks already in ${result.path}; nothing changed.`,
  );
  if (result.updated.length) {
    io.out(`  Changed in place (Codex asks to review these again): ${result.updated.join(', ')}.`);
  }
  for (const line of shiftLines(result.shifts)) io.out(line);
  io.out(
    'Codex runs project hooks only in a trusted project and only after you approve them: Codex shows "Hooks need review" at startup (or use /hooks). javi never approves hooks for you.',
  );
  io.out(
    'Until the first event arrives, javi status --platform codex-cli says "waiting for approval in Codex".',
  );
  io.out('Codex waits at most 3 s for SessionEnd hooks, so the end of a session is best effort.');
  const hooksTracking = codexHooksTracking(projectDir, io.git);
  if (hooksTracking === 'tracked') {
    io.out(
      'Warning: .codex/hooks.json is tracked by git. It now holds the launcher path on this machine (with your user name); commit it only if you mean to.',
    );
  } else if (hooksTracking === 'unknown') {
    io.out(
      'Warning: javi could not check whether git tracks .codex/hooks.json (git is missing, failed or did not answer in time). It now holds the launcher path on this machine (with your user name); do not commit it unless you mean to.',
    );
  }
  if (await codexProjectConfigHasHooks(projectDir)) {
    io.out(
      "Warning: this project's .codex/config.toml has a [hooks] table as well; Codex warns when a folder defines hooks in both places.",
    );
  }
  for (const { command, problem } of probeShellOutput(io.env, projectDir)) {
    io.out(
      problem === 'timeout'
        ? `Warning: '${command}' did not finish within 2 s. Codex starts every hook in your shell, so each hook would wait for it.`
        : `Warning: '${command}' printed something (${problem}). Codex runs hooks in your shell and passes plain hook output to the model as context (SessionStart, SubagentStart, UserPromptSubmit; on Stop it is an error). Remove that output from your shell startup files.`,
    );
  }
  return true;
};

/** Folders Codex may key this project's trust by: the folder and its repository root. */
const codexProjectDirs = (projectDir: string) => {
  const dirs = [projectDir];
  try {
    dirs.push(realpathSync(projectDir));
  } catch {
    // keep the plain path
  }
  try {
    const top = execFileSync('git', ['-C', projectDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: childEnv(),
    }).trim();
    if (top) dirs.push(top);
  } catch {
    // not a git repository
  }
  return [...new Set(dirs)];
};

/** `javi status --platform codex-cli`: registered, trusted, approved, and seen running? (M3) */
const codexHookStatus = async (
  io: Io,
  state: CollectorState,
  projectDir: string,
  projectRef: string,
) => {
  const hooksPath = codexHooksPath(projectDir);
  const positions = await codexJaviGroups(projectDir, projectRef);
  if (!positions.length) {
    io.out(
      `Codex CLI hooks: not found in ${hooksPath} (run javi init --platform codex-cli in that folder)`,
    );
  } else {
    const configPath = codexConfigPath(codexHome(io.env));
    const approval = await readCodexApproval({
      configPath,
      projectDirs: codexProjectDirs(projectDir),
      hooksPath,
      positions,
    });
    if (approval.kind === 'unreadable') {
      io.out(
        `Codex CLI hooks: registered in ${hooksPath}; javi cannot read ${configPath} to see whether they are approved.`,
      );
    } else if (approval.trust !== 'trusted') {
      io.out(
        `Codex CLI hooks: project not trusted — Codex loads ${hooksPath} only in a trusted project (trust it when Codex asks).`,
      );
    } else if (approval.approved < approval.total) {
      io.out(
        `Codex CLI hooks: hooks not approved (${approval.approved} of ${approval.total}) — approve them in Codex: "Hooks need review" at startup, or /hooks.`,
      );
    } else {
      io.out(`Codex CLI hooks: approved (${approval.approved} of ${approval.total})`);
    }
    if (approval.kind === 'ok' && approval.disabled) {
      io.out(`  ${approval.disabled} of javi's Codex hooks are turned off in Codex (/hooks).`);
    }
  }
  const last = await state.lastHookAt(projectRef, 'codex-cli');
  io.out(
    last
      ? `Last Codex CLI hook event: ${last}`
      : 'Codex CLI hook events: no events yet (waiting for approval in Codex).',
  );
};

/** True when `platform`'s hooks for `projectRef` are installed in `projectDir`. */
const hooksInstalledFor = (platform: Platform, projectDir: string, projectRef: string) =>
  platform === 'gemini-cli'
    ? geminiHooksInstalled(projectDir, projectRef)
    : platform === 'codex-cli'
      ? codexHooksInstalled(projectDir, projectRef)
      : claudeHooksInstalled(projectDir, projectRef);

const hooksFileFor = (platform: Platform, projectDir: string) =>
  platform === 'gemini-cli'
    ? geminiProjectSettingsPath(projectDir)
    : platform === 'codex-cli'
      ? codexHooksPath(projectDir)
      : settingsPath(projectDir);

// --- Agent self-report (ADR-0017) ---

/**
 * `javi mcp`: are javi's hooks for `platform` and `projectRef` installed? An MCP client's
 * working directory is not guaranteed to be the project folder, so the folders `init
 * --self-report` recorded for this platform and project come first, then the working
 * directory. Either way the platform's hooks file itself must hold javi's hook for the project.
 * Never reads credentials.json (the token).
 */
const selfReportHooksInstalled = async (
  state: CollectorState,
  platform: Platform,
  projectRef: string,
  cwd: string,
) => {
  const dirs = (await state.selfReportRegistrations())
    .filter((r) => r.platform === platform && r.project === projectRef)
    .map((r) => r.dir);
  for (const dir of new Set([...dirs, cwd])) {
    if (await hooksInstalledFor(platform, dir, projectRef)) return true;
  }
  return false;
};

const selfReportCommand = (platform: Platform) =>
  `javi init --self-report${platform === 'claude-code' ? '' : ` --platform ${platform}`}`;

/** `init --self-report`, after the hooks: launcher, MCP entry, optional pre-approval. */
const initSelfReport = async (
  io: Io,
  state: CollectorState,
  platform: Platform,
  projectDir: string,
  cliPath: string,
  projectRef: string,
  preApprove: boolean,
): Promise<boolean> => {
  const file = registrationPath(platform, projectDir);
  let launcher: string;
  let result: Awaited<ReturnType<typeof registerSelfReport>>;
  let excludeNote = '';
  try {
    launcher = await installMcpLauncher(state.home, cliPath);
    const previous = await state.selfReportRegistration(platform, file);
    result = await registerSelfReport({
      platform,
      projectDir,
      projectRef,
      nodePath: process.execPath,
      launcher,
      preApprove,
      previous,
    });
    // Code review L2: a .mcp.json javi created stays out of commits, like settings.local.json.
    let excluded = previous?.excluded ?? null;
    if (platform === 'claude-code' && result.record.created && !excluded) {
      const ignored = await excludeFromGit(projectDir, file);
      excludeNote = ignored.note;
      excluded = ignored.added;
    }
    await state.saveSelfReportRegistration({ ...result.record, excluded });
  } catch (e) {
    io.err(
      `Self-report not registered: ${(e as Error).message} javi's hooks and the token are in place; re-run ${selfReportCommand(platform)} once the file is fixed.`,
    );
    return false;
  }
  const name = PLATFORM_NAMES[platform];
  io.out(`Self-report launcher written: ${launcher}.`);
  io.out(
    `  It runs ${cliPath} mcp; javi init rewrites it, so the registered command stays the same after an upgrade.`,
  );
  io.out(
    result.changed
      ? `Self-report MCP server "javi" registered in ${result.file}.`
      : `Self-report MCP server "javi" already registered in ${result.file}; nothing changed.`,
  );
  io.out(
    `  ${name} starts: ${process.execPath} --no-warnings ${launcher} --platform ${platform} --project ${projectRef} (no token, no environment variables).`,
  );
  if (excludeNote) io.out(`  javi created ${result.file}: ${excludeNote}.`);
  io.out(
    `  If you commit ${result.file}, javi's entry (paths on this machine) goes with it. If Node.js moves, run ${selfReportCommand(platform)} again; javi status warns about it.`,
  );
  if (platform === 'claude-code') {
    io.out('Claude Code asks once whether to use the MCP servers of a project .mcp.json.');
    if (preApprove) {
      io.out(
        result.allowAdded.length
          ? `Pre-approved in ${settingsPath(projectDir)}: ${result.allowAdded.join(', ')} (javi uninstall removes exactly what javi added).`
          : `Pre-approval already in ${settingsPath(projectDir)}: ${CLAUDE_SELF_REPORT_ALLOW.join(', ')}.`,
      );
    } else {
      if (result.allowRemoved.length) {
        io.out(
          `Removed javi's earlier pre-approval from ${settingsPath(projectDir)}: ${result.allowRemoved.join(', ')}.`,
        );
      }
      io.out(
        'Not pre-approved: Claude Code asks before each report (you can choose to always allow it there), or re-run with --allow-self-report.',
      );
    }
  } else if (platform === 'gemini-cli') {
    io.out('Gemini CLI starts stdio MCP servers only in a trusted folder.');
    io.out(
      preApprove
        ? 'Pre-approved: trust and includeTools (report_status, report_task) are set on the javi entry only.'
        : 'Not pre-approved: Gemini CLI asks before each report, or re-run with --allow-self-report.',
    );
  } else {
    io.out(
      `Codex CLI reads ${result.file} only in a trusted project. It decides about approval from the tools' annotations, so there is nothing to pre-approve${preApprove ? ' (--allow-self-report writes nothing for Codex CLI)' : ''}.`,
    );
  }
  io.out(
    `Self-report needs javi's ${name} hooks: they record each report for the dashboard, labelled "reported by agent".`,
  );
  return true;
};

/**
 * A value read from a registration file (repository content) as it may be printed: C0 and C1
 * control characters removed, so a planted entry cannot drive the terminal (code review L3).
 */
const printable = (value: unknown) =>
  // eslint-disable-next-line no-control-regex
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '') : '';

/** `javi status`: is self-report registered for this platform and project, pre-approved, runnable? */
const selfReportStatus = async (
  io: Io,
  platform: Platform,
  projectDir: string,
  projectRef: string,
) => {
  const sr = await readSelfReport(platform, projectDir);
  const command = selfReportCommand(platform);
  if (!sr.entry) {
    io.out(
      sr.unreadable
        ? `Self-report: javi cannot read ${sr.file}.`
        : `Self-report: not registered in ${sr.file} (${command} adds it).`,
    );
    return;
  }
  if (sr.project !== projectRef) {
    io.out(
      `Self-report: registered in ${sr.file} for another project (${sr.project === null ? 'none' : printable(sr.project)}).`,
    );
    return;
  }
  io.out(`Self-report: registered in ${sr.file} (MCP server javi).`);
  if (sr.preApproved === null) {
    io.out("Self-report pre-approval: not needed (Codex CLI decides from the tools' annotations).");
  } else if (sr.preApproved) {
    io.out(
      platform === 'claude-code'
        ? `Self-report pre-approval: on (${CLAUDE_SELF_REPORT_ALLOW.join(', ')} in ${settingsPath(projectDir)}).`
        : 'Self-report pre-approval: on (trust and includeTools on the javi entry).',
    );
  } else {
    io.out(
      `Self-report pre-approval: off (${PLATFORM_NAMES[platform]} asks before each report; ${command} --allow-self-report pre-approves).`,
    );
  }
  if (!sr.nodeExists) {
    io.out(
      `Warning: the Node.js path registered for self-report (${printable(sr.entry.command)}) no longer exists, so ${PLATFORM_NAMES[platform]} cannot start javi's MCP server. Run ${command} again.`,
    );
  }
  if (!sr.launcherExists) {
    io.out(
      `Warning: the self-report launcher ${printable(sr.entry.args[1])} is missing. Run ${command} again.`,
    );
  } else if (!sr.launcherTargetExists) {
    io.out(
      sr.launcherTarget
        ? `Warning: the self-report launcher ${printable(sr.entry.args[1])} runs ${printable(sr.launcherTarget)}, which is missing, so ${PLATFORM_NAMES[platform]} cannot start javi's MCP server. Run ${command} again.`
        : `Warning: javi cannot read which javi the self-report launcher ${printable(sr.entry.args[1])} runs. Run ${command} again.`,
    );
  }
};

/**
 * `javi uninstall`, before the hooks: javi's MCP entry for this project and the allow rules javi
 * added. False when the file cannot be read or javi's block was edited (nothing removed).
 */
const uninstallSelfReport = async (
  io: Io,
  state: CollectorState,
  platform: Platform,
  projectDir: string,
  projectRef: string,
): Promise<boolean> => {
  const file = registrationPath(platform, projectDir);
  const record = await state.selfReportRegistration(platform, file);
  let result: Awaited<ReturnType<typeof unregisterSelfReport>>;
  try {
    result = await unregisterSelfReport({ platform, projectDir, projectRef, record });
  } catch (e) {
    io.err((e as Error).message);
    return false;
  }
  if (result.outcome === 'changed' && result.keysBelow.length) {
    io.err(keysAfterBlockMessage(file, result.keysBelow));
    io.err('Nothing was removed; run javi uninstall again once they are moved.');
    return false;
  }
  if (result.outcome === 'changed') {
    io.err(
      `javi's self-report block in ${file} was edited, so javi left the file as it is and removed nothing.`,
    );
    io.err(
      `Remove javi's lines yourself, '${SELF_REPORT_BLOCK_START}' through '${CODEX_BLOCK_END}' included, then run javi uninstall again.`,
    );
    return false;
  }
  if (result.unreadable) {
    io.out(
      `Warning: javi cannot read ${file}, and javi never registered self-report there, so it was left as it is.`,
    );
  }
  if (result.outcome === 'removed') io.out(`Removed javi's self-report MCP server from ${file}.`);
  if (result.outcome === 'deleted') {
    io.out(`${file} held only javi's self-report MCP server, so the file was removed.`);
  }
  if (result.allowRemoved.length) {
    io.out(
      `Removed javi's self-report pre-approval from ${settingsPath(projectDir)}: ${result.allowRemoved.join(', ')}.`,
    );
  }
  if (result.outcome !== 'absent') {
    io.out(
      `The launcher ${mcpLauncherPath(state.home)} stays: other projects may use it, and it holds no token.`,
    );
  }
  if (record?.project === projectRef || result.outcome !== 'absent') {
    if (record?.excluded && (await removeExcludeLine(record.excluded))) {
      io.out(`Removed ${record.excluded.line} from ${record.excluded.exclude}.`);
    }
    await state.removeSelfReportRegistration(platform, file);
  }
  return true;
};

// --- Privacy classes L1/L2 (ADR-0018 §5, §6) ---

type PrivacyRequest =
  { class: 'L0' } | { class: KeyedClass; loaded: LoadedKeys; stored: StoredPrivacy };

const NOTHING_SAVED = 'Nothing was saved: no token, key or hooks.';

type PrivacyFlags = { class: 'L0' } | { class: KeyedClass; keyFile: string | null };

/**
 * `--privacy L0|L1|L2 [--privacy-key-file <path>]` of `javi init` (review H2, H3): refused with
 * `--no-verify` and with a UUID-looking project ref. Returns null without `--privacy`, an exit
 * code on refusal.
 */
const checkPrivacyFlags = (
  argv: string[],
  io: Io,
  projectRef: string,
): PrivacyFlags | number | null => {
  const keyFileGiven = argv.includes('--privacy-key-file');
  if (!argv.includes('--privacy')) {
    if (keyFileGiven) {
      io.err('--privacy-key-file only applies with --privacy L1 or --privacy L2.');
      return 2;
    }
    return null;
  }
  const value = flag(argv, 'privacy');
  if (!isPrivacyClass(value)) {
    io.err('Use --privacy L0, --privacy L1 or --privacy L2.');
    return 2;
  }
  if (argv.includes('--no-verify')) {
    io.err(
      "--privacy needs the check against Javi's Dog before anything is saved; it cannot be combined with --no-verify.",
    );
    return 2;
  }
  if (UUID_LIKE.test(projectRef)) {
    io.err(
      '--privacy needs the project slug (as shown on the project page), not the project id: the slug is part of every encrypted event.',
    );
    return 2;
  }
  if (value === 'L0') {
    if (keyFileGiven) {
      io.err('--privacy L0 needs no recovery key: leave out --privacy-key-file.');
      return 2;
    }
    return { class: 'L0' };
  }
  const keyFile = flag(argv, 'privacy-key-file');
  if (keyFileGiven && (!keyFile || keyFile.startsWith('--'))) {
    io.err('--privacy-key-file needs a path.');
    return 2;
  }
  return { class: value, keyFile: keyFile ?? null };
};

/**
 * The recovery key of an L1/L2 request from exactly one source — `--privacy-key-file`,
 * `JAVI_PRIVACY_KEY` (already deleted from the environment) or the hidden terminal prompt —
 * parsed with its checksum, and the project keys derived from it. An exit code on refusal.
 * Never echoes the key.
 */
const readPrivacyRequest = async (
  flags: PrivacyFlags,
  io: Io,
  projectRef: string,
  envKey: string | undefined,
): Promise<PrivacyRequest | number> => {
  if (flags.class === 'L0') return { class: 'L0' };
  for (const line of PRIVACY_GUIDANCE) io.out(line);
  const { keyFile } = flags;
  const value = flags.class;
  if (keyFile && envKey !== undefined) {
    io.err('Give the recovery key one way only: --privacy-key-file or JAVI_PRIVACY_KEY.');
    return 2;
  }
  let text: string;
  if (keyFile) {
    const read = await readKeyFile(resolve(io.cwd, keyFile));
    if (!read.ok) {
      io.err(read.message);
      return 2;
    }
    text = read.text;
  } else if (envKey !== undefined) {
    text = envKey;
  } else {
    const answer = io.promptHidden
      ? await io.promptHidden(`Recovery key for ${projectRef} (input hidden): `)
      : ({ ok: false, reason: 'no-terminal' } as const);
    if (!answer.ok) {
      io.err(
        answer.reason === 'cancelled'
          ? `Cancelled. ${NOTHING_SAVED}`
          : 'No terminal to read the recovery key from. Run javi init --privacy yourself in a terminal, or give the key with --privacy-key-file <path> or JAVI_PRIVACY_KEY.',
      );
      return answer.reason === 'cancelled' ? 1 : 2;
    }
    text = answer.text;
  }
  const { deriveProjectKeys, encodeRecoveryKey, parseRecoveryKey } = await loadCrypto();
  const parsed = await parseRecoveryKey(text);
  if (!parsed.ok) {
    io.err(`The recovery key was not accepted: ${parsed.message}`);
    return 2;
  }
  const keys = await deriveProjectKeys(parsed.secret, projectRef);
  const canonical = await encodeRecoveryKey(parsed.secret);
  parsed.secret.fill(0);
  return {
    class: value,
    loaded: { class: value, keys },
    stored: { class: value, key: canonical },
  };
};

/** Issue codes as the JGR spec spells them (spec §13); anything else is shown as `unknown`. */
const issueCodes = (codes: string[]) => [
  ...new Set(codes.map((c) => (/^[a-z][a-z0-9_]{0,63}$/.test(c) ? c : 'unknown'))),
];

/**
 * The canary (ADR-0018 §5, §6, review H2): the installation event in the requested class, sent
 * through an in-memory spool before anything is written. Accepted → null; otherwise the
 * message to show. `rejected[].issues[].code` decides: `privacy_class_not_allowed` means the
 * project's class is lower than the one requested.
 */
const checkCanary = async (
  io: Io,
  args: Readonly<{
    endpoint: string;
    token: string;
    projectRef: string;
    platform: Platform;
    installation: Installation;
    request: PrivacyRequest;
  }>,
): Promise<string | null> => {
  const codes: string[] = [];
  const client = createJgrClient({
    endpoint: args.endpoint,
    token: args.token,
    producerId: args.installation.producer_id,
    spool: createMemorySpool(),
    maxAttempts: 2,
    ...(io.fetch && { fetch: io.fetch }),
    onRejected: (rejected) => {
      for (const event of rejected) {
        for (const issue of event.issues ?? []) codes.push(String(issue?.code));
      }
    },
  });
  const { request } = args;
  const cls = request.class;
  const record = await buildCanaryRecord({
    loaded: request.class === 'L0' ? null : request.loaded,
    projectRef: args.projectRef,
    producerId: args.installation.producer_id,
    threadRef: opaqueRef('init', args.installation.producer_id, args.installation.salt),
    platform: args.platform,
    eventId: createUlid()(),
  });
  const recorded = await client.record(record);
  if (!recorded.ok) {
    return `Could not build the ${cls} check event (${issueCodes(recorded.issues.map((i) => i.code)).join(', ')}).`;
  }
  const result = await client.flush();
  if (result.status === 'ok' && result.rejected === 0 && result.accepted + result.duplicates > 0) {
    return null;
  }
  const unique = issueCodes(codes);
  if (unique.includes('privacy_class_not_allowed')) {
    return `Javi's Dog refused the ${cls} check event (privacy_class_not_allowed): project ${args.projectRef} does not accept privacy class ${cls} yet. An owner or admin raises the class on the project page first; then run this again.`;
  }
  if (unique.length) return `Javi's Dog refused the ${cls} check event (${unique.join(', ')}).`;
  if (result.status === 'unauthorized') {
    return `The ingest token was refused (HTTP ${result.httpStatus ?? 401}).`;
  }
  const http = result.httpStatus ? `, HTTP ${result.httpStatus}` : '';
  return `Javi's Dog did not confirm the ${cls} check event (${result.status}${http}).`;
};

/** The project's credentials entry after init: the privacy part kept, replaced or removed. */
const credentialsAfterInit = (
  endpoint: string,
  token: string,
  request: PrivacyRequest | null,
  existing: ProjectCredentials | null,
): ProjectCredentials => {
  const kept = storedPrivacy(existing?.privacy);
  const privacy = request === null ? kept : request.class === 'L0' ? null : request.stored;
  return { endpoint, token, ...(privacy && { privacy }) };
};

/** What `javi init` did with the project's privacy class (never the key). */
const privacyInitLines = async (
  io: Io,
  state: CollectorState,
  projectRef: string,
  request: PrivacyRequest | null,
  previous: ProjectCredentials | null,
  creds: ProjectCredentials,
) => {
  const file = join(state.home, 'credentials.json');
  const had = storedPrivacy(previous?.privacy);
  if (request?.class === 'L0') {
    io.out(
      had
        ? `Privacy class L0: the recovery key for ${projectRef} was removed from ${file}.`
        : `Privacy class L0: no recovery key was stored for ${projectRef}.`,
    );
    return;
  }
  const kept = storedPrivacy(creds.privacy);
  if (!kept) return;
  const loaded = request ? request.loaded : await loadProjectKeys(kept, projectRef);
  const kid = loaded ? `key ${loaded.keys.kid}` : 'the stored key cannot be read';
  io.out(
    request
      ? `Privacy class ${kept.class}: recovery key stored in ${file} (${kid}). The key is never printed.`
      : `Privacy class ${kept.class} kept (${kid}); javi init --privacy L0 removes the key.`,
  );
};

/** `javi status`: class and kid (never the key), and the last rejected events (codes only). */
const privacyStatus = async (
  io: Io,
  state: CollectorState,
  projectRef: string,
  creds: ProjectCredentials,
) => {
  const privacy = storedPrivacy(creds.privacy);
  if (!privacy) {
    io.out('Privacy class: L0 (no recovery key stored).');
  } else {
    const loaded = await loadProjectKeys(privacy, projectRef);
    io.out(
      loaded
        ? `Privacy class: ${privacy.class} (key ${loaded.keys.kid}; the key itself is never shown).`
        : `Privacy class: ${privacy.class}, but the stored recovery key cannot be read: run javi init --privacy ${privacy.class} again.`,
    );
  }
  const rejections = await state.lastRejections(projectRef);
  if (!rejections) {
    io.out('Rejected events: none recorded.');
    return;
  }
  io.out(
    `Last rejected events: ${rejections.events} at ${rejections.at} (${issueCodes(rejections.codes).join(', ')}).`,
  );
  if (rejections.codes.includes('privacy_class_not_allowed')) {
    io.out(
      'privacy_class_not_allowed: the project accepts a lower privacy class than this machine sends. Status events still arrive (they stay L0); only the repo and branch identity is refused. Raise the class on the project page, or run javi init --privacy L0.',
    );
  }
};

export const main = async (argv: string[], io: Io): Promise<number> => {
  const [command] = argv;
  // ADR-0018 §6 (review M3): read once and deleted from the environment before anything runs.
  const envKey = takePrivacyKeyEnv(io.env);
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
        env: io.env,
        cwd: io.cwd,
        ...(io.systemProxy && { systemProxy: io.systemProxy }),
      });
    }
    return 0;
  }

  if (command === 'mcp') {
    // MCP server on stdin/stdout (ADR-0017 §1): stdout carries JSON-RPC only, so every message
    // here goes to stderr. No token is read, no receiver started, no flush.
    const stdio = io.stdio;
    if (!platform || !projectRef || !REF.test(projectRef) || !stdio) {
      io.err(`Usage: javi mcp --platform <${PLATFORMS.join('|')}> --project <project slug>`);
      return 2;
    }
    await serveStdio(stdio.stdin, stdio.stdout, stdio.stderr, {
      version: COLLECTOR_VERSION,
      hooksInstalled: () => selfReportHooksInstalled(state, platform, projectRef, io.cwd),
    });
    // Let the last response reach the pipe before the process exits.
    await new Promise<void>((done) => stdio.stdout.write('', () => done()));
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
      `Usage: javi usage on [--port <n>] [--platform <${PLATFORMS.join('|')}>] | javi usage off [--platform <${PLATFORMS.join('|')}>]`,
    );
    return 2;
  }

  if (command === 'receive') return receive(io, state);

  if (!projectRef || !REF.test(projectRef)) {
    io.err(
      `Usage: javi <init|flush|status|uninstall> --project <project slug> [--platform <${PLATFORMS.join('|')}>]`,
    );
    return 2;
  }

  switch (command) {
    case 'init': {
      const selfReport = argv.includes('--self-report');
      const preApprove = argv.includes('--allow-self-report');
      const allowTracked = argv.includes('--allow-tracked-config');
      if (!selfReport && (preApprove || allowTracked)) {
        io.err('--allow-self-report and --allow-tracked-config only apply with --self-report.');
        return 2;
      }
      // ADR-0018 §6: the --privacy flags are checked before the token is read.
      const privacyFlags = checkPrivacyFlags(argv, io, projectRef);
      if (typeof privacyFlags === 'number') return privacyFlags;
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
      if (selfReport) {
        // Before anything is written: a tracked, unreadable or foreign registration file stops
        // init with no token saved and no hooks registered.
        const check = await checkSelfReport({
          platform,
          projectDir,
          allowTracked,
          allowSelfReport: preApprove,
          ...(io.git && { git: io.git }),
        });
        if (!check.ok) {
          io.err(check.message);
          return 1;
        }
      }
      // ADR-0018 §6 (review H2): with --privacy, the key is read and the canary checked before
      // anything is written — no token, key, hook, installation file or javi copy.
      let privacy: PrivacyRequest | null = null;
      let canaryInstallation: Installation | undefined;
      if (privacyFlags) {
        const request = await readPrivacyRequest(privacyFlags, io, projectRef, envKey);
        if (typeof request === 'number') return request;
        privacy = request;
        canaryInstallation = (await state.peekInstallation()) ?? newInstallation();
        const refused = await checkCanary(io, {
          endpoint,
          token,
          projectRef,
          platform,
          installation: canaryInstallation,
          request,
        });
        if (refused) {
          io.err(`${refused} ${NOTHING_SAVED}`);
          return 1;
        }
      }
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
      // After a canary, its producer id is the one stored (when none existed yet); without
      // --privacy the installation is created after the hooks, as before.
      const canaryProducer = canaryInstallation
        ? await state.installation(canaryInstallation)
        : null;
      const previous = await state.credentials(projectRef);
      const creds = credentialsAfterInit(endpoint, token, privacy, previous);
      if (platform === 'gemini-cli') {
        // Hooks first: a settings file javi cannot edit stops init before the token is saved.
        if (!(await initGeminiHooks(io, projectDir, cliPath, projectRef))) return 1;
        await state.saveCredentials(projectRef, creds);
      } else if (platform === 'codex-cli') {
        if (!(await initCodexHooks(io, state, projectDir, cliPath, projectRef))) return 1;
        await state.saveCredentials(projectRef, creds);
      } else {
        await state.saveCredentials(projectRef, creds);
        const path = await installHooks(projectDir, process.execPath, cliPath, projectRef);
        io.out(
          `Hooks registered in ${path} (${await ensureIgnored(projectDir, settingsPath(projectDir))}).`,
        );
      }
      if (
        selfReport &&
        !(await initSelfReport(io, state, platform, projectDir, cliPath, projectRef, preApprove))
      ) {
        return 1;
      }
      const installation = canaryProducer ?? (await state.installation());
      io.out(`Token stored in ${join(state.home, 'credentials.json')} as ${masked(token)}`);
      io.out(`Producer id: ${installation.producer_id}`);
      await privacyInitLines(io, state, projectRef, privacy, previous, creds);
      if (privacy) {
        io.out(
          `Connection verified: Javi's Dog accepted the ${privacy.class} check event before anything was saved.`,
        );
        return argv.includes('--usage') ? usageOn(argv, io, state, platform) : 0;
      }

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
      await geminiTelemetryWarnings(io, state);
      await codexEnvWarnings(io, state);
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
      await privacyStatus(io, state, projectRef, creds);
      const statusDir = resolve(io.cwd, flag(argv, 'dir') ?? '.');
      if (platform === 'gemini-cli') await geminiHookStatus(io, state, statusDir, projectRef);
      if (platform === 'codex-cli') await codexHookStatus(io, state, statusDir, projectRef);
      await selfReportStatus(io, platform, statusDir, projectRef);
      await usageStatus(io, state);
      return 0;
    }

    case 'uninstall': {
      const projectDir = resolve(io.cwd, flag(argv, 'dir') ?? '.');
      let path: string;
      let removed: boolean;
      let shifts: CodexShift[] = [];
      let deleted = false;
      // ADR-0017 §5: javi's MCP entry first, then the hooks.
      if (!(await uninstallSelfReport(io, state, platform, projectDir, projectRef))) return 1;
      if (platform === 'gemini-cli' || platform === 'codex-cli') {
        try {
          if (platform === 'gemini-cli')
            ({ path, removed } = await uninstallGeminiHooks(projectDir));
          else {
            const hooksPath = codexHooksPath(projectDir);
            const result = await uninstallCodexHooks(
              projectDir,
              await state.codexHooksOrigin(hooksPath),
            );
            ({ path, shifts, deleted } = result);
            removed = result.removed > 0;
            if (removed) await state.removeCodexHooksOrigin(hooksPath);
          }
        } catch (e) {
          io.err((e as Error).message);
          return 1;
        }
      } else {
        ({ path, removed } = await uninstallHooks(projectDir));
      }
      io.out(removed ? `Removed javi hooks from ${path}.` : `No hooks found in ${path}.`);
      if (deleted) io.out(`${path} held only javi's hooks, so the file was removed.`);
      for (const line of shiftLines(shifts)) io.out(line);
      if (argv.includes('--forget-token')) {
        // R8: every platform's hooks of one project share its token; keep it for the others.
        const others: Platform[] = [];
        for (const other of PLATFORMS) {
          if (other !== platform && (await hooksInstalledFor(other, projectDir, projectRef))) {
            others.push(other);
          }
        }
        if (others.length) {
          for (const other of others) {
            io.out(
              `Token kept: ${PLATFORM_NAMES[other]} hooks for ${projectRef} are still installed in ${hooksFileFor(other, projectDir)} and need it.`,
            );
            io.out(
              `To remove it, run javi uninstall --project ${projectRef} --platform ${other} --forget-token.`,
            );
          }
        } else {
          await state.removeCredentials(projectRef);
          io.out('Token removed from this machine.');
        }
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

/**
 * Starts `javi <args>` detached (background flush, receiver) with an explicit environment that
 * never holds the recovery key (ADR-0018 §6, review M3). `spawnImpl` is injectable for tests.
 */
export const detachedSpawner =
  (cliPath: string, env: NodeJS.ProcessEnv = process.env, spawnImpl: typeof spawn = spawn) =>
  (args: string[]) => {
    const child = spawnImpl(process.execPath, [cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnv(env),
    });
    child.unref();
    return child;
  };

if (isEntryPoint()) {
  const cliPath = fileURLToPath(import.meta.url);
  const detached = detachedSpawner(cliPath);
  main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: readAllStdin,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    spawnFlush: (projectRef) => {
      detached(['flush', '--project', projectRef, '--quiet']);
    },
    spawnReceiver: () => {
      detached(['receive']);
    },
    systemProxy: { platform: process.platform, run: runCommand },
    promptHidden: promptHiddenFromTerminal,
    // Only `javi mcp` touches process.stdin as a stream (other commands keep their behaviour).
    ...(process.argv[2] === 'mcp' && {
      stdio: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    }),
  }).then(
    (code) => process.exit(code),
    () => process.exit(process.argv[2] === 'hook' ? 0 : 1),
  );
}
