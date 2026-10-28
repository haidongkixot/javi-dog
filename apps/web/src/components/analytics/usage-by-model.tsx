import type { UsageAnalytics } from '@javis-dog/analytics';
import { formatTokens, formatUsd } from './format';

const COLUMNS = [
  'Model',
  'Input tokens',
  'Output tokens',
  'Cache read',
  'Cache write',
  // Producer-reported cost is an approximation (ADR-0011, ADR-0013): the header says so.
  'Estimated cost (USD)',
  'Reports',
] as const;

/** Tokens (exact) and estimated cost per model for the period, as a plain data table. */
export function UsageByModel({
  rows,
  caption,
}: {
  rows: UsageAnalytics['byModel'];
  caption: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs whitespace-nowrap">
        <caption className="px-5 pb-2 text-left text-xs text-muted">{caption}</caption>
        <thead>
          <tr>
            {COLUMNS.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={`border-y border-line bg-surface-subtle px-4 py-2.5 text-[11px] font-bold tracking-wide text-muted uppercase ${i > 0 ? 'text-right' : ''}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.model ?? '\u0000none'} className="border-b border-line">
              <th scope="row" className="px-4 py-2.5 text-left font-normal">
                {r.model === null ? (
                  <span className="text-muted">Model not reported</span>
                ) : (
                  <span className="font-mono text-ink">{r.model}</span>
                )}
              </th>
              <td className="px-4 py-2.5 text-right text-ink">{formatTokens(r.inputTokens)}</td>
              <td className="px-4 py-2.5 text-right text-ink">{formatTokens(r.outputTokens)}</td>
              <td className="px-4 py-2.5 text-right text-ink">{formatTokens(r.cacheReadTokens)}</td>
              <td className="px-4 py-2.5 text-right text-ink">
                {formatTokens(r.cacheWriteTokens)}
              </td>
              <td className="px-4 py-2.5 text-right text-ink">{formatUsd(r.estimatedCostUsd)}</td>
              <td className="px-4 py-2.5 text-right text-muted">{formatTokens(r.reports)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
