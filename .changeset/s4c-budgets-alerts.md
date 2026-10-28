---
'@javis-dog/resilience': minor
'@javis-dog/notify': minor
'@javis-dog/ingest': minor
'@javis-dog/event-store': minor
'@javis-dog/web': minor
---

S4c budgets and alerts (ADR-0014): new JD-M12 `@javis-dog/resilience` (`project_budgets`, `budget_alerts`, `createBudgetRepository` with status, set/clear, exactly-once `claimAlert`, `markAlert`; `forecastSpend`, `crossedThreshold`, `utcMonth`); JD-M06 migration 0005 and `retentionCutoff` keeps the current UTC month; JD-M09 `sendEmail`, `budgetAlertEmail`, `sendBudgetAlertEmail` (one email per recipient); JD-M05 optional `onStored` hook; JD-APP budget card, Budget column, alerts scheduled with `after()`. After review: `BudgetStatus` adds `thresholdReached`, `pendingAlerts`, `failedAlerts`, `exhaustedAlerts` (`alerted` = sent only; `percentUsed` exact, floored to 0.01), `BudgetAlertJob.attempt`, `percentOfLimit`; JD-M09 `SEND_TIMEOUT_MS`, `timeoutMs`, `idempotencyKey`.
