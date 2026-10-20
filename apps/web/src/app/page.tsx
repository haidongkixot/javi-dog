import Image from 'next/image';

// S0 foundation page. Per product rule 4 ("No mock masquerading as product"), it shows no
// sample metrics and states plainly that nothing is connected yet. The five-space shell lands in S1.

const promise = [
  {
    step: '01',
    title: 'Observe',
    body: 'See every project, thread and agent in one place.',
    signals: 'Status · Heartbeat · Event timeline',
    badge: 'bg-accent-soft',
  },
  {
    step: '02',
    title: 'Understand',
    body: 'Make resource consumption and failure patterns explainable.',
    signals: 'Token deltas · Retries · Budget guardrails',
    badge: 'bg-ok-bg',
  },
  {
    step: '03',
    title: 'Keep the flow',
    body: 'Spot attention needs early and coordinate next steps.',
    signals: 'Stale-run alerts · Safe interventions',
    badge: 'bg-coral-soft',
  },
] as const;

const readiness = [
  { label: 'Brand system & design tokens', state: 'Ready', tone: 'text-ok bg-ok-bg' },
  { label: 'Sign-in (GitHub, Google)', state: 'Not connected', tone: 'text-info bg-info-bg' },
  { label: 'Database', state: 'Not connected', tone: 'text-info bg-info-bg' },
  {
    label: 'JGR signal ingest',
    state: 'Protocol draft next',
    tone: 'text-protocol bg-protocol-bg',
  },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-10 sm:px-8">
      <header className="flex items-center gap-3">
        <Image src="/brand/javis-dog-tile.svg" alt="" width={40} height={40} priority />
        <div>
          <p className="text-lg font-extrabold tracking-tight">Javi&apos;s Dog</p>
          <p className="text-[11px] font-bold tracking-[0.14em] text-muted">AGENT OBSERVABILITY</p>
        </div>
      </header>

      <div
        role="status"
        className="flex items-center gap-2 rounded-control border border-line bg-accent-soft px-3 py-2 text-xs text-ink"
      >
        <span aria-hidden className="size-1.5 rounded-full bg-violet" />
        <strong>Foundation build.</strong>
        <span>No projects, agents, providers or backend are connected yet.</span>
      </div>

      <section>
        <p className="mb-2 text-[11px] font-extrabold tracking-[0.14em] text-accent uppercase">
          Sprint 0 · Discovery &amp; readiness
        </p>
        <h1 className="text-[29px] leading-tight font-extrabold tracking-[-0.04em]">
          Every agent. One clear signal.
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          A loyal companion for the agentic coding world — built to turn scattered coding signals
          into clear operational insight. Your pack dashboard arrives once real signals can flow.
        </p>
      </section>

      <section aria-label="Product promise" className="grid gap-4 sm:grid-cols-3">
        {promise.map((p) => (
          <article
            key={p.step}
            className="rounded-card border border-line-card bg-surface p-5 shadow-card"
          >
            <span
              aria-hidden
              className={`mb-4 grid size-9 place-items-center rounded-full text-xs font-extrabold text-ink ${p.badge}`}
            >
              {p.step}
            </span>
            <h2 className="text-sm font-extrabold tracking-wide uppercase">{p.title}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">{p.body}</p>
            <p className="mt-4 border-t border-line pt-3 text-xs font-semibold text-muted">
              {p.signals}
            </p>
          </article>
        ))}
      </section>

      <section
        aria-labelledby="readiness-title"
        className="rounded-card border border-line-card bg-surface shadow-card"
      >
        <h2 id="readiness-title" className="px-5 pt-5 text-sm font-extrabold">
          Pack readiness
        </h2>
        <p className="px-5 pt-1 text-xs text-muted">What is verified today — nothing more.</p>
        <ul className="mt-3">
          {readiness.map((r) => (
            <li
              key={r.label}
              className="flex items-center justify-between gap-4 border-t border-line px-5 py-3 text-[13px]"
            >
              <span className="font-semibold">{r.label}</span>
              <span
                className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-1 text-xs font-extrabold ${r.tone}`}
              >
                <span aria-hidden className="size-1.5 rounded-full bg-current" />
                {r.state}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
