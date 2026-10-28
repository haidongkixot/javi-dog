---
'@javis-dog/jgr-spec': minor
'@javis-dog/event-store': minor
'@javis-dog/projects': patch
'@javis-dog/ingest': minor
'@javis-dog/jgr-sdk': patch
'@javis-dog/web': patch
---

S3d ingest hardening (ADR-0008 Changes): canonical event ids (validator, store, DB check via migration 0003); signal written for accepted-or-duplicate batches, forward-only `last_signal_at`, throttled `last_used_at`; bounded retention purge `{ deleted, batches, complete }`; 415 for unsupported content type/encoding (SDK keeps the spool); > 100 events → 413; rate window from the DB clock; sorted inserts.
