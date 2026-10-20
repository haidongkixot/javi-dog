import type { ReactNode } from 'react';
import type { StatusTone } from '../tokens.ts';

export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

const toneClass: Record<StatusTone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  protocol: 'bg-protocol-bg text-protocol',
};

/** Status is always pill + text label, never color alone (BRAND_GUIDE §3). */
export function StatusPill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-1 text-xs font-extrabold whitespace-nowrap',
        toneClass[tone],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** Product rule 4: any surface without a real backend says so. */
export function DemoBanner({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-accent-soft px-3 py-2 text-xs text-ink"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-violet" />
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

export function PageHead({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
      <div>
        <p className="mb-2 text-[11px] font-extrabold tracking-[0.14em] text-accent uppercase">
          {eyebrow}
        </p>
        <h1 className="text-2xl leading-tight font-extrabold tracking-[-0.04em] text-balance md:text-[29px]">
          {title}
        </h1>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>
      </div>
      {actions ? (
        <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function Card({
  children,
  className,
  as: Tag = 'section',
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div';
  labelledBy?: string;
}) {
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={cx(
        'min-w-0 rounded-card border border-line-card bg-surface shadow-card',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHead({
  id,
  title,
  subtitle,
  aside,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-5">
      <div>
        <h2 id={id} className="text-sm font-extrabold tracking-tight">
          {title}
        </h2>
        {subtitle ? <p className="mt-1 text-xs leading-snug text-muted">{subtitle}</p> : null}
      </div>
      {aside}
    </div>
  );
}

/**
 * KPI card. A missing value renders "No signal yet" instead of a zero — a zero would
 * claim a measurement that never happened ("Live means verified").
 */
export function MetricCard({
  label,
  value,
  unit,
  meta,
  icon,
  iconClassName,
}: {
  label: string;
  value: string | null;
  unit?: string;
  meta?: ReactNode;
  icon?: ReactNode;
  iconClassName?: string;
}) {
  const empty = value === null;
  return (
    <Card as="article" className="relative overflow-hidden p-4">
      <div className="flex items-center justify-between text-xs font-semibold text-muted">
        <h3>{label}</h3>
        {icon ? (
          <span
            aria-hidden
            className={cx('grid size-7 place-items-center rounded-[10px]', iconClassName)}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p className="tabular mt-3.5 mb-2 text-[29px] leading-none font-extrabold tracking-[-0.05em]">
        {empty ? <span className="text-decorative">—</span> : value}
        {!empty && unit ? <span className="text-sm font-semibold text-muted"> {unit}</span> : null}
      </p>
      <p className="text-xs text-muted">{empty ? 'No signal yet' : meta}</p>
    </Card>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-5 py-6">
      <p className="text-[13px] font-extrabold">{title}</p>
      <p className="max-w-prose text-xs leading-relaxed text-muted">{children}</p>
      {action}
    </div>
  );
}

export function RuleList({
  items,
}: {
  items: ReadonlyArray<{ n: string; title: string; body: string }>;
}) {
  return (
    <ol className="px-5 pt-2 pb-4">
      {items.map((item) => (
        <li key={item.n} className="flex gap-2.5 border-b border-line py-2.5 last:border-0">
          <span
            aria-hidden
            className="grid size-6 flex-none place-items-center rounded-lg bg-accent-soft text-[11px] font-extrabold text-protocol"
          >
            {item.n}
          </span>
          <div>
            <p className="text-xs font-bold">{item.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{item.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function EndpointBlock({
  method,
  path,
  note,
}: {
  method: string;
  path: string;
  note?: string;
}) {
  return (
    <div className="mx-5 mt-3 overflow-auto rounded-xl bg-sidebar px-3.5 py-3 font-mono text-xs text-sidebar-text">
      <span className="mr-2 font-extrabold text-mint">{method}</span>
      <span className="text-sidebar-text-active">{path}</span>
      {note ? <span className="mt-1.5 block font-sans text-[11px]">{note}</span> : null}
    </div>
  );
}
