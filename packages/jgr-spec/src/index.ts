// JD-M01 public contract. Import from '@javis-dog/jgr-spec' only (ADR-0001).
export {
  coreEventTypes,
  EncryptedPayload,
  EventType,
  JGR_LIMITS,
  JGR_VERSION,
  JgrBatch,
  JgrEvent,
  PrivacyClass,
  Status,
  UsageDelta,
  type JgrEventInput,
} from './schema.ts';
export {
  L0_ATTRIBUTES,
  L1_HASHED_ATTRIBUTES,
  validateBatch,
  validateEvent,
  type BatchResult,
  type EventResult,
  type Issue,
  type IssueCode,
} from './validate.ts';
