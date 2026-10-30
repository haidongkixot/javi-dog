import { PassThrough } from 'node:stream';
import { serveStdio } from '../src/index.ts';

// Instance layer of docs/jgr/conformance/self-report/README.md "MCP steps": JD-C03 over
// in-memory streams. `serveStdio` (public entry) wires `createMcpServer` to the three streams it
// is given, exactly as `javi mcp` does with the process streams; `hooksInstalled` is the option
// that makes javi's hooks count as installed or not.

export interface SessionEnd {
  /** The server promise resolved (stdin closed and every pending message answered). */
  exited: boolean;
  /** Complete stdout lines that arrived after stdin was closed. */
  trailing: string[];
  /** stdout bytes that never got a terminating `\n`. */
  partial: string;
  /** Every complete stdout line of the session, in order. */
  stdoutLines: string[];
  /** stderr, read in full. */
  stderr: string;
}

export interface Session {
  /** Writes `text` as UTF-8 bytes followed by `\n`. */
  write(text: string): void;
  /** The next unread complete stdout line, or null after `timeoutMs`. */
  nextLine(timeoutMs: number): Promise<string | null>;
  /** Closes stdin, waits up to `timeoutMs` for the server to finish, then reads what is left. */
  close(timeoutMs: number): Promise<SessionEnd>;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export const openSession = (hooksInstalled: boolean): Session => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let pending = '';
  const unread: string[] = [];
  const all: string[] = [];
  let wake: (() => void) | null = null;
  let errText = '';

  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      unread.push(line);
      all.push(line);
      nl = pending.indexOf('\n');
    }
    wake?.();
  });
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    errText += chunk;
  });

  let exited = false;
  const done = serveStdio(stdin, stdout, stderr, {
    version: '0.0.0-conformance',
    hooksInstalled: () => hooksInstalled,
  }).then(() => {
    exited = true;
  });

  const nextLine = async (timeoutMs: number): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs;
    while (unread.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
    return unread.shift() ?? null;
  };

  return {
    write(text) {
      stdin.write(Buffer.from(`${text}\n`, 'utf8'));
    },
    nextLine,
    async close(timeoutMs) {
      stdin.end();
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
      // Let stream 'data' events already queued by the server's last writes arrive.
      await tick();
      await tick();
      return {
        exited,
        trailing: unread.splice(0),
        partial: pending,
        stdoutLines: [...all],
        stderr: errText,
      };
    },
  };
};
