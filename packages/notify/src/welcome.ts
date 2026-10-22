// Welcome email (JD-M09). Brand voice: warm, brief, concrete; no claims without evidence.

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const welcomeEmail = ({ name, appUrl }: { name: string; appUrl: string }) => {
  const first = name.trim().split(/\s+/)[0] || 'there';
  const projectsUrl = new URL('/projects', appUrl).href;
  const subject = "Welcome to Javi's Dog — your workspace is ready";
  const text = [
    `Hi ${first},`,
    '',
    "Your Javi's Dog workspace is ready. Start by creating a project and an ingest token:",
    projectsUrl,
    '',
    "Connecting coding agents arrives soon. Until then, Javi's Dog shows nothing it hasn't verified.",
    '',
    "You're receiving this because you signed in to Javi's Dog. We only use your email for account messages.",
  ].join('\n');
  const html = `<p>Hi ${escapeHtml(first)},</p>
<p>Your Javi's Dog workspace is ready. Start by <a href="${projectsUrl}">creating a project and an ingest token</a>.</p>
<p>Connecting coding agents arrives soon. Until then, Javi's Dog shows nothing it hasn't verified.</p>
<p style="color:#5f5f78;font-size:12px">You're receiving this because you signed in to Javi's Dog. We only use your email for account messages.</p>`;
  return { subject, text, html };
};

export class NotifyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Resend responded ${status}`);
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

/** Sends the welcome email. Throws `NotifyError` (status only — never the address) on failure. */
export const sendWelcomeEmail = async (
  config: SendConfig,
  to: { email: string; name: string },
): Promise<{ id: string }> => {
  const { subject, text, html } = welcomeEmail({ name: to.name, appUrl: config.appUrl });
  const res = await (config.fetch ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.from, to: [to.email], subject, text, html }),
  });
  if (!res.ok) throw new NotifyError(res.status);
  const body = (await res.json()) as { id?: string };
  return { id: body.id ?? '' };
};
