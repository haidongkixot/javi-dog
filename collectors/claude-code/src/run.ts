import { createHmac } from 'node:crypto';
import {
  codexSubagentLink,
  mapCodexHook,
  mapGeminiHook,
  matchJaviTool,
  selfReportRecord,
  type AdapterContext,
} from '@javis-dog/collector-adapters';
import {
  createFileSpool,
  createJgrClient,
  type FlushResult,
  type RecordInput,
} from '@javis-dog/jgr-sdk';
import { codexEnvRisks, codexHome, type SystemProxyProbe } from './codex-config.ts';
import { codexThreadRef } from './codex-usage.ts';
import { geminiHome } from './gemini-settings.ts';
import { findGeminiTelemetryOverrides } from './gemini-telemetry.ts';
import { COLLECTOR_VERSION, mapHook, opaqueRef } from './mapping.ts';
import type { Platform } from './platform.ts';
import {
  buildIdentityRecord,
  isIdentityTrigger,
  loadProjectKeys,
  ulidAfter,
  type StoredPrivacy,
} from './privacy.ts';
import { readSessionFolder } from './session-folder.ts';
import type { CollectorState } from './state.ts';

/** Above this many waiting events a hook triggers a background flush. */
export const FLUSH_BACKLOG = 25;
/** A hook also triggers a flush when the last one is older than this. */
export const FLUSH_INTERVAL_MS = 30_000;
/** Minimum gap between two background flush spawns. */
export const FLUSH_DEBOUNCE_MS = 3_000;
/** Events that should reach the dashboard promptly. */
/**
 * An empty environment typed as `NodeJS.ProcessEnv`, so the package also type-checks where a
 * global augmentation makes some variable required (Next.js: `NODE_ENV`).
 */
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

const URGENT = new Set(['attention.requested', 'session.ended', 'session.started']);
/** The end-of-turn hook of each platform: its `heartbeat idle` is flushed at once too. */
const END_OF_TURN: Readonly<Record<Platform, string>> = {
  'claude-code': 'Stop',
  'codex-cli': 'Stop',
  'gemini-cli': 'AfterAgent',
};

/**
 * Prompt delivery (ADR-0017 §3, review H2): besides `URGENT`, a self-reported status other than
 * `working`, a self-reported `task.failed`, and the end-of-turn `heartbeat idle` (Claude Code
 * and Codex `Stop`, Gemini `AfterAgent`) start a flush at once. `selfReported` is true only for
 * a record built by the self-report path (javi's own tool), never inferred from its shape.
 */
export const isUrgent = (
  input: Pick<RecordInput, 'type' | 'status'>,
  ctx: { platform: Platform; hookEvent: unknown; selfReported: boolean },
): boolean => {
  if (URGENT.has(input.type)) return true;
  if (ctx.selfReported) {
    return (
      (input.type === 'heartbeat' && input.status !== 'working') || input.type === 'task.failed'
    );
  }
  return (
    input.type === 'heartbeat' &&
    input.status === 'idle' &&
    ctx.hookEvent === END_OF_TURN[ctx.platform]
  );
};

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
   * Gemini CLI and Codex CLI: the hook process's environment (the agent passes its own, `.env`
   * included) and working directory (the session's folder), for the SessionStart checks.
   */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Codex CLI SessionStart: OS proxy settings to check as well (S5c code review M3); the CLI
   * passes the real `scutil` / `reg` runner (2 s timeout), tests inject one.
   */
  systemProxy?: SystemProxyProbe;
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
    const env = deps.env ?? EMPTY_ENV;
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
 * Codex CLI SessionStart (ADR-0016 Changes H1, H2, M5): looks in the hook's environment (Codex
 * passes its own, `$CODEX_HOME/.env` included) and in `$CODEX_HOME/.env` for a proxy that would
 * carry Codex's logs and javi's bearer off the loopback, for header variables that replace the
 * bearer (both while Codex usage is on), and for javi's own Claude Code header value, which
 * Codex would merge into its default metrics export to OpenAI (while Claude Code usage is on).
 * NO_PROXY counts with hyper-util's rules (S5c code review H1), and OS proxy settings (macOS
 * `scutil --proxy`, Windows Internet Settings, M3) count as a proxy too. Runs only in folders
 * with javi's Codex hooks. Records a local warning with names and paths only, or clears the project's warning. Never
 * throws.
 */
