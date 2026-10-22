// JD-M05 public contract. Import from '@javis-dog/ingest' only (ADR-0001).
export { readBoundedBody, type BodyResult } from './body.ts';
export {
  createIngestDeps,
  createIngestHandler,
  INGEST_RATE_LIMIT_PER_MINUTE,
  type IngestDeps,
  type TokenScope,
} from './handler.ts';
