import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { gunzip } from 'node:zlib';
import { parseGeminiMetrics, type AdapterUsagePoint } from '@javis-dog/collector-adapters';
import { createFileSpool, createJgrClient, type JgrClient } from '@javis-dog/jgr-sdk';
import { parseOtlpMetrics } from './otlp.ts';
import { runFlush } from './run.ts';
import type { CollectorState, ReceiverInfo } from './state.ts';
import { toUsageGroups, toUsageRecord, usageThreadRef, type CumulativeBaselines } from './usage.ts';

// Local OTLP/HTTP JSON metrics receiver for Claude Code and Gemini CLI token usage (ADR-0011,
// ADR-0016, JD-C01). Bound to 127.0.0.1 only. Request bodies, headers and the secret are never
// logged or stored: only the allowlisted usage fields of attributed sessions reach the
// project's spool. Gemini CLI also exports logs and traces to the same endpoint; those are
// answered `200 {}` and drained without being parsed or kept.

/** Decoded (and wire) body limit. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** The receiver exits after this long without requests. */
export const RECEIVER_IDLE_MS = 30 * 60 * 1000;
/** Minimum gap between two flushes of the same project. */
export const RECEIVER_FLUSH_GAP_MS = 3_000;
/** Minimum gap between two receiver spawn attempts from hooks. */
export const RECEIVER_SPAWN_DEBOUNCE_MS = 5_000;
/** Hooks do not spawn a receiver for this long after another program was found on the port. */
export const RECEIVER_PORT_CONFLICT_BACKOFF_MS = 10 * 60 * 1000;
/** On every reply to an authenticated request: the receiver's pid (its identity for the CLI). */
export const RECEIVER_PID_HEADER = 'x-javi-receiver-pid';
const PATHS = new Set(['/v1/metrics', '/']);
/** Accepted and discarded unread (Gemini CLI sends all three OTLP signals; ADR-0016 §3). */
const SINK_PATHS = new Set(['/v1/logs', '/v1/traces']);

export interface UsageReceiverOptions {
  state: CollectorState;
  /** 0 picks a free port (tests). */
  port: number;
  secret: string;
  /** Installation salt: session ids are hashed with it, exactly like the hooks do. */
  salt: string;
  idleMs?: number;
  flushGapMs?: number;
  /** Delivers one project's spool; defaults to the locked `runFlush`. */
  flush?: (projectRef: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

export interface UsageReceiver {
  /** Starts listening on 127.0.0.1; resolves the bound port. Rejects with EADDRINUSE etc. */
  listen(): Promise<number>;
  /** Stops listening, waits for requests and a running flush, marks receiver.json stopped. */
  close(): Promise<void>;
  /** Resolves after the receiver closed itself for being idle. */
  idle: Promise<void>;
}

/** True when a process with this pid exists (EPERM: exists, owned by someone else). */
export const isPidAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
};

/** True when something accepts TCP connections on 127.0.0.1:port. */
export const isPortInUse = (port: number, timeoutMs = 1_000): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/**
 * Asks whatever listens on 127.0.0.1:port whether it is a javi receiver holding `secret`:
 * an authenticated empty OTLP request (`{}`: 200, no events). Resolves the pid the receiver
 * reports, or null (nothing listening, wrong secret, another program, no answer in time).
 */
export const probeReceiver = (
  port: number,
  secret: string,
  timeoutMs = 1_000,
): Promise<number | null> =>
  new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve(null);
      return;
    }
    const body = '{}';
    let settled = false;
    const done = (pid: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(pid);
    };
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/metrics',
        method: 'POST',
        agent: false, // one-shot connection: nothing lingers in a hook process
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          connection: 'close',
        },
      },
      (res) => {
        const raw = res.headers[RECEIVER_PID_HEADER];
        const pid = typeof raw === 'string' && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : null;
        res.resume();
        done(res.statusCode === 200 ? pid : null);
      },
    );
    const timer = setTimeout(() => done(null), timeoutMs);
    req.on('error', () => done(null));
    req.end(body);
  });

/**
 * The receiver recorded in receiver.json, only when its process is alive AND a probe with the
 * usage secret confirms that this very pid answers on the recorded port. A live pid alone may
 * be a recycled pid of an unrelated program: never signal or trust it without the probe.
 */
