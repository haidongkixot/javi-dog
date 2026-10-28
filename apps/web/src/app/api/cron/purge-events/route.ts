import { createDb, createEventRepository } from '@javis-dog/event-store';
import { runRetentionPurge } from '@/lib/purge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The purge loops for up to ~20 s (ADR-0009 Changes); keep the function alive past that.
export const maxDuration = 60;

// Vercel Cron (apps/web/vercel.json) calls this daily with `Authorization: Bearer $CRON_SECRET`.
export async function GET(request: Request) {
  const { httpStatus, body } = await runRetentionPurge(request.headers.get('authorization'), {
    env: process.env,
    purge: (cutoff, now) =>
      createEventRepository(createDb(process.env.DATABASE_URL!)).purgeEventsBefore(cutoff, now),
  });
  return Response.json(body, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } });
}
