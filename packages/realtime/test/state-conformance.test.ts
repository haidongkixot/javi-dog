import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventRepository, projects, type NewEvent } from '@javis-dog/event-store';
import { createProjectRepository } from '@javis-dog/projects';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDashboardReader, type DashboardSnapshot } from '../src/index.ts';
import { freshDb } from './helpers.ts';

// Runner for the QA lane's black-box vectors in docs/jgr/conformance/state (S4a Q1), written
// from that README's runner rules: fresh database per vector, direct seeding with explicit
// `received_at`, pinned `now`, partial comparison, invariants I1–I5.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/state/', import.meta.url));
const STATUSES = new Set(['working', 'waiting', 'idle', 'blocked', 'failed', 'completed', null]);

type Offset = number | null;
interface Vector {
  description: string;
  now: string;
  workspaces: Record<
    string,
    { name: string; projects: Array<{ slug: string; name: string; lastSignalOffsetMs?: Offset }> }
  >;
  events: Array<{
    workspace: string;
    project: string;
    thread_ref: string;
    agent_ref?: string;
    type: string;
    status?: string;
    sequence: number;
    receivedOffsetMs: number;
    occurredOffsetMs?: number;
    usage_delta?: Record<string, unknown>;
    attributes?: Record<string, unknown>;
  }>;
  snapshotOf: string;
  expect: {
    overview?: Record<string, { value: number; reports?: number; lastSignalOffsetMs?: Offset }>;
    threadCount?: number;
    threads?: Array<Record<string, unknown> & { projectSlug: string; threadRef: string }>;
    threadOrder?: Array<{ projectSlug: string; threadRef: string }>;
    activity?: { length?: number; items?: Array<Record<string, unknown> & { index: number }> };
    projectCount?: number;
    projects?: Array<Record<string, unknown> & { slug: string }>;
    absentStrings: string[];
  };
}

const vectors = readdirSync(DIR)
  .filter((f) => /^\d{2}-.*\.json$/.test(f))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Vector] as const);

const at = (now: number, offset: number) => new Date(now + offset);
const instant = (iso: string | null) => (iso === null ? null : Date.parse(iso));

/** `fooOffsetMs` → compares `fooAt` as an instant; other fields compare exactly. */
const compareFields = (
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  now: number,
  where: string,
  skip: string[] = [],
) => {
  for (const [key, value] of Object.entries(expected)) {
    if (skip.includes(key)) continue;
    if (key.endsWith('OffsetMs')) {
      // `atOffsetMs` → `at` (activity); `lastSignalOffsetMs` → `lastSignalAt`, etc.
      const base = key.slice(0, -'OffsetMs'.length);
      const field = base === 'at' ? 'at' : `${base}At`;
      const want = value === null ? null : now + (value as number);
      expect(instant(actual[field] as string | null), `${where} ${field}`).toBe(want);
    } else {
      expect(actual[key], `${where} ${key}`).toEqual(value);
    }
  }
};

