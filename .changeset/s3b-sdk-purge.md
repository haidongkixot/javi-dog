---
'@javis-dog/jgr-sdk': minor
'@javis-dog/event-store': minor
'@javis-dog/web': minor
---

S3b (ADR-0009): new JD-M02 `@javis-dog/jgr-sdk` (`createJgrClient` with `record`/`flush`, `createFileSpool`, `createMemorySpool`, `createUlid`); JD-M06 exports `EVENT_RETENTION_DAYS` and `retentionCutoff`; JD-APP adds the daily `GET /api/cron/purge-events` (Vercel Cron, `CRON_SECRET`) and reports `CRON_SECRET` presence in `/api/health`.
