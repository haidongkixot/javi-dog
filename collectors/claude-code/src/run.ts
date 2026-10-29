import { mapGeminiHook } from '@javis-dog/collector-adapters';
import { createFileSpool, createJgrClient, type FlushResult } from '@javis-dog/jgr-sdk';
import { geminiHome } from './gemini-settings.ts';
import { findGeminiTelemetryOverrides } from './gemini-telemetry.ts';
import { COLLECTOR_VERSION, mapHook } from './mapping.ts';
import type { Platform } from './platform.ts';
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
  /**
   * Which agent called the hook (ADR-0016): `claude-code` (default) maps with `mapHook`,
   * `gemini-cli` with JD-C02 `mapGeminiHook` and records when a Gemini hook was last seen.
   */
  platform?: Platform;
  now?: () => Date;
  /** Starts `javi flush` in the background (detached in the CLI). */
  spawnFlush: () => void;
  /**
   * When token usage is on (`~/.javi/usage.json`): makes sure the local usage receiver runs
   * (ADR-0011). Must never throw or print; the CLI spawns a detached `javi receive`.
   */
  ensureReceiver?: () => void | Promise<void>;
  /**
   * Gemini CLI only: the hook process's environment (Gemini passes its own, `.env` included)
   * and working directory (the session's folder), for the SessionStart telemetry check.
   */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Gemini CLI SessionStart while Gemini usage is on (ADR-0016 Changes R1): looks for anything
 * that would send this session's telemetry (logs with tool arguments, responses and the user's
 * email, plus javi's bearer) elsewhere — telemetry variables in the hook's environment, in the
 * folder's `.env` lookup chain (also covering variables Gemini redacts from hook environments)
 * and a workspace `telemetry` block — and records a local warning with names and paths only,
 * or clears the project's warning when there is none. Never throws.
 */
const checkGeminiTelemetry = async (deps: HookDeps) => {
  try {
    const config = await deps.state.usageConfig();
    if (!config?.gemini) return;
    const env = deps.env ?? {};
    const overrides = await findGeminiTelemetryOverrides({
      cwd: deps.cwd ?? process.cwd(),
      home: geminiHome(env),
      userSettingsPath: config.gemini.path,
      env,
      ...(config.written && { own: config.written }),
    });
    if (overrides.length) {
      await deps.state.saveGeminiTelemetryWarning({
        project: deps.projectRef,
        at: (deps.now?.() ?? new Date()).toISOString(),
        overrides,
      });
    } else {
      await deps.state.removeGeminiTelemetryWarning(deps.projectRef);
    }
  } catch {
    // A check that cannot run must never cost the hook event.
  }
};

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
    const gemini = deps.platform === 'gemini-cli';
    const input = gemini
      ? mapGeminiHook(raw, {
          projectRef: deps.projectRef,
          salt,
          collectorVersion: COLLECTOR_VERSION,
        })
      : mapHook(raw, { projectRef: deps.projectRef, salt });
    if (!input) return 'ignored';
    if (gemini) {
      // For `javi status`: proof that Gemini runs our hooks (an untrusted folder never does).
      await deps.state
        .markHookSeen(deps.projectRef, 'gemini-cli', deps.now?.() ?? new Date())
        .catch(() => {});
      if (input.type === 'session.started') await checkGeminiTelemetry(deps);
    }

    // Usage attribution (ADR-0011), only while usage is on: the receiver forwards only sessions
    // seen by a hook. Failures here must not cost the hook event itself.
    const usageOn = await deps.state.usageConfig().then(Boolean, () => false);
    if (usageOn) {
      const seenAt = (deps.now?.() ?? new Date()).getTime();
      await deps.state
        .rememberSession(input.thread_ref, deps.projectRef, seenAt)
        .catch(() => false);
      try {
        await deps.ensureReceiver?.();
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
