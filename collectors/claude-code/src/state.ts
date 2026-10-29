import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * Only hashed session refs (`opaqueRef('cc' | 'gm', …)`: Claude Code, Gemini CLI) may name a
 * file — never a raw session id.
 */
const THREAD_REF = /^(?:cc|gm)_[0-9a-f]{32}$/;
const SESSION_FILE = /^(?:cc|gm)_[0-9a-f]{32}\.json$/;
const WARNING_PREFIX = 'gemini-telemetry.';

export const javiHome = (env: NodeJS.ProcessEnv = process.env) =>
  env.JAVI_HOME?.trim() || join(homedir(), '.javi');

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
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
  const path = (...parts: string[]) => join(home, ...parts);

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