const checkCodexEnv = async (deps: HookDeps) => {
  try {
    const config = await deps.state.usageConfig();
    if (!config) {
      await deps.state.removeCodexEnvWarning(deps.projectRef);
      return;
    }
    const env = deps.env ?? EMPTY_ENV;
    const risks = await codexEnvRisks({
      env,
      home: codexHome(env),
      // OS proxy settings only matter while Codex usage is on (they redirect its log export).
      ...(config.codex && deps.systemProxy && { system: deps.systemProxy }),
      ...(config.written?.OTEL_EXPORTER_OTLP_METRICS_HEADERS && {
        claudeHeader: config.written.OTEL_EXPORTER_OTLP_METRICS_HEADERS,
      }),
    });
    const proxy = config.codex ? risks.proxy : [];
    const headers = config.codex ? risks.headers : [];
    if (proxy.length || headers.length || risks.claudeHeader) {
      await deps.state.saveCodexEnvWarning({
        project: deps.projectRef,
        at: (deps.now?.() ?? new Date()).toISOString(),
        proxy,
        headers,
        claudeHeader: risks.claudeHeader,
      });
    } else {
      await deps.state.removeCodexEnvWarning(deps.projectRef);
    }
  } catch {
    // A check that cannot run must never cost the hook event.
  }
};

/** The JGR record for a hook, by platform (JD-C02 adapters for Gemini CLI and Codex CLI). */
const mapForPlatform = (raw: unknown, deps: HookDeps, salt: string) => {
  const ctx: AdapterContext = {
    projectRef: deps.projectRef,
    salt,
    collectorVersion: COLLECTOR_VERSION,
  };
  if (deps.platform === 'gemini-cli') return mapGeminiHook(raw, ctx);
  if (deps.platform === 'codex-cli') return mapCodexHook(raw, ctx);
  return mapHook(raw, { projectRef: deps.projectRef, salt });
};

/**
 * The seen-call key of a self-report (code review M1): hex HMAC-SHA-256(salt, platform ‖ 0x00 ‖
 * session id ‖ 0x00 ‖ call id) for Claude Code and Codex, whose post-tool payloads carry a
 * `tool_use_id`; null for Gemini (no call id) or a payload without one. Reads only `session_id`
 * and `tool_use_id`, which `selfReportRecord` reads too. The raw ids never leave this function.
 */
