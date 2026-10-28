// Prints the committed migrations exactly as drizzle's migrator would apply them (ADR-0015):
// statements split at `--> statement-breakpoint`, the sha256 `hash` and journal `when` that go
// into `drizzle.__drizzle_migrations`. Used to apply migrations to `main` through the Neon MCP
// server without a connection string in the session. Reads files only; never connects.
// Usage: pnpm --filter @javis-dog/event-store db:statements [--after <created_at>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as {
  entries: Array<{ tag: string; when: number }>;
};
const afterIndex = process.argv.indexOf('--after');
const after = afterIndex > 0 ? Number(process.argv[afterIndex + 1]) : -Infinity;

const out = readMigrationFiles({ migrationsFolder })
  .map((m, i) => ({
    tag: journal.entries[i]!.tag,
    when: m.folderMillis,
    hash: m.hash,
    statements: m.sql.map((s) => s.trim()).filter(Boolean),
  }))
  .filter((m) => m.when > after);
console.log(JSON.stringify(out, null, 2));
