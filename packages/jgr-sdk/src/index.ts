// JD-M02 public contract. Import from '@javis-dog/jgr-sdk' only (ADR-0001).
export {
  createJgrClient,
  type FlushResult,
  type JgrClient,
  type JgrClientOptions,
  type RecordInput,
  type RecordResult,
  type RejectedEvent,
} from './client.ts';
export {
  createFileSpool,
  createMemorySpool,
  DEFAULT_SPOOL_MAX_EVENTS,
  type Spool,
} from './spool.ts';
export { createUlid } from './ulid.ts';
