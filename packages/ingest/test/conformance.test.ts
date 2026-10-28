import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { schema } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createProjectRepository } from '@javis-dog/projects';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIngestDeps, createIngestHandler } from '../src/index.ts';

// HTTP conformance runner (S3d P2). The vectors in docs/jgr/conformance/http were written by
// the QA lane from ADR-0008 alone; this file follows the runner rules in their README against
// the real handler and real JD-M06 tables on PGlite. Each vector gets its own workspace.

type Matcher =
  | string
  | {
      equals?: unknown;
      pattern?: string;
      integerMin?: number;
      integerMax?: number;
      present?: boolean;
      absent?: boolean;
    };

interface ProjectSetup {
  slug: string;
  privacy_class: 'L0' | 'L1' | 'L2';
  preload?: unknown[];
}

interface Vector {
  description: string;
  setup: {
    token: 'valid' | 'revoked' | 'unknown' | 'malformed' | 'missing';
    project: ProjectSetup;
    preload: unknown[];
    otherProjects: ProjectSetup[];
    requestsAlreadyInWindow: number;
  };
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    gzip: boolean;
    body: unknown;
    rawBody: string | null;
    bodyPadBytes: number | null;
  };
  expect: {
    status: number;
    headers: Record<string, Matcher>;
    errorCode: string | null;
    accepted: number | null;
    duplicates: number | null;
    rejected: Array<{ index: number; event_id: Matcher | null; codes: string[] }> | null;
    lastSignal: 'advanced' | 'unchanged' | null;
    equivalenceGroup: string | null;
  };
}

const dir = new URL('../../../docs/jgr/conformance/http/', import.meta.url);
const vectors = readdirSync(dir)
  .filter((f) => /^\d+-.*\.json$/.test(f))
  .sort()
  .map((f) => ({ file: f, v: JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Vector }));

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };

/** Whole-string placeholders ($PROJECT_ID, $PROJECT_SLUG, $NOW, $NOW±n<unit>) per the README. */
const substitute = (value: unknown, ctx: { id: string; slug: string }): unknown => {
  if (Array.isArray(value)) return value.map((x) => substitute(x, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, substitute(x, ctx)]));
  }
  if (typeof value !== 'string') return value;
  if (value === '$PROJECT_ID') return ctx.id;
  if (value === '$PROJECT_SLUG') return ctx.slug;
  const now = /^\$NOW(?:([+-])(\d+)([smhd]))?$/.exec(value);
  if (now) {
    const shift = now[1] ? (now[1] === '+' ? 1 : -1) * Number(now[2]) * UNIT_MS[now[3]!]! : 0;
    return isoSeconds(new Date(Date.now() + shift));
  }
  return value;
};

const matches = (actual: unknown, m: Matcher): boolean => {
  if (typeof m === 'string') return actual === m;
  if (m.absent) return actual === undefined || actual === null;
  if (m.present && actual === undefined) return false;
  if ('equals' in m && JSON.stringify(actual) !== JSON.stringify(m.equals)) return false;
  if (m.pattern && !(typeof actual === 'string' && new RegExp(m.pattern).test(actual)))
    return false;
  if (m.integerMin !== undefined || m.integerMax !== undefined) {
    const n = typeof actual === 'string' && /^[0-9]+$/.test(actual) ? Number(actual) : actual;
    if (typeof n !== 'number' || !Number.isInteger(n)) return false;
    if (m.integerMin !== undefined && n < m.integerMin) return false;
    if (m.integerMax !== undefined && n > m.integerMax) return false;
  }
  return true;
};

/** Same character class, different value, canonical last character kept (README "Tokens"). */
const unknownLike = (token: string) => {
  const head = token.slice(0, -9);
  const swapped = token
    .slice(-9, -1)
    .split('')
    .map((c) => (c === 'A' ? 'B' : 'A'))
    .join('');
  return head + swapped + token.slice(-1);
};

