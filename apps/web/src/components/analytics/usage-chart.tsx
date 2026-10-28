import type { UsageDay } from '@javis-dog/analytics';
import {
  compactTokens,
  dayOfMonth,
  formatTokens,
  fullDay,
  monthOf,
  niceTicks,
  rangeLabel,
} from './format';

// Grouped columns, one pair per UTC day (dataviz skill): both series share one unit (tokens) and
// one axis, and each column grows from the same baseline, so input and output stay comparable
// day to day — in a stack, output would float on input and could not be compared.
// Colors are brand tokens: input = Signal Violet, output = the deep step of the mint hue
// (`positive`, #198F62), because the pastel mint fails the chart lightness/chroma checks on white
// (validated with the dataviz palette script; tritan ΔE 6.5 → the legend, position and the table
// carry identity too).
//
// Geometry: x in percent of the plot width (the chart is fluid from phone to desktop without
// scaling its text), y in px. Columns get a 4px rounded data end and a square baseline end.

const TOP = 18; // room for the peak label above a full-height column
const PLOT = 160;
const AXIS = 36; // two label rows: day of month, then the month where it starts
const HEIGHT = TOP + PLOT + AXIS;
const BASE = TOP + PLOT;

// Within a day slot: input at 18–48 %, a 4 % surface gap (~2px on desktop), output at 52–82 %.
const SERIES = [
  { key: 'input', label: 'Input tokens', offset: 0.18, fill: 'fill-violet', swatch: 'bg-violet' },
  {
    key: 'output',
    label: 'Output tokens',
    offset: 0.52,
    fill: 'fill-positive',
    swatch: 'bg-positive',
  },
] as const;
const BAR = 0.3;

const pct = (n: number) => `${n.toFixed(3)}%`;
const value = (d: UsageDay, key: 'input' | 'output') =>
  key === 'input' ? d.inputTokens : d.outputTokens;

function Column({
  x,
  width,
  height,
  fill,
  series,
}: {
  x: string;
  width: string;
  height: number;
  fill: string;
  series: string;
}) {
  return (
    <g
      data-series={series}
      data-height={height}
      className={`${fill} transition-opacity group-hover:opacity-75 motion-reduce:transition-none`}
    >
      {height <= 4 ? (
        <rect x={x} width={width} y={BASE - height} height={height} />
      ) : (
        <>
          <rect x={x} width={width} y={BASE - height} height={height} rx={4} />
          {/* Squares the baseline end: rounded data end only (dataviz mark spec). */}
          <rect x={x} width={width} y={BASE - 4} height={4} />
        </>
      )}
    </g>
  );
}

const dayTitle = (d: UsageDay) =>
  d.reports === 0
    ? `${fullDay(d.date)} (UTC): no usage reports`
    : `${fullDay(d.date)} (UTC): ${formatTokens(d.inputTokens)} input tokens, ` +
      `${formatTokens(d.outputTokens)} output tokens`;

/** Screen-reader summary of the whole chart; the table carries every value. */
export const chartSummary = (days: UsageDay[]) => {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return 'No days to chart.';
  const input = days.reduce((s, d) => s + d.inputTokens, 0);
  const output = days.reduce((s, d) => s + d.outputTokens, 0);
  const peak = days.reduce((a, d) =>
    d.inputTokens + d.outputTokens > a.inputTokens + a.outputTokens ? d : a,
  );
  return (
    `Column chart of input and output tokens per UTC day, ${days.length} days from ` +
    `${fullDay(first.date)} to ${fullDay(last.date)}. In total ${formatTokens(input)} input ` +
    `and ${formatTokens(output)} output tokens. Busiest day ${fullDay(peak.date)} with ` +
    `${formatTokens(peak.inputTokens)} input and ${formatTokens(peak.outputTokens)} output ` +
    'tokens. The data table lists every day.'
  );
};

