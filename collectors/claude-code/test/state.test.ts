import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createState } from '../src/index.ts';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'javi-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('collector state', () => {
  it('creates the installation once and keeps it across instances', async () => {
    const a = await createState(home).installation();
    const b = await createState(home).installation();
    expect(a).toEqual(b);
    expect(a.producer_id).toMatch(/^prod_claude-code_[0-9a-f]{12}$/);
    expect(a.salt.length).toBeGreaterThanOrEqual(43);
  });

  it('counts sequences per thread across instances, without duplicates under concurrency', async () => {
    const s = createState(home);
    const seqs = await Promise.all(Array.from({ length: 20 }, () => s.nextSequence('cc_thread')));
    expect([...seqs].sort((x, y) => x - y)).toEqual([...Array(20).keys()]);
    expect(await createState(home).nextSequence('cc_thread')).toBe(20);
    expect(await s.nextSequence('cc_other')).toBe(0);
  });

  it('stores credentials per project and can forget them', async () => {
    const s = createState(home);
    await s.saveCredentials('web-app', {
      endpoint: 'https://x.test/api/v1/events',
      token: 'jd_it_t',
    });
    await s.saveCredentials('api', { endpoint: 'https://x.test/api/v1/events', token: 'jd_it_u' });
    expect(await s.credentials('web-app')).toMatchObject({ token: 'jd_it_t' });
    await s.removeCredentials('web-app');
    expect(await s.credentials('web-app')).toBeNull();
    expect(await s.credentials('api')).not.toBeNull();
    expect(await readFile(join(home, 'credentials.json'), 'utf8')).not.toContain('jd_it_t');
  });

  it('lets only one flusher per project run at a time', async () => {
    const s = createState(home);
    let release!: () => void;
    const first = s.tryFlushLock(
      'web-app',
      () => new Promise<string>((r) => (release = () => r('first'))),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.tryFlushLock('web-app', async () => 'second')).toBeNull();
    expect(await s.tryFlushLock('api', async () => 'other project')).toBe('other project');
    release();
    expect(await first).toBe('first');
    expect(await s.tryFlushLock('web-app', async () => 'third')).toBe('third');
  });
});
