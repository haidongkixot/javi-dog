import { getGithubWebhookHandler } from '@/lib/github-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GitHub App webhook (JD-M10, ADR-0019 §3). Everything, including the 503 without a secret or a
// database and the `Cache-Control: no-store` header, is decided by the JD-M10 handler.
export async function POST(request: Request) {
  return getGithubWebhookHandler(process.env)(request);
}
