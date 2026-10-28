import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventRepository, type NewEvent } from '@javis-dog/event-store';
import { createProjectRepository } from '@javis-dog/projects';
import { describe, expect, it } from 'vitest';
import { createAnalyticsReader, type UsageAnalytics } from '../src/index.ts';
import { freshDb } from './helpers.ts';

// Runner for the QA lane's black-box vectors in docs/jgr/conformance/analytics (S4b Q2), written
// from that README's runner rules: fresh database per vector, explicit `received_at`, pinned
// `now`, partial comparison, invariants I1–I9.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/analytics/', import.meta.url));
const COST_TOLERANCE = 1e-9;
const NUMERIC = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'estimatedCostUsd',
  'reports',
  'tasksCompleted',
  'tasksFailed',
] as const;
const USAGE = NUMERIC.slice(0, 6);

type Fields = Record<string, unknown>;
interface Vector {
  now: string;
  workspaces: Record<string, { name: string; projects: Array<{ slug: string; name: string }> }>;
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
    usage_delta?: Fields;
    attributes?: Fields;
  }>;
  query: {
    workspace: string;
    days?: number;
    project?: string;
    foreignProject?: { workspace: string; slug: string };
  };
  expect: {
    from?: string;
    to?: string;
    daysLength?: number;
    days?: Array<Fields & { date: string }>;
    otherDaysZero?: boolean;
    totals?: Fields;
    byModelLength?: number;
    byModelOrder?: Array<string | null>;
    byModel?: Array<Fields & { model: string | null }>;
    byProjectLength?: number;
    byProjectOrder?: string[];
    byProject?: Array<Fields & { slug: string }>;
    lastReportOffsetMs?: number | null;
    absentStrings: string[];
  };
}

const vectors = readdirSync(DIR)
  .filter((f) => /^\d{2}-.*\.json$/.test(f))
  .sort()
  .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Vector] as const);

const sum = (rows: Fields[], field: string) => rows.reduce((s, r) => s + Number(r[field]), 0);

