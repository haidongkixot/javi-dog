import { createHash, timingSafeEqual } from 'node:crypto';
import { retentionCutoff } from '@javis-dog/event-store';

type Env = Readonly<Record<string, string | undefined>>;

export interface PurgeResult {
  deleted: number;
  batches: number;
  /** `false` when the time budget ran out first; the next daily run continues (H3). */
  complete: boolean;
}

export interface PurgeDeps {
  env: Env;
  /** Deletes events received before `cutoff` (and stale rate windows) in bounded batches. */
  purge: (cutoff: Date, now: Date) => Promise<PurgeResult>;
  now?: () => Date;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>` (hashing equalizes lengths). */
const authorized = (header: string | null, secret: string) =>
  timingSafeEqual(digest(header ?? ''), digest(`Bearer ${secret}`));

const notConfigured = { httpStatus: 503, body: { error: 'not_configured' } };

/**
 * Daily retention purge (ADR-0008, ADR-0009). Counts only; never echoes secrets or errors.
 * Without `CRON_SECRET` nothing can be authenticated, so it answers 503. With it, the caller
 * must authenticate before learning anything else about the configuration (H3).
 */
export const runRetentionPurge = async (
  authorization: string | null,
  deps: PurgeDeps,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> => {
  const secret = deps.env.CRON_SECRET?.trim();
  if (!secret) return notConfigured;
  if (!authorized(authorization, secret))
    return { httpStatus: 401, body: { error: 'unauthorized' } };
  if (!deps.env.DATABASE_URL) return notConfigured;

  const now = deps.now?.() ?? new Date();
  const cutoff = retentionCutoff(now);
  try {
    const { deleted, batches, complete } = await deps.purge(cutoff, now);
    return {
      httpStatus: 200,
      body: { deleted, batches, complete, cutoff: cutoff.toISOString() },
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        module: 'JD-APP',
        msg: 'retention purge failed',
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { httpStatus: 503, body: { error: 'unavailable' } };
  }
};
