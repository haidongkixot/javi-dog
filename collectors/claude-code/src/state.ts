import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SelfReportRegistration } from './mcp-registration.ts';

// Local collector state under JAVI_HOME (default ~/.javi). Files holding secrets are written
// with mode 0600 (POSIX; on Windows the user profile ACL applies). Never inside a repository.

export interface Installation {
  /** Stable per installation (JGR-R03). */
  producer_id: string;
  /** Per-installation salt: session and agent ids are hashed with it (spec §12). */
  salt: string;
}

export interface ProjectCredentials {
  endpoint: string;
  token: string;
}

/** What `javi usage on --platform gemini-cli` wrote into Gemini CLI's user settings (ADR-0016). */
export interface GeminiUsageConfig {
  /** The `~/.gemini/settings.json` javi edited (usage off edits the same file). */
  path: string;
  /** The `telemetry` block javi wrote (for refusal checks and a clean `usage off`). */
  written: Record<string, unknown>;
  /** SHA-256 (hex) of the whole file as javi wrote it: unchanged → exact restore. */
  sha256: string;
}

/** `~/.javi/usage.json` — written by `javi usage on` (ADR-0011). Holds the local secret. */
export interface UsageConfig {
  port: number;
  /** Bearer secret the agents send to the local receiver; never printed. */
  secret: string;
  /**
   * The env values javi wrote into Claude's user settings (for a clean `usage off`). Absent
   * when Claude Code usage is off and only another platform uses the receiver (ADR-0016).
   */
  written?: Record<string, string>;
  /** Present while Gemini CLI usage export is on (ADR-0016 §3). */
  gemini?: GeminiUsageConfig;
  /** Present while Codex CLI usage export is on (ADR-0016 Changes S5c C3, H6). */
  codex?: CodexUsageConfig;
}

/** What `javi usage on --platform codex-cli` appended to Codex's user `config.toml`. */
export interface CodexUsageConfig {
  /** The `$CODEX_HOME/config.toml` javi edited (usage off edits the same file). */
  path: string;
  /** The exact marked block javi wrote (`# >>> javi usage …` to `# <<< javi`, final newline). */
  block: string;
  /** What javi put before the block to separate it from the user's text ('' or line breaks). */
  separator: string;
  /** True when javi created the file: usage off removes it again if nothing else is left. */
  created: boolean;
}

/**
 * `~/.javi/warnings/codex-env.<project>.json` — written by a Codex CLI SessionStart hook that
 * found a proxy or header variable that would redirect or break Codex's log export (ADR-0016
 * Changes H1, M5), or javi's own Claude Code header in Codex's environment (H2). Names, paths,
 * project and time only: never a value.
 */
export interface CodexEnvWarning {
  project: string;
  at: string;
  /** Proxy variables not covered by NO_PROXY for 127.0.0.1 (H1), per source. */
  proxy: Array<{ source: string; keys: string[] }>;
  /** OTLP header variables that override javi's bearer (M5), per source. */
  headers: Array<{ source: string; keys: string[] }>;
  /** javi's Claude Code `OTEL_EXPORTER_OTLP_METRICS_HEADERS` value is in Codex's env (H2). */
  claudeHeader: boolean;
}

/** `~/.javi/codex-hooks/<hash of the hooks.json path>.json` (S5c code review L5). */
export interface CodexHooksOriginRecord {
  /** javi created `.codex/hooks.json`: uninstall may delete it when nothing else is left. */
  created: boolean;
  /** Hook events the user's file already had (also empty ones): uninstall keeps them. */
  events: string[];
  /** The user's file had a `hooks` key. */
  hooksKey: boolean;
}

/** `~/.javi/gemini-settings.before.json` — Gemini user settings before the first `usage on`. */
export interface GeminiSettingsBefore {
  path: string;
  existed: boolean;
  /** The file's exact text (absent when it did not exist). */
  text?: string;
}

/**
 * `~/.javi/warnings/gemini-telemetry.<project>.json` — written by a Gemini CLI SessionStart hook
 * that found a telemetry override (ADR-0016 Changes R1). Names, paths, project and time only:
 * never a value.
 */
