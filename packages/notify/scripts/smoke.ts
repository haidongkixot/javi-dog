// Sends one welcome email to Resend's test sink (no real recipient).
// Usage: NODE_USE_ENV_PROXY=1 pnpm --filter @javis-dog/notify email:smoke
import { sendWelcomeEmail } from '../src/index.ts';

const { RESEND_API_KEY, EMAIL_FROM } = process.env;
if (!RESEND_API_KEY || !EMAIL_FROM) {
  console.error('RESEND_API_KEY and EMAIL_FROM must be set.');
  process.exit(1);
}
const { id } = await sendWelcomeEmail(
  { apiKey: RESEND_API_KEY, from: EMAIL_FROM, appUrl: 'https://javisdog.vercel.app' },
  { email: 'delivered@resend.dev', name: 'Smoke Test' },
);
console.log(`PASS welcome email accepted by Resend (id ${id.slice(0, 8)}…)`);
