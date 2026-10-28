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
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileSpool, createJgrClient } from '@javis-dog/jgr-sdk';
import {
  DEFAULT_USAGE_PORT,
  claudeUserSettingsPath,
  disableUsageEnv,
  enableUsageEnv,
} from './claude-env.ts';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
import {
  RECEIVER_IDLE_MS,
  createUsageReceiver,
  ensureReceiver,
  isPidAlive,
  liveReceiver,
} from './receiver.ts';
import { runFlush, runHook } from './run.ts';
import { installHooks, settingsPath, uninstallHooks } from './settings.ts';
import { createState, javiHome, type CollectorState } from './state.ts';

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

/** Keeps `.claude/settings.local.json` out of commits via the repo-local exclude file. */
const ensureIgnored = async (projectDir: string, file: string) => {
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
    if (!current.split(/\r?\n/).includes('.claude/settings.local.json')) {
      await appendFile(
        exclude,
        `${current.endsWith('\n') || !current ? '' : '\n'}.claude/settings.local.json\n`,
      );
    }
    return 'added to .git/info/exclude';
  } catch {
    return 'could not update git excludes — add .claude/settings.local.json to .gitignore';
  }
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

/** Stops the live receiver (SIGTERM, then waits up to 5 s for it to exit). */
const stopReceiver = async (state: CollectorState) => {
  const live = await liveReceiver(state);
  if (!live) return false;
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

const usageOn = async (argv: string[], io: Io, state: CollectorState): Promise<number> => {
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
  // Generated once; `usage on` again (or with a new port) keeps the same secret.
  const secret = config?.secret ?? randomBytes(24).toString('base64url');

  const live = await liveReceiver(state);
  if (!(live && live.port === port) && !(await portFree(port))) {
    io.err(
      `Port ${port} on 127.0.0.1 is taken by another program. Pick a free one: javi usage on --port <n>`,
    );
    return 1;
  }

  const path = claudeSettings(io.env);
  const result = await enableUsageEnv({
    path,
    port,
    secret,
    shellEnv: io.env,
    ...(config?.written && { previous: config.written }),
  });
  if (!result.ok) {
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

  // A receiver still listening on the previous port would never get exports again.
  if (live && live.port !== port) await stopReceiver(state);
  await state.saveUsageConfig({ port, secret, written: result.written });
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

const usageOff = async (io: Io, state: CollectorState): Promise<number> => {
  const config = await state.usageConfig();
  if (!config) {
    io.out('Token usage export is already off.');
    return 0;
  }
  const { path, removed } = await disableUsageEnv({
    path: claudeSettings(io.env),
    written: config.written,
  });
  const stopped = await stopReceiver(state);
  await state.removeUsageConfig();
  if (!(await liveReceiver(state))) await state.removeReceiverInfo();
  io.out(
    removed.length
      ? `Removed from ${path}: ${removed.join(', ')}.`
      : `Nothing to remove from ${path} (those keys were already changed or removed).`,
  );
  io.out(stopped ? 'Usage receiver stopped.' : 'No usage receiver was running.');
  io.out('New Claude Code sessions no longer export token usage.');
  return 0;
};

const usageStatus = async (io: Io, state: CollectorState) => {
  const config = await state.usageConfig();
  if (!config) {
    io.out('Usage: off');
    return;
  }
  const info = await state.receiverInfo();
  const alive = info && isPidAlive(info.pid);
  io.out(`Usage: on (port ${config.port})`);
  io.out(`Usage receiver: ${alive ? `running (pid ${info.pid})` : 'not running'}`);
  io.out(`Usage forwarded: ${info?.forwarded ?? 0}, dropped (unattributed): ${info?.dropped ?? 0}`);
  io.out(`Last usage export: ${info?.lastRequestAt ?? 'never'}`);
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
    // Another receiver already holds the port: that one does the work.
    if ((e as { code?: string }).code === 'EADDRINUSE') return 0;
    throw e;
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

export const main = async (argv: string[], io: Io): Promise<number> => {
  const [command] = argv;
  const projectRef = flag(argv, 'project');
  const state = createState(javiHome(io.env));

  if (command === 'hook') {
    // Claude Code hook: no output, exit 0 whatever happens (a hook must stay neutral).
    if (projectRef && REF.test(projectRef)) {
      await runHook({
        state,
        projectRef,
        stdin: await io.readStdin().catch(() => ''),
        spawnFlush: () => io.spawnFlush(projectRef),
        ensureReceiver: async () => {
          await ensureReceiver({ state, spawnReceiver: io.spawnReceiver });
        },
      });
    }
    return 0;
  }

  if (command === 'usage') {
    if (argv[1] === 'on') return usageOn(argv, io, state);
    if (argv[1] === 'off') return usageOff(io, state);
    io.err('Usage: javi usage on [--port <n>] | javi usage off');
    return 2;
  }

  if (command === 'receive') return receive(io, state);

  if (!projectRef || !REF.test(projectRef)) {
    io.err('Usage: javi <init|flush|status|uninstall> --project <project slug>');
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
      await state.saveCredentials(projectRef, { endpoint, token });
      const installation = await state.installation();
      const cliPath = fileURLToPath(import.meta.url);
      const path = await installHooks(projectDir, process.execPath, cliPath, projectRef);
      io.out(
        `Hooks registered in ${path} (${await ensureIgnored(projectDir, settingsPath(projectDir))}).`,
      );
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
        attributes: { platform: 'claude-code', collector_version: COLLECTOR_VERSION },
      });
      if (!recorded.ok) {
        io.err(`Could not build the check event: ${recorded.issues.map((i) => i.code).join(', ')}`);
        return 1;
      }
      const result = await runFlush({ state, projectRef, ...(io.fetch && { fetch: io.fetch }) });
      if ('accepted' in result && result.status === 'ok' && result.rejected === 0) {
        io.out("Connection verified: Javi's Dog accepted a check event.");
        return argv.includes('--usage') ? usageOn(argv, io, state) : 0;
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
      await usageStatus(io, state);
      return 0;
    }

    case 'uninstall': {
      const projectDir = resolve(io.cwd, flag(argv, 'dir') ?? '.');
      const { path, removed } = await uninstallHooks(projectDir);
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
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
