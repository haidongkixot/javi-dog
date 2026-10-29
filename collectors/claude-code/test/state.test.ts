import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCEPTED_IDS_MAX, SESSION_TTL_MS, createState } from '../src/index.ts';

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

describe('createState home creation', () => {
  it('never leaves an unhandled rejection when the home cannot be created', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // The parent is a regular file, so mkdir(home) fails before any method awaits it.
      const parent = join(await mkdtemp(join(tmpdir(), 'javi-state-ready-')), 'file');
      await writeFile(parent, 'x');
      const state = createState(join(parent, 'home'));
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      // Callers still see the failure when they use the state.
      await expect(state.installation()).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Codex sub-agent links (S5c C6, M4)', () => {
  const child = `cx_${'a'.repeat(32)}`;
  const parent = `cx_${'b'.repeat(32)}`;
  const agent = `ag_${'c'.repeat(32)}`;
  it('stores hashed refs only, with the 7-day session TTL', async () => {
    const s = createState(home);
    const day = 24 * 60 * 60 * 1000;
    expect(await s.rememberSubagent('raw-agent-id', parent, agent, 0)).toBe(false);
    expect(await s.rememberSubagent(child, 'raw-session-id', agent, 0)).toBe(false);
    expect(await s.rememberSubagent(child, parent, 'has/slash', 0)).toBe(false);
    expect(await s.rememberSubagent(child, parent, agent, 1_000)).toBe(true);
    expect(await s.subagentParent(child, 1_000 + 6 * day)).toEqual({ parent, agentRef: agent });
    expect(await s.subagentParent(`cx_${'d'.repeat(32)}`)).toBeNull();
    expect(await s.subagentParent(child, 1_000 + 7 * day)).toBeNull();
    expect(await s.subagentParent(child, 1_000)).toBeNull(); // expired entries are removed
  });

  it('sessions accept cx_ refs', async () => {
    const s = createState(home);
    expect(await s.rememberSession(parent, 'web-app', Date.now())).toBe(true);
    expect(await s.sessionProject(parent)).toBe('web-app');
  });

  it('accepted event ids (S5c item 8): persisted, bounded to the newest, swept after 7 days, UUIDs only', async () => {
    const id = (n: number) => `00000000-0000-8000-8000-${String(n).padStart(12, '0')}`;
    const s = createState(home);
    const t0 = 1_800_000_000_000;
    await s.recordAcceptedEventIds('codex-cli', [id(1), id(2), 'not-an-id', 'sess-raw'], t0);
    expect([...(await createState(home).acceptedEventIds('codex-cli', t0))].sort()).toEqual([
      id(1),
      id(2),
    ]);
    expect(await s.acceptedEventIds('gemini-cli', t0)).toEqual(new Set());
    // Newest `max` kept; an id seen again is refreshed, not duplicated.
    await s.recordAcceptedEventIds('codex-cli', [id(3), id(1)], t0 + 1, 2);
    expect([...(await s.acceptedEventIds('codex-cli', t0 + 1))].sort()).toEqual([id(1), id(3)]);
    // Older than 7 days: gone on read and swept on the next write.
    const later = t0 + 1 + SESSION_TTL_MS;
    expect(await s.acceptedEventIds('codex-cli', later)).toEqual(new Set());
    await s.recordAcceptedEventIds('codex-cli', [id(4)], later);
    const file = await readFile(join(home, 'accepted', 'codex-cli.json'), 'utf8');
    expect(JSON.parse(file).ids).toEqual([[id(4), later]]);
    expect(ACCEPTED_IDS_MAX).toBe(20_000);
    await expect(s.recordAcceptedEventIds('../x', [id(5)], t0)).rejects.toThrow();
  });
});
