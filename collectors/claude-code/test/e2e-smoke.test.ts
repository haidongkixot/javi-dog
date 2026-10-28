import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { validateBatch } from '@javis-dog/jgr-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// S5a R7 (TEST_PLAN §S5a): scripts/e2e-smoke.mjs end to end — the real build, the real
// tarball installed offline, init, the registered hook command, flush and status — against a
// local recording JGR receiver on 127.0.0.1. Nothing leaves this machine. One script run
// (~10 s: build + pack + npm install); the assertions share it.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'e2e-smoke.mjs');
const TOKEN = `jd_it_${'E2e'.repeat(14)}Q`;
// Must match SENTINELS in scripts/e2e-smoke.mjs (the summary reports their count).
const SENTINELS = [
  'E2E-PROMPT-SENTINEL',
  'do not send this prompt',
  'E2E-TOOL-INPUT-SENTINEL',
  'E2E-TOOL-OUTPUT-SENTINEL',
  'API_KEY=e2e-not-a-secret',
  'E2E-ASSISTANT-SENTINEL',
  '/e2e-sentinel/secret-repo',
  'secret-repo',
  'e2e-sentinel',
];

type Received = {
  auth: string;
  encoding: string;
  text: string;
  events: Array<Record<string, unknown>>;
};
type Summary = {
  pass: boolean;
  failures: string[];
  steps: Array<{ step: string; exit_code: number | null; silent?: boolean }>;
  events: {
    expected_hook_events: number;
    recorded: { init_check: number; hooks: number; total: number };
    delivered: { accepted: number; duplicates: number; rejected: number; dropped: number };
    spool_after_flush: number;
    status_spooled: number | null;
    flush_wait_timeouts: number;
  };
  thread_refs: string[];
  producer_id: string;
  privacy: {
    sentinels: number;
    files_scanned: number;
    files_with_hook_content: number;
    spooled_events_checked: number;
    events_with_hook_content: number;
    events_with_path_chars: number;
  };
  temp_removed: boolean;
  project_ref: string;
};

