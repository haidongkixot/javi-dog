import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createEventRepository, schema } from '@javis-dog/event-store';
import { deriveProjectKeys, encryptL2, generateProjectSecret, l1Hash } from '@javis-dog/crypto';
import { createProjectRepository } from '@javis-dog/projects';
import { createDashboardReader, THREAD_IDENTITY_TYPE } from '@javis-dog/realtime';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { ZodError } from 'zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveThreadIdentity } from '@/lib/privacy/identity';

// JD-M04 `setPrivacyClass` and the JD-M07 identity fields on real SQL (PGlite with the committed
// migrations), then the browser-side decryption of what the reader returns (TEST_PLAN §S5f
// reader row, ADR-0018 §7, §8). Nothing on the server decrypts: the reader passes the stored
// `encrypted` object through unchanged. WebCrypto is Node's engine.

let db: ReturnType<typeof drizzle<typeof schema>>;
beforeAll(async () => {
  db = drizzle(new PGlite(), { schema });
  await migrate(db, {
    migrationsFolder: resolve(process.cwd(), '../../packages/event-store/migrations'),
  });
}, 60_000);

describe('JD-M04 setPrivacyClass', () => {
  it('changes the class of a project in the workspace, and only there', async () => {
    const repo = createProjectRepository(db);
    const a = await repo.createWorkspace({ name: 'Alpha team' });
    const b = await repo.createWorkspace({ name: 'Bravo team' });
    const p = await repo.createProject(a.id, { name: 'Web app', platforms: ['claude-code'] });
    expect(p.privacyClass).toBe('L0');

    expect(await repo.setPrivacyClass(a.id, p.id, 'L2')).toEqual({ id: p.id, privacyClass: 'L2' });
    expect((await repo.getProject(a.id, p.id))?.privacyClass).toBe('L2');

    // Another workspace cannot change it, and learns nothing.
    expect(await repo.setPrivacyClass(b.id, p.id, 'L0')).toBeNull();
    expect((await repo.getProject(a.id, p.id))?.privacyClass).toBe('L2');

    await expect(repo.setPrivacyClass(a.id, p.id, 'L3')).rejects.toBeInstanceOf(ZodError);
    expect(await repo.setPrivacyClass(a.id, p.id, 'L0')).toEqual({ id: p.id, privacyClass: 'L0' });
  });
});

describe('JD-M07 reader → browser decryption', () => {
  it('opens the stored ciphertext with the AAD parts the reader returns', async () => {
    const projectsRepo = createProjectRepository(db);
    const ws = await projectsRepo.createWorkspace({ name: 'Decrypt team' });
    const project = await projectsRepo.createProject(ws.id, {
      name: 'Demo app',
      slug: 'demo-app',
      platforms: ['claude-code'],
      privacyClass: 'L2',
    });
    const keys = await deriveProjectKeys(generateProjectSecret(), 'demo-app');
    const eventId = randomUUID();
    const base = {
      eventId,
      slug: 'demo-app',
      producerId: 'prod_laptop',
      threadRef: 'cc_thread_1',
      type: THREAD_IDENTITY_TYPE,
    };
    const encrypted = await encryptL2(keys.l2Key, keys.kid, base, {
      repo: 'javi-dog',
      branch: 'main',
    });
    const now = new Date();
    await createEventRepository(db).insertEvents([
      {
        projectId: project.id,
        workspaceId: ws.id,
        producerId: base.producerId,
        eventId,
        threadRef: base.threadRef,
        sequence: 1,
        type: base.type,
        status: null,
        privacyClass: 'L2',
        occurredAt: now,
        receivedAt: now,
        attributes: { repo_hash: await l1Hash(keys.l1Keys, 'repo', 'javi-dog') },
        encrypted,
      },
    ]);

    const snapshot = await createDashboardReader(db).snapshot(ws.id, { now });
    const identity = snapshot.threads[0]?.identity ?? null;
    // Review M1: the AAD comes from the thread row the identity is shown in.
    const row = {
      threadRef: snapshot.threads[0]?.threadRef ?? '',
      projectSlug: snapshot.threads[0]?.projectSlug ?? '',
    };
    expect(row).toEqual({ threadRef: 'cc_thread_1', projectSlug: 'demo-app' });
    expect(identity?.encrypted).toEqual(encrypted);
    expect(JSON.stringify(snapshot)).not.toContain('javi-dog');

    expect(await resolveThreadIdentity(identity, new Map([[keys.kid, keys.l2Key]]), row)).toEqual({
      kind: 'names',
      repo: 'javi-dog',
      branch: 'main',
      kid: keys.kid,
    });
    const other = await deriveProjectKeys(generateProjectSecret(), 'demo-app');
    expect(await resolveThreadIdentity(identity, new Map([[other.kid, other.l2Key]]), row)).toEqual(
      {
        kind: 'other-kid',
      },
    );
    expect(await resolveThreadIdentity(identity, new Map(), row)).toEqual({
      kind: 'no-key',
      kid: keys.kid,
    });
  });
});
