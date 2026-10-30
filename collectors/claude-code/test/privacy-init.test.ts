import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { decryptL2, deriveProjectKeys } from '@javis-dog/crypto';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createIngestDeps, createIngestHandler } from '@javis-dog/ingest';
import { createProjectRepository } from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/index.ts';
import { filesUnder, leaks, makeRecoveryKey } from './privacy-fixtures.ts';

// `javi init --privacy` in-process against the real JD-M05 handler on PGlite (TEST_PLAN S5f
// collector rows; ADR-0018 §5, §6, review H1–H3, M3). The ingest ceiling is the project's
// `privacy_class`; nothing here reaches production.
let client: PGlite;
let fetchToHandler: typeof fetch;
let root: string;
const tokens: Record<string, string> = {};
let fixture: Awaited<ReturnType<typeof makeRecoveryKey>>;
const ENDPOINT = 'http://localhost/api/v1/events';

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  const projects = createProjectRepository(db);
  const ws = await projects.createWorkspace({ name: 'Privacy team' });
  for (const [name, privacyClass] of [
    ['Shop Two', 'L2'],
    ['Docs Zero', 'L0'],
    ['Api One', 'L1'],
    ['Lowered Two', 'L2'],
  ] as const) {
    const p = await projects.createProject(ws.id, {
      name,
      platforms: ['claude-code'],
      privacyClass,
    });
    tokens[p.slug] = (await projects.issueToken(ws.id, p.id, 'laptop')).token;
  }
  const handler = createIngestHandler(createIngestDeps(db));
  fetchToHandler = async (url, init) => handler(new Request(url as string, init));
  root = await mkdtemp(join(tmpdir(), 'javi-privacy-init-'));
  fixture = await makeRecoveryKey();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
const dirs = async () => {
  const home = join(root, `home-${n}`);
  const projectDir = join(root, `project-${n++}`);
  await mkdir(projectDir, { recursive: true });
  return { home, projectDir };
};

const io = (
  d: { home: string; projectDir: string },
  slug: string,
  overrides: Partial<Io> & { envExtra?: NodeJS.ProcessEnv } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const { envExtra, ...rest } = overrides;
  const value: Io = {
    env: { JAVI_HOME: d.home, JAVI_INGEST_TOKEN: tokens[slug], ...envExtra },
    cwd: d.projectDir,
    readStdin: async () => '',
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    spawnFlush: () => {},
    spawnReceiver: () => {},
    fetch: fetchToHandler,
    ...rest,
  };
  return { value, out, err, all: () => [...out, ...err].join('\n') };
};

const init = (slug: string, extra: string[] = []) => [
  'init',
  '--project',
  slug,
  '--endpoint',
  ENDPOINT,
  ...extra,
];

const rows = async (slug: string) =>
  (
    await client.query<{
      type: string;
      privacy_class: string;
      encrypted: Record<string, string> | null;
      attributes: Record<string, string> | null;
      event_id: string;
      producer_id: string;
      thread_ref: string;
    }>(
      `select e.type, e.privacy_class, e.encrypted, e.attributes, e.event_id, e.producer_id,
              e.thread_ref
         from events e join projects p on p.id = e.project_id
        where p.slug = $1 order by e.received_at, e.sequence`,
      [slug],
    )
  ).rows;

/** Asserts the sentinels appear nowhere in the output or under `dir` except credentials.json. */
const assertNoLeak = async (output: string, ...dirsToScan: string[]) => {
  expect(leaks(output, fixture.sentinels)).toEqual([]);
  for (const dir of dirsToScan) {
    for (const [path, text] of await filesUnder(dir)) {
      if (path === 'credentials.json') continue;
      expect(leaks(text, fixture.sentinels), path).toEqual([]);
    }
  }
};