let temp: string;
let server: Server;
let endpoint: string;
const received: Received[] = [];
const seen = new Set<string>();
let result: { code: number | null; stdout: string; stderr: string };
let summaryText: string;
let summary: Summary;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'javi-e2e-test-'));
  // A minimal JGR receiver: bearer check, gzip, the real JD-M01 validator, dedupe, 202.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      const encoding = String(req.headers['content-encoding'] ?? 'identity');
      const raw = Buffer.concat(chunks);
      const text = (encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8');
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (auth !== `Bearer ${TOKEN}`) return reply(401, { error: 'unauthorized' });
      const parsed = JSON.parse(text) as { events: Array<Record<string, unknown>> };
      received.push({ auth, encoding, text, events: parsed.events });
      const v = validateBatch(parsed);
      if (!v.ok) return reply(400, { error: 'malformed', issues: v.issues });
      let accepted = 0;
      for (const e of v.accepted) {
        if (!seen.has(e.event_id)) {
          seen.add(e.event_id);
          accepted++;
        }
      }
      reply(202, {
        accepted,
        duplicates: v.accepted.length - accepted,
        rejected: v.rejected,
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/events`;

  const tokenFile = join(temp, 'token');
  const out = join(temp, 'summary.json');
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.toLowerCase().startsWith('npm_') && k !== 'JAVI_INGEST_TOKEN') env[k] = v;
  }
  result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: {
        ...env,
        TMPDIR: temp, // the script's temp root lands here, so cleanup is checkable
        INGEST_URL: endpoint,
        E2E_TOKEN_FILE: tokenFile,
        E2E_OUT: out,
        E2E_PROJECT_REF: 'web-app',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  summaryText = await readFile(out, 'utf8');
  summary = JSON.parse(summaryText) as Summary;
}, 240_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
});

describe('e2e-smoke.mjs against a local recording receiver', () => {
  it('passes: every step exits 0 and the summary says so', () => {
    expect(summary.failures).toEqual([]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(summary.pass).toBe(true);
    expect(summary.steps.map((s) => s.step)).toEqual([
      'pack',
      'install',
      'init',
      'hook:SessionStart',
      'hook:UserPromptSubmit',
      'hook:PreToolUse',
      'hook:PostToolUse',
      'hook:Stop',
      'hook:SessionEnd',
      'flush',
      'status',
    ]);
    expect(summary.steps.every((s) => s.exit_code === 0)).toBe(true);
    expect(summary.steps.filter((s) => s.step.startsWith('hook:')).every((s) => s.silent)).toBe(
      true,
    );
    expect(result.stdout).toContain('PASS javi e2e smoke');
  });

  it('delivers every recorded event and leaves the spool empty', () => {
    expect(summary.events.recorded).toEqual({ init_check: 1, hooks: 6, total: 7 });
    expect(summary.events.delivered).toMatchObject({ accepted: 7, rejected: 0, dropped: 0 });
    expect(summary.events.spool_after_flush).toBe(0);
    expect(summary.events.status_spooled).toBe(0);
    expect(summary.events.flush_wait_timeouts).toBe(0);
    // The receiver's own view agrees.
    expect(seen.size).toBe(7);
    expect(received.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('the receiver got the expected event types for the project and thread refs', () => {
    const events = received.flatMap((r) => r.events);
    const unique = new Map(events.map((e) => [e.event_id as string, e]));
    expect([...unique.values()].map((e) => e.type).sort()).toEqual(
      [
        'heartbeat',
        'heartbeat',
        'session.ended',
        'session.started',
        'task.completed',
        'task.started',
        'x.javi.collector.installed',
      ].sort(),
    );
    expect(new Set(events.map((e) => e.project_ref))).toEqual(new Set(['web-app']));
    expect(new Set(events.map((e) => e.producer_id))).toEqual(new Set([summary.producer_id]));
    expect(new Set(events.map((e) => e.thread_ref))).toEqual(new Set(summary.thread_refs));
    expect(summary.thread_refs.every((r) => /^(cc|init)_[0-9a-f]{32}$/.test(r))).toBe(true);
    const completed = [...unique.values()].find((e) => e.type === 'task.completed')!;
    expect(completed.attributes).toMatchObject({ tool_name: 'Bash', duration_ms: 413 });
  });

  it('no prompt text, tool input or output, assistant text or path in any received byte', () => {
    expect(received.length).toBeGreaterThan(0);
    const all = received.map((r) => r.text).join('\n');
    for (const s of SENTINELS) expect(all).not.toContain(s);
    for (const s of [temp, tmpdir(), 'transcript', '.jsonl', '.env', 'cat ', 'toolu_', ROOT]) {
      expect(all).not.toContain(s);
    }
    // No string value anywhere in the events looks like a path.
    const strings = JSON.stringify(received.flatMap((r) => r.events)).match(/"[^"]*"/g) ?? [];
    expect(strings.filter((s) => s.includes('/') || s.includes('\\'))).toEqual([]);
    expect(summary.privacy.files_with_hook_content).toBe(0);
    expect(summary.privacy.sentinels).toBe(5);
    expect(summary.privacy.files_scanned).toBeGreaterThan(0);
    expect(summary.privacy.spooled_events_checked).toBeGreaterThan(0);
    expect(summary.privacy.events_with_hook_content).toBe(0);
    expect(summary.privacy.events_with_path_chars).toBe(0);
  });

  it('never prints or stores the token, and removes its temp dirs', async () => {
    for (const text of [result.stdout, result.stderr, summaryText]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TOKEN.slice(6));
    }
    expect(summary.temp_removed).toBe(true);
    const left = (await readdir(temp)).filter((n) => n.startsWith('javi-e2e-'));
    expect(left).toEqual([]);
  });
});
