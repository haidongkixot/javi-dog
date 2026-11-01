---
'@javis-dog/ingest': minor
---

S5g (ADR-0019 D0 M2): JD-M05 `POST /api/v1/events` rejects, per event, a `producer_id` starting `gh-app_` or a `thread_ref` starting `gh_` (case-insensitive) with issue code `reserved_ref`. These prefixes are reserved for the GitHub App bridge (JD-M10).
