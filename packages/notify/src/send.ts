// Resend REST transport shared by every JD-M09 email (ADR-0007).

export class NotifyError extends Error {
  readonly status: number;
  /** `status` is the Resend HTTP status, or 0 when no response arrived. Never carries an address. */
  constructor(status: number) {
    super(status ? `Resend responded ${status}` : 'Resend request failed');
    this.name = 'NotifyError';
    this.status = status;
  }
}

/** Per-request timeout for a Resend call; a timeout counts as a failed delivery. */
export const SEND_TIMEOUT_MS = 10_000;

export interface SendConfig {
  apiKey: string;
  from: string;
  appUrl: string;
  fetch?: typeof fetch;
  /** Per-request timeout in ms (default `SEND_TIMEOUT_MS`). */
  timeoutMs?: number;
}

export type MailConfig = Pick<SendConfig, 'apiKey' | 'from' | 'fetch' | 'timeoutMs'>;

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
  /**
   * Optional base for Resend's `Idempotency-Key` header: the request for `to[i]` sends
   * `<idempotencyKey>/<i>`. Keep it stable across retries of the same email so Resend can
   * de-duplicate a re-send (its de-duplication window is UNVERIFIED here).
   */
  idempotencyKey?: string;
}

/** One entry per recipient: an id for each delivery Resend accepted, an error for each that failed. */
export interface DeliveryReport {
  ids: string[];
  /** Errors carry a class name and HTTP status only — never a recipient address. */
  errors: Error[];
}

/** `AbortSignal.timeout`, or an AbortController timer where the runtime lacks it. */
const timeoutSignal = (ms: number): AbortSignal => {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    ms,
  );
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
};

type Content = Pick<EmailMessage, 'subject' | 'text' | 'html'>;

const postOne = async (
  config: MailConfig,
  to: string,
  content: Content,
  idempotencyKey: string | undefined,
) => {
  let res: Response;
  let body: { id?: string };
  try {
    res = await (config.fetch ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
      },
      body: JSON.stringify({ from: config.from, to: [to], ...content }),
      // Covers the response body too: a hung Resend call fails instead of stalling `after()`.
      signal: timeoutSignal(config.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new NotifyError(res.status);
    body = (await res.json()) as { id?: string };
  } catch (error) {
    // Transport errors, timeouts and bad JSON become status 0: their messages may echo hosts
    // or addresses, so they are never passed on.
    throw error instanceof NotifyError ? error : new NotifyError(0);
  }
  return body.id ?? '';
};

/**
 * Sends `message` as **one email per recipient**, so recipients never see each other's address
 * (a single Resend call with several `to` entries would expose them). Every recipient is tried
 * even when an earlier one fails; failures are reported, not thrown. Each request times out
 * after `timeoutMs` (10 s); a timeout is a `NotifyError` with status 0.
 */
export const sendEmail = async (
  config: MailConfig,
  { to, idempotencyKey, subject, text, html }: EmailMessage,
): Promise<DeliveryReport> => {
  const report: DeliveryReport = { ids: [], errors: [] };
  for (const [index, recipient] of to.entries()) {
    try {
      const key = idempotencyKey ? `${idempotencyKey}/${index}` : undefined;
      report.ids.push(await postOne(config, recipient, { subject, text, html }, key));
    } catch (error) {
      report.errors.push(error instanceof Error ? error : new NotifyError(0));
    }
  }
  return report;
};
