import type { Metadata } from 'next';
import {
  Card,
  CardHead,
  EndpointBlock,
  PageHead,
  RuleList,
  StatusPill,
} from '@javis-dog/ui/components';
import type { StatusTone } from '@javis-dog/ui';

export const metadata: Metadata = { title: 'JGR & Integrations' };

const integrations: ReadonlyArray<{
  key: string;
  name: string;
  desc: string;
  status: string;
  tone: StatusTone;
}> = [
  {
    key: 'CC',
    name: 'Claude Code',
    desc: 'Hooks + OpenTelemetry adapter',
    status: 'Available · javi CLI (beta)',
    tone: 'info',
  },
  {
    key: 'CX',
    name: 'Codex / Gemini CLI',
    desc: 'OpenTelemetry (OTLP) adapter',
    status: 'Planned · Sprint 5',
    tone: 'info',
  },
  {
    key: 'GH',
    name: 'GitHub',
    desc: 'Commits, pull requests and CI for any tool',
    status: 'Planned · Sprint 6',
    tone: 'info',
  },
  {
    key: 'API',
    name: 'Custom JGR API',
    desc: 'Token-authenticated ingestion endpoint; request signing planned for v0.2',
    status: 'Spec in progress',
    tone: 'protocol',
  },
];

const envelope = [
  {
    n: '01',
    title: 'Stable event identity',
    body: 'event_id + producer_id + sequence for idempotency and ordering.',
  },
  {
    n: '02',
    title: 'Minimal observability fields',
    body: 'project_ref, thread_ref, agent_ref, status, occurred_at.',
  },
  {
    n: '03',
    title: 'Usage counters, not source code',
    body: 'Token deltas and durations; prompts and code excluded by default.',
  },
  {
    n: '04',
    title: 'Delivery guarantees',
    body: 'Batching, retry with backoff, rate limits and replay protection.',
  },
] as const;

const privacy = [
  {
    n: 'L0',
    title: 'Operational metadata only (the default)',
    body: 'Status, timings and token counts. No prompts, code, secrets, file paths or repo and branch names.',
  },
  {
    n: 'L1',
    title: 'Keyed hashes of names (opt-in, per project)',
    body: 'Off until a project owner or admin turns it on. javi then sends repo, branch and folder names only as keyed hashes (HMAC) made with the project’s recovery key. Javi’s Dog can’t reverse them, but it sees which threads share a repo, branch or folder, and how often.',
  },
  {
    n: 'L2',
    title: 'Encrypted repo and branch names (opt-in, per project)',
    body: 'L1, plus repo and branch names encrypted on your machine with the project’s recovery key. Javi’s Dog stores only the ciphertext; a browser that holds the key decrypts them. Status, timing, token counts, event sizes and the sender’s IP stay visible to Javi’s Dog, and anyone holding the key can read the names.',
  },
] as const;

// JGR & Integrations — "Can I trust the incoming signal?"
export default function IntegrationsPage() {
  return (
    <>
      <PageHead
        eyebrow="Control plane"
        title="One shared language for every agent."
        description="Javi Grande Rules (JGR) define a minimal, privacy-aware event contract between coding tools and Javi's Dog."
      />
      <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(280px,1fr)] gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="directory-title">
          <CardHead
            id="directory-title"
            title="Integration directory"
            subtitle="Nothing is connected until a verified signal arrives"
          />
          <ul className="px-5 pt-1 pb-3">
            {integrations.map((i) => (
              <li
                key={i.key}
                className="flex items-center gap-3 border-b border-line py-3 last:border-0"
              >
                <span
                  aria-hidden
                  className="grid size-9 flex-none place-items-center rounded-xl bg-accent-soft text-xs font-extrabold text-protocol"
                >
                  {i.key}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold">{i.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{i.desc}</p>
                </div>
                <div className="ml-auto text-right">
                  <StatusPill tone={i.tone}>{i.status}</StatusPill>
                  <p className="mt-1 text-[11px] text-muted">Connection not verified yet.</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card labelledBy="envelope-title">
          <CardHead
            id="envelope-title"
            title="JGR event envelope"
            subtitle="JGR v0.1 · draft spec, accepted by the endpoint below"
          />
          <EndpointBlock
            method="POST"
            path="/api/v1/events"
            note="Accepts project ingest tokens (Bearer). Issue one on a project page, then run javi init in your repo. Your agents show up on the dashboards once their first signal arrives."
          />
          <RuleList items={envelope} />
        </Card>
      </div>
      <div className="grid grid-cols-2 gap-4 max-[850px]:grid-cols-1">
        <Card labelledBy="privacy-title">
          <CardHead
            id="privacy-title"
            title="Privacy classes"
            subtitle="L0 by default. L1 and L2 are opt-in per project, set up on the project page and with javi init --privacy"
          />
          <RuleList items={privacy} />
        </Card>
        <Card labelledBy="quality-title">
          <CardHead
            id="quality-title"
            title="Signal delivery quality"
            subtitle="Design goals, not measured SLAs"
          />
          <dl className="grid gap-4 px-5 pt-4 pb-5 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Event delivery target</dt>
              <dd className="tabular font-bold">p95 &lt; 2 s</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Payload target</dt>
              <dd className="tabular font-bold">&lt; 4 KB</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Raw code in telemetry</dt>
              <dd className="font-bold text-ok">Off by default</dd>
            </div>
            <p className="text-muted">Targets are hypotheses until load-tested in Sprint 5.</p>
          </dl>
        </Card>
      </div>
    </>
  );
}
