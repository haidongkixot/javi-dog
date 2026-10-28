import { createFileSpool, createJgrClient, type FlushResult } from '@javis-dog/jgr-sdk';
import { mapHook } from './mapping.ts';
import type { CollectorState } from './state.ts';

/** Above this many waiting events a hook triggers a background flush. */
export const FLUSH_BACKLOG = 25;
/** A hook also triggers a flush when the last one is older than this. */
export const FLUSH_INTERVAL_MS = 30_000;
/** Minimum gap between two background flush spawns. */
export const FLUSH_DEBOUNCE_MS = 3_000;
/** Events that should reach the dashboard promptly. */
const URGENT = new Set(['attention.requested', 'session.ended', 'session.started']);

export interface HookDeps {
  state: CollectorState;
  projectRef: string;
  stdin: string;
  now?: () => Date;
  /** Starts `javi flush` in the background (detached in the CLI). */
  spawnFlush: () => void;
  /**
   * When token usage is on (`~/.javi/usage.json`): makes sure the local usage receiver runs
   * (ADR-0011). Must never throw or print; the CLI spawns a detached `javi receive`.
   */
  ensureReceiver?: () => void | Promise<void>;
}

/**
 * One hook invocation: map → persist sequence → spool → maybe start a background flush.
 * Never throws and never writes to stdout: a hook must not change Claude Code's behaviour.
 */
export const runHook = async (deps: HookDeps): Promise<'recorded' | 'ignored' | 'error'> => {
  try {
    const creds = await deps.state.credentials(deps.projectRef);
    if (!creds) return 'ignored';
    let raw: unknown;
    try {
      raw = JSON.parse(deps.stdin);
    } catch {
      return 'ignored';
    }
    const { producer_id, salt } = await deps.state.installation();
    const input = mapHook(raw, { projectRef: deps.projectRef, salt });
    if (!input) return 'ignored';

    // Usage attribution (ADR-0011): the receiver forwards only sessions seen by a hook.
    // Failures here must not cost the hook event itself.
    const seenAt = (deps.now?.() ?? new Date()).getTime();
    await deps.state.rememberSession(input.thread_ref, deps.projectRef, seenAt).catch(() => false);
    if (deps.ensureReceiver) {
      try {
        if (await deps.state.usageConfig()) await deps.ensureReceiver();
      } catch {
        // A receiver that cannot start shows up in `javi status`, never in Claude Code.
      }
    }

    const spool = createFileSpool(deps.state.spoolDir(deps.projectRef));
    const client = createJgrClient({
      endpoint: creds.endpoint,
      token: creds.token,
      producerId: producer_id,
      spool,
      ...(deps.now && { now: deps.now }),
    });
    const sequence = await deps.state.nextSequence(input.thread_ref);
    const result = await client.record({ ...input, sequence });
    if (!result.ok) return 'error';

    const now = (deps.now?.() ?? new Date()).getTime();
    const urgent = URGENT.has(input.type);
    if (!urgent && now - (await deps.state.flushRequestedAt(deps.projectRef)) < FLUSH_DEBOUNCE_MS) {
      return 'recorded';
    }
    const last = await deps.state.lastFlush(deps.projectRef);
    const lastAt = typeof last?.at === 'string' ? Date.parse(last.at) : 0;
    if (urgent || (await spool.count()) >= FLUSH_BACKLOG || now - lastAt >= FLUSH_INTERVAL_MS) {
      await deps.state.markFlushRequested(deps.projectRef, now);
      deps.spawnFlush();
    }
    return 'recorded';
  } catch {
    return 'error';
  }
};

export interface FlushDeps {
  state: CollectorState;
  projectRef: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Delivers the project's spool; one flusher per project at a time. */
export const runFlush = async (
  deps: FlushDeps,
): Promise<FlushResult | { status: 'not_configured' | 'busy' }> => {
  const creds = await deps.state.credentials(deps.projectRef);
  if (!creds) return { status: 'not_configured' };
  const { producer_id } = await deps.state.installation();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempt = () =>
    deps.state.tryFlushLock(deps.projectRef, async () => {
      const client = createJgrClient({
        endpoint: creds.endpoint,
        token: creds.token,
        producerId: producer_id,
        spool: createFileSpool(deps.state.spoolDir(deps.projectRef)),
        maxAttempts: 3,
        ...(deps.fetch && { fetch: deps.fetch }),
        ...(deps.now && { now: deps.now }),
        ...(deps.sleep && { sleep: deps.sleep }),
      });
      // client.flush() re-reads the spool each round, so events recorded meanwhile are included.
      const flushed = await client.flush();
      await deps.state.saveLastFlush(deps.projectRef, {
        at: (deps.now?.() ?? new Date()).toISOString(),
        ...flushed,
      });
      return flushed;
    });
  // Another flusher holds the lock: give it a moment, then try once more so an urgent
  // event recorded during its last round is not left waiting for the next hook.
  const first = await attempt();
  if (first) return first;
  await sleep(1_000);
  return (await attempt()) ?? { status: 'busy' };
};
