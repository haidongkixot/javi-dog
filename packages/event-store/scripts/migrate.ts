// Applies committed migrations over Neon's HTTP driver (ADR-0005). Never run at build time.
// Usage: NODE_USE_ENV_PROXY=1 pnpm --filter @javis-dog/event-store db:migrate
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

console.log('Applying migrations …');
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
await migrate(drizzle(neon(url)), { migrationsFolder });
console.log('Migrations applied.');