function DataTable({ days, id }: { days: UsageDay[]; id: string }) {
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-bold text-ink underline">
        Show daily values as a table
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table
          id={id}
          className="w-full border-collapse text-left text-xs whitespace-nowrap tabular-nums"
        >
          <caption className="pb-2 text-left text-xs text-muted">
            Input and output tokens per UTC day
            {first && last ? `, ${rangeLabel(first.date, last.date)}` : ''}
          </caption>
          <thead>
            <tr>
              {['Date (UTC)', 'Input tokens', 'Output tokens', 'Usage reports'].map((c, i) => (
                <th
                  key={c}
                  scope="col"
                  className={`border-y border-line bg-surface-subtle px-3 py-2 text-[11px] font-bold tracking-wide text-muted uppercase ${i > 0 ? 'text-right' : ''}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-b border-line">
                <th scope="row" className="px-3 py-2 font-normal text-ink">
                  <time dateTime={d.date}>{fullDay(d.date)}</time>
                </th>
                {/* A day without reports is not a measured zero. */}
                <td className="px-3 py-2 text-right text-ink">
                  {d.reports === 0 ? '—' : formatTokens(d.inputTokens)}
                </td>
                <td className="px-3 py-2 text-right text-ink">
                  {d.reports === 0 ? '—' : formatTokens(d.outputTokens)}
                </td>
                <td className="px-3 py-2 text-right text-muted">{formatTokens(d.reports)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/**
 * Input vs output tokens per UTC day as grouped columns, with a legend, a UTC date axis, an
 * `aria-label` summary and a table equivalent. Render it only when the period has usage
 * reports: callers show the empty state instead of a chart of zeros (ADR-0013).
 */
export function UsageChart({ days, id = 'usage' }: { days: UsageDay[]; id?: string }) {
  const max = Math.max(0, ...days.map((d) => Math.max(d.inputTokens, d.outputTokens)));
  const { top, ticks } = max > 0 ? niceTicks(max) : { top: 1, ticks: [] };
  const y = (v: number) => BASE - (v / top) * PLOT;
  // Nonzero values stay visible (≥ 1px); zero stays zero.
  const h = (v: number) => (v <= 0 ? 0 : Math.max(1, (v / top) * PLOT));
  const slot = 100 / Math.max(days.length, 1);
  const peakIndex = days.reduce(
    (best, d, i) => (max > 0 && Math.max(d.inputTokens, d.outputTokens) === max ? i : best),
    -1,
  );
  const peak = days[peakIndex];
  const peakSeries = peak && peak.outputTokens > peak.inputTokens ? SERIES[1] : SERIES[0];

  return (
    <div className="px-5 pt-3 pb-4">
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`size-2.5 rounded-[3px] ${s.swatch}`} />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="flex">
        {/* Y ticks in HTML so they never scale with the plot; the SVG label and table carry them. */}
        <div
          aria-hidden
          className="relative w-10 flex-none text-right text-xs text-muted tabular-nums"
          style={{ height: HEIGHT }}
        >
          {[0, ...ticks].map((t) => (
            <span key={t} className="absolute right-2 leading-none" style={{ top: y(t) - 6 }}>
              {compactTokens(t)}
            </span>
          ))}
        </div>
        <svg
          role="img"
          aria-label={chartSummary(days)}
          width="100%"
          height={HEIGHT}
          className="block min-w-0 flex-1 overflow-visible"
        >
          {ticks.map((t) => (
            <line
              key={t}
              x1="0"
              x2="100%"
              y1={y(t)}
              y2={y(t)}
              className="stroke-line"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ))}
          <line
            x1="0"
            x2="100%"
            y1={BASE}
            y2={BASE}
            className="stroke-decorative"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {days.map((d, i) => (
            <g key={d.date} data-day={d.date} className="group">
              <title>{dayTitle(d)}</title>
              {SERIES.map((s) => (
                <Column
                  key={s.key}
                  series={s.key}
                  x={pct((i + s.offset) * slot)}
                  width={pct(BAR * slot)}
                  height={h(value(d, s.key))}
                  fill={s.fill}
                />
              ))}
              {/* Hit target: the whole day slot, not only the painted columns. */}
              <rect
                x={pct(i * slot)}
                width={pct(slot)}
                y={TOP}
                height={PLOT}
                className="fill-transparent"
              />
              <text
                x={pct((i + 0.5) * slot)}
                y={BASE + 15}
                textAnchor="middle"
                className="fill-muted text-xs tabular-nums"
              >
                {dayOfMonth(d.date)}
              </text>
              {i === 0 || dayOfMonth(d.date) === '1' ? (
                <text
                  x={pct(i * slot + slot * 0.1)}
                  y={BASE + 30}
                  className="fill-muted text-xs"
                  data-month
                >
                  {monthOf(d.date)}
                </text>
              ) : null}
            </g>
          ))}
          {peak ? (
            // One selective direct label: the highest column of the period.
            <text
              x={pct((peakIndex + peakSeries.offset + BAR / 2) * slot)}
              y={y(max) - 5}
              textAnchor="middle"
              className="fill-ink text-xs font-bold tabular-nums"
            >
              {compactTokens(max)}
            </text>
          ) : null}
        </svg>
      </div>
      <p className="mt-1 pl-10 text-xs text-muted" data-axis-title>
        Date (UTC)
      </p>
      <DataTable days={days} id={`${id}-table`} />
    </div>
  );
}
