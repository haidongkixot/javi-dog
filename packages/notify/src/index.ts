// JD-M09 public contract. Import from '@javis-dog/notify' only (ADR-0001).
export {
  budgetAlertEmail,
  budgetMonthLabel,
  sendBudgetAlertEmail,
  type BudgetAlertEmailInput,
  type BudgetAlertSendInput,
} from './budget.ts';
export {
  NotifyError,
  sendEmail,
  type DeliveryReport,
  type EmailMessage,
  type MailConfig,
  type SendConfig,
} from './send.ts';
export { sendWelcomeEmail, welcomeEmail } from './welcome.ts';
