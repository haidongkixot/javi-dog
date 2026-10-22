# JD-M09 · `@javis-dog/notify` — Transactional email

Status: **in-progress**. S2c: welcome email via the Resend REST API (ADR-0007). Alerts arrive with JD-M12.

## Public contract

| Export | Description |
|---|---|
| `sendWelcomeEmail(config, to)` | POSTs one email to Resend; returns `{ id }`; throws `NotifyError` (HTTP status only) |
| `welcomeEmail({ name, appUrl })` | Subject, text and HTML (name escaped) |
| `NotifyError`, `SendConfig` | Types |

`pnpm --filter @javis-dog/notify email:smoke` sends one email to Resend's test sink `delivered@resend.dev` (needs `RESEND_API_KEY`, `EMAIL_FROM`; sandbox: `NODE_USE_ENV_PROXY=1`).