describe('Usage analytics conformance vectors (docs/jgr/conformance/analytics)', () => {
  it('has the vectors the README lists', () => {
    expect(vectors.length).toBe(23);
  });

  it.each(vectors)('%s', async (file, v) => {
    const now = Date.parse(v.now);
    const { db } = await freshDb();
    const repo = createProjectRepository(db);
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
        producerId: 'prod_analytics_qa',
        eventId: randomUUID(),
        threadRef: e.thread_ref,
        agentRef: e.agent_ref ?? null,
        sequence: e.sequence,
        type: e.type,
        status: e.status ?? null,
        privacyClass: 'L0',
        receivedAt: new Date(now + e.receivedOffsetMs),
        occurredAt: new Date(now + (e.occurredOffsetMs ?? e.receivedOffsetMs)),
        usageDelta: e.usage_delta ?? null,
        attributes: e.attributes ?? null,
        encrypted: null,
      };
    });
    if (rows.length) expect(await createEventRepository(db).insertEvents(rows)).toBe(rows.length);

    const q = v.query;
    const projectId = q.project
      ? ids.get(`${q.workspace}:${q.project}`)!.projectId
      : q.foreignProject
        ? ids.get(`${q.foreignProject.workspace}:${q.foreignProject.slug}`)!.projectId
        : undefined;
    const r: UsageAnalytics = await createAnalyticsReader(db).usage(
      workspaceIds.get(q.workspace)!,
      {
        now: new Date(now),
        ...(q.days !== undefined && { days: q.days }),
        ...(projectId && { projectId }),
      },
    );
    const x = v.expect;
    const cmp = (actual: Fields, want: Fields, where: string, keyFields: string[]) => {
      for (const [k, w] of Object.entries(want)) {
        if (keyFields.includes(k)) continue;
        if (k === 'estimatedCostUsd') {
          expect(typeof actual[k], `${where} ${k} type`).toBe('number');
          expect(
            Math.abs((actual[k] as number) - (w as number)),
            `${where} ${k}`,
          ).toBeLessThanOrEqual(COST_TOLERANCE);
        } else if (k === 'projectId' && typeof w === 'string' && w.startsWith('$PROJECT_ID:')) {
          const [, key, slug] = w.split(':');
          expect(actual[k], `${where} ${k}`).toBe(ids.get(`${key}:${slug}`)?.projectId);
        } else {
          expect(actual[k], `${where} ${k}`).toEqual(w);
        }
      }
    };

    // I1–I2
    expect(Number.isNaN(Date.parse(r.generatedAt)), `${file} I1`).toBe(false);
    const expectedLen = Math.min(30, Math.max(1, q.days ?? 14));
    expect(r.days.length, `${file} I2 length`).toBe(expectedLen);
    expect(r.days[0]!.date).toBe(r.from);
    expect(r.days.at(-1)!.date).toBe(r.to);
    expect(r.to, `${file} I2 to`).toBe(new Date(now).toISOString().slice(0, 10));
    r.days.forEach((d, i) => {
      if (i > 0) {
        expect(
          Date.parse(`${d.date}T00:00:00Z`) - Date.parse(`${r.days[i - 1]!.date}T00:00:00Z`),
        ).toBe(86_400_000);
      }
    });
    // I3–I5, I8
    for (const f of NUMERIC) {
      const delta = Math.abs(Number(r.totals[f]) - sum(r.days as unknown as Fields[], f));
      expect(delta, `${file} I3 ${f}`).toBeLessThanOrEqual(
        f === 'estimatedCostUsd' ? COST_TOLERANCE : 0,
      );
    }
    for (const f of USAGE) {
      const tol = f === 'estimatedCostUsd' ? COST_TOLERANCE : 0;
      if (r.byModel.length || r.totals.reports) {
        expect(
          Math.abs(sum(r.byModel as unknown as Fields[], f) - Number(r.totals[f])),
          `${file} I4 model ${f}`,
        ).toBeLessThanOrEqual(tol);
      }
      if (r.byProject.length || r.totals.reports) {
        expect(
          Math.abs(sum(r.byProject as unknown as Fields[], f) - Number(r.totals[f])),
          `${file} I4 project ${f}`,
        ).toBeLessThanOrEqual(tol);
      }
    }
    for (const list of [r.byModel, r.byProject] as unknown as Fields[][]) {
      const load = list.map((e) => Number(e.inputTokens) + Number(e.outputTokens));
      expect(load, `${file} I5`).toEqual([...load].sort((a, b) => b - a));
    }
    for (const row of [...r.days, r.totals, ...r.byModel, ...r.byProject] as unknown as Fields[]) {
      for (const f of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reports',
      ]) {
        if (row[f] !== undefined)
          expect(Number.isInteger(row[f]) && (row[f] as number) >= 0, `${file} I8`).toBe(true);
      }
    }
    // I6
    const own = new Map(
      [...ids]
        .filter(([k]) => k.startsWith(`${q.workspace}:`))
        .map(([k, s]) => [s.projectId, k.split(':')[1]]),
    );
    for (const p of r.byProject) {
      expect(own.get(p.projectId), `${file} I6`).toBe(p.slug);
      const seeded = v.workspaces[q.workspace]!.projects.find((s) => s.slug === p.slug)!;
      expect(p.name).toBe(seeded.name);
    }
    // I7
    expect(r.lastReportAt === null, `${file} I7`).toBe(r.totals.reports === 0);

    if (x.from !== undefined) expect(r.from, file).toBe(x.from);
    if (x.to !== undefined) expect(r.to, file).toBe(x.to);
    if (x.daysLength !== undefined) expect(r.days.length, file).toBe(x.daysLength);
    for (const want of x.days ?? []) {
      const m = r.days.filter((d) => d.date === want.date);
      expect(m.length, `${file} day ${want.date}`).toBe(1);
      cmp(m[0] as unknown as Fields, want, `${file} day ${want.date}`, ['date']);
    }
    if (x.otherDaysZero) {
      const listed = new Set((x.days ?? []).map((d) => d.date));
      for (const d of r.days.filter((d) => !listed.has(d.date))) {
        for (const f of NUMERIC) expect(d[f], `${file} zero-fill ${d.date} ${f}`).toBe(0);
      }
    }
    if (x.totals) cmp(r.totals as unknown as Fields, x.totals, `${file} totals`, []);
    if (x.byModelLength !== undefined) expect(r.byModel.length, file).toBe(x.byModelLength);
    if (x.byModelOrder)
      expect(
        r.byModel.map((m) => m.model),
        `${file} byModelOrder`,
      ).toEqual(x.byModelOrder);
    for (const want of x.byModel ?? []) {
      const m = r.byModel.filter((e) => e.model === want.model);
      expect(m.length, `${file} model ${String(want.model)}`).toBe(1);
      cmp(m[0] as unknown as Fields, want, `${file} model ${String(want.model)}`, ['model']);
    }
    if (x.byProjectLength !== undefined) expect(r.byProject.length, file).toBe(x.byProjectLength);
    if (x.byProjectOrder)
      expect(
        r.byProject.map((p) => p.slug),
        `${file} byProjectOrder`,
      ).toEqual(x.byProjectOrder);
    for (const want of x.byProject ?? []) {
      const m = r.byProject.filter((e) => e.slug === want.slug);
      expect(m.length, `${file} project ${want.slug}`).toBe(1);
      cmp(m[0] as unknown as Fields, want, `${file} project ${want.slug}`, ['slug']);
    }
    if (x.lastReportOffsetMs !== undefined) {
      expect(
        r.lastReportAt === null ? null : Date.parse(r.lastReportAt),
        `${file} lastReportAt`,
      ).toBe(x.lastReportOffsetMs === null ? null : now + x.lastReportOffsetMs);
    }
    // I9
    const text = JSON.stringify(r);
    for (const raw of x.absentStrings) {
      const s = raw.replace(
        /\$PROJECT_ID:([A-Z]):([a-z0-9-]+)/g,
        (_m, key: string, slug: string) => ids.get(`${key}:${slug}`)?.projectId ?? raw,
      );
      expect(text.includes(s), `${file} I9 contains ${s}`).toBe(false);
    }
  });
});