export const selfReportSeenKey = (platform: Platform, raw: unknown, salt: string) => {
  if (platform === 'gemini-cli' || !raw || typeof raw !== 'object') return null;
  const own = (key: string) => {
    const value: unknown = Object.hasOwn(raw, key) ? (raw as Record<string, unknown>)[key] : null;
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  const sessionId = own('session_id');
  const callId = own('tool_use_id');
  if (!sessionId || !callId) return null;
  return createHmac('sha256', salt)
    .update(`${platform}\u0000${sessionId}\u0000${callId}`)
    .digest('hex');
};

/** The hook payload's `cwd` (an own property), read only for L1/L2 projects (G13). */
const payloadCwd = (raw: unknown): unknown =>
  raw && typeof raw === 'object' && Object.hasOwn(raw, 'cwd')
    ? (raw as { cwd?: unknown }).cwd
    : undefined;

/**
 * ADR-0018 §5 (review H1): after a trigger event of an L1/L2 project, records the thread's
 * `x.javi.thread.identity` with the same `thread_ref`. Nothing when the stored key cannot be
 * loaded or the payload has no usable `cwd`. Never throws: a failure here never costs the
 * trigger event, which is already spooled unchanged.
 */
const recordIdentity = async (
  args: Readonly<{
    privacy: StoredPrivacy | undefined;
    raw: unknown;
    trigger: { event_id: string; thread_ref: string; occurred_at: string } & Pick<
      RecordInput,
      'type' | 'status'
    >;
    selfReported: boolean;
    projectRef: string;
    producerId: string;
    platform: Platform;
    state: CollectorState;
    client: ReturnType<typeof createJgrClient>;
  }>,
): Promise<void> => {
  try {
    if (!args.privacy) return;
    if (!isIdentityTrigger(args.trigger, args.selfReported)) return;
    const loaded = await loadProjectKeys(args.privacy, args.projectRef);
    if (!loaded) return;
    const folder = await readSessionFolder(payloadCwd(args.raw));
    if (!folder) return;
    const record = await buildIdentityRecord({
      loaded,
      projectRef: args.projectRef,
      producerId: args.producerId,
      threadRef: args.trigger.thread_ref,
      platform: args.platform,
      folder,
      eventId: ulidAfter(args.trigger.event_id),
      occurredAt: args.trigger.occurred_at,
    });
    const sequence = await args.state.nextSequence(record.thread_ref);
    await args.client.record({ ...record, sequence });
  } catch {
    // The identity costs only the names, never the status signal.
  }
};

const hookEventName = (raw: unknown) =>
  raw && typeof raw === 'object' ? (raw as { hook_event_name?: unknown }).hook_event_name : null;

/**
 * One hook invocation: map → persist sequence → spool → maybe start a background flush.
 * Never throws and never writes to stdout: a hook must not change Claude Code's behaviour.
 *
 * javi's own self-report tools (ADR-0017 §3, JD-C02 `matchJaviTool`): a pre-tool hook records
 * nothing; a post-tool hook records only `selfReportRecord(…)`, built on the platform mapper's
 * record for the same hook as its base (same thread, agent and platform attributes), or
 * nothing when the input is invalid. Never the generic tool event. When the platform mapper
 * returns null (no `session_id` or no event name) nothing is recorded: `selfReportRecord`
 * needs the session id too, so no valid base could exist. Every other tool maps as before.
 * A self-report whose call (platform, session, `tool_use_id`) was already recorded is ignored
 * (seen-call marker, code review M1).
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
    const codex = deps.platform === 'codex-cli';
    if (codex) {
      // For `javi status`: proof that Codex runs our hooks (project trusted, hooks approved).
      await deps.state
        .markHookSeen(deps.projectRef, 'codex-cli', deps.now?.() ?? new Date())
        .catch(() => {});
      if (hookEventName(raw) === 'SessionStart') await checkCodexEnv(deps);
    }
    const platform = deps.platform ?? 'claude-code';
    const mapped = mapForPlatform(raw, deps, salt);
    if (!mapped) return 'ignored';
    if (gemini) {
      // For `javi status`: proof that Gemini runs our hooks (an untrusted folder never does).
      await deps.state
        .markHookSeen(deps.projectRef, 'gemini-cli', deps.now?.() ?? new Date())
        .catch(() => {});
      if (mapped.type === 'session.started') await checkGeminiTelemetry(deps);
    }
    let input: RecordInput = mapped;
    const javi = matchJaviTool(platform, raw);
    if (javi) {
      // Pre-tool: silent (no task.started without an end). Post-tool: the report or nothing.
      if (javi.phase === 'pre') return 'ignored';
      const report = selfReportRecord(
        platform,
        raw,
        { salt, at: deps.now?.() ?? new Date() },
        mapped,
      );
      if (!report) return 'ignored';
      // A re-run hook of the same call (code review M1): its event id differs (the time part is
      // the hook clock), so JD-C01 remembers the call and records it only once.
      const seenKey = selfReportSeenKey(platform, raw, salt);
      // A marker that cannot be read or written never costs the report (a duplicate is better).
      const fresh = seenKey ? await deps.state.markSelfReportSeen(seenKey).catch(() => true) : true;
      if (!fresh) return 'ignored';
      input = report;
    }

    // Usage attribution (ADR-0011), only while usage is on: the receiver forwards only sessions
    // seen by a hook. Failures here must not cost the hook event itself.
    const usageOn = await deps.state.usageConfig().then(Boolean, () => false);
    if (usageOn) {
      const seenAt = (deps.now?.() ?? new Date()).getTime();
      await deps.state
        .rememberSession(input.thread_ref, deps.projectRef, seenAt)
        .catch(() => false);
      if (codex && hookEventName(raw) === 'SubagentStart') {
        // C6/M4: the sub-agent's usage arrives under its own id; stored before the hook exits.
        try {
          const link = codexSubagentLink(raw);
          if (link) {
            await deps.state.rememberSubagent(
              codexThreadRef(link.agentId, salt),
              codexThreadRef(link.sessionId, salt),
              input.agent_ref ?? opaqueRef('ag', link.agentId, salt),
              seenAt,
            );
          }
        } catch {
          // A link that cannot be stored only means that sub-agent's usage is dropped.
        }
      }
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
    if (creds.privacy) {
      await recordIdentity({
        privacy: creds.privacy,
        raw,
        trigger: result.event,
        selfReported: javi !== null,
        projectRef: deps.projectRef,
        producerId: producer_id,
        platform,
        state: deps.state,
        client,
      });
    }

    const now = (deps.now?.() ?? new Date()).getTime();
    const urgent = isUrgent(input, {
      platform,
      hookEvent: hookEventName(raw),
      selfReported: javi !== null,
    });
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
      // ADR-0018 §5 (review H1): the codes of rejected events, for `javi status`.
      const codes: string[] = [];
      let rejectedEvents = 0;
      const client = createJgrClient({
        endpoint: creds.endpoint,
        token: creds.token,
        producerId: producer_id,
        spool: createFileSpool(deps.state.spoolDir(deps.projectRef)),
        maxAttempts: 3,
        ...(deps.fetch && { fetch: deps.fetch }),
        ...(deps.now && { now: deps.now }),
        ...(deps.sleep && { sleep: deps.sleep }),
        onRejected: (rejected) => {
          rejectedEvents += rejected.length;
          for (const event of rejected) {
            for (const issue of event.issues ?? []) codes.push(String(issue?.code));
          }
        },
      });
      // client.flush() re-reads the spool each round, so events recorded meanwhile are included.
      const flushed = await client.flush();
      const at = (deps.now?.() ?? new Date()).toISOString();
      await deps.state.saveLastFlush(deps.projectRef, { at, ...flushed });
      if (rejectedEvents > 0) {
        await deps.state.saveRejections(deps.projectRef, at, codes, rejectedEvents).catch(() => {});
      }
      return flushed;
    });
  // Another flusher holds the lock: give it a moment, then try once more so an urgent
  // event recorded during its last round is not left waiting for the next hook.
  const first = await attempt();
  if (first) return first;
  await sleep(1_000);
  return (await attempt()) ?? { status: 'busy' };
};