export interface GeminiTelemetryWarning {
  project: string;
  at: string;
  overrides: Array<{ source: string; keys: string[] }>;
}

/** `~/.javi/receiver.json` — the running (or last) usage receiver. `pid` 0 = stopped cleanly. */
export interface ReceiverInfo {
  pid: number;
  port: number;
  startedAt: string;
  /** Usage groups spooled for a project (lifetime of the file, carried across restarts). */
  forwarded: number;
  /** Usage groups dropped locally: unknown session, project without credentials, invalid. */
  dropped: number;
  /** Last accepted OTLP export, or null. */
  lastRequestAt: string | null;
  /** Codex records skipped because their event id was already spooled (re-sent, item 8). */
  duplicates?: number;
  /**
   * Set by `javi receive` when another program holds the usage port (Claude Code's exports go
   * there); hooks back off spawning for a while. A successful listen or `usage on` clears it.
   */
  portConflict?: { at: string };
}

/** Session attributions older than this count as absent and are pruned (ADR-0011). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A hook refreshes its session's attribution at most this often. */
const SESSION_REFRESH_MS = 60 * 60 * 1000;
/** Full sweeps of `sessions/` at most this often. */
const SESSION_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
/**
 * Only hashed session refs (`opaqueRef('cc' | 'gm' | 'cx', …)`: Claude Code, Gemini CLI, Codex
 * CLI) may name a file — never a raw session id.
 */
const THREAD_REF = /^(?:cc|gm|cx)_[0-9a-f]{32}$/;
const SESSION_FILE = /^(?:cc|gm|cx)_[0-9a-f]{32}\.json$/;
/** Codex sub-agent links: hashed child ref → hashed parent session ref (S5c C6, M4). */
const CODEX_REF = /^cx_[0-9a-f]{32}$/;
const AGENT_REF = /^[A-Za-z0-9_:-]{1,128}$/;
/** Accepted usage event ids (UUIDs) kept per platform, newest last (S5c code review item 8). */
export const ACCEPTED_IDS_MAX = 20_000;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLATFORM_NAME = /^[a-z][a-z-]{0,31}$/;
/** Self-report seen-call keys kept (code review M1), newest last. */
export const SEEN_CALLS_MAX = 512;
/** A seen-call key: hex HMAC-SHA-256, never a raw session or call id. */
const SEEN_KEY = /^[0-9a-f]{64}$/;
const WARNING_PREFIX = 'gemini-telemetry.';
const CODEX_WARNING_PREFIX = 'codex-env.';

export const javiHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.JAVI_HOME?.trim() || join(homedir(), '.javi');

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** `[eventId, atMs]` pairs of an accepted-ids file; anything malformed is skipped. */
const readAccepted = async (path: string): Promise<Array<[string, number]>> => {
  const file = await readJson<{ ids?: unknown }>(path);
  if (!file || !Array.isArray(file.ids)) return [];
  return file.ids.filter(
    (e): e is [string, number] =>
      Array.isArray(e) &&
      typeof e[0] === 'string' &&
      EVENT_ID.test(e[0]) &&
      typeof e[1] === 'number' &&
      Number.isFinite(e[1]),
  );
};

/** Temp file + rename so a crash never leaves half a file behind. */
export const writeJsonPrivate = async (path: string, value: unknown, mode = 0o600) =>
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);

/** Writes `text` to a temp file next to `path` (with `mode`), then renames it onto `path`. */
export const writeTextAtomic = async (path: string, text: string, mode = 0o600) => {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { mode });
    await rename(temp, path);
  } catch (e) {
    await rm(temp, { force: true }).catch(() => {});
    throw e;
  }
};

