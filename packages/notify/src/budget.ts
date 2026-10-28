// Budget alert email (JD-M09, ADR-0014). Brand voice: warm, brief, concrete, no alarm.
// L0 only: project name, month and money figures — never prompts, session ids or addresses.
import { sendEmail, type DeliveryReport, type SendConfig } from './send.ts';

export interface BudgetAlertEmailInput {
  projectName: string;
  projectUrl: string;
  /** e.g. "October 2026". */
  monthLabel: string;
  /** 80 or 100 (ADR-0014). */
  threshold: number;
  spendUsd: number;
  limitUsd: number;
  percentUsed: number;
  /** null before 24 h of the month have elapsed. */
  forecastUsd: number | null;
  /** Usage reports this month that carried estimated figures (ADR-0013). */
  estimatedReports: number;
  reports: number;
}

/** Structurally a JD-M12 `BudgetAlertJob`; JD-M09 does not depend on JD-M12. */
export interface BudgetAlertSendInput {
  projectId: string;
  projectName: string;
  threshold: number;
  /** Verified owner emails. One email per recipient; never logged. */
  recipients: string[];
  status: {
    /** UTC month, e.g. "2026-10". */
    month: string;
    spendUsd: number;
    limitUsd: number | null;
    percentUsed: number | null;
    forecastUsd: number | null;
    reports: number;
    estimatedReports: number;
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// eslint-disable-next-line no-control-regex -- strip control characters from user-entered names
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || 'Your project';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n: number) => usd.format(n);
/** Floored so 99.6 % never reads as a reached 100 %. */
const percent = (n: number) => `${Math.floor(n)} %`;

/** "2026-10" → "October 2026" (UTC); anything else is returned unchanged. */
export const budgetMonthLabel = (month: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

export const budgetAlertEmail = (input: BudgetAlertEmailInput) => {
  const name = oneLine(input.projectName);
  const reached = input.threshold >= 100;
  const pct = percent(input.percentUsed);

  const subject = reached
    ? `${name} reached its ${input.monthLabel} budget (estimated)`
    : `${name} is at ${pct} of its ${input.monthLabel} budget (estimated)`;
  const lead = reached
    ? `${name} has reached its ${input.monthLabel} budget. Javi's Dog never pauses your agents, so spend can keep growing past the limit.`
    : `${name} has used an estimated ${pct} of its ${input.monthLabel} budget. Nothing is blocked — this is an early heads-up so you can plan the rest of the month.`;
  const facts = [
    `Estimated spend: ${money(input.spendUsd)} of your ${money(input.limitUsd)} budget (${pct})`,
    input.forecastUsd === null
      ? 'Forecast: too early to forecast — less than a day of this month has passed'
      : `Forecast for ${input.monthLabel}: about ${money(input.forecastUsd)} (estimated)`,
    ...(input.estimatedReports > 0
      ? [
          `Note: ${input.estimatedReports} of ${input.reports} usage reports this month carried estimated figures`,
        ]
      : []),
  ];
  const howItWorks =
    "Spend adds up the cost your coding agents report, so it is an estimate and can differ from your provider's bill.";
  const footer =
    "You're receiving this because you own this Javi's Dog workspace. You get at most one email per threshold (80 % and 100 %) per project each month.";

  const text = [
    'Hi,',
    '',
    lead,
    '',
    ...facts.map((f) => `- ${f}`),
    '',
    `Open the project: ${input.projectUrl}`,
    '',
    howItWorks,
    '',
    footer,
  ].join('\n');
  const html = `<p>Hi,</p>
<p>${escapeHtml(lead)}</p>
<ul>${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
<p><a href="${escapeHtml(input.projectUrl)}">Open ${escapeHtml(name)} in Javi's Dog</a></p>
<p>${escapeHtml(howItWorks)}</p>
<p style="color:#5f5f78;font-size:12px">${escapeHtml(footer)}</p>`;
  return { subject, text, html };
};

/**
 * Sends one budget alert email per recipient (never one email with every owner in `to`).
 * Returns the per-recipient report; throws only for a job without a limit (nothing sent).
 */
export const sendBudgetAlertEmail = async (
  config: SendConfig,
  job: BudgetAlertSendInput,
): Promise<DeliveryReport> => {
  const { limitUsd, spendUsd } = job.status;
  if (limitUsd === null || !(limitUsd > 0)) {
    throw new RangeError('budget alert without a monthly limit');
  }
  const message = budgetAlertEmail({
    projectName: job.projectName,
    projectUrl: new URL(`/projects/${encodeURIComponent(job.projectId)}`, config.appUrl).href,
    monthLabel: budgetMonthLabel(job.status.month),
    threshold: job.threshold,
    spendUsd,
    limitUsd,
    percentUsed: job.status.percentUsed ?? (spendUsd / limitUsd) * 100,
    forecastUsd: job.status.forecastUsd,
    estimatedReports: job.status.estimatedReports,
    reports: job.status.reports,
  });
  return sendEmail(config, { to: job.recipients, ...message });
};
