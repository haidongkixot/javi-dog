import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JgrEvent } from '@javis-dog/jgr-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileSpool, createMemorySpool, type Spool } from '../src/index.ts';

const ev = (n: number): JgrEvent =>
  ({
    jgr: '0.1',
    event_id: `01JBZ4XQ80${String(n).padStart(16, '0')}`,
    producer_id: 'prod_test',
    project_ref: 'web-app',
    thread_ref: 'sess_1',
    sequence: n,
    type: 'heartbeat',
    status: 'working',
    occurred_at: '2026-10-23T00:00:00Z',
    privacy_class: 'L0',
  }) as JgrEvent;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jgr-spool-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const kinds: Array<[string, (max: number) => Spool]> = [
  ['memory', (maxEvents) => createMemorySpool({ maxEvents })],
  ['file', (maxEvents) => createFileSpool(join(dir, 'spool'), { maxEvents })],
];

describe.each(kinds)('%s spool', (_, make) => {
  it('is FIFO by event id regardless of append order', async () => {
    const spool = make(10);
    await spool.append([ev(3), ev(1)]);
    await spool.append([ev(2)]);
    expect((await spool.peek(10)).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect((await spool.peek(2)).map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('evicts the oldest events beyond the bound and reports how many', async () => {
    const spool = make(3);
    await spool.append([ev(1), ev(2)]);
    expect(await spool.append([ev(3), ev(4), ev(5)])).toEqual({ evicted: 2 });
    expect((await spool.peek(10)).map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(await spool.count()).toBe(3);
  });

  it('removes by id and ignores unknown ids', async () => {
    const spool = make(10);
    await spool.append([ev(1), ev(2)]);
    await spool.remove([ev(1).event_id, ev(9).event_id]);
    expect((await spool.peek(10)).map((e) => e.sequence)).toEqual([2]);
  });
});

describe('file spool specifics', () => {
  it('survives a new instance (process restart) and leaves no temp files', async () => {
    const path = join(dir, 'spool');
    await createFileSpool(path).append([ev(1), ev(2)]);
    const reopened = createFileSpool(path);
    expect(await reopened.count()).toBe(2);
    expect((await readdir(path)).every((f) => f.endsWith('.json'))).toBe(true);
    expect(JSON.parse(await readFile(join(path, `${ev(1).event_id}.json`), 'utf8'))).toEqual(ev(1));
  });

  it('skips and deletes a corrupt file instead of blocking the queue', async () => {
    const path = join(dir, 'spool');
    const spool = createFileSpool(path);
    await spool.append([ev(2)]);
    await writeFile(join(path, `${ev(1).event_id}.json`), '{not json');
    expect((await spool.peek(10)).map((e) => e.sequence)).toEqual([2]);
    expect(await spool.count()).toBe(1);
  });

  it('refuses ids that could escape the directory', async () => {
    const spool = createFileSpool(join(dir, 'spool'));
    await expect(
      spool.append([{ ...ev(1), event_id: '../../etc/passwd' } as JgrEvent]),
    ).rejects.toThrow(/Unsafe/);
  });
});
