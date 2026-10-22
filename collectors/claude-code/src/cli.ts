#!/usr/bin/env node
// `javi` — Javi's Dog collector for Claude Code (JD-C01, ADR-0010).
//   javi init --project <slug> [--endpoint <url>] [--dir <project dir>] [--no-verify]
//            token from JAVI_INGEST_TOKEN or piped stdin; never from argv (shell history)
//   javi hook --project <slug>      (called by Claude Code; silent, always exits 0)
//   javi flush --project <slug>     javi status --project <slug>
//   javi uninstall --project <slug> [--dir <project dir>] [--forget-token]
import { execFileSync, spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileSpool, createJgrClient } from '@javis-dog/jgr-sdk';
import { COLLECTOR_VERSION, opaqueRef } from './mapping.ts';
import { runFlush, runHook } from './run.ts';
import { installHooks, settingsPath, uninstallHooks } from './settings.ts';
import { createState, javiHome } from './state.ts';

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
      });
    }
    return 0;
  }

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

      if (argv.includes('--no-verify')) return 0;
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
        return 0;
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
        return 1;
      }
      const spooled = await createFileSpool(state.spoolDir(projectRef)).count();
      io.out(`Project ${projectRef}: endpoint ${creds.endpoint}, token ${masked(creds.token)}`);
      io.out(`Spooled events: ${spooled}`);
      io.out(`Last flush: ${JSON.stringify((await state.lastFlush(projectRef)) ?? 'never')}`);
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
  main(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: readAllStdin,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    spawnFlush: (projectRef) => {
      spawn(process.execPath, [cliPath, 'flush', '--project', projectRef, '--quiet'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    },
  }).then(
    (code) => process.exit(code),
    () => process.exit(process.argv[2] === 'hook' ? 0 : 1),
  );
}
