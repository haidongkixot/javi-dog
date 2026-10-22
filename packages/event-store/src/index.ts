// JD-M06 public contract. Import from '@javis-dog/event-store' only (ADR-0001).
export { createDb, pingDb, type AnyDb, type Db, type DbPing } from './client.ts';
export {
  createEventRepository,
  EVENT_RETENTION_DAYS,
  retentionCutoff,
  type EventRepository,
  type NewEvent,
} from './events.ts';
export { events, ingestRateWindows, ingestTokens, projects, schema, workspaces } from './schema.ts';
