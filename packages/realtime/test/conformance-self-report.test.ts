import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createEventRepository, type NewEvent } from '@javis-dog/event-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDashboardReader } from '../src/index.ts';
import { freshDb, seeder } from './helpers.ts';

// T5 (S5d): runner for the QA lane's agent self-report vectors, group R (JD-M07 thread reader),
// in docs/jgr/conformance/self-report. Written from that README's "Runner rules" → "Reader
// steps"; every expectation comes from the vector files, never from the implementation.
//
// - Store: one PGlite with the committed migrations for the file (test/helpers.ts `freshDb`,
//   the reader's test store), emptied before every vector (`truncate workspaces,
//   ingest_rate_windows cascade`, as reader tests do), so each vector starts from an empty
//   store; one workspace, one project `web-app`, producer `prod_conformance`, thread
//   `cc_rv_<id>`. A PGlite boot per vector would cost ~2.5 s each for no extra isolation.
// - Events are built as the README says (fresh `event_id`, `occurred_at` = `received_at` =
//   `receivedAt`, `attributes` = { platform, tool_name?, error_code? }, `agent_ref` =
//   `agent_<label>`, `usage_delta` { input_tokens: 1 } for `usage.reported`) and stored through
//   the JD-M06 repository with an explicit `received_at`.
// - Read: `createDashboardReader(db).snapshot(workspaceId, { now: receivedAt + 1 s })`, the
//   thread `cc_rv_<id>`. The README's attention flag `needsAttention` is mapped to
//   `ThreadState.needsAttention` (attention and not ended).
// - Schema: JD-M07 has no JSON-schema validator among its dev dependencies, so this file runs a
//   minimal structural check of the `readerVector` definition; the full Ajv validation of the
//   R files runs in collectors/mcp-server/test/conformance.test.ts.

const DIR = fileURLToPath(new URL('../../../docs/jgr/conformance/self-report/', import.meta.url));
const PRODUCER = 'prod_conformance';
const PROJECT_SLUG = 'web-app';

const JGR_STATUSES = ['working', 'waiting', 'idle', 'blocked', 'failed', 'completed'];
const EVENT_TYPES = [
  'session.started',
  'session.ended',
  'agent.started',
  'agent.stopped',
  'heartbeat',
  'task.started',
  'task.completed',
  'task.failed',
  'attention.requested',
  'usage.reported',
  'error',
];
const STATUS_REQUIRED = new Set(['heartbeat', 'agent.started', 'agent.stopped']);
const REASONS = [
  null,
  'needs_input',
  'needs_approval',
  'missing_credentials',
  'missing_access',
  'tests_failing',
  'ci_failing',
  'rate_limited',
  'dependency_down',
  'conflicting_requirements',
  'other',
];

