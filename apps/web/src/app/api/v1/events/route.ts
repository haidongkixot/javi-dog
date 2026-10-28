import { after } from 'next/server';
import { getIngestHandler } from '@/lib/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// JGR v0.1 §8 ingress (JD-M05, ADR-0008). Budget alerts run after the response (ADR-0014).
export async function POST(request: Request) {
  const handle = getIngestHandler(process.env, after);
  if (!handle) {
    return Response.json(
      { error: 'not_configured', message: 'Ingest is not configured on this deployment.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return handle(request);
}