export const createState = (home: string) => {
  const ready = mkdir(home, { recursive: true, mode: 0o700 });
  // Handled here so a home that cannot be created is never an unhandled rejection (which
  // would print to stderr and change the exit code of a hook); every method that awaits
  // `ready` still sees the error.
  ready.catch(() => {});
  const path = (...parts: string[]) => join(home, ...parts);
  const registrationFile = (platform: string, file: string) =>
    path(
      'self-report',
      `${createHash('sha256')
        .update(`${platform}\u0000${resolve(file)}`)
        .digest('hex')
        .slice(0, 32)}.json`,
    );
  const isRegistration = (value: unknown): value is SelfReportRegistration => {
    const r = value as Partial<SelfReportRegistration> | null;
    return (
      !!r &&
      typeof r === 'object' &&
      typeof r.platform === 'string' &&
      typeof r.project === 'string' &&
      typeof r.dir === 'string' &&
      typeof r.file === 'string' &&
      typeof r.created === 'boolean' &&
      typeof r.container === 'boolean' &&
      typeof r.separator === 'string' &&
      Array.isArray(r.allow) &&
      r.allow.every((a) => typeof a === 'string') &&
      (r.allowCreated === null || r.allowCreated === 'permissions' || r.allowCreated === 'allow')
    );
  };
  const originFile = (hooksPath: string) =>
    path(
      'codex-hooks',
      `${createHash('sha256').update(resolve(hooksPath)).digest('hex').slice(0, 32)}.json`,
    );

  /** Runs `work` while holding a directory lock (mkdir is atomic everywhere). */
  const withLock = async <T>(name: string, work: () => Promise<T>, staleMs = 5_000) => {
    await ready;
    await mkdir(path('locks'), { recursive: true, mode: 0o700 });
    const lock = path('locks', name);
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch {
        const age = await stat(lock).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        );
        if (age > staleMs) await rm(lock, { recursive: true, force: true });
        else if (attempt > 200) throw new Error(`Lock busy: ${name}`);
        else await new Promise((r) => setTimeout(r, 5));
      }
    }
    try {
      return await work();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  };

  return {
    home,
    spoolDir: (projectRef: string) => path('spool', projectRef),

    /** Created once; later calls return the same producer id and salt. */
    installation: () =>
      withLock('installation', async () => {
        const file = path('installation.json');
        const existing = await readJson<Installation>(file);
        if (existing?.producer_id && existing.salt) return existing;
        const created: Installation = {
          producer_id: `prod_claude-code_${randomBytes(6).toString('hex')}`,
          salt: randomBytes(32).toString('base64url'),
        };
        await writeJsonPrivate(file, created);
        return created;
      }),

    credentials: async (projectRef: string) =>
      (await readJson<Record<string, ProjectCredentials>>(path('credentials.json')))?.[
        projectRef
      ] ?? null,

    saveCredentials: (projectRef: string, creds: ProjectCredentials) =>
      withLock('credentials', async () => {
        const file = path('credentials.json');
        const all = (await readJson<Record<string, ProjectCredentials>>(file)) ?? {};
        all[projectRef] = creds;
        await writeJsonPrivate(file, all);
      }),

    removeCredentials: (projectRef: string) =>
      withLock('credentials', async () => {
        const file = path('credentials.json');
        const all = (await readJson<Record<string, ProjectCredentials>>(file)) ?? {};
        delete all[projectRef];
        await writeJsonPrivate(file, all);
      }),

    /** Next sequence for a thread, persisted so separate hook processes keep counting. */
    nextSequence: (threadRef: string) =>
      withLock(`seq-${threadRef}`, async () => {
        await mkdir(path('seq'), { recursive: true, mode: 0o700 });
        const file = path('seq', `${threadRef}.json`);
        const next = (await readJson<{ next: number }>(file))?.next ?? 0;
        await writeJsonPrivate(file, { next: next + 1 });
        return next;
      }),

    /** Only one flusher per project at a time; returns null when another one is running. */
    tryFlushLock: async <T>(projectRef: string, work: () => Promise<T>): Promise<T | null> => {
      await ready;
      await mkdir(path('locks'), { recursive: true, mode: 0o700 });
      const lock = path('locks', `flush-${projectRef}`);
      try {
        await mkdir(lock);
      } catch {
        const age = await stat(lock).then(
          (s) => Date.now() - s.mtimeMs,
          () => 0,
        );
        if (age < 120_000) return null;
        await rm(lock, { recursive: true, force: true });
        await mkdir(lock);
      }
      try {
        return await work();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    },

    /** When a hook last started a background flush (debounces spawns during tool bursts). */
    flushRequestedAt: async (projectRef: string) =>
      (await readJson<{ at: number }>(path('last-flush', `${projectRef}.requested.json`)))?.at ?? 0,

    markFlushRequested: async (projectRef: string, at: number) => {
      await mkdir(path('last-flush'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(path('last-flush', `${projectRef}.requested.json`), { at });
    },

    lastFlush: (projectRef: string) =>
      readJson<Record<string, unknown>>(path('last-flush', `${projectRef}.json`)),

    saveLastFlush: async (projectRef: string, result: Record<string, unknown>) => {
      await mkdir(path('last-flush'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(path('last-flush', `${projectRef}.json`), result);
    },

    // --- Token usage (ADR-0011) ---

    usageConfig: async (): Promise<UsageConfig | null> => {
      const config = await readJson<UsageConfig>(path('usage.json'));
      return config && Number.isInteger(config.port) && typeof config.secret === 'string'
        ? config
        : null;
    },

    saveUsageConfig: async (config: UsageConfig) => {
      await ready;
      await writeJsonPrivate(path('usage.json'), config);
    },

    removeUsageConfig: () => rm(path('usage.json'), { force: true }),

    /**
     * Records which project a session belongs to, so the usage receiver can attribute
     * machine-wide telemetry. Only hashed refs are accepted; returns false otherwise.
     */
    rememberSession: async (threadRef: string, projectRef: string, atMs: number) => {
      if (!THREAD_REF.test(threadRef)) return false;
      await ready;
      const dir = path('sessions');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${threadRef}.json`);
      const existing = await readJson<{ project: string; at: number }>(file);
      if (existing?.project !== projectRef || atMs - existing.at >= SESSION_REFRESH_MS) {
        await writeJsonPrivate(file, { project: projectRef, at: atMs });
      }
      // Opportunistic sweep, at most once a day; never fails the caller.
      const marker = join(dir, '.pruned.json');
      const pruned = (await readJson<{ at: number }>(marker))?.at ?? 0;
      if (atMs - pruned >= SESSION_PRUNE_EVERY_MS) {
        await writeJsonPrivate(marker, { at: atMs });
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          if (!SESSION_FILE.test(name)) continue;
          const entry = await readJson<{ at: number }>(join(dir, name));
          if (!entry || !(atMs - entry.at < SESSION_TTL_MS)) {
            await rm(join(dir, name), { force: true });
          }
        }
      }
      return true;
    },

    /** The project a session was seen in during the last 7 days, or null. */
    sessionProject: async (threadRef: string, nowMs = Date.now()): Promise<string | null> => {
      if (!THREAD_REF.test(threadRef)) return null;
      const file = path('sessions', `${threadRef}.json`);
      const entry = await readJson<{ project: string; at: number }>(file);
      if (!entry || typeof entry.project !== 'string' || typeof entry.at !== 'number') {
        return null;
      }
      if (!(nowMs - entry.at < SESSION_TTL_MS)) {
        await rm(file, { force: true });
        return null;
      }
      return entry.project;
    },

    /** Gemini CLI user settings as they were before javi's first `usage on` (ADR-0016). */
    geminiSettingsBefore: () => readJson<GeminiSettingsBefore>(path('gemini-settings.before.json')),

    saveGeminiSettingsBefore: async (before: GeminiSettingsBefore) => {
      await ready;
      await writeJsonPrivate(path('gemini-settings.before.json'), before);
    },

    removeGeminiSettingsBefore: () => rm(path('gemini-settings.before.json'), { force: true }),

    /**
     * Last hook event seen for a project from a platform other than Claude Code (`javi status`
     * says "no events yet" truthfully, e.g. for an untrusted Gemini CLI folder).
     */
    lastHookAt: async (projectRef: string, platform: string): Promise<string | null> => {
      const at = (
        await readJson<{ at: unknown }>(path('last-hook', `${projectRef}.${platform}.json`))
      )?.at;
      return typeof at === 'string' ? at : null;
    },

    markHookSeen: async (projectRef: string, platform: string, at: Date) => {
      await mkdir(path('last-hook'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(path('last-hook', `${projectRef}.${platform}.json`), {
        at: at.toISOString(),
      });
    },

    // --- Gemini CLI telemetry redirection warnings (ADR-0016 Changes R1) ---

    saveGeminiTelemetryWarning: async (warning: GeminiTelemetryWarning) => {
      await mkdir(path('warnings'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(path('warnings', `${WARNING_PREFIX}${warning.project}.json`), warning);
    },

    removeGeminiTelemetryWarning: (projectRef: string) =>
      rm(path('warnings', `${WARNING_PREFIX}${projectRef}.json`), { force: true }),

    /** All recorded warnings, oldest project name first. */
    geminiTelemetryWarnings: async (): Promise<GeminiTelemetryWarning[]> => {
      const names = await readdir(path('warnings')).catch(() => [] as string[]);
      const warnings: GeminiTelemetryWarning[] = [];
      for (const name of names.sort()) {
        if (!name.startsWith(WARNING_PREFIX) || !name.endsWith('.json')) continue;
        const w = await readJson<GeminiTelemetryWarning>(path('warnings', name));
        if (w && typeof w.project === 'string' && Array.isArray(w.overrides)) warnings.push(w);
      }
      return warnings;
    },

    clearGeminiTelemetryWarnings: async () => {
      const names = await readdir(path('warnings')).catch(() => [] as string[]);
      for (const name of names) {
        if (name.startsWith(WARNING_PREFIX)) await rm(path('warnings', name), { force: true });
      }
    },

    // --- Codex CLI (ADR-0016 Changes S5c) ---

    /**
     * Records that the Codex sub-agent thread `childRef` (`opaqueRef('cx', agent_id)`) belongs
     * to the session `parentRef` (`opaqueRef('cx', session_id)`), with the sub-agent's
     * `agentRef`, so the receiver can count its usage in the parent thread (C6, M4). Hashed refs
     * only; same 7-day TTL as session attributions. Returns false for anything else.
     */
    rememberSubagent: async (
      childRef: string,
      parentRef: string,
      agentRef: string,
      atMs: number,
    ): Promise<boolean> => {
      if (!CODEX_REF.test(childRef) || !CODEX_REF.test(parentRef) || !AGENT_REF.test(agentRef)) {
        return false;
      }
      await ready;
      await mkdir(path('subagents'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(path('subagents', `${childRef}.json`), {
        parent: parentRef,
        agent_ref: agentRef,
        at: atMs,
      });
      // Opportunistic sweep, at most once a day (as for sessions); never fails the caller.
      const marker = path('subagents', '.pruned.json');
      const pruned = (await readJson<{ at: number }>(marker))?.at ?? 0;
      if (atMs - pruned >= SESSION_PRUNE_EVERY_MS) {
        await writeJsonPrivate(marker, { at: atMs }).catch(() => {});
        for (const name of await readdir(path('subagents')).catch(() => [] as string[])) {
          if (!/^cx_[0-9a-f]{32}\.json$/.test(name)) continue;
          const entry = await readJson<{ at: number }>(path('subagents', name));
          if (!entry || !(atMs - entry.at < SESSION_TTL_MS)) {
            await rm(path('subagents', name), { force: true });
          }
        }
      }
      return true;
    },

    /** The parent session and agent ref of a Codex sub-agent seen in the last 7 days, or null. */
    subagentParent: async (
      childRef: string,
      nowMs = Date.now(),
    ): Promise<{ parent: string; agentRef: string } | null> => {
      if (!CODEX_REF.test(childRef)) return null;
      const file = path('subagents', `${childRef}.json`);
      const entry = await readJson<{ parent: unknown; agent_ref: unknown; at: unknown }>(file);
      if (
        !entry ||
        typeof entry.parent !== 'string' ||
        !CODEX_REF.test(entry.parent) ||
        typeof entry.agent_ref !== 'string' ||
        !AGENT_REF.test(entry.agent_ref) ||
        typeof entry.at !== 'number'
      ) {
        return null;
      }
      if (!(nowMs - entry.at < SESSION_TTL_MS)) {
        await rm(file, { force: true });
        return null;
      }
      return { parent: entry.parent, agentRef: entry.agent_ref };
    },

    /**
     * Event ids the receiver already spooled for `platform` in the last 7 days (S5c code review
     * item 8): a re-sent Codex record or re-logged turn cost has the same deterministic id and
     * must not be spooled again with a new sequence (a JGR §9 gap). Ids are HMAC-derived UUIDs,
     * never raw conversation or turn ids.
     */
    acceptedEventIds: async (platform: string, nowMs = Date.now()): Promise<Set<string>> => {
      if (!PLATFORM_NAME.test(platform)) return new Set();
      const entries = await readAccepted(path('accepted', `${platform}.json`));
      return new Set(entries.filter(([, at]) => nowMs - at < SESSION_TTL_MS).map(([id]) => id));
    },

    /**
     * Adds ids that were just spooled (after a successful append only). Keeps the newest
     * `max` (default 20 000) ids from the last 7 days; atomic write under a lock, mode 0600.
     */
    recordAcceptedEventIds: async (
      platform: string,
      ids: string[],
      nowMs = Date.now(),
      max = ACCEPTED_IDS_MAX,
    ) => {
      if (!PLATFORM_NAME.test(platform)) throw new Error('Unknown platform for accepted ids.');
      const fresh = ids.filter((id) => EVENT_ID.test(id));
      if (!fresh.length) return;
      await withLock(`accepted-${platform}`, async () => {
        const file = path('accepted', `${platform}.json`);
        const adding = new Set(fresh);
        const kept = (await readAccepted(file)).filter(
          ([id, at]) => !adding.has(id) && nowMs - at < SESSION_TTL_MS,
        );
        const next = [...kept, ...[...adding].map((id) => [id, nowMs] as [string, number])];
        await mkdir(path('accepted'), { recursive: true, mode: 0o700 });
        await writeTextAtomic(file, `${JSON.stringify({ v: 1, ids: next.slice(-max) })}\n`);
      });
    },

    /**
     * What a project's `.codex/hooks.json` was before javi's first init (S5c code review L5),
     * keyed by a hash of its path (no path in a file name). Event names and flags only.
     */
    codexHooksOrigin: async (hooksPath: string): Promise<CodexHooksOriginRecord | null> => {
      const entry = await readJson<CodexHooksOriginRecord>(originFile(hooksPath));
      return entry &&
        typeof entry.created === 'boolean' &&
        typeof entry.hooksKey === 'boolean' &&
        Array.isArray(entry.events) &&
        entry.events.every((e) => typeof e === 'string')
        ? { created: entry.created, events: entry.events, hooksKey: entry.hooksKey }
        : null;
    },

    saveCodexHooksOrigin: async (hooksPath: string, origin: CodexHooksOriginRecord) => {
      await ready;
      await mkdir(path('codex-hooks'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(originFile(hooksPath), {
        created: origin.created,
        events: origin.events,
        hooksKey: origin.hooksKey,
      });
    },

    removeCodexHooksOrigin: (hooksPath: string) => rm(originFile(hooksPath), { force: true }),

    // --- Agent self-report registrations (ADR-0017 §5) ---

    /**
     * What `javi init --self-report` wrote into one registration file (`.mcp.json`,
     * `.gemini/settings.json` or `.codex/config.toml`), keyed by a hash of platform and path.
     * Paths, flags and javi's own allow rules only; never a token.
     */
    selfReportRegistration: async (
      platform: string,
      file: string,
    ): Promise<SelfReportRegistration | null> => {
      const entry = await readJson<unknown>(registrationFile(platform, file));
      return isRegistration(entry) ? entry : null;
    },

    saveSelfReportRegistration: async (registration: SelfReportRegistration) => {
      await ready;
      await mkdir(path('self-report'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(
        registrationFile(registration.platform, registration.file),
        registration,
      );
    },

    removeSelfReportRegistration: (platform: string, file: string) =>
      rm(registrationFile(platform, file), { force: true }),

    /**
     * Self-report seen-call marker (code review M1): checks and sets `key` (hex HMAC of
     * platform, session id and call id) in `self-report/seen.json`, newest `max` keys kept. True
     * when the key is new (record the report), false when a hook already recorded this call. A
     * corrupt or missing file counts as empty.
     */
    markSelfReportSeen: async (key: string, max = SEEN_CALLS_MAX): Promise<boolean> => {
      if (!SEEN_KEY.test(key)) throw new Error('A seen-call key must be a hex HMAC.');
      return withLock('self-report-seen', async () => {
        const file = path('self-report', 'seen.json');
        const stored = await readJson<{ keys?: unknown }>(file);
        const keys =
          stored && Array.isArray(stored.keys)
            ? stored.keys.filter((k): k is string => typeof k === 'string' && SEEN_KEY.test(k))
            : [];
        if (keys.includes(key)) return false;
        await mkdir(path('self-report'), { recursive: true, mode: 0o700 });
        await writeTextAtomic(
          file,
          `${JSON.stringify({ v: 1, keys: [...keys, key].slice(-max) })}\n`,
        );
        return true;
      });
    },

    /** Every recorded registration (for `javi mcp`: where a project's hooks live). */
    selfReportRegistrations: async (): Promise<SelfReportRegistration[]> => {
      const names = await readdir(path('self-report')).catch(() => [] as string[]);
      const found: SelfReportRegistration[] = [];
      for (const name of names.sort()) {
        if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
        const entry = await readJson<unknown>(path('self-report', name));
        if (isRegistration(entry)) found.push(entry);
      }
      return found;
    },

    saveCodexEnvWarning: async (warning: CodexEnvWarning) => {
      await mkdir(path('warnings'), { recursive: true, mode: 0o700 });
      await writeJsonPrivate(
        path('warnings', `${CODEX_WARNING_PREFIX}${warning.project}.json`),
        warning,
      );
    },

    removeCodexEnvWarning: (projectRef: string) =>
      rm(path('warnings', `${CODEX_WARNING_PREFIX}${projectRef}.json`), { force: true }),

    /** All recorded Codex warnings, oldest project name first. */
    codexEnvWarnings: async (): Promise<CodexEnvWarning[]> => {
      const names = await readdir(path('warnings')).catch(() => [] as string[]);
      const warnings: CodexEnvWarning[] = [];
      for (const name of names.sort()) {
        if (!name.startsWith(CODEX_WARNING_PREFIX) || !name.endsWith('.json')) continue;
        const w = await readJson<CodexEnvWarning>(path('warnings', name));
        if (
          w &&
          typeof w.project === 'string' &&
          Array.isArray(w.proxy) &&
          Array.isArray(w.headers)
        ) {
          warnings.push(w);
        }
      }
      return warnings;
    },

    clearCodexEnvWarnings: async () => {
      const names = await readdir(path('warnings')).catch(() => [] as string[]);
      for (const name of names) {
        if (name.startsWith(CODEX_WARNING_PREFIX))
          await rm(path('warnings', name), { force: true });
      }
    },

    receiverInfo: () => readJson<ReceiverInfo>(path('receiver.json')),

    saveReceiverInfo: async (info: ReceiverInfo) => {
      await ready;
      await writeJsonPrivate(path('receiver.json'), info);
    },

    removeReceiverInfo: () => rm(path('receiver.json'), { force: true }),

    /** When a hook last tried to start the receiver (debounces spawns). */
    receiverRequestedAt: async () =>
      (await readJson<{ at: number }>(path('receiver.requested.json')))?.at ?? 0,

    markReceiverRequested: async (at: number) => {
      await ready;
      await writeJsonPrivate(path('receiver.requested.json'), { at });
    },
  };
};

export type CollectorState = ReturnType<typeof createState>;
