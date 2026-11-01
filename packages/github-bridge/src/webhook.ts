import type { JgrEvent } from '@javis-dog/jgr-spec';
import { classifyDelivery, isTooOld, type DeliveryKind, type IgnoredReason } from './classify.ts';
import { sha256Hex } from './ids.ts';
import { installationChange } from './installations.ts';
import { mapDelivery } from './map.ts';
import { readRawBody, WEBHOOK_MAX_BODY_BYTES, type RawBodyResult } from './raw-body.ts';
import type { GithubRepository } from './repository.ts';
import { verifyGithubSignature } from './signature.ts';

// The framework-free `POST /api/github/webhook` handler (ADR-0019 §3 with D0 H2/H3/H4/L1 and QA
// gaps G3, G13, G14, G18–G23). JD-APP wires the real dependencies; this module must not import
// JD-M06 or JD-M05 (they depend on it), so the event store is reached through injected functions.

/**
 * One event row for the JD-M06 `events` table. Structurally a JD-M06 `NewEvent`, declared here
 * because JD-M10 cannot import JD-M06 (JD-M06 composes JD-M10's tables).
 */
export interface GithubEventRow {
  projectId: string;
  workspaceId: string;
  producerId: string;
  eventId: string;
  threadRef: string;
  agentRef: null;
  sequence: number;
  type: string;
  status: null;
  privacyClass: string;
  occurredAt: Date;
  receivedAt: Date;
  usageDelta: null;
  attributes: Record<string, unknown> | null;
  encrypted: null;
}

/** The JD-M10 repository methods the handler uses (`createGithubRepository(db)` provides them). */
export type GithubWebhookStore = Pick<
  GithubRepository,
  | 'hasDelivery'
  | 'recordDelivery'
  | 'applyInstallationDelivery'
  | 'refreshRepositoryName'
  | 'routeTarget'
  | 'touchVerifiedDelivery'
>;

/**
 * `GITHUB_APP_WEBHOOK_SECRET` (`current`) and `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` (`previous`).
 * Without a non-empty `current` the handler answers 503, even when `previous` is set (G13).
 */
export interface GithubWebhookSecrets {
  current?: string | null;
  previous?: string | null;
}

/** Why the handler answered as it did. A fixed vocabulary: never derived from request data. */
export type GithubWebhookOutcome =
  | 'not_configured'
  | 'unsupported_encoding'
  | 'unauthorized'
  | 'too_large'
  | 'unreadable'
  | 'duplicate'
  | 'not_json'
  | `ignored:${IgnoredReason}`
  | 'too_old'
  | 'unrouted'
  | 'rejected'
  | 'applied'
  | 'stored'
  | 'error';

/**
 * One log line. Only the delivery GUID (after verification, and only when GUID-shaped), the event
 * kind, the action and the outcome (ADR-0019 §3.8, D0 H2), plus the status code and fixed
 * framing fields. Never headers, bodies, names, secrets or error messages.
 */
export interface GithubWebhookLogEntry {
  level: 'info' | 'warn' | 'error';
  module: 'JD-M10';
  msg: 'github webhook';
  status: number;
  outcome: GithubWebhookOutcome;
  delivery?: string;
  event?: string;
  action?: string;
}

export type GithubWebhookLog = (entry: GithubWebhookLogEntry) => void;

/** Everything the handler touches outside itself; JD-APP wires the real ones. */
export interface GithubWebhookDeps {
  secrets: GithubWebhookSecrets;
  /** JD-M10 persistence: `createGithubRepository(db)`. */
  store: GithubWebhookStore;
  /** JD-M06 `createEventRepository(db).insertEvents`: idempotent on (project, producer, event_id). */
  insertEvents(rows: GithubEventRow[]): Promise<number>;
  /** JD-M06 `touchSignal`: marks a verified signal for the linked project (D0 M1). */
  touchSignal(scope: { projectId: string; workspaceId: string }, at: Date): Promise<void>;
  /** Bounded raw-body reader; defaults to `readRawBody`. */
  readBody?: (request: Request, maxBytes: number) => Promise<RawBodyResult>;
  /** Request clock: 3-day rule, JD-M01 validation, receipt time. Defaults to `new Date()`. */
  now?: () => Date;
  /** Defaults to `consoleGithubWebhookLog` (one JSON line per request). */
  log?: GithubWebhookLog;
}

/** Writes one JSON line: `console.error` for 5xx, `console.warn` for refusals, else `info`. */
export const consoleGithubWebhookLog: GithubWebhookLog = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.info(line);
};

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * The 503 answer when the route cannot run at all (no webhook secret, or no database in JD-APP).
 * Never claims to be connected.
 */
