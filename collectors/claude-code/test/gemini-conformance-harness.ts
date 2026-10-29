import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// I/O helpers for the Gemini conformance runner (gemini-conformance.test.ts). Nothing here
// knows the expected values: they come from docs/jgr/conformance/gemini only.

/** Every file under `dir`, recursively (an absent dir is empty). */
export const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
};

/** Text of a file, or null when it vanished meanwhile (a flusher took a spooled event). */
export const readIfPresent = (path: string) => readFile(path, 'utf8').catch(() => null);

/**
 * README "Fixed environment" → Ingest: answers `202 {"accepted": n, "duplicates": 0,
 * "rejected": []}` and records every decompressed batch, keyed by the bearer token (the
 * runner picks one token per vector, so a late flush is still filed under its vector).
 */
export const startIngestStub = async () => {
  const batches = new Map<string, string[]>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let text: string;
      let n = 0;
      try {
        text =
          req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString();
        n = (JSON.parse(text) as { events: unknown[] }).events.length;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const list = batches.get(token) ?? [];
      list.push(text);
      batches.set(token, list);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: n, duplicates: 0, rejected: [] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}/api/v1/events`,
    batches: (token: string) => batches.get(token) ?? [],
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};

/** A port nothing listens on right now (for `javi usage on --port`). */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

export interface RawReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * README "Usage steps" → Request: exactly `host`, `content-type`, `authorization` (optional)
 * and `content-length`, lower-case, written on a raw socket so no client adds or rewrites a
 * header. Reads one response (content-length framed, or until the server closes).
 */
export const rawPost = (
  port: number,
  path: string,
  body: Buffer,
  authorization: string | null,
): Promise<RawReply> =>
  new Promise((resolve, reject) => {
    const head =
      `POST ${path} HTTP/1.1\r\n` +
      `host: 127.0.0.1:${port}\r\n` +
      'content-type: application/json\r\n' +
      (authorization === null ? '' : `authorization: ${authorization}\r\n`) +
      `content-length: ${body.length}\r\n\r\n`;
    const socket = connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (reply: RawReply | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (reply instanceof Error) reject(reply);
      else resolve(reply);
    };
    const parse = (final: boolean) => {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (final) finish(new Error('Connection closed before a full response head.'));
        return;
      }
      const [statusLine, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? '')?.[1] ?? NaN);
      const rest = buf.subarray(end + 4);
      const length = headers['content-length'];
      if (length !== undefined) {
        if (rest.length < Number(length)) {
          if (final) finish(new Error('Connection closed before the full response body.'));
          return;
        }
        finish({ status, headers, body: rest.subarray(0, Number(length)).toString('utf8') });
      } else if (final) {
        finish({ status, headers, body: rest.toString('utf8') });
      }
    };
    const timer = setTimeout(() => finish(new Error('No response within 10 s.')), 10_000);
    socket.on('connect', () => socket.write(Buffer.concat([Buffer.from(head, 'latin1'), body])));
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      parse(false);
    });
    socket.on('end', () => parse(true));
    socket.on('error', (e) => finish(e));
  });

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

/**
 * Starts one hook process the way the agent would: `bash -c <command>` for a Gemini hook
 * entry (Gemini's hookRunner on macOS/Linux), the exec form for a Claude Code entry. Writes
 * the stdin bytes, closes stdin and waits for the process to close its pipes; 10 s is a FAIL.
 */
export const runProcess = (
  argv: { shell: string } | { file: string; args: string[] },
  stdin: Buffer,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const started = performance.now();
    const child =
      'shell' in argv
        ? spawn('bash', ['-c', argv.shell], { cwd: opts.cwd, env: opts.env })
        : spawn(argv.file, argv.args, { cwd: opts.cwd, env: opts.env });
    const out: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 10_000);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdin.on('error', () => {}); // a process that exits before reading stdin
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out),
        stderr,
        timedOut,
        ms: Math.round(performance.now() - started),
      });
    });
    child.stdin.end(stdin);
  });

/**
 * Linux harness hook for "wait for quiescence": the pids of live processes whose environment
 * carries `marker` (every process the runner starts, and the detached `javi flush` they spawn,
 * inherit it). `null` when /proc is not available.
 */
export const markedProcesses = async (marker: string): Promise<number[] | null> => {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    return null;
  }
  const needle = Buffer.from(`\0${marker}\0`);
  const found: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const environ = await readFile(`/proc/${name}/environ`).catch(() => null);
    if (environ && Buffer.concat([Buffer.from([0]), environ]).includes(needle)) {
      found.push(Number(name));
    }
  }
  return found;
};

/**
 * Waits until no marked process is alive (the hook exited and any flush it started finished).
 * Without /proc it falls back to the README's fixed 4 s wait. Returns false on timeout.
 */
export const waitForQuiescence = async (marker: string, timeoutMs = 15_000) => {
  // performance.now(): the runner pins Date in its own process too.
  const until = performance.now() + timeoutMs;
  for (;;) {
    const live = await markedProcesses(marker);
    if (live === null) {
      await new Promise((r) => setTimeout(r, 4_000));
      return true;
    }
    if (!live.length) return true;
    if (performance.now() > until) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
};
