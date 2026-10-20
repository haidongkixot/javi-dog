import type { Metadata } from 'next';
import { Card, CardHead, PageHead, RuleList, StatusPill } from '@javis-dog/ui/components';

export const metadata: Metadata = { title: 'Token network' };

const principles = [
  {
    n: '01',
    title: 'Never lend raw provider keys',
    body: 'Credentials stay with their owner and their approved provider.',
  },
  {
    n: '02',
    title: 'Check terms and legal feasibility',
    body: 'Provider limits may not be transferable across accounts or products.',
  },
  {
    n: '03',
    title: 'Use explicit quotas and revocation',
    body: 'Capacity grants need caps, expiry, audit trails and a kill switch.',
  },
  {
    n: '04',
    title: 'Measure value before tokenization',
    body: 'Model a credit abstraction only after unit economics are validated.',
  },
] as const;

// Token network — CONCEPT ONLY (CLAUDE.md §3). Shows the hypothesis and its safety boundary;
// no capacity numbers, no exchange, no credentials.
export default function TokenNetworkPage() {
  return (
    <>
      <PageHead
        eyebrow="Resource exchange"
        title="Keep work moving when limits hit."
        description="A future coordination layer for eligible compute and usage credits — not a marketplace for raw API keys."
        actions={<StatusPill tone="warn">Phase 2 · not live</StatusPill>}
      />
      <Card className="flex items-start gap-4 bg-sidebar p-5 text-sidebar-text-active">
        <span
          aria-hidden
          className="grid size-12 flex-none place-items-center rounded-2xl bg-yellow text-xl font-black text-pack-night"
        >
          ↗
        </span>
        <div>
          <h2 className="text-sm font-extrabold">Pack Pool · concept exploration</h2>
          <p className="mt-1 text-xs leading-relaxed text-sidebar-text">
            How might contributors offer policy-compliant capacity or platform-independent credits
            to projects that need them? This is a research question, gated by a legal and
            provider-terms review.
          </p>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="principles-title">
          <CardHead
            id="principles-title"
            title="Safety principles"
            subtitle="What must be true before launch"
          />
          <RuleList items={principles} />
        </Card>
        <Card labelledBy="first-title">
          <CardHead
            id="first-title"
            title="What comes first"
            subtitle="Keep the flow without lending anything"
          />
          <RuleList
            items={[
              {
                n: '01',
                title: 'Exhaustion alerts',
                body: 'Warn before a thread runs out of tokens or context.',
              },
              {
                n: '02',
                title: 'Budget forecasts',
                body: 'Project burn rate against your own limits.',
              },
              {
                n: '03',
                title: 'Checkpoint guidance',
                body: 'Pause and resume long-running work safely.',
              },
              {
                n: '04',
                title: 'Failover to your own keys',
                body: 'Switch between providers you already own (BYOK).',
              },
            ]}
          />
        </Card>
      </div>
      <Card className="border-yellow bg-yellow-soft p-5">
        <h2 className="text-xs font-extrabold">Important scope note</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink">
          This is a product hypothesis and a design concept. No tokens, credentials, money or
          resources are exchanged, and none will be until the review is complete.
        </p>
      </Card>
    </>
  );
}