export const githubWebhookNotConfigured = () => json(503, { error: 'not_configured' });

/** `X-GitHub-Delivery` is logged only in this shape (D0 H2). */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event names that may appear in a log line for an ignored delivery (never free text). */
const LOGGABLE_EVENTS: ReadonlySet<string> = new Set([
  'workflow_run',
  'check_suite',
  'pull_request',
  'installation',
  'installation_repositories',
  'ping',
]);

const EMPTY = new Uint8Array(0);

const nonEmpty = (v: string | null | undefined): v is string => typeof v === 'string' && v !== '';

const levelOf = (status: number): GithubWebhookLogEntry['level'] =>
  status >= 500 && status !== 503 ? 'error' : status >= 400 ? 'warn' : 'info';

const toRow = (
  event: JgrEvent,
  target: { projectId: string; workspaceId: string },
  receivedAt: Date,
): GithubEventRow => ({
  projectId: target.projectId,
  workspaceId: target.workspaceId,
  producerId: event.producer_id,
  eventId: event.event_id,
  threadRef: event.thread_ref,
  agentRef: null,
  sequence: event.sequence,
  type: event.type,
  status: null,
  privacyClass: event.privacy_class,
  occurredAt: new Date(event.occurred_at),
  receivedAt,
  usageDelta: null,
  attributes: (event.attributes as Record<string, unknown> | undefined) ?? null,
  encrypted: null,
});

/**
 * Builds the `POST /api/github/webhook` handler (ADR-0019 §3). Checks, in this order:
 *
 * 1. no non-empty current secret → 503 `not_configured` (also with only the previous one, G13);
 * 2. `Content-Encoding` other than `identity` (any case) → 415, before the body is read (L1, G19);
 * 3. `X-Hub-Signature-256` missing or not `sha256=` + 64 lower-case hex → 401, before reading;
 * 4. body over 1 MiB → 413 (an unreadable stream → 400);
 * 5. HMAC-SHA256 of the raw bytes, current then previous secret, constant time → else 401. All
 *    401s have the same body, whatever failed. Nothing is parsed before this passes;
 * 6. body SHA-256 already in `github_deliveries` → 202 (D0 H2);
 * 7. not UTF-8 or not JSON → 202 and dropped (G18);
 * 8. classification by payload shape, `X-GitHub-Event` must agree (unknown, `ping`, mismatch,
 *    unmapped action, missing installation …) → 202;
 * 9. `installation*`: applied through `applyInstallationDelivery` → 200, or 202 for a known body;
 *    `new_permissions_accepted` changes nothing → 202;
 * 10. runs, suites, PRs: per-event 3-day rule → 202; `full_name` refresh (G20); routing (linked,
 *     same installation, claimed, unsuspended) → else 202; mapping + JD-M01 validation → a
 *     rejected event (e.g. > 5 min in the future, G21) → 202 with nothing stored; insert, signal,
 *     verified-delivery time, and the body hash **last** (G14) → 200.
 *
 * Every 202 except a JD-M01 rejection records the body hash (activity hashes are purged after 3
 * days, installation hashes kept). Any store failure → 500 with no hash recorded, so GitHub's
 * redelivery is processed. Responses are small `{ ok, outcome }` / `{ error }` JSON, `no-store`.
 */