export const liveReceiver = async (state: CollectorState): Promise<ReceiverInfo | null> => {
  const info = await state.receiverInfo();
  if (!info || !isPidAlive(info.pid)) return null;
  const config = await state.usageConfig();
  if (!config) return null;
  return (await probeReceiver(info.port, config.secret)) === info.pid ? info : null;
};

/** True while a port conflict younger than the back-off is recorded in receiver.json. */
export const portConflictActive = (info: ReceiverInfo | null, nowMs: number): boolean => {
  const at = info?.portConflict ? Date.parse(info.portConflict.at) : NaN;
  return Number.isFinite(at) && nowMs - at < RECEIVER_PORT_CONFLICT_BACKOFF_MS;
};

/**
 * Called by hooks when usage is on: starts the receiver unless a confirmed one runs, at most
 * one spawn attempt per 5 s, none for 10 min after another program was found on the port.
 * A second receiver racing for the port exits by itself. Never throws.
 */
export const ensureReceiver = async (opts: {
  state: CollectorState;
  spawnReceiver: () => void;
  now?: () => number;
}): Promise<'running' | 'backoff' | 'debounced' | 'spawned' | 'error'> => {
  try {
    if (await liveReceiver(opts.state)) return 'running';
    const now = opts.now?.() ?? Date.now();
    if (portConflictActive(await opts.state.receiverInfo(), now)) return 'backoff';
    if (now - (await opts.state.receiverRequestedAt()) < RECEIVER_SPAWN_DEBOUNCE_MS) {
      return 'debounced';
    }
    await opts.state.markReceiverRequested(now);
    opts.spawnReceiver();
    return 'spawned';
  } catch {
    return 'error';
  }
};

const digest = (value: string) => createHash('sha256').update(value).digest();

const send = (res: ServerResponse, status: number, body: object, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Consumes the body to its end without keeping a single chunk, whatever its size (ADR-0016
 * Changes R9): Gemini CLI log batches can exceed 1 MiB, and answering 413 would only make the
 * exporter retry. The server's request timeout still bounds how long a body may stream.
 */
const discardBody = (req: IncomingMessage): Promise<void> =>
  new Promise((resolve, reject) => {
    req.on('data', () => {}); // each chunk is dropped as it arrives
    req.on('end', () => resolve());
    req.on('error', () => reject(new HttpError(400, 'Request aborted.')));
  });

/**
 * Gemini CLI points from the same body. JD-C02 is a pure parser: should it throw, Claude Code
 * usage of the same request must not be lost, so a throw counts as "no Gemini points".
 */
const geminiPoints = (body: unknown): AdapterUsagePoint[] => {
  try {
    const parsed = parseGeminiMetrics(body);
    return parsed.ok ? parsed.points : [];
  } catch {
    return [];
  }
};

/** Reads at most MAX_BODY_BYTES from the wire; beyond that stops buffering (413). */
const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return; // drained, never buffered
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Body larger than 1 MiB.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => reject(new HttpError(400, 'Request aborted.')));
  });

const gunzipCapped = (raw: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    // maxOutputLength caps the decompressed size: a gzip bomb fails fast instead of filling memory.
    gunzip(raw, { maxOutputLength: MAX_BODY_BYTES }, (error, out) => {
      if (!error) resolve(out);
      else if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
        reject(new HttpError(413, 'Decoded body larger than 1 MiB.'));
      } else reject(new HttpError(400, 'Invalid gzip body.'));
    });
  });

