import { createDb, pingDb } from '@javis-dog/event-store';
import { checkHealth } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { httpStatus, body } = await checkHealth({
    env: process.env,
    ping: (url) => pingDb(createDb(url)),
  });
  return Response.json(body, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } });
}