export const createGithubWebhookHandler = (deps: GithubWebhookDeps) => {
  const log = deps.log ?? consoleGithubWebhookLog;
  const readBody = deps.readBody ?? readRawBody;

  return async (request: Request): Promise<Response> => {
    const now = deps.now?.() ?? new Date();
    let delivery: string | undefined;
    let event: string | undefined;
    let action: string | undefined;

    const finish = (
      status: number,
      outcome: GithubWebhookOutcome,
      body: Record<string, unknown>,
    ) => {
      log({
        level: levelOf(status),
        module: 'JD-M10',
        msg: 'github webhook',
        status,
        outcome,
        ...(delivery !== undefined && { delivery }),
        ...(event !== undefined && { event }),
        ...(action !== undefined && { action }),
      });
      return json(status, body);
    };
    const acknowledged = (status: 200 | 202, outcome: GithubWebhookOutcome) =>
      finish(status, outcome, { ok: true, outcome });
    const unauthorized = () => finish(401, 'unauthorized', { error: 'unauthorized' });

    // 1. Configuration.
    const current = deps.secrets.current;
    if (!nonEmpty(current)) {
      log({
        level: 'warn',
        module: 'JD-M10',
        msg: 'github webhook',
        status: 503,
        outcome: 'not_configured',
      });
      return githubWebhookNotConfigured();
    }

    // 2. Encoding, before the body is read.
    const encoding = request.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      return finish(415, 'unsupported_encoding', { error: 'unsupported_media_type' });
    }

    // 3. Header format, before the body is read: with no secrets the verifier only parses it.
    const signature = request.headers.get('x-hub-signature-256');
    if (verifyGithubSignature(EMPTY, signature, []) !== 'mismatch') return unauthorized();

    // 4. Size.
    const body = await readBody(request, WEBHOOK_MAX_BODY_BYTES);
    if (!body.ok) {
      return body.reason === 'too_large'
        ? finish(413, 'too_large', { error: 'too_large' })
        : finish(400, 'unreadable', { error: 'unreadable' });
    }

    // 5. Signature over the raw bytes.
    const secrets = [current, deps.secrets.previous].filter(nonEmpty);
    if (verifyGithubSignature(body.bytes, signature, secrets) !== 'ok') return unauthorized();

    // Verified from here on. The GUID is unsigned: logged only, and only in GUID shape.
    const guid = request.headers.get('x-github-delivery');
    if (guid !== null && GUID.test(guid)) delivery = guid.toLowerCase();
    const bodySha256 = sha256Hex(body.bytes);
    const { store } = deps;

    try {
      // 6. Replay and redelivery dedupe on the signed content (D0 H2).
      if (await store.hasDelivery(bodySha256)) return acknowledged(202, 'duplicate');

      // 7. Parse. `ignoreBOM` keeps a BOM, which JSON.parse then refuses: the bytes are the truth.
      let payload: unknown;
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body.bytes);
        payload = JSON.parse(text) as unknown;
      } catch {
        await store.recordDelivery(bodySha256, 'activity', now);
        return acknowledged(202, 'not_json');
      }

      // 8. Classification: the payload shape decides; the header must agree.
      const headerEvent = request.headers.get('x-github-event');
      const classified = classifyDelivery(payload, headerEvent);
      if (classified.kind === 'ignored') {
        if (headerEvent !== null && LOGGABLE_EVENTS.has(headerEvent)) event = headerEvent;
        await store.recordDelivery(bodySha256, 'activity', now);
        return acknowledged(202, `ignored:${classified.reason}`);
      }
      event = classified.kind satisfies DeliveryKind;
      action = classified.action;

      // 9. Installations: exempt from the 3-day rule (D0 H4); the kept body hash guards replays.
      if (classified.kind === 'installation' || classified.kind === 'installation_repositories') {
        if (
          classified.kind === 'installation' &&
          classified.action === 'new_permissions_accepted'
        ) {
          // Nothing the bridge keeps changes (permissions are fixed by the manifest).
          await store.recordDelivery(bodySha256, 'installation', now);
          return acknowledged(202, 'ignored:action');
        }
        const result = await store.applyInstallationDelivery(
          installationChange(classified),
          bodySha256,
          now,
        );
        return result === 'applied' ? acknowledged(200, 'applied') : acknowledged(202, 'duplicate');
      }

      // 10. Runs, suites and PRs.
      if (isTooOld(classified.kind, payload, now)) {
        await store.recordDelivery(bodySha256, 'activity', now);
        return acknowledged(202, 'too_old');
      }
      const { installationId, repository } = classified;
      await store.refreshRepositoryName(installationId, repository);
      const target = await store.routeTarget(installationId, repository.repoId);
      if (!target) {
        await store.recordDelivery(bodySha256, 'activity', now);
        return acknowledged(202, 'unrouted');
      }
      const mapped = mapDelivery(classified, {
        bodySha256,
        installationId,
        projectSlug: target.projectSlug,
        receivedAt: now,
      });
      // A JD-M01 rejection stores nothing, not even the hash: a later redelivery may pass.
      if (!mapped.ok) return acknowledged(202, 'rejected');

      await deps.insertEvents(mapped.events.map((e) => toRow(e, target, now)));
      await Promise.all([
        deps.touchSignal({ projectId: target.projectId, workspaceId: target.workspaceId }, now),
        store.touchVerifiedDelivery(installationId, now),
      ]);
      // Last (G14): any failure above leaves no hash, so the redelivery is processed.
      await store.recordDelivery(bodySha256, 'activity', now);
      return acknowledged(200, 'stored');
    } catch {
      // Driver errors can echo hosts or credentials: the outcome is all that is logged.
      return finish(500, 'error', { error: 'unavailable' });
    }
  };
};

export type GithubWebhookHandler = ReturnType<typeof createGithubWebhookHandler>;
