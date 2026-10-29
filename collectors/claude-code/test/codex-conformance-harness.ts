import { spawn } from 'node:child_process';
import { connect } from 'node:net';

// I/O helpers for the Codex conformance runner (codex-conformance.test.ts). Nothing here knows
// the expected values: they come from docs/jgr/conformance/codex only. Generic helpers are
// reused from the Gemini runner's harness (same README conventions); what differs for Codex
// (README "Differences from the Gemini runner") lives here.

export {
  freePort,
  markedProcesses,
  listFiles,
  readIfPresent,
  startIngestStub,
  waitForQuiescence,
} from './gemini-conformance-harness.ts';

/**
 * README "Fixed environment" → Process env hygiene: none of these names from the runner's own
 * environment reaches a `javi` command or hook process. `OTEL_*`, `CLAUDE_CODE_ENABLE_TELEMETRY`
 * (all `CLAUDE_*`), `GEMINI_*` (incl. `GEMINI_TELEMETRY_*`), every `CODEX_*` (the runner sets
 * `CODEX_HOME` itself), every `JAVI_*` (the runner sets its own), and every proxy variable in
 * any letter case: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and any other name that
 * ends in `PROXY` / `_proxy` or is a `noproxy` setting (this sandbox runs behind a proxy).
 */
export const FORBIDDEN_ENV = (name: string) =>
  /^(OTEL_|CLAUDE_|GEMINI_|CODEX_|JAVI_)/i.test(name) ||
  /proxy$/i.test(name) ||
  /noproxy/i.test(name);

/** The runner's environment without anything {@link FORBIDDEN_ENV} names. */
export const hygienicEnv = (source: NodeJS.ProcessEnv = process.env) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) if (!FORBIDDEN_ENV(k)) env[k] = v;
  return env;
};

export interface RawReply {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** The connection was reset (or EPIPE) after the status line arrived (README U19: fine). */
  resetAfterStatus: boolean;
}

/**
 * README "Usage steps" → Request: exactly `host`, `content-type`, `authorization` (optional)
 * and `content-length`, lower-case, on a raw socket so no client adds or rewrites a header. No
 * gzip. Reads one response (content-length framed, or until the server closes). A reset or
 * EPIPE after the status line was received resolves with what arrived (README U19); no
 * response at all rejects.
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
    /** `final`: the connection is over (end, close or error); `reset`: it ended in an error. */
    const parse = (final: boolean, reset = false) => {
      const end = buf.indexOf('\r\n\r\n');
      const statusLine = buf.subarray(0, Math.max(buf.indexOf('\r\n'), 0)).toString('latin1');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? NaN);
      if (end < 0) {
        if (!final) return;
        if (reset && Number.isFinite(status)) {
          finish({ status, headers: {}, body: '', resetAfterStatus: true });
        } else finish(new Error('Connection closed before a full response head.'));
        return;
      }
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n').slice(1);
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const rest = buf.subarray(end + 4);
      const length = headers['content-length'];
      if (length !== undefined && rest.length >= Number(length)) {
        finish({
          status,
          headers,
          body: rest.subarray(0, Number(length)).toString('utf8'),
          resetAfterStatus: false,
        });
      } else if (final) {
        finish({ status, headers, body: rest.toString('utf8'), resetAfterStatus: reset });
      }
    };
    const timer = setTimeout(() => finish(new Error('No response within 15 s.')), 15_000);
    socket.on('connect', () => {
      socket.write(Buffer.from(head, 'latin1'));
      socket.write(body);
    });
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      parse(false);
    });
    socket.on('end', () => parse(true));
    socket.on('close', () => parse(true, true));
    socket.on('error', () => parse(true, true));
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
 * README "Hook steps" → Invocation: `{ sh }` runs `/bin/sh -c '<command>'` (a Codex handler,
 * not Codex's `$SHELL -lc`, so no profile output reaches stdout); `{ bash }` runs `bash -c` (a
 * Gemini entry, as Gemini's hookRunner does); `{ file, args }` is the exec form (Claude Code).
 * Writes the stdin bytes, closes stdin and waits for exit; after 10 s the process is killed and
 * `timedOut` is set (a FAIL).
 */
export const runProcess = (
  argv: { sh: string } | { bash: string } | { file: string; args: string[] },
  stdin: Buffer,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> =>
  new Promise((resolve) => {
    const started = performance.now();
    const child =
      'sh' in argv
        ? spawn('/bin/sh', ['-c', argv.sh], { cwd: opts.cwd, env: opts.env })
        : 'bash' in argv
          ? spawn('bash', ['-c', argv.bash], { cwd: opts.cwd, env: opts.env })
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

/** A value at a dotted path of a parsed TOML/JSON object, or undefined. */
export const at = (root: unknown, path: string[]): unknown => {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
};

/**
 * README "Absent strings" → Global: the raw session ids and agent ids of a vector, collected
 * from the places the README names. `walkPayload` handles one hook payload (stdin object).
 */
export const collectRawIds = () => {
  const sessions = new Set<string>();
  const agents = new Set<string>();
  const strings = (value: unknown, into: Set<string>) => {
    if (typeof value === 'string') {
      if (value) into.add(value);
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) strings(v, into);
    }
  };
  /** Hook payload: string `session_id` values, strings nested in a non-string one; `agent_id`. */
  const payload = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(payload);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'session_id') strings(v, sessions);
        if (k === 'agent_id' && typeof v === 'string' && v) agents.add(v);
        payload(v);
      }
    }
  };
  /** OTLP body: every `conversation.id` string value. */
  const body = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(body);
    else if (node && typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (o.key === 'conversation.id') strings(o.value, sessions);
      for (const v of Object.values(o)) body(v);
    }
  };
  const rawStdin = (raw: string | null) => {
    if (raw === null) return;
    for (const m of raw.matchAll(/"session_id"\s*:\s*"([^"]+)"/g)) sessions.add(m[1]!);
    for (const m of raw.matchAll(/"agent_id"\s*:\s*"([^"]+)"/g)) agents.add(m[1]!);
  };
  const rawBody = (raw: string | null) => {
    if (raw === null) return;
    for (const m of raw.matchAll(/"conversation\.id"[^}]*?"stringValue"\s*:\s*"([^"]+)"/g)) {
      sessions.add(m[1]!);
    }
  };
  return { sessions, agents, payload, body, rawStdin, rawBody };
};
