import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createProjectRepository } from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, settingsPath, type Io } from '../src/index.ts';

// javi CLI in-process → real JD-M05 handler → PGlite (TEST_PLAN S3c).
let client: PGlite;
let token: string;
let home: string;
let projectDir: string;
let fetchToHandler: typeof fetch;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  const projects = createProjectRepository(db);
  const ws = await projects.createWorkspace({ name: 'Collector team' });
  const p = await projects.createProject(ws.id, { name: 'Web App', platforms: ['claude-code'] });
  token = (await projects.issueToken(ws.id, p.id, 'laptop')).token;
  const handler = createIngestHandler(createIngestDeps(db));
  fetchToHandler = async (url, init) => handler(new Request(url as string, init));
  home = await mkdtemp(join(tmpdir(), 'javi-cli-home-'));
  projectDir = await mkdtemp(join(tmpdir(), 'javi-cli-project-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

const io = (overrides: Partial<Io> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[] = [];
  const value: Io = {
    env: { JAVI_HOME: home },
    cwd: projectDir,
    readStdin: async () => '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: (ref) => spawned.push(ref),
    spawnReceiver: () => spawned.push('receiver'),
    fetch: fetchToHandler,
    ...overrides,
  };
  return { value, out, err, spawned };
};

const events = async () =>
  (
    await client.query<{ type: string; thread_ref: string }>(
      'select type, thread_ref from events order by received_at, sequence',
    )
  ).rows;

describe('javi CLI end to end', () => {
  it('init stores the token outside the repo, registers hooks and verifies the connection', async () => {
    const t = io({ readStdin: async () => `${token}\n` });
    expect(
      await main(
        ['init', '--project', 'web-app', '--endpoint', 'http://localhost/api/v1/events'],
        t.value,
      ),
    ).toBe(0);
    expect(t.out.at(-1)).toMatch(/Connection verified/);
    expect(t.out.join('\n')).not.toContain(token);
    const settings = await readFile(settingsPath(projectDir), 'utf8');
    expect(settings).not.toContain(token);
    expect(settings).toContain('"--project"');
    expect(await readFile(join(home, 'credentials.json'), 'utf8')).toContain(token);
    expect((await events()).map((e) => e.type)).toEqual(['x.javi.collector.installed']);
  });

  it('refuses a malformed token or a plain-http remote endpoint', async () => {
    expect(
      await main(['init', '--project', 'web-app'], io({ readStdin: async () => 'nope' }).value),
    ).toBe(2);
    const t = io({ readStdin: async () => token });
    expect(
      await main(['init', '--project', 'web-app', '--endpoint', 'http://example.com/x'], t.value),
    ).toBe(2);
  });

  it('hook records silently and asks for a background flush; flush delivers', async () => {
    const stdin = JSON.stringify({
      session_id: 'sess-1',
      transcript_path: '/secret/t.jsonl',
      cwd: '/secret',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const t = io({ readStdin: async () => stdin });
    expect(await main(['hook', '--project', 'web-app'], t.value)).toBe(0);
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([]);
    expect(t.spawned).toEqual(['web-app']);

    const f = io();
    expect(await main(['flush', '--project', 'web-app', '--quiet'], f.value)).toBe(0);
    const types = (await events()).map((e) => e.type);
    expect(types).toContain('session.started');
    const stored = JSON.stringify(await events());
    expect(stored).not.toContain('sess-1');
  });

  it('hook stays silent and exits 0 for garbage input, unknown projects and bad args', async () => {
    for (const [argv, stdin] of [
      [['hook', '--project', 'web-app'], 'not json'],
      [['hook', '--project', 'unknown-project'], '{"session_id":"s","hook_event_name":"Stop"}'],
      [['hook'], ''],
      [['hook', '--project', '../etc'], ''],
    ] as Array<[string[], string]>) {
      const t = io({ readStdin: async () => stdin });
      expect(await main(argv, t.value)).toBe(0);
      expect([...t.out, ...t.err]).toEqual([]);
    }
  });

  it('status masks the token and reports the spool and last flush', async () => {
    const t = io();
    expect(await main(['status', '--project', 'web-app'], t.value)).toBe(0);
    const text = t.out.join('\n');
    expect(text).not.toContain(token);
    expect(text).toContain(token.slice(0, 10));
    expect(text).toMatch(/Spooled events: 0/);
    expect(text).toMatch(/"status":"ok"/);
  });

  it('a revoked token keeps events spooled (nothing lost)', async () => {
    await client.query('update ingest_tokens set revoked_at = now()');
    const stdin = JSON.stringify({ session_id: 'sess-2', hook_event_name: 'Stop' });
    await main(['hook', '--project', 'web-app'], io({ readStdin: async () => stdin }).value);
    const f = io();
    expect(await main(['flush', '--project', 'web-app'], f.value)).toBe(1);
    expect(f.out.join('')).toMatch(/"status":"unauthorized"/);
    const s = io();
    await main(['status', '--project', 'web-app'], s.value);
    expect(s.out.join('\n')).toMatch(/Spooled events: 1/);
  });

  it('uninstall removes the hooks and can forget the token', async () => {
    const t = io();
    expect(await main(['uninstall', '--project', 'web-app', '--forget-token'], t.value)).toBe(0);
    expect(await readFile(settingsPath(projectDir), 'utf8')).not.toContain('javi-collector');
    expect(await readFile(join(home, 'credentials.json'), 'utf8')).not.toContain(token);
  });
});