interface ReaderEvent {
  type: string;
  status: string | null;
  toolName: string | null;
  errorCode: string | null;
  agent: string | null;
  receivedAt: string;
  sequence: number;
}
interface ReaderExpect {
  status: string | null;
  statusSource: 'agent' | 'collector';
  statusReason: string | null;
  needsAttention: boolean;
}
interface ReaderStep {
  note: string;
  event: ReaderEvent;
  expect: ReaderExpect | null;
}
interface ReaderVector {
  id: string;
  kind: 'reader';
  description: string;
  ambiguities: string[];
  platform: string;
  steps: ReaderStep[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const keysEqual = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const nullOrString = (v: unknown, max = Infinity) =>
  v === null || (typeof v === 'string' && v.length >= 1 && v.length <= max);

/** Minimal structural check of schema.json `readerVector` / `readerStep` (no validator here). */
const structuralProblems = (v: unknown): string[] => {
  const out: string[] = [];
  if (!isObj(v)) return ['not an object'];
  const top = ['$schema', 'id', 'kind', 'description', 'contract', 'ambiguities', 'platform'];
  if (!keysEqual(v, [...top, 'steps'])) out.push(`top-level keys ${Object.keys(v).join(',')}`);
  if (v.$schema !== './schema.json') out.push('$schema');
  if (typeof v.id !== 'string' || !/^R[0-9]{2}$/.test(v.id)) out.push('id');
  if (v.kind !== 'reader') out.push('kind');
  for (const k of ['description', 'contract']) {
    if (typeof v[k] !== 'string' || (v[k] as string).length < 1) out.push(k);
  }
  const amb = v.ambiguities;
  if (
    !Array.isArray(amb) ||
    amb.some((a) => typeof a !== 'string' || !/^[GY][0-9]+$/.test(a)) ||
    new Set(amb).size !== amb.length
  ) {
    out.push('ambiguities');
  }
  if (v.platform !== 'claude-code') out.push('platform');
  if (!Array.isArray(v.steps) || v.steps.length < 1) return [...out, 'steps'];
  v.steps.forEach((s: unknown, i) => {
    const at = `steps[${i}]`;
    if (!isObj(s) || !keysEqual(s, ['note', 'event', 'expect'])) return out.push(`${at} keys`);
    if (typeof s.note !== 'string' || s.note.length < 1) out.push(`${at}.note`);
    const e = s.event;
    const eKeys = ['type', 'status', 'toolName', 'errorCode', 'agent', 'receivedAt', 'sequence'];
    if (!isObj(e) || !keysEqual(e, eKeys)) return out.push(`${at}.event keys`);
    if (!EVENT_TYPES.includes(e.type as string)) out.push(`${at}.event.type`);
    if (!(e.status === null || JGR_STATUSES.includes(e.status as string))) {
      out.push(`${at}.event.status`);
    }
    if (STATUS_REQUIRED.has(e.type as string) && e.status === null) {
      out.push(`${at}.event.status required for ${String(e.type)}`);
    }
    if (!nullOrString(e.toolName, 128)) out.push(`${at}.event.toolName`);
    if (!nullOrString(e.errorCode, 128)) out.push(`${at}.event.errorCode`);
    if (!(
      e.agent === null ||
      (typeof e.agent === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(e.agent))
    )) {
      out.push(`${at}.event.agent`);
    }
    if (
      typeof e.receivedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(e.receivedAt)
    ) {
      out.push(`${at}.event.receivedAt`);
    }
    if (!Number.isInteger(e.sequence) || (e.sequence as number) < 0)
      out.push(`${at}.event.sequence`);
    const x = s.expect;
    if (x === null) return;
    if (!isObj(x) || !keysEqual(x, ['status', 'statusSource', 'statusReason', 'needsAttention'])) {
      return out.push(`${at}.expect keys`);
    }
    if (!(x.status === null || JGR_STATUSES.includes(x.status as string)))
      out.push(`${at}.expect.status`);
    if (x.statusSource !== 'agent' && x.statusSource !== 'collector') {
      out.push(`${at}.expect.statusSource`);
    }
    if (!REASONS.includes(x.statusReason as string | null)) out.push(`${at}.expect.statusReason`);
    if (typeof x.needsAttention !== 'boolean') out.push(`${at}.expect.needsAttention`);
  });
  return out;
};

const files = readdirSync(DIR)
  .filter((f) => /^R\d{2}-[a-z0-9-]+\.json$/.test(f))
  .sort();

const buildRow = (
  scope: { workspaceId: string; projectId: string },
  vector: ReaderVector,
  e: ReaderEvent,
): NewEvent => {
  const at = new Date(e.receivedAt);
  const attributes: Record<string, string> = { platform: vector.platform };
  if (e.toolName !== null) attributes.tool_name = e.toolName;
  if (e.errorCode !== null) attributes.error_code = e.errorCode;
  return {
    ...scope,
    producerId: PRODUCER,
    eventId: randomUUID(),
    threadRef: `cc_rv_${vector.id}`,
    agentRef: e.agent === null ? null : `agent_${e.agent}`,
    sequence: e.sequence,
    type: e.type,
    status: e.status,
    privacyClass: 'L0',
    occurredAt: at,
    receivedAt: at,
    usageDelta: e.type === 'usage.reported' ? { input_tokens: 1 } : null,
    attributes,
  };
};

describe('self-report conformance vectors: R group (JD-M07 thread reader)', () => {
  let ctx: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => {
    ctx = await freshDb();
  });
  afterAll(async () => {
    await ctx.client.close();
  });
  beforeEach(async () => {
    await ctx.client.exec('truncate workspaces, ingest_rate_windows cascade');
  });

  it('the suite has 21 R vectors (README "Vectors" totals)', () => {
    expect(files).toHaveLength(21);
  });

  it('the structural check rejects a broken vector (sanity: the check is not vacuous)', () => {
    const good = JSON.parse(readFileSync(`${DIR}${files[0] ?? ''}`, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(structuralProblems(good)).toEqual([]);
    expect(structuralProblems({ ...good, extra: 1 })).not.toEqual([]);
    expect(structuralProblems({ ...good, steps: [] })).not.toEqual([]);
  });

  for (const file of files) {
    it(file.replace(/\.json$/, ''), async () => {
      const raw = JSON.parse(readFileSync(`${DIR}${file}`, 'utf8')) as unknown;
      expect(structuralProblems(raw), `${file} structure`).toEqual([]);
      const vector = raw as ReaderVector;
      expect(file.startsWith(`${vector.id}-`)).toBe(true);

      const { db } = ctx;
      const empty = await ctx.client.query<{ n: number }>('select count(*)::int as n from events');
      expect(empty.rows[0]?.n, 'store is empty before the vector').toBe(0);

      const seed = seeder(db);
      const workspaceId = await seed.workspace(`Conformance ${vector.id}`);
      const scope = await seed.project(workspaceId, 'Web App', PROJECT_SLUG);
      const events = createEventRepository(db);
      const reader = createDashboardReader(db);
      const threadRef = `cc_rv_${vector.id}`;
      const failures: string[] = [];

      for (const [i, step] of vector.steps.entries()) {
        const stored = await events.insertEvents([buildRow(scope, vector, step.event)]);
        if (stored !== 1) {
          failures.push(`step ${i} (${step.note}): event not stored (${stored})`);
          break;
        }
        if (step.expect === null) continue;
        const now = new Date(new Date(step.event.receivedAt).getTime() + 1_000);
        const snapshot = await reader.snapshot(workspaceId, { now });
        const thread = snapshot.threads.find((t) => t.threadRef === threadRef);
        if (!thread) {
          failures.push(`step ${i} (${step.note}): thread ${threadRef} missing`);
          continue;
        }
        const got = {
          status: thread.status ?? null,
          statusSource: thread.statusSource,
          statusReason: thread.statusReason ?? null,
          needsAttention: thread.needsAttention,
        };
        if (!isDeepStrictEqual(got, step.expect)) {
          failures.push(
            `step ${i} (${step.note}): expected ${JSON.stringify(step.expect)}, ` +
              `got ${JSON.stringify(got)}`,
          );
        }
      }
      const gaps = vector.ambiguities.length
        ? ` [ambiguities: ${vector.ambiguities.join(', ')}]`
        : '';
      expect(failures, `${vector.id} FAIL${gaps}:\n${failures.join('\n')}`).toEqual([]);
    });
  }
});
