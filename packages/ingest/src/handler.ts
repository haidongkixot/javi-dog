import { createEventRepository, type AnyDb, type NewEvent } from '@javis-dog/event-store';
import { JGR_LIMITS, validateBatch, type Issue } from '@javis-dog/jgr-spec';
import { createProjectRepository } from '@javis-dog/projects';
import { readBoundedBody } from './body.ts';

/** 60 batches per token per UTC minute ≈ 6 000 events (ADR-0008). */
export const INGEST_RATE_LIMIT_PER_MINUTE = 60;

export interface TokenScope {
  tokenId: string;
  projectId: string;
  workspaceId: string;
  projectSlug: string;
  privacyClass: string;
}

/** Everything the handler touches outside itself; real wiring in `createIngestDeps`. */
export interface IngestDeps {
  verifyToken(raw: string): Promise<TokenScope | null>;
  hitRateWindow(tokenId: string, now: Date): Promise<{ count: number; resetAt: Date }>;
  insertEvents(rows: NewEvent[]): Promise<number>;
  touchSignal(scope: { projectId: string; workspaceId: string }, at: Date): Promise<void>;
  markTokenUsed(tokenId: string, at: Date): Promise<void>;
  now?: () => Date;
  rateLimitPerMinute?: number;
}

export const createIngestDeps = (db: AnyDb): IngestDeps => {
  const projects = createProjectRepository(db);
  const events = createEventRepository(db);
  return {
    verifyToken: projects.verifyToken,
    markTokenUsed: projects.markTokenUsed,
    hitRateWindow: events.hitRateWindow,
    insertEvents: events.insertEvents,
    touchSignal: events.touchSignal,
  };
};

type Rejected = { index: number; event_id?: string; issues: Issue[] };

const PRIVACY_RANK: Record<string, number> = { L0: 0, L1: 1, L2: 2 };
const BEARER = /^Bearer ([^\s]+)$/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const malformed = (message: string) =>
  json(400, { error: 'malformed', issues: [{ code: 'schema', path: '', message }] });

const unauthorized = () =>
  json(
    401,
    { error: 'unauthorized', message: 'A valid project ingest token is required.' },
    { 'WWW-Authenticate': 'Bearer' },
  );

/** Logs the failure class only: driver errors can echo hosts or credentials. */
const logFailure = (error: unknown) =>
  console.error(
    JSON.stringify({
      level: 'error',
      module: 'JD-M05',
      msg: 'ingest failed',
      error: error instanceof Error ? error.name : typeof error,
    }),
  );

/**
 * `POST /api/v1/events` (JGR v0.1 §8, ADR-0008). Order: auth → rate limit → bounded body →
 * JD-M01 validation → project scope and privacy ceiling → idempotent insert → verified signal.
 */
export const createIngestHandler =
  (deps: IngestDeps) =>
  async (request: Request): Promise<Response> => {
    const now = deps.now?.() ?? new Date();
    const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) return unauthorized();

    try {
      const scope = await deps.verifyToken(token);
      if (!scope) return unauthorized();

      const limit = deps.rateLimitPerMinute ?? INGEST_RATE_LIMIT_PER_MINUTE;
      const window = await deps.hitRateWindow(scope.tokenId, now);
      if (window.count > limit) {
        const retryAfter = Math.max(
          1,
          Math.ceil((window.resetAt.getTime() - now.getTime()) / 1000),
        );
        return json(
          429,
          { error: 'rate_limited', message: `At most ${limit} batches per minute per token.` },
          { 'Retry-After': String(retryAfter) },
        );
      }

      const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return malformed('Content-Type must be application/json.');

      const body = await readBoundedBody(request, JGR_LIMITS.maxBatchBytes);
      if (!body.ok) {
        if (body.reason === 'too_large') {
          return json(413, {
            error: 'too_large',
            issues: [
              {
                code: 'too_large',
                path: '',
                message: `Batch exceeds ${JGR_LIMITS.maxBatchBytes} bytes.`,
              },
            ],
          });
        }
        return malformed(
          body.reason === 'unsupported_encoding'
            ? 'Content-Encoding must be gzip or identity.'
            : body.reason === 'empty'
              ? 'Request body is empty.'
              : 'Request body is not valid gzip or UTF-8.',
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return malformed('Request body is not valid JSON.');
      }

      const result = validateBatch(parsed, now);
      if (!result.ok) {
        const tooLarge = result.issues.some((i) => i.code === 'too_large');
        return json(tooLarge ? 413 : 400, {
          error: tooLarge ? 'too_large' : 'malformed',
          issues: result.issues,
        });
      }

      // validateBatch keeps input order, so accepted events map to the indexes not rejected.
      const rejected: Rejected[] = [...result.rejected];
      const rejectedIndexes = new Set(rejected.map((r) => r.index));
      const total = (parsed as { events: unknown[] }).events.length;
      const acceptedIndexes = [...Array(total).keys()].filter((i) => !rejectedIndexes.has(i));
      const ceiling = PRIVACY_RANK[scope.privacyClass] ?? 0;

      const rows: NewEvent[] = [];
      result.accepted.forEach((event, n) => {
        const index = acceptedIndexes[n]!;
        const issues: Issue[] = [];
        if (event.project_ref !== scope.projectSlug && event.project_ref !== scope.projectId) {
          issues.push({
            code: 'project_mismatch',
            path: 'project_ref',
            message: 'project_ref does not match the project of this ingest token.',
          });
        }
        if ((PRIVACY_RANK[event.privacy_class] ?? 0) > ceiling) {
          issues.push({
            code: 'privacy_class_not_allowed',
            path: 'privacy_class',
            message: `This project accepts privacy class ${scope.privacyClass} at most.`,
          });
        }
        if (issues.length) {
          rejected.push({ index, event_id: event.event_id, issues });
          return;
        }
        rows.push({
          projectId: scope.projectId,
          workspaceId: scope.workspaceId,
          producerId: event.producer_id,
          eventId: event.event_id,
          threadRef: event.thread_ref,
          agentRef: event.agent_ref ?? null,
          sequence: event.sequence,
          type: event.type,
          status: event.status ?? null,
          privacyClass: event.privacy_class,
          occurredAt: new Date(event.occurred_at),
          receivedAt: now,
          usageDelta: event.usage_delta ?? null,
          attributes: event.attributes ?? null,
          encrypted: event.encrypted ?? null,
        });
      });

      const stored = await deps.insertEvents(rows);
      if (stored > 0) {
        await Promise.all([
          deps.touchSignal({ projectId: scope.projectId, workspaceId: scope.workspaceId }, now),
          deps.markTokenUsed(scope.tokenId, now),
        ]);
      }

      return json(202, {
        accepted: stored,
        duplicates: rows.length - stored,
        rejected: rejected.sort((a, b) => a.index - b.index),
      });
    } catch (error) {
      logFailure(error);
      return json(503, { error: 'unavailable', message: 'Temporary failure; retry with backoff.' });
    }
  };
