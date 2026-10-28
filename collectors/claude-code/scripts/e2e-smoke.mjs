// Packed end-to-end smoke for `javi` (S5a R7, ADR-0015 §8). Proves the real tarball works:
// build + pack → npm install --offline into a temp prefix → `javi init` (token on stdin) →
// the registered hook command fed realistic Claude Code hook payloads → `javi flush` →
// `javi status`. Everything runs under one temp dir (HOME, JAVI_HOME, JAVI_CLAUDE_HOME, the
// project, npm cache/logs), which is removed at the end; only the JSON summary is kept.
//   INGEST_URL=<…/api/v1/events> E2E_TOKEN_FILE=<file> E2E_OUT=<summary.json> \
//     [E2E_PROJECT_REF=<project slug>] [E2E_TARBALL=<prebuilt .tgz>] \
//     pnpm --filter @javis-dog/collector-claude-code e2e:smoke
// The token is read from E2E_TOKEN_FILE and handed to `javi init` on stdin only (never argv or
// env); it is never printed or written to the summary. Exit 0 only when every step exits 0,
// every recorded event was delivered, the spool is empty and no hook content leaked; 1
// otherwise; 2 for a usage error (nothing run).
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmInvocation, quoteWinArg } from './npm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const TOKEN = /^jd_it_[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_:-]{1,128}$/;
const HOOK_MARKER = 'javi-collector';
const STEP_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 180_000;
const FLUSH_WAIT_MS = 30_000;

/**
 * Content a Claude Code hook carries that javi must never store or send (ADR-0010). Each one
 * is planted in the payloads below and searched for afterwards in every local file javi wrote.
 */
export const SENTINELS = [
  'E2E-PROMPT-SENTINEL do not send this prompt',
  'E2E-TOOL-INPUT-SENTINEL',
  'E2E-TOOL-OUTPUT-SENTINEL API_KEY=e2e-not-a-secret',
  'E2E-ASSISTANT-SENTINEL',
  '/e2e-sentinel/secret-repo',
];

/** Expected hook → JGR mapping (collector README "What is sent"). */
const EXPECTED_TYPES = {
  SessionStart: 'session.started',
  UserPromptSubmit: 'heartbeat',
  PreToolUse: 'task.started',
  PostToolUse: 'task.completed',
  Stop: 'heartbeat',
  SessionEnd: 'session.ended',
};

const fail = (message) => {
  console.error(message);
  process.exit(2);
};

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Spawns one command; output is captured, never echoed. */
const run = (command, args, { env, cwd, stdin = '', shell = false, timeoutMs = STEP_TIMEOUT_MS }) =>
  new Promise((done) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { env, cwd, shell, windowsHide: true });
    } catch (e) {
      done({ code: null, stdout, stderr: String(e?.code ?? e), ms: 0 });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      done({
        code: null,
        stdout,
        stderr: `${stderr}${e.code ?? e.name}`,
        ms: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });

const waitFor = async (check, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** Every regular file below `dir` (missing dir → none). */
const walk = async (dir) => {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(path)));
    else if (e.isFile()) out.push(path);
  }
  return out;
};

const opaqueRef = (prefix, value, salt) =>
  `${prefix}_${createHmac('sha256', salt).update(value).digest('hex').slice(0, 32)}`;

// --- Inputs ---

const endpoint = (() => {
  const value = process.env.INGEST_URL;
  if (!value) fail('INGEST_URL is not set (no default: name the endpoint explicitly).');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('INGEST_URL is not a valid URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    fail('INGEST_URL must be https:// (http:// only for localhost).');
  }
  if (url.username || url.password) fail('INGEST_URL must not contain credentials.');
  return url.href;
})();

const token = await (async () => {
  const path = process.env.E2E_TOKEN_FILE;
  if (!path) fail('E2E_TOKEN_FILE is not set.');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    fail(`Cannot read E2E_TOKEN_FILE (${e?.code ?? 'error'}).`); // never the contents
  }
  const value = text.trim();
  if (!TOKEN.test(value)) fail('E2E_TOKEN_FILE does not hold one ingest token (jd_it_…).');
  return value;
})();

