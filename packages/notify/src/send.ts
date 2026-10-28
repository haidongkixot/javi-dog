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

export interface SendConfig {
  apiKey: string;
  from: string;
  appUrl: string;
  fetch?: typeof fetch;
}

export type MailConfig = Pick<SendConfig, 'apiKey' | 'from' | 'fetch'>;

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** One entry per recipient: an id for each delivery Resend accepted, an error for each that failed. */
export interface DeliveryReport {
  ids: string[];
  /** Errors carry a class name and HTTP status only — never a recipient address. */
  errors: Error[];
}

const postOne = async (config: MailConfig, to: string, message: Omit<EmailMessage, 'to'>) => {
  const res = await (config.fetch ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.from, to: [to], ...message }),
  });
  if (!res.ok) throw new NotifyError(res.status);
  const body = (await res.json()) as { id?: string };
  return body.id ?? '';
};

/**
 * Sends `message` as **one email per recipient**, so recipients never see each other's address
 * (a single Resend call with several `to` entries would expose them). Every recipient is tried
 * even when an earlier one fails; failures are reported, not thrown.
 */
export const sendEmail = async (
  config: MailConfig,
  { to, ...message }: EmailMessage,
): Promise<DeliveryReport> => {
  const report: DeliveryReport = { ids: [], errors: [] };
  for (const recipient of to) {
    try {
      report.ids.push(await postOne(config, recipient, message));
    } catch (error) {
      report.errors.push(error instanceof Error ? error : new NotifyError(0));
    }
  }
  return report;
};