export const createUsageReceiver = (opts: UsageReceiverOptions): UsageReceiver => {
  const { state, secret, salt } = opts;
  const idleMs = opts.idleMs ?? RECEIVER_IDLE_MS;
  const flushGapMs = opts.flushGapMs ?? RECEIVER_FLUSH_GAP_MS;
  const flush =
    opts.flush ??
    ((projectRef: string) =>
      runFlush({ state, projectRef, ...(opts.fetch && { fetch: opts.fetch }) }));
  const expectedAuth = digest(`Bearer ${secret}`);
  // One map per platform: Claude Code and Gemini CLI series can never share a baseline.
  const baselines: CumulativeBaselines = new Map();
  const geminiBaselines: CumulativeBaselines = new Map();
  /**
   * When this receiver started listening (Unix ns). A Gemini series that started at or after it
   * counts from its first export, because every export since then reached this receiver
   * (ADR-0016 Changes R2). Until `listen()` resolves, no series qualifies.
   */
  let startedNs: string | undefined;

  let port = opts.port;
  let info: ReceiverInfo | null = null;
  let closing = false;
  let idleTimer: NodeJS.Timeout | undefined;
  let resolveIdle!: () => void;
  const idle = new Promise<void>((r) => (resolveIdle = r));
  const inFlight = new Set<Promise<unknown>>();

  // receiver.json writes are serialized so a later snapshot never lands before an earlier one.
  let infoWrite: Promise<void> = Promise.resolve();
  const persistInfo = () => {
    if (!info) return infoWrite;
    const snapshot = { ...info };
    infoWrite = infoWrite.then(() => state.saveReceiverInfo(snapshot)).catch(() => {});
    return infoWrite;
  };

  // Per-project flush scheduling: at most one flush per `flushGapMs`, never two at once.
  const flushes = new Map<
    string,
    {
      lastStart: number;
      timer: NodeJS.Timeout | undefined;
      running: Promise<void> | undefined;
      again: boolean;
    }
  >();
  const scheduleFlush = (projectRef: string) => {
    if (closing) return;
    let entry = flushes.get(projectRef);
    if (!entry) {
      entry = { lastStart: -Infinity, timer: undefined, running: undefined, again: false };
      flushes.set(projectRef, entry);
    }
    const slot = entry;
    if (slot.running) {
      slot.again = true; // events recorded during a flush get the next one
      return;
    }
    if (slot.timer) return; // the pending flush re-reads the spool
    const wait = Math.max(0, slot.lastStart + flushGapMs - Date.now());
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      slot.lastStart = Date.now();
      slot.running = flush(projectRef)
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          slot.running = undefined;
          if (slot.again) {
            slot.again = false;
            scheduleFlush(projectRef);
          }
        });
    }, wait);
  };

  const armIdle = () => {
    if (closing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void close().then(resolveIdle);
    }, idleMs);
    idleTimer.unref();
  };

  /** Usage groups → the attributed projects' spools. Returns the projects that got events. */
  const accept = async (body: unknown) => {
    const parsed = parseOtlpMetrics(body);
    if (!parsed.ok) throw new HttpError(400, 'Not an OTLP metrics request.');
    const gemini = geminiPoints(body);
    // An empty request (e.g. the CLI's probe) carries no export: nothing to count or record.
    if (!parsed.points.length && !gemini.length) return;
    // Baselines move on a copy, committed only once every record of this request is spooled:
    // after an internal error (503) the exporter's retry is computed against the same baselines.
    const working: CumulativeBaselines = new Map(baselines);
    const workingGemini: CumulativeBaselines = new Map(geminiBaselines);
    const groups = [
      ...toUsageGroups(parsed.points, working),
      ...toUsageGroups(gemini, workingGemini, 'gemini-cli', {
        ...(startedNs !== undefined && { receiverStartNs: startedNs }),
      }),
    ];
    const { producer_id } = await state.installation();
    const clients = new Map<string, JgrClient | null>();
    const touched = new Set<string>();
    let forwarded = 0;
    let dropped = 0;
    for (const group of groups) {
      const threadRef = usageThreadRef(group, salt);
      const projectRef = await state.sessionProject(threadRef);
      if (!projectRef) {
        dropped += 1; // usage of sessions no hook attributed never leaves the machine
        continue;
      }
      if (!clients.has(projectRef)) {
        const creds = await state.credentials(projectRef);
        clients.set(
          projectRef,
          creds
            ? createJgrClient({
                endpoint: creds.endpoint,
                token: creds.token,
                producerId: producer_id,
                spool: createFileSpool(state.spoolDir(projectRef)),
              })
            : null,
        );
      }
      const client = clients.get(projectRef);
      if (!client) {
        dropped += 1;
        continue;
      }
      const record = toUsageRecord(group, { projectRef, salt });
      const result = await client.record({
        ...record,
        sequence: await state.nextSequence(threadRef),
      });
      if (result.ok) {
        forwarded += 1;
        touched.add(projectRef);
      } else dropped += 1;
    }
    for (const [key, value] of working) baselines.set(key, value);
    for (const [key, value] of workingGemini) geminiBaselines.set(key, value);
    if (info) {
      info.forwarded += forwarded;
      info.dropped += dropped;
      info.lastRequestAt = new Date().toISOString();
      await persistInfo();
    }
    for (const projectRef of touched) scheduleFlush(projectRef);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0]!;
    const sink = SINK_PATHS.has(path);
    if (!PATHS.has(path) && !sink) return send(res, 404, { message: 'Not found.' });
    if (req.method !== 'POST') {
      return send(res, 405, { message: 'Method not allowed.' }, { allow: 'POST' });
    }
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !timingSafeEqual(digest(auth), expectedAuth)) {
      return send(res, 401, { message: 'Unauthorized.' }, { 'www-authenticate': 'Bearer' });
    }
    // Only an authenticated caller keeps the receiver alive and learns who answers.
    armIdle();
    res.setHeader(RECEIVER_PID_HEADER, String(process.pid));
    // DNS-rebinding guard: a browser page on another name can reach 127.0.0.1 but not fake Host.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return send(res, 403, { message: 'Forbidden host.' });
    }
    if (sink) {
      // Logs and traces carry prompts, tool arguments and responses: never parsed, decoded,
      // stored or counted. The body is drained unbuffered at any size (R9), only after the
      // bearer and Host checks above.
      await discardBody(req);
      return send(res, 200, {});
    }
    const mediaType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return send(res, 415, { message: 'Only application/json (OTLP http/json) is accepted.' });
    }
    const encoding = (req.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && encoding !== 'gzip') {
      return send(res, 415, { message: 'Only gzip or identity encoding is accepted.' });
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return send(res, 413, { message: 'Body larger than 1 MiB.' }, { connection: 'close' });
    }
    const raw = await readBody(req);
    const decoded = encoding === 'gzip' ? await gunzipCapped(raw) : raw;
    if (decoded.length > MAX_BODY_BYTES) throw new HttpError(413, 'Body larger than 1 MiB.');
    let body: unknown;
    try {
      body = JSON.parse(decoded.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
    await accept(body);
    send(res, 200, {});
  };

  const server = createServer((req, res) => {
    const work = handle(req, res).catch((error: unknown) => {
      // Internal errors (lock busy, spool write failed) are retryable for OTLP clients (503);
      // event ids are deterministic and baselines unchanged, so a retry is counted once.
      const status = error instanceof HttpError ? error.status : 503;
      const message =
        error instanceof HttpError ? error.message : 'Temporarily unavailable, please retry.';
      if (!res.headersSent) {
        // The rest of an oversized body is drained (not buffered) so the client reads the answer.
        send(res, status, { message }, status === 413 ? { connection: 'close' } : {});
      }
    });
    // Whatever was answered, an unread body is drained without buffering.
    void work.finally(() => req.resume());
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const close = async () => {
    if (closing) return;
    closing = true;
    if (idleTimer) clearTimeout(idleTimer);
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeIdleConnections();
    });
    await Promise.all(inFlight);
    for (const slot of flushes.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      await slot.running;
    }
    if (info) {
      info.pid = 0;
      await persistInfo();
    }
  };

  return {
    listen: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, '127.0.0.1', () => {
          server.off('error', reject);
          port = (server.address() as { port: number }).port;
          startedNs = String(BigInt(Date.now()) * 1_000_000n);
          void (async () => {
            // Counters carry over restarts so `javi status` keeps the totals since `usage on`.
            const previous = await state.receiverInfo();
            const count = (n: unknown) =>
              Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : 0;
            info = {
              pid: process.pid,
              port,
              startedAt: new Date().toISOString(),
              forwarded: count(previous?.forwarded),
              dropped: count(previous?.dropped),
              lastRequestAt:
                typeof previous?.lastRequestAt === 'string' ? previous.lastRequestAt : null,
            };
            await persistInfo();
            armIdle();
            resolve(port);
          })().catch(reject);
        });
      }),
    close,
    idle,
  };
};
