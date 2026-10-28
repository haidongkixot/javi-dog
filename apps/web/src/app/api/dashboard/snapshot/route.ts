import { dashboardDeps, dashboardSnapshotResponse } from '@/lib/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Polled every 10 s by the dashboard pages (ADR-0012). The workspace comes from the session;
// the request (including any query string) is deliberately not read.
export async function GET() {
  return dashboardSnapshotResponse(dashboardDeps);
}