const projectRef = process.env.E2E_PROJECT_REF?.trim() || 'e2e-smoke';
if (!REF.test(projectRef)) fail('E2E_PROJECT_REF must be a project slug (letters, digits, _ : -).');
const outPath = process.env.E2E_OUT?.trim() ? resolve(process.env.E2E_OUT.trim()) : null;
const prebuilt = process.env.E2E_TARBALL?.trim() ? resolve(process.env.E2E_TARBALL.trim()) : null;
if (prebuilt && !existsSync(prebuilt)) fail('E2E_TARBALL does not exist.');

const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'javi-e2e-'));

/** Replaces the token, any ingest-token-shaped string and the temp root in captured output. */
const redact = (text) =>
  text
    .split(token)
    .join('[token]')
    .replace(/jd_it_[A-Za-z0-9_-]+/g, 'jd_it_[redacted]')
    .split(temp)
    .join('<temp>');
const tail = (text, n = 5) => redact(text).trim().split(/\r?\n/).slice(-n).filter(Boolean);

const started = Date.now();
const steps = [];
const failures = [];
const summary = {
  tool: 'javis-dog-e2e-smoke',
  endpoint: (() => {
    const u = new URL(endpoint);
    return `${u.origin}${u.pathname}`;
  })(),
  project_ref: projectRef,
  collector_version: version,
  tarball: prebuilt ? 'prebuilt (E2E_TARBALL)' : 'built and packed by this run',
  started_at: new Date(started).toISOString(),
  steps,
};

const record = (step, result, extra = {}) => {
  const entry = { step, exit_code: result.code, ms: result.ms, ...extra };
  if (result.code !== 0) {
    entry.stderr_tail = tail(result.stderr);
    failures.push(`${step} exited ${result.code}`);
  }
  steps.push(entry);
  return result.code === 0;
};

