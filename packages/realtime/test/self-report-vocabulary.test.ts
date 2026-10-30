import { SELF_REPORT } from '@javis-dog/collector-adapters';
import { describe, expect, it } from 'vitest';
import { STATUS_REASONS } from '../src/index.ts';

// The reader parses reasons the collector wrote (ADR-0017 §2, §6); the two lists must not drift.
describe('self-report vocabulary shared with JD-C02', () => {
  it('STATUS_REASONS equals SELF_REPORT.reasons, in order', () => {
    expect([...STATUS_REASONS]).toEqual([...SELF_REPORT.reasons]);
  });

  it('the reader accepts reasons on exactly the statuses the validator allows', () => {
    expect([...SELF_REPORT.reasonStatuses].sort()).toEqual(['blocked', 'failed', 'waiting']);
  });
});
