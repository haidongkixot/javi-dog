import { defineConfig } from 'drizzle-kit';

// `generate` only needs the schema; migrations are applied by scripts/migrate.ts over HTTP.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
});