try {
  // npm with its cache and logs in the temp dir and without a parent's npm_* settings.
  const npmEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toLowerCase().startsWith('npm_')) npmEnv[k] = v;
  }
  Object.assign(npmEnv, {
    npm_config_cache: join(temp, 'npm-cache'),
    npm_config_logs_dir: join(temp, 'npm-logs'),
    npm_config_update_notifier: 'false',
  });
  delete npmEnv.JAVI_INGEST_TOKEN;

  const home = join(temp, 'home');
  const javiHome = join(temp, 'javi-home');
  const claudeHome = join(temp, 'claude-home');
  const projectDir = join(temp, 'project');
  const prefix = join(temp, 'prefix');
  for (const d of [home, javiHome, claudeHome, projectDir, prefix]) {
    await mkdir(d, { recursive: true });
  }
  // A repository of its own, so init's git exclude never touches an enclosing checkout.
  await run('git', ['init', '-q'], { cwd: projectDir, env: npmEnv });

  const javiEnv = { ...npmEnv, HOME: home, JAVI_HOME: javiHome, JAVI_CLAUDE_HOME: claudeHome };
  if (WIN) javiEnv.USERPROFILE = home;

  // 1. Build + pack (scripts/pack.mjs, output in the temp dir) unless a tarball was given.
  let tarball = prebuilt;
  if (!tarball) {
    const out = join(temp, 'dist');
    const packed = await run(process.execPath, [join(ROOT, 'scripts', 'pack.mjs'), '--out', out], {
      cwd: ROOT,
      env: npmEnv,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    tarball = join(out, `javis-dog-javi-${version}.tgz`);
    if (!record('pack', packed) || !existsSync(tarball)) throw new Error('pack failed');
    summary.tarball_bytes = (await stat(tarball)).size;
  }

  // 2. Offline install into a temp prefix (what npx does, without the registry).
  const npm = npmInvocation([
    'install',
    '--offline',
    '--no-audit',
    '--no-fund',
    '--prefix',
    prefix,
    tarball,
  ]);
  const installed = await run(npm.command, npm.args, {
    cwd: temp,
    env: npmEnv,
    shell: npm.shell,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (!record('install', installed)) throw new Error('install failed');
  const bin = join(prefix, 'node_modules', '.bin', WIN ? 'javi.cmd' : 'javi');
  const runBin = (args, opts) =>
    WIN
      ? run(quoteWinArg(bin), args.map(quoteWinArg), { ...opts, shell: true })
      : run(bin, args, opts);

  // 3. init: the token goes in on stdin, never on the command line.
  const init = await runBin(
    ['init', '--project', projectRef, '--endpoint', endpoint, '--dir', projectDir],
    { cwd: projectDir, env: javiEnv, stdin: `${token}\n` },
  );
  const verified = init.stdout.includes('Connection verified');
  if (!record('init', init, { verified })) throw new Error('init failed');

  const installation = await readJson(join(javiHome, 'installation.json'));
  if (!installation?.producer_id || !installation.salt) throw new Error('no installation.json');
  summary.producer_id = installation.producer_id;

  const lastFlushFile = join(javiHome, 'last-flush', `${projectRef}.json`);
  const requestedFile = join(javiHome, 'last-flush', `${projectRef}.requested.json`);
  const lockDir = join(javiHome, 'locks', `flush-${projectRef}`);
  const spoolDir = join(javiHome, 'spool', projectRef);
  const delivered = { accepted: 0, duplicates: 0, rejected: 0, dropped: 0, flushes: 0 };
  const flushes = [];
  const addFlush = (source, result) => {
    if (!result || typeof result !== 'object') return;
    flushes.push({
      source,
      status: result.status,
      accepted: result.accepted ?? 0,
      duplicates: result.duplicates ?? 0,
      rejected: result.rejected ?? 0,
      dropped: result.dropped ?? 0,
      remaining: result.remaining ?? null,
      ...(result.httpStatus !== undefined && { http_status: result.httpStatus }),
    });
    delivered.accepted += result.accepted ?? 0;
    delivered.duplicates += result.duplicates ?? 0;
    delivered.rejected += result.rejected ?? 0;
    delivered.dropped += result.dropped ?? 0;
    delivered.flushes += 1;
  };
  let lastFlushAt = (await readJson(lastFlushFile))?.at ?? null;
  if (lastFlushAt) addFlush('init', await readJson(lastFlushFile));

  // 4. The hook command exactly as init registered it, fed realistic hook payloads.
  const settings = await readJson(join(projectDir, '.claude', 'settings.local.json'));
  const hookFor = (event) =>
    (settings?.hooks?.[event] ?? [])
      .flatMap((g) => g.hooks ?? [])
      .find((h) => Array.isArray(h.args) && h.args.includes(HOOK_MARKER));
  const sessionId = randomUUID();
  const common = {
    session_id: sessionId,
    transcript_path: `${SENTINELS[4]}/.claude/projects/e2e/${sessionId}.jsonl`,
    cwd: SENTINELS[4],
    permission_mode: 'default',
  };
  const payloads = [
    ['SessionStart', { source: 'startup', model: 'claude-sonnet-4-5' }],
    ['UserPromptSubmit', { prompt: SENTINELS[0] }],
    [
      'PreToolUse',
      {
        tool_name: 'Bash',
        tool_input: { command: `cat ${SENTINELS[4]}/.env # ${SENTINELS[1]}` },
        tool_use_id: 'toolu_e2e_01',
      },
    ],
    [
      'PostToolUse',
      {
        tool_name: 'Bash',
        tool_input: { command: `cat ${SENTINELS[4]}/.env # ${SENTINELS[1]}` },
        tool_response: { stdout: SENTINELS[2], stderr: '', interrupted: false },
        tool_use_id: 'toolu_e2e_01',
        duration_ms: 412.7,
      },
    ],
    ['Stop', { stop_hook_active: false, last_assistant_message: SENTINELS[3] }],
    ['SessionEnd', { reason: 'prompt_input_exit' }],
  ];
  // event_id → type, thread ref and privacy flags of the full spooled event (best effort: a
  // background flush may deliver an event before this snapshot sees it).
  const observed = new Map();
  const snapshotSpool = async () => {
    for (const file of await walk(spoolDir)) {
      const id = file.slice(file.lastIndexOf(WIN ? '\\' : '/') + 1).replace(/\.json$/, '');
      if (observed.has(id)) continue;
      const text = await readFile(file, 'utf8').catch(() => null);
      let event = null;
      try {
        event = text && JSON.parse(text);
      } catch {
        // half-written or already removed
      }
      if (!event) continue;
      observed.set(id, {
        type: event.type,
        thread_ref: event.thread_ref,
        content: SENTINELS.some((s) => text.includes(s)),
        path: /[/\\]/.test(text),
      });
    }
  };
  let flushWaitTimeouts = 0;
  for (const [event, extra] of payloads) {
    const hook = hookFor(event);
    if (!hook) {
      failures.push(`no javi hook registered for ${event}`);
      steps.push({ step: `hook:${event}`, exit_code: null, ms: 0, registered: false });
      continue;
    }
    const requestedBefore = (await readJson(requestedFile))?.at ?? null;
    const result = await run(hook.command, hook.args, {
      cwd: projectDir,
      env: javiEnv,
      stdin: JSON.stringify({ ...common, hook_event_name: event, ...extra }),
    });
    await snapshotSpool();
    const silent = result.stdout === '' && result.stderr === '';
    if (!silent) failures.push(`hook:${event} wrote output (hooks must stay silent)`);
    // A hook that started a background flush: wait for it, so its delivery is counted and
    // the next step never races it.
    const spawned = ((await readJson(requestedFile))?.at ?? null) !== requestedBefore;
    if (spawned) {
      const done = await waitFor(async () => {
        const at = (await readJson(lastFlushFile))?.at ?? null;
        return at !== lastFlushAt && !existsSync(lockDir);
      }, FLUSH_WAIT_MS);
      if (done) {
        const result = await readJson(lastFlushFile);
        lastFlushAt = result?.at ?? null;
        addFlush(`background after ${event}`, result);
      } else flushWaitTimeouts += 1;
    }
    record(`hook:${event}`, result, { silent, flush_spawned: spawned });
  }

  // Events recorded by hooks: the per-thread sequence counters (race-free, unlike the spool).
  const seqDir = join(javiHome, 'seq');
  const sessionRef = opaqueRef('cc', sessionId, installation.salt);
  const initRef = opaqueRef('init', installation.producer_id, installation.salt);
  const hookRecorded = (await readJson(join(seqDir, `${sessionRef}.json`)))?.next ?? 0;
  const spooledBeforeFlush = (await walk(spoolDir)).filter((f) => f.endsWith('.json')).length;

  // Privacy: no planted hook content in any file javi wrote, no path in any spooled event.
  const scanned = [...(await walk(javiHome)), ...(await walk(join(projectDir, '.claude')))];
  let sentinelHits = 0;
  for (const file of scanned) {
    const text = await readFile(file, 'utf8').catch(() => '');
    if (SENTINELS.some((s) => text.includes(s))) sentinelHits += 1;
  }
  const events = [...observed.values()];
  const eventsWithContent = events.filter((e) => e.content).length;
  const eventsWithPaths = events.filter((e) => e.path).length;

  // 5. flush and 6. status, with the stable copy the hooks run (README: node ~/.javi/bin/…).
  const stable = hookFor('SessionStart')?.args?.[0];
  const flush = await run(process.execPath, [stable, 'flush', '--project', projectRef], {
    cwd: projectDir,
    env: javiEnv,
  });
  let finalFlush = null;
  try {
    finalFlush = JSON.parse(flush.stdout.trim().split(/\r?\n/).pop() ?? '');
  } catch {
    failures.push('flush printed no JSON result');
  }
  if (finalFlush && 'accepted' in finalFlush) addFlush('javi flush', finalFlush);
  record('flush', flush, { result_status: finalFlush?.status ?? null });

  const status = await run(process.execPath, [stable, 'status', '--project', projectRef], {
    cwd: projectDir,
    env: javiEnv,
  });
  const spooledMatch = /Spooled events: (\d+)/.exec(status.stdout);
  record('status', status, { spooled_events: spooledMatch ? Number(spooledMatch[1]) : null });

  const spoolAfter = (await walk(spoolDir)).filter((f) => f.endsWith('.json')).length;
  const recorded = { init_check: 1, hooks: hookRecorded, total: 1 + hookRecorded };
  summary.events = {
    expected_hook_events: payloads.length,
    recorded,
    spooled_after_hooks: spooledBeforeFlush,
    delivered,
    spool_after_flush: spoolAfter,
    status_spooled: spooledMatch ? Number(spooledMatch[1]) : null,
    flush_wait_timeouts: flushWaitTimeouts,
  };
  summary.flushes = flushes;
  summary.thread_refs = [initRef, sessionRef];
  summary.observed_types = [...new Set([...observed.values()].map((e) => e.type))].sort();
  summary.observed_thread_refs = [
    ...new Set([...observed.values()].map((e) => e.thread_ref)),
  ].sort();
  summary.privacy = {
    sentinels: SENTINELS.length,
    files_scanned: scanned.length,
    files_with_hook_content: sentinelHits,
    spooled_events_checked: events.length,
    events_with_hook_content: eventsWithContent,
    events_with_path_chars: eventsWithPaths,
  };

  if (hookRecorded !== payloads.length) {
    failures.push(`hooks recorded ${hookRecorded} events, expected ${payloads.length}`);
  }
  if (!verified) failures.push('init did not verify the connection');
  if (finalFlush?.status !== 'ok') failures.push(`final flush status ${finalFlush?.status}`);
  if (spoolAfter !== 0) failures.push(`spool holds ${spoolAfter} events after flush`);
  if (summary.events.status_spooled !== 0) failures.push('javi status does not report 0 spooled');
  if (delivered.accepted + delivered.duplicates !== recorded.total) {
    failures.push(
      `delivered ${delivered.accepted + delivered.duplicates} of ${recorded.total} recorded events`,
    );
  }
  if (delivered.rejected || delivered.dropped) failures.push('events were rejected or dropped');
  if (sentinelHits) failures.push(`${sentinelHits} local file(s) hold hook content`);
  if (eventsWithContent) failures.push(`${eventsWithContent} spooled event(s) hold hook content`);
  if (eventsWithPaths) failures.push(`${eventsWithPaths} spooled event(s) hold a path character`);
  const unexpected = summary.observed_types.filter(
    (t) => !Object.values(EXPECTED_TYPES).includes(t),
  );
  if (unexpected.length) failures.push(`unexpected event types ${unexpected.join(', ')}`);
} catch (e) {
  failures.push(`aborted: ${redact(e instanceof Error ? e.message : String(e))}`);
} finally {
  summary.wall_ms = Date.now() - started;
  summary.failures = failures;
  summary.pass = failures.length === 0;
  // Detached flushes are awaited above; give a straggler a moment before removing its home.
  await new Promise((r) => setTimeout(r, 200));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
    failures.push('temp dir could not be removed');
  });
  summary.temp_removed = !existsSync(temp);
}

const json = redact(`${JSON.stringify(summary, null, 2)}\n`);
if (outPath) await writeFile(outPath, json);
console.log(`${summary.pass ? 'PASS' : 'FAIL'} javi e2e smoke → ${summary.endpoint}`);
for (const s of steps) console.log(`  ${s.step}: exit ${s.exit_code} (${s.ms} ms)`);
if (summary.events) {
  const e = summary.events;
  console.log(
    `  events recorded ${e.recorded.total}, delivered ${e.delivered.accepted + e.delivered.duplicates} in ${e.delivered.flushes} flush(es), spool after flush ${e.spool_after_flush}`,
  );
}
for (const f of failures) console.log(`  FAIL: ${redact(f)}`);
if (outPath) console.log(`Summary written to ${outPath}`);
process.exit(summary.pass ? 0 : 1);
