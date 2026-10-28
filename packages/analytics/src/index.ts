// JD-M08 public contract. Import from '@javis-dog/analytics' only (ADR-0001).
export {
  ANALYTICS_DEFAULT_DAYS,
  ANALYTICS_MAX_DAYS,
  createAnalyticsReader,
  type AnalyticsReader,
} from './reader.ts';
export type { UsageAnalytics, UsageDay, UsageTotals } from './types.ts';
