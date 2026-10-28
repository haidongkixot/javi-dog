# JD-M12 · `@javis-dog/resilience` — budgets and alerts

Status: **in-progress** (S4c, ADR-0014). One optional monthly USD budget per project, month-to-date **estimated** spend with a linear forecast, and 80 % / 100 % alerts claimed exactly once per (project, UTC month, threshold), emailed to workspace owners after ingest. BYOK failover is planned for S6.

| Export | Description |
|---|---|
| `budgetTables` (`project_budgets`, `budget_alerts`) | Composed into the JD-M06 schema (migration 0005) |
| `createBudgetRepository(db)` | `status`, `statuses`, `setBudget`, `clearBudget`, `claimAlert`, `markAlert` |
| `forecastSpend()`, `crossedThreshold()`, `utcMonth()` | Pure arithmetic |

Database tests live in `packages/event-store/test/budgets.test.ts` (same pattern as JD-M03).
