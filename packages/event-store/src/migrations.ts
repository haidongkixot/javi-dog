// Second public entry point, `@javis-dog/event-store/migrations`: for scripts and other
// modules' PGlite tests only. App code must not import it — bundlers try to resolve the
// URL below as an asset.
import { fileURLToPath } from 'node:url';

/** Absolute path of the committed migrations. */
export const getMigrationsFolder = () => fileURLToPath(new URL('../migrations', import.meta.url));
