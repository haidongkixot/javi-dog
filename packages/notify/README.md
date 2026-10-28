# JD-M09 · `@javis-dog/notify` — Transactional email

Status: **in-progress**. S2c: welcome email via the Resend REST API (ADR-0007). S4c: budget alert email (ADR-0014).

## Public contract

| Export | Description |
|---|---|
| `sendEmail(config, { to, subject, text, html })` | One Resend request **per recipient** (recipients never see each other's address); tries every recipient; returns `{ ids, errors }` and never throws for a delivery failure |
| `sendWelcomeEmail(config, to)` | POSTs one email to Resend; returns `{ id }`; throws `NotifyError` (HTTP status only) |
| `welcomeEmail({ name, appUrl })` | Subject, text and HTML (name escaped) |
| `sendBudgetAlertEmail(config, job)` | Budget alert to each owner in `job.recipients` (a JD-M12 `BudgetAlertJob` fits); link `/projects/<id>`; returns `{ ids, errors }`; throws `RangeError` for a job without a limit (nothing sent) |
| `budgetAlertEmail(input)`, `budgetMonthLabel(month)` | Alert subject/text/HTML: every money value labelled estimated, forecast or "too early to forecast", a note when usage reports carried estimated figures; L0 only |
| `NotifyError`, `SendConfig`, `MailConfig`, `EmailMessage`, `DeliveryReport` | Types; errors carry a class name and HTTP status (0 = no response), never an address |

`pnpm --filter @javis-dog/notify email:smoke` sends one email to Resend's test sink `delivered@resend.dev` (needs `RESEND_API_KEY`, `EMAIL_FROM`; sandbox: `NODE_USE_ENV_PROXY=1`).
