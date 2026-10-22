---
'@javis-dog/ingest': minor
'@javis-dog/event-store': minor
'@javis-dog/projects': minor
'@javis-dog/jgr-spec': minor
'@javis-dog/web': minor
---

S3a (ADR-0008): new JD-M05 `@javis-dog/ingest` (`createIngestHandler`, `createIngestDeps`, `readBoundedBody`); JD-M06 adds `events` / `ingest_rate_windows` (migration 0002), `createEventRepository` and `getMigrationsFolder`; JD-M04 `verifyToken` also returns `projectSlug` and `privacyClass`, plus `markTokenUsed`; JD-M01 adds the receiver-side issue codes `project_mismatch` and `privacy_class_not_allowed`; JD-APP serves `POST /api/v1/events`.
