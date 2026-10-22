import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
export const writeJsonPrivate = async (path: string, value: unknown) => {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
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
  };
};

export type CollectorState = ReturnType<typeof createState>;