describe('Thread-state conformance vectors (docs/jgr/conformance/state)', () => {
  it('has the vectors the README lists', () => {
    expect(vectors.length).toBe(27);
  });

  it.each(vectors)('%s', async (file, v) => {
    const now = Date.parse(v.now);
    const { db } = await freshDb();
    const repo = createProjectRepository(db);
    const eventsRepo = createEventRepository(db);

    // Seeding (BLOCKED, not FAIL, if this throws: the error names the seeding step).
    const ids = new Map<string, { workspaceId: string; projectId: string }>();
    const workspaceIds = new Map<string, string>();
    for (const [key, ws] of Object.entries(v.workspaces)) {
      const workspaceId = (await repo.createWorkspace({ name: ws.name })).id;
      workspaceIds.set(key, workspaceId);
      for (const p of ws.projects) {
        const project = await repo.createProject(workspaceId, {
          name: p.name,
          slug: p.slug,
          platforms: ['claude-code'],
        });
        ids.set(`${key}:${p.slug}`, { workspaceId, projectId: project.id });
      }
    }
    const rows: NewEvent[] = v.events.map((e) => {
      const scope = ids.get(`${e.workspace}:${e.project}`);
      if (!scope) throw new Error(`BLOCKED ${file}: unknown project ${e.workspace}:${e.project}`);
      return {
        ...scope,
        producerId: 'prod_state_qa',
        eventId: randomUUID(),
        threadRef: e.thread_ref,
        agentRef: e.agent_ref ?? null,
        sequence: e.sequence,
        type: e.type,
        status: e.status ?? null,
        privacyClass: 'L0',
        receivedAt: at(now, e.receivedOffsetMs),
        occurredAt: at(now, e.occurredOffsetMs ?? e.receivedOffsetMs),
        usageDelta: e.usage_delta ?? null,
        attributes: e.attributes ?? null,
        encrypted: null,
      };
    });
    if (rows.length) expect(await eventsRepo.insertEvents(rows)).toBe(rows.length);
    for (const [key, ws] of Object.entries(v.workspaces)) {
      for (const p of ws.projects) {
        const scope = ids.get(`${key}:${p.slug}`)!;
        const newest = v.events
          .filter((e) => e.workspace === key && e.project === p.slug)
          .reduce<number | null>((m, e) => Math.max(m ?? -Infinity, e.receivedOffsetMs), null);
        const offset = p.lastSignalOffsetMs !== undefined ? p.lastSignalOffsetMs : newest;
        await db
          .update(projects)
          .set({ lastSignalAt: offset === null ? null : at(now, offset) })
          .where(eq(projects.id, scope.projectId));
      }
    }

    const snap: DashboardSnapshot = await createDashboardReader(db).snapshot(
      workspaceIds.get(v.snapshotOf)!,
      { now: new Date(now) },
    );
    const x = v.expect;

    // I1
    expect(instant(snap.generatedAt)).toBe(now);
    expect(snap.freshnessWindowMs).toBe(180_000);
    expect(snap.windowHours).toBe(24);
    // I2
    const own = [...ids].filter(([k]) => k.startsWith(`${v.snapshotOf}:`));
    const ownIds = new Set(own.map(([, s]) => s.projectId));
    const ownSlugs = new Set(own.map(([k]) => k.split(':')[1]));
    for (const p of snap.projects) {
      expect(ownIds.has(p.id), `${file} I2 project id`).toBe(true);
      expect(ownSlugs.has(p.slug), `${file} I2 slug`).toBe(true);
    }
    for (const t of snap.threads) {
      expect(ownIds.has(t.projectId), `${file} I2 thread project`).toBe(true);
      expect(ownSlugs.has(t.projectSlug), `${file} I2 thread slug`).toBe(true);
    }
    // I3
    expect(snap.activity.length).toBeLessThanOrEqual(25);
    const times = snap.activity.map((a) => Date.parse(a.at));
    expect(times, `${file} I3 order`).toEqual([...times].sort((a, b) => b - a));
    // I4
    for (const t of snap.threads) {
      expect(['fresh', 'stale', 'ended']).toContain(t.freshness);
      expect(STATUSES.has(t.status), `${file} I4 status ${String(t.status)}`).toBe(true);
    }

    for (const [name, want] of Object.entries(x.overview ?? {})) {
      const got = snap.overview[name as keyof DashboardSnapshot['overview']] as unknown as Record<
        string,
        unknown
      >;
      compareFields(got, want, now, `${file} overview.${name}`);
    }
    if (x.threadCount !== undefined) expect(snap.threads.length, file).toBe(x.threadCount);
    for (const want of x.threads ?? []) {
      const matches = snap.threads.filter(
        (t) => t.projectSlug === want.projectSlug && t.threadRef === want.threadRef,
      );
      expect(matches.length, `${file} thread ${want.projectSlug}/${want.threadRef}`).toBe(1);
      compareFields(matches[0] as unknown as Record<string, unknown>, want, now, file);
    }
    if (x.threadOrder) {
      expect(
        snap.threads.map((t) => ({ projectSlug: t.projectSlug, threadRef: t.threadRef })),
        `${file} threadOrder`,
      ).toEqual(x.threadOrder);
    }
    if (x.activity?.length !== undefined) {
      expect(snap.activity.length, `${file} activity`).toBe(x.activity.length);
    }
    for (const item of x.activity?.items ?? []) {
      const got = snap.activity[item.index] as unknown as Record<string, unknown>;
      expect(got, `${file} activity[${item.index}]`).toBeDefined();
      compareFields(got, item, now, `${file} activity[${item.index}]`, ['index']);
    }
    if (x.projectCount !== undefined) expect(snap.projects.length, file).toBe(x.projectCount);
    for (const want of x.projects ?? []) {
      const matches = snap.projects.filter((p) => p.slug === want.slug);
      expect(matches.length, `${file} project ${want.slug}`).toBe(1);
      compareFields(matches[0] as unknown as Record<string, unknown>, want, now, file);
    }
    // I5
    const text = JSON.stringify(snap);
    for (const raw of x.absentStrings) {
      const s = raw.replace(
        /\$PROJECT_ID:([A-Z]):([a-z0-9-]+)/g,
        (_m, key: string, slug: string) => ids.get(`${key}:${slug}`)?.projectId ?? raw,
      );
      expect(text.includes(s), `${file} I5 contains ${s}`).toBe(false);
    }
  });
});
