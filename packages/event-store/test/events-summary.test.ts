import { createProjectRepository } from '@javis-dog/projects';
import { describe, expect, it } from 'vitest';
import { eventsSummary } from '../scripts/events-summary.ts';
import { createEventRepository } from '../src/index.ts';
import { freshDb } from './helpers.ts';

describe('db:events summary script', () => {
  it('counts events per type and sessions for a slug, without exposing refs', async () => {
    const { db } = await freshDb();
    const projects = createProjectRepository(db);
    const ws = await projects.createWorkspace({ name: 'Summary team' });
    const p = await projects.createProject(ws.id, { name: 'Web App', platforms: ['claude-code'] });
    const base = {
      projectId: p.id,
      workspaceId: ws.id,
      producerId: 'prod_x',
      privacyClass: 'L0',
      occurredAt: new Date('2026-10-23T00:00:00Z'),
    };
    await createEventRepository(db).insertEvents([
      {
        ...base,
        eventId: 'e1',
        threadRef: 'cc_a',
        sequence: 0,
        type: 'session.started',
        status: 'working',
      },
      { ...base, eventId: 'e2', threadRef: 'cc_a', sequence: 1, type: 'task.started' },
      { ...base, eventId: 'e3', threadRef: 'cc_b', sequence: 0, type: 'task.started' },
    ]);
    const summary = await eventsSummary(db, 'web-app');
    expect(summary.projects).toBe(1);
    expect(summary.rows.map((r) => [r.type, r.events, r.threads])).toEqual([
      ['session.started', 1, 1],
      ['task.started', 2, 2],
    ]);
    expect(JSON.stringify(summary)).not.toContain('cc_a');
    expect((await eventsSummary(db, 'nope')).rows).toEqual([]);
  });
});
