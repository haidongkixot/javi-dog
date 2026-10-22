import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JgrEvent } from '@javis-dog/jgr-spec';

/**
 * Local queue of validated events waiting for delivery (JGR §8, ADR-0009). FIFO by
 * `event_id` (ULIDs sort by time), bounded with oldest-first eviction. Holds events only —
 * never the ingest token.
 */
export interface Spool {
  /** Adds events; returns how many old events were evicted to stay within the bound. */
  append(events: JgrEvent[]): Promise<{ evicted: number }>;
  /** Oldest events first, at most `limit`. */
  peek(limit: number): Promise<JgrEvent[]>;
  remove(eventIds: string[]): Promise<void>;
  count(): Promise<number>;
}

export const DEFAULT_SPOOL_MAX_EVENTS = 10_000;

export const createMemorySpool = ({ maxEvents = DEFAULT_SPOOL_MAX_EVENTS } = {}): Spool => {
  let queue: JgrEvent[] = [];
  return {
    async append(events) {
      queue.push(...events);
      queue.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
      const evicted = Math.max(0, queue.length - maxEvents);
      if (evicted) queue = queue.slice(evicted);
      return { evicted };
    },
    peek: async (limit) => queue.slice(0, limit),
    async remove(ids) {
      const gone = new Set(ids);
      queue = queue.filter((e) => !gone.has(e.event_id));
    },
    count: async () => queue.length,
  };
};

// Event ids become file names: allow only ULID/UUID characters, never path separators.
const SAFE_ID = /^[0-9A-Za-z-]{26,36}$/;
const isMissing = (e: unknown) => (e as { code?: string })?.code === 'ENOENT';

/**
 * One file per event in a private directory. Safe for several short-lived processes
 * (hook scripts): writes are temp-file + rename, and if two processes send the same
 * event the receiver deduplicates it (ADR-0008).
 */
export const createFileSpool = (
  dir: string,
  { maxEvents = DEFAULT_SPOOL_MAX_EVENTS } = {},
): Spool => {
  const ready = mkdir(dir, { recursive: true, mode: 0o700 });
  const file = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error('Unsafe event id for the file spool.');
    return join(dir, `${id}.json`);
  };
  const list = async () => {
    await ready;
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  };
  const unlinkQuietly = (path: string) =>
    unlink(path).catch((e: unknown) => {
      if (!isMissing(e)) throw e;
    });

  return {
    async append(events) {
      await ready;
      for (const event of events) {
        const target = file(event.event_id);
        const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(temp, JSON.stringify(event), { mode: 0o600 });
        await rename(temp, target);
      }
      const files = await list();
      const excess = files.slice(0, Math.max(0, files.length - maxEvents));
      await Promise.all(excess.map((f) => unlinkQuietly(join(dir, f))));
      return { evicted: excess.length };
    },

    async peek(limit) {
      const out: JgrEvent[] = [];
      for (const name of await list()) {
        if (out.length >= limit) break;
        const path = join(dir, name);
        try {
          out.push(JSON.parse(await readFile(path, 'utf8')) as JgrEvent);
        } catch (e) {
          // Taken by another process (ENOENT) or corrupt: a corrupt file can never be sent.
          if (!isMissing(e)) await unlinkQuietly(path);
        }
      }
      return out;
    },

    async remove(ids) {
      await Promise.all(ids.map((id) => unlinkQuietly(file(id))));
    },

    count: async () => (await list()).length,
  };
};
