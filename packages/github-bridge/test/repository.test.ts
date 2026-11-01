import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { createGithubRepository, type GithubDb } from '../src/index.ts';

// Statement-level checks for JD-M10 writes whose guard only matters under concurrency. PGlite runs
// one statement at a time, so two racing links cannot be reproduced there (the sequential case is
// covered in packages/event-store/test/github.test.ts); these tests read the SQL instead.

const WS = '00000000-0000-4000-8000-00000000000a';
const PROJECT = '00000000-0000-4000-8000-00000000000b';
const USER = '00000000-0000-4000-8000-0000000000aa';

/** A database stand-in that renders every statement and answers with `rows`. */
const recordingDb = (rows: unknown[]) => {
  const dialect = new PgDialect();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    execute: async (query: SQL) => {
      statements.push(dialect.sqlToQuery(query));
      return { rows };
    },
  } as unknown as GithubDb;
  return { db, statements };
};

const squash = (text: string) => text.replace(/\s+/g, ' ');

describe('linkRepository (L-5: concurrent links)', () => {
  it('re-checks the row’s own project_id in the UPDATE, not only the CTE snapshot', async () => {
    const { db, statements } = recordingDb([{ found: 1, linked: 0 }]);
    const result = await createGithubRepository(db).linkRepository({
      workspaceId: WS,
      repoId: 1,
      projectId: PROJECT,
      userId: USER,
    });
    expect(result).toBe('linked_elsewhere');
    expect(statements).toHaveLength(1);
    const { sql, params } = statements[0]!;
    // Under READ COMMITTED a blocked UPDATE re-evaluates its WHERE on the committed row: only a
    // predicate on `r` (not on the CTE's copy) stops a second link from overwriting the first.
    const update = squash(sql).split('update github_repositories r')[1]!.split('returning')[0]!;
    const guard = /and \(r\.project_id is null or r\.project_id = \$(\d+)::uuid\)/.exec(update);
    expect(guard, update).not.toBeNull();
    expect(params[Number(guard![1]) - 1]).toBe(PROJECT);
  });
});