describe('javi init --privacy L2 (canary first, key stored, identity end to end)', () => {
  it('accepts the L2 canary, stores the key 0600, never prints it, removes JAVI_PRIVACY_KEY', async () => {
    const d = await dirs();
    const t = io(d, 'shop-two', { envExtra: { JAVI_PRIVACY_KEY: fixture.key } });
    expect(await main(init('shop-two', ['--privacy', 'L2']), t.value), t.all()).toBe(0);
    expect(t.value.env.JAVI_PRIVACY_KEY).toBeUndefined();
    expect(process.env.JAVI_PRIVACY_KEY).toBeUndefined();
    const keys = await deriveProjectKeys(fixture.secret, 'shop-two');
    expect(t.out).toContain('Run javi init --privacy yourself, in a terminal.');
    expect(t.out.join('\n')).toMatch(/never paste the recovery key into an agent chat/i);
    expect(t.out.join('\n')).toContain(`Privacy class L2: recovery key stored in`);
    expect(t.out.join('\n')).toContain(`(key ${keys.kid})`);
    expect(t.out.at(-1)).toMatch(/accepted the L2 check event before anything was saved/);

    const creds = JSON.parse(await readFile(join(d.home, 'credentials.json'), 'utf8'));
    expect(creds['shop-two'].privacy).toEqual({ class: 'L2', key: fixture.key });
    if (process.platform !== 'win32') {
      expect((await stat(join(d.home, 'credentials.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(d.home)).mode & 0o777).toBe(0o700);
    }

    // The canary: L2 installation event, decryptable with its own context only.
    const [canary] = await rows('shop-two');
    expect(canary?.type).toBe('x.javi.collector.installed');
    expect(canary?.privacy_class).toBe('L2');
    const ctx = {
      eventId: canary!.event_id,
      slug: 'shop-two',
      producerId: canary!.producer_id,
      threadRef: canary!.thread_ref,
      type: 'x.javi.collector.installed',
    };
    const byKid = new Map([[keys.kid, keys.l2Key]]);
    expect(await decryptL2(byKid, canary!.encrypted, ctx)).toEqual({
      ok: true,
      payload: { v: 1, canary: true },
    });
    // The stored installation is the canary's producer.
    const installation = JSON.parse(await readFile(join(d.home, 'installation.json'), 'utf8'));
    expect(installation.producer_id).toBe(canary!.producer_id);

    // Hook → flush → stored identity (L2), status shows class + kid, never the key.
    const repo = join(d.projectDir, 'shop');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const h = io(d, 'shop-two', {
      readStdin: async () =>
        JSON.stringify({ session_id: 's-1', cwd: repo, hook_event_name: 'SessionStart' }),
    });
    expect(await main(['hook', '--project', 'shop-two'], h.value)).toBe(0);
    expect(h.out).toEqual([]);
    expect(h.err).toEqual([]);
    expect(await main(['flush', '--project', 'shop-two', '--quiet'], io(d, 'shop-two').value)).toBe(
      0,
    );
    const stored = await rows('shop-two');
    expect(stored.map((r) => [r.type, r.privacy_class])).toEqual([
      ['x.javi.collector.installed', 'L2'],
      ['session.started', 'L0'],
      ['x.javi.thread.identity', 'L2'],
    ]);
    const identity = stored[2]!;
    expect(
      await decryptL2(byKid, identity.encrypted, {
        eventId: identity.event_id,
        slug: 'shop-two',
        producerId: identity.producer_id,
        threadRef: identity.thread_ref,
        type: 'x.javi.thread.identity',
      }),
    ).toEqual({ ok: true, payload: { v: 1, repo: 'shop', branch: 'main' } });

    const s = io(d, 'shop-two');
    expect(await main(['status', '--project', 'shop-two'], s.value)).toBe(0);
    expect(s.out).toContain(`Privacy class: L2 (key ${keys.kid}; the key itself is never shown).`);
    expect(s.out).toContain('Rejected events: none recorded.');
    await assertNoLeak([t.all(), h.all(), s.all()].join('\n'), d.home, d.projectDir);
    // The stored event rows never carry the key either.
    expect(leaks(JSON.stringify(stored), fixture.sentinels)).toEqual([]);
  });

  it('plain init keeps the stored key; --privacy L0 removes it', async () => {
    const d = await dirs();
    const first = io(d, 'shop-two', { envExtra: { JAVI_PRIVACY_KEY: fixture.key } });
    expect(await main(init('shop-two', ['--privacy', 'L2']), first.value)).toBe(0);
    const again = io(d, 'shop-two');
    expect(await main(init('shop-two'), again.value), again.all()).toBe(0);
    expect(again.out.join('\n')).toMatch(/Privacy class L2 kept \(key [0-9A-Z]{8}\)/);
    const down = io(d, 'shop-two');
    expect(await main(init('shop-two', ['--privacy', 'L0']), down.value), down.all()).toBe(0);
    expect(down.out.join('\n')).toContain(
      'Privacy class L0: the recovery key for shop-two was removed',
    );
    const creds = JSON.parse(await readFile(join(d.home, 'credentials.json'), 'utf8'));
    expect(creds['shop-two'].privacy).toBeUndefined();
    expect(await readFile(join(d.home, 'credentials.json'), 'utf8')).not.toContain(fixture.key);
    const s = io(d, 'shop-two');
    await main(['status', '--project', 'shop-two'], s.value);
    expect(s.out).toContain('Privacy class: L0 (no recovery key stored).');
  });

  describe('key-loss warning before the stored key is removed (security review L4)', () => {
    const WARNING =
      "Warning: this deletes this machine's copy of the recovery key for shop-two. Stored L2 names stay readable only with another copy of the key (your download or the copy you kept).";

    /** An Io whose `out` records, per line, whether credentials.json still held the key then. */
    const watching = (d: { home: string; projectDir: string }) => {
      const t = io(d, 'shop-two');
      const keyPresent: boolean[] = [];
      const out = t.value.out;
      t.value.out = (line) => {
        out(line);
        let text = '';
        try {
          text = readFileSync(join(d.home, 'credentials.json'), 'utf8');
        } catch {
          // no file yet
        }
        keyPresent.push(text.includes(fixture.key));
      };
      return { ...t, keyPresent };
    };

    it('javi init --privacy L0 warns, while the key is still stored', async () => {
      const d = await dirs();
      const first = io(d, 'shop-two', { envExtra: { JAVI_PRIVACY_KEY: fixture.key } });
      expect(await main(init('shop-two', ['--privacy', 'L2']), first.value)).toBe(0);
      expect(first.all()).not.toContain('Warning: this deletes');
      const down = watching(d);
      expect(await main(init('shop-two', ['--privacy', 'L0']), down.value), down.all()).toBe(0);
      const at = down.out.indexOf(WARNING);
      expect(at, down.all()).toBeGreaterThanOrEqual(0);
      expect(down.keyPresent[at]).toBe(true);
      expect(down.keyPresent.at(-1)).toBe(false);
      await assertNoLeak(down.all());
      // Nothing stored any more: a second L0 run has nothing to warn about.
      const again = io(d, 'shop-two');
      expect(await main(init('shop-two', ['--privacy', 'L0']), again.value)).toBe(0);
      expect(again.all()).not.toContain('Warning: this deletes');
    });

    it('javi uninstall --forget-token warns, while the key is still stored', async () => {
      const d = await dirs();
      const first = io(d, 'shop-two', { envExtra: { JAVI_PRIVACY_KEY: fixture.key } });
      expect(await main(init('shop-two', ['--privacy', 'L2']), first.value)).toBe(0);
      const un = watching(d);
      const argv = ['uninstall', '--project', 'shop-two', '--dir', d.projectDir, '--forget-token'];
      expect(await main(argv, un.value), un.all()).toBe(0);
      const at = un.out.indexOf(WARNING);
      expect(at, un.all()).toBeGreaterThanOrEqual(0);
      expect(un.keyPresent[at]).toBe(true);
      expect(un.out).toContain('Token removed from this machine.');
      expect(un.keyPresent.at(-1)).toBe(false);
      await assertNoLeak(un.all());
    });

    it('no warning without a stored key (L0 project, uninstall --forget-token)', async () => {
      const d = await dirs();
      const first = io(d, 'shop-two');
      expect(await main(init('shop-two'), first.value), first.all()).toBe(0);
      const un = io(d, 'shop-two');
      const argv = ['uninstall', '--project', 'shop-two', '--dir', d.projectDir, '--forget-token'];
      expect(await main(argv, un.value), un.all()).toBe(0);
      expect(un.out).toContain('Token removed from this machine.');
      expect(un.all()).not.toContain('Warning: this deletes');
    });
  });

  it('L1 from --privacy-key-file: canary is class L1 without hashes or ciphertext', async () => {
    const d = await dirs();
    const keyFile = join(root, `key-${n}.txt`);
    await writeFile(keyFile, `${fixture.key.toLowerCase()}\n`, { mode: 0o600 });
    const t = io(d, 'api-one');
    expect(
      await main(init('api-one', ['--privacy', 'L1', '--privacy-key-file', keyFile]), t.value),
      t.all(),
    ).toBe(0);
    const [canary] = await rows('api-one');
    expect(canary?.privacy_class).toBe('L1');
    expect(canary?.encrypted).toBeNull();
    expect(Object.keys(canary?.attributes ?? {}).sort()).toEqual(['collector_version', 'platform']);
    const creds = JSON.parse(await readFile(join(d.home, 'credentials.json'), 'utf8'));
    // Stored in canonical form, whatever case the file used.
    expect(creds['api-one'].privacy).toEqual({ class: 'L1', key: fixture.key });
    await assertNoLeak(t.all(), d.home, d.projectDir);
  });

  it('reads the key from the hidden prompt when no file or variable is given', async () => {
    const d = await dirs();
    const prompts: string[] = [];
    const t = io(d, 'shop-two', {
      promptHidden: async (p) => {
        prompts.push(p);
        return { ok: true, text: fixture.key };
      },
    });
    expect(await main(init('shop-two', ['--privacy', 'L2']), t.value), t.all()).toBe(0);
    expect(prompts).toEqual(['Recovery key for shop-two (input hidden): ']);
    await assertNoLeak(t.all(), d.home, d.projectDir);
  });
});

describe('javi init --privacy refusals (nothing written)', () => {
  const nothingWritten = async (d: { home: string; projectDir: string }) => {
    expect((await filesUnder(d.home)).map(([p]) => p)).toEqual([]);
    expect((await filesUnder(d.projectDir)).map(([p]) => p)).toEqual([]);
  };

  it('a project whose class is lower: privacy_class_not_allowed, no token, key, hooks or installation', async () => {
    const d = await dirs();
    const t = io(d, 'docs-zero', { envExtra: { JAVI_PRIVACY_KEY: fixture.key } });
    expect(await main(init('docs-zero', ['--privacy', 'L2']), t.value)).toBe(1);
    expect(t.err.join('\n')).toContain('privacy_class_not_allowed');
    expect(t.err.join('\n')).toContain('Nothing was saved: no token, key or hooks.');
    await nothingWritten(d);
    expect(await rows('docs-zero')).toEqual([]);
    await assertNoLeak(t.all());
  });

  it('a dead endpoint: refused, nothing written', async () => {
    const d = await dirs();
    const t = io(d, 'shop-two', {
      envExtra: { JAVI_PRIVACY_KEY: fixture.key },
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await main(init('shop-two', ['--privacy', 'L2']), t.value)).toBe(1);
    expect(t.err.join('\n')).toMatch(/did not confirm the L2 check event \(retry_later\)/);
    await nothingWritten(d);
  });

  it('refuses --no-verify with --privacy, a UUID project, a bad key, a missing terminal', async () => {
    const cases: Array<{ argv: string[]; slug: string; env?: NodeJS.ProcessEnv; expect: RegExp }> =
      [
        {
          argv: init('shop-two', ['--privacy', 'L2', '--no-verify']),
          slug: 'shop-two',
          env: { JAVI_PRIVACY_KEY: fixture.key },
          expect: /cannot be combined with --no-verify/,
        },
        {
          argv: init('shop-two', ['--privacy', 'L0', '--no-verify']),
          slug: 'shop-two',
          expect: /cannot be combined with --no-verify/,
        },
        {
          argv: init('0b8f2c1e-4d3a-4f5b-9c6d-7e8f9a0b1c2d', ['--privacy', 'L2']),
          slug: 'shop-two',
          env: { JAVI_PRIVACY_KEY: fixture.key },
          expect: /needs the project slug/,
        },
        {
          argv: init('0B8F2C1E4D3A4F5B9C6D7E8F9A0B1C2D', ['--privacy', 'L1']),
          slug: 'shop-two',
          expect: /needs the project slug/,
        },
        {
          argv: init('shop-two', ['--privacy', 'L3']),
          slug: 'shop-two',
          expect: /Use --privacy L0, --privacy L1 or --privacy L2/,
        },
        {
          argv: init('shop-two', ['--privacy-key-file', '/nope']),
          slug: 'shop-two',
          expect: /only applies with --privacy L1 or --privacy L2/,
        },
        {
          argv: init('shop-two', ['--privacy', 'L2']),
          slug: 'shop-two',
          env: {
            JAVI_PRIVACY_KEY: `${fixture.key.slice(0, -1)}${fixture.key.endsWith('0') ? '1' : '0'}`,
          },
          expect: /not accepted: This recovery key has a typo: its checksum does not match\./,
        },
        {
          argv: init('shop-two', ['--privacy', 'L2']),
          slug: 'shop-two',
          expect: /No terminal to read the recovery key from/,
        },
        {
          argv: init('shop-two', ['--privacy', 'L2', '--privacy-key-file', '/nope']),
          slug: 'shop-two',
          env: { JAVI_PRIVACY_KEY: fixture.key },
          expect: /one way only/,
        },
      ];
    for (const c of cases) {
      const d = await dirs();
      const t = io(d, c.slug, { envExtra: c.env ?? {} });
      expect(await main(c.argv, t.value), c.argv.join(' ')).toBe(2);
      expect(t.err.join('\n'), c.argv.join(' ')).toMatch(c.expect);
      await nothingWritten(d);
      await assertNoLeak(t.all());
      // The environment variable is gone even when init refuses.
      expect(t.value.env.JAVI_PRIVACY_KEY).toBeUndefined();
    }
  });

  it('a cancelled prompt exits 1 and writes nothing', async () => {
    const d = await dirs();
    const t = io(d, 'shop-two', {
      promptHidden: async () => ({ ok: false, reason: 'cancelled' }),
    });
    expect(await main(init('shop-two', ['--privacy', 'L2']), t.value)).toBe(1);
    expect(t.err.join('\n')).toMatch(/^Cancelled\. Nothing was saved/);
    await nothingWritten(d);
  });

  it('a prompt refused inside a coding agent: exit 2, points to --privacy-key-file (review M3)', async () => {
    const d = await dirs();
    const t = io(d, 'shop-two', {
      promptHidden: async () => ({ ok: false, reason: 'agent', marker: 'CLAUDECODE' }),
    });
    expect(await main(init('shop-two', ['--privacy', 'L2']), t.value)).toBe(2);
    const err = t.err.join('\n');
    expect(err).toContain('javi runs inside a coding agent here (CLAUDECODE is set)');
    expect(err).toContain(
      'Run javi init --privacy yourself in a terminal; never paste the key into an agent.',
    );
    expect(err).toContain('--privacy-key-file <path>');
    expect(err).not.toContain('JAVI_PRIVACY_KEY');
    await nothingWritten(d);
  });

  it.runIf(process.platform !== 'win32')(
    'a FIFO, a directory or an oversized key file is refused without hanging',
    async () => {
      const fifo = join(root, 'key.fifo');
      execFileSync('mkfifo', [fifo]);
      const big = join(root, 'big.key');
      await writeFile(big, 'x'.repeat(2048));
      for (const [file, message] of [
        [fifo, /not a regular file/],
        [root, /not a regular file|EISDIR/],
        [big, /larger than 1024 bytes/],
        [join(root, 'missing.key'), /Could not open the key file \(ENOENT\)/],
      ] as const) {
        const d = await dirs();
        const t = io(d, 'shop-two');
        const run = main(
          init('shop-two', ['--privacy', 'L2', '--privacy-key-file', file]),
          t.value,
        );
        const code = await Promise.race([
          run,
          new Promise<string>((r) => setTimeout(() => r('timeout'), 3_000)),
        ]);
        expect(code, file).toBe(2);
        expect(t.err.join('\n')).toMatch(message);
        await nothingWritten(d);
      }
    },
  );
});

describe('rejections in javi status (review H1)', () => {
  it('a project lowered to L0: status events still stored, identity rejected, codes shown', async () => {
    const d = await dirs();
    const t = io(d, 'lowered-two', { envExtra: { JAVI_PRIVACY_KEY: fixture.key } });
    expect(await main(init('lowered-two', ['--privacy', 'L2']), t.value), t.all()).toBe(0);
    await client.query(`update projects set privacy_class = 'L0' where slug = 'lowered-two'`);
    const h = io(d, 'lowered-two', {
      readStdin: async () =>
        JSON.stringify({ session_id: 's-low', cwd: d.projectDir, hook_event_name: 'SessionStart' }),
    });
    expect(await main(['hook', '--project', 'lowered-two'], h.value)).toBe(0);
    const f = io(d, 'lowered-two');
    expect(await main(['flush', '--project', 'lowered-two'], f.value)).toBe(0);
    expect((await rows('lowered-two')).map((r) => r.type)).toEqual([
      'x.javi.collector.installed',
      'session.started',
    ]);
    const record = JSON.parse(
      await readFile(join(d.home, 'rejections', 'lowered-two.json'), 'utf8'),
    );
    expect(record).toEqual({
      at: expect.any(String),
      codes: ['privacy_class_not_allowed'],
      events: 1,
    });
    const s = io(d, 'lowered-two');
    expect(await main(['status', '--project', 'lowered-two'], s.value)).toBe(0);
    const text = s.out.join('\n');
    expect(text).toMatch(/Privacy class: L2 \(key [0-9A-Z]{8}; the key itself is never shown\)\./);
    expect(text).toMatch(/Last rejected events: 1 at .* \(privacy_class_not_allowed\)\./);
    expect(text).toMatch(/Status events still arrive/);
    await assertNoLeak([t.all(), h.all(), f.all(), s.all()].join('\n'), d.home, d.projectDir);
  });
});