let client: PGlite;
let handler: (request: Request) => Promise<Response>;
let projects: ReturnType<typeof createProjectRepository>;
const groups = new Map<
  string,
  Array<{ file: string; status: number; headers: string; error: unknown }>
>();

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  projects = createProjectRepository(db);
  handler = createIngestHandler(createIngestDeps(db));
});
afterAll(async () => {
  await client.close();
});

const post = (token: string, headers: Record<string, string>, body: BodyInit) =>
  handler(
    new Request('https://javisdog.test/api/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
    }),
  );

const readSignal = async (projectId: string) =>
  (
    await client.query<{ at: Date | null }>(
      'select last_signal_at as at from projects where id = $1',
      [projectId],
    )
  ).rows[0]!.at;

describe('HTTP conformance vectors (docs/jgr/conformance/http, ADR-0008)', () => {
  it('found the QA vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(40);
  });

  it.each(vectors)(
    '$file',
    async ({ file, v }) => {
      // Setup: a fresh workspace per vector, so slugs and dedupe keys never collide.
      const ws = await projects.createWorkspace({ name: `Vector ${file.slice(0, 2)}` });
      const make = async (p: ProjectSetup) => {
        const created = await projects.createProject(ws.id, {
          name: p.slug,
          slug: p.slug,
          platforms: ['claude-code'],
          privacyClass: p.privacy_class,
        });
        const { token, record } = await projects.issueToken(ws.id, created.id, 'conformance');
        return { id: created.id, slug: created.slug, token, tokenId: record.id };
      };
      const main = await make(v.setup.project);
      const others = await Promise.all(v.setup.otherProjects.map(make));

      const preload = async (p: { id: string; slug: string; token: string }, list: unknown[]) => {
        if (!list.length) return;
        const res = await post(
          p.token,
          { 'content-type': 'application/json' },
          JSON.stringify({ events: substitute(list, p) }),
        );
        const body = (await res.json()) as {
          accepted: number;
          duplicates: number;
          rejected: unknown[];
        };
        // README "Preload": anything else is BLOCKED (setup failed), reported as a test failure here.
        expect({ status: res.status, ...body }, `${file}: preload BLOCKED`).toEqual({
          status: 202,
          accepted: list.length,
          duplicates: 0,
          rejected: [],
        });
      };
      for (const [i, p] of v.setup.otherProjects.entries())
        await preload(others[i]!, p.preload ?? []);
      await preload(main, v.setup.preload);

      // Rate-limit fillers must share one database-clock minute with the probe.
      if (v.setup.requestsAlreadyInWindow > 0) {
        const second = new Date().getUTCSeconds();
        if (second > 40) await new Promise((r) => setTimeout(r, (61 - second) * 1000));
        const filler = JSON.stringify({
          events: [
            {
              jgr: '0.1',
              event_id: '01JBZ4XQ8000000000000ZZZZZ',
              producer_id: 'prod_filler',
              project_ref: main.slug,
              thread_ref: 's_ffffffffffffffffffffffffffffffff',
              sequence: 1,
              type: 'heartbeat',
              status: 'working',
              occurred_at: isoSeconds(new Date(Date.now() - 30_000)),
            },
          ],
        });
        for (let i = 0; i < v.setup.requestsAlreadyInWindow; i++) {
          const res = await post(main.token, { 'content-type': 'application/json' }, filler);
          expect(res.status, `${file}: filler ${i + 1} must be 202`).toBe(202);
        }
      }

      let token = main.token;
      if (v.setup.token === 'revoked') await projects.revokeToken(ws.id, main.tokenId);
      if (v.setup.token === 'unknown') token = unknownLike(main.token);
      if (v.setup.token === 'malformed') token = 'not-a-token';

      const headers: Record<string, string> = {};
      for (const [k, val] of Object.entries(v.request.headers)) {
        headers[k.toLowerCase()] = val.replaceAll('$TOKEN', token);
      }
      if (v.setup.token !== 'missing' && !('authorization' in headers)) {
        headers.authorization = `Bearer ${token}`;
      }
      let text = v.request.rawBody ?? JSON.stringify(substitute(v.request.body, main));
      if (v.request.bodyPadBytes && text.length < v.request.bodyPadBytes) {
        text += ' '.repeat(v.request.bodyPadBytes - Buffer.byteLength(text));
      }
      const payload: BodyInit = v.request.gzip ? gzipSync(Buffer.from(text)) : text;
      if (v.request.gzip && !('content-encoding' in headers)) headers['content-encoding'] = 'gzip';

      if (v.expect.lastSignal) await new Promise((r) => setTimeout(r, 1100));
      const s0 = await readSignal(main.id);
      const res = await handler(
        new Request(`https://javisdog.test${v.request.path}`, {
          method: v.request.method,
          headers,
          body: payload,
        }),
      );
      const s1 = await readSignal(main.id);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status, `${file}: status`).toBe(v.expect.status);
      for (const [name, m] of Object.entries(v.expect.headers)) {
        expect(matches(res.headers.get(name) ?? undefined, m), `${file}: header ${name}`).toBe(
          true,
        );
      }
      if (res.status === 202) {
        expect(typeof body.accepted).toBe('number');
        expect(typeof body.duplicates).toBe('number');
        expect(Array.isArray(body.rejected)).toBe(true);
        if (v.expect.accepted !== null)
          expect(body.accepted, `${file}: accepted`).toBe(v.expect.accepted);
        if (v.expect.duplicates !== null) {
          expect(body.duplicates, `${file}: duplicates`).toBe(v.expect.duplicates);
        }
        if (v.expect.rejected !== null) {
          const got = (
            body.rejected as Array<{
              index: number;
              event_id?: string;
              issues: Array<{ code: string }>;
            }>
          )
            .map((r) => ({
              index: r.index,
              event_id: r.event_id,
              codes: [...new Set(r.issues.map((i) => i.code))].sort(),
            }))
            .sort((a, b) => a.index - b.index);
          const want = [...v.expect.rejected].sort((a, b) => a.index - b.index);
          expect(
            got.map((r) => r.index),
            `${file}: rejected indexes`,
          ).toEqual(want.map((r) => r.index));
          want.forEach((w, n) => {
            expect(got[n]!.codes, `${file}: codes at ${w.index}`).toEqual([...w.codes].sort());
            if (w.event_id !== null) {
              expect(matches(got[n]!.event_id, w.event_id), `${file}: event_id at ${w.index}`).toBe(
                true,
              );
            }
          });
        }
      } else {
        expect(typeof body.error === 'string' && body.error.length > 0, `${file}: error`).toBe(
          true,
        );
        if (v.expect.errorCode !== null)
          expect(body.error, `${file}: error code`).toBe(v.expect.errorCode);
      }
      if (v.expect.lastSignal === 'advanced') {
        expect(s1 !== null && (s0 === null || s1 > s0), `${file}: signal advanced`).toBe(true);
      }
      if (v.expect.lastSignal === 'unchanged') {
        expect(s1?.getTime() ?? null, `${file}: signal unchanged`).toBe(s0?.getTime() ?? null);
      }
      if (v.expect.equivalenceGroup) {
        const list = groups.get(v.expect.equivalenceGroup) ?? [];
        list.push({
          file,
          status: res.status,
          headers: JSON.stringify(Object.keys(v.expect.headers).map((h) => res.headers.get(h))),
          error: body.error,
        });
        groups.set(v.expect.equivalenceGroup, list);
      }
    },
    90_000,
  );

  it('answers every member of an equivalence group identically', () => {
    expect(groups.size).toBeGreaterThan(0);
    for (const [, list] of groups) {
      const first = list[0]!;
      for (const other of list) {
        expect(
          { status: other.status, headers: other.headers, error: other.error },
          other.file,
        ).toEqual({
          status: first.status,
          headers: first.headers,
          error: first.error,
        });
      }
    }
  });
});
