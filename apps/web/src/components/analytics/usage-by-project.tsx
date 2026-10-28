import Link from 'next/link';
import type { UsageAnalytics } from '@javis-dog/analytics';
import { formatTokens, formatUsd } from './format';

const COLUMNS = [
  'Project',
  'Input tokens',
  'Output tokens',
  // Producer-reported cost is an approximation (ADR-0011, ADR-0013): the header says so.
  'Estimated cost (USD)',
] as const;

/** Compact usage per workspace project for the period; each name links to its project page. */
export function UsageByProject({
  rows,
  caption,
}: {
  rows: UsageAnalytics['byProject'];
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
            <tr key={r.projectId} className="border-b border-line">
              <th scope="row" className="px-4 py-2.5 text-left font-normal">
                <Link
                  href={`/projects/${r.projectId}`}
                  className="font-bold text-ink underline underline-offset-2"
                >
                  {r.name}
                </Link>
              </th>
              <td className="px-4 py-2.5 text-right text-ink">{formatTokens(r.inputTokens)}</td>
              <td className="px-4 py-2.5 text-right text-ink">{formatTokens(r.outputTokens)}</td>
              <td className="px-4 py-2.5 text-right text-ink">{formatUsd(r.estimatedCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
