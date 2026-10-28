import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createEventRepository, projects, schema, type NewEvent } from '@javis-dog/event-store';
import { getMigrationsFolder } from '@javis-dog/event-store/migrations';
import { createProjectRepository } from '@javis-dog/projects';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

/** A fresh in-process Postgres with the committed migrations applied (TEST_PLAN S4a). */
export const freshDb = async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { client, db };
};

export type TestDb = Awaited<ReturnType<typeof freshDb>>['db'];

export type Scope = { workspaceId: string; projectId: string };

/** Seeding helpers bound to one database. */
export const seeder = (db: TestDb) => {
  const projectsRepo = createProjectRepository(db);
  const eventsRepo = createEventRepository(db);
  let sequence = 0;

  return {
    async workspace(name: string) {
      return (await projectsRepo.createWorkspace({ name })).id;
    },

    async project(workspaceId: string, name: string, slug?: string): Promise<Scope> {
      const p = await projectsRepo.createProject(workspaceId, {
        name,
        ...(slug ? { slug } : {}),
        platforms: ['claude-code'],
      });
      return { workspaceId, projectId: p.id };
    },

    /** Sets `projects.last_signal_at` directly (the ingest path's touchSignal caps by `now()`). */
    async signal(scope: Scope, at: Date | null) {
      await db.update(projects).set({ lastSignalAt: at }).where(eq(projects.id, scope.projectId));
    },

    /** Inserts one event; `receivedAt` is explicit unless `dbClock` asks for the column default. */
    async event(
      scope: Scope,
      e: Partial<NewEvent> & { type: string; receivedAt?: Date },
      opts: { dbClock?: boolean } = {},
    ) {
      sequence += 1;
      const row: NewEvent = {
        ...scope,
        producerId: 'prod_test',
        eventId: randomUUID(),
        threadRef: 'cc_thread_1',
        sequence,
        status: null,
        privacyClass: 'L0',
        occurredAt: e.receivedAt ?? new Date(),
        ...e,
      };
      if (opts.dbClock) delete row.receivedAt;
      const stored = await eventsRepo.insertEvents([row]);
      if (stored !== 1) throw new Error('seed event was not stored');
    },
  };
};

/** `base` minus `ms` milliseconds. */
export const ago = (base: Date, ms: number) => new Date(base.getTime() - ms);
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
