---
'@javis-dog/event-store': minor
---

S5g (ADR-0019 D0 H2/H3): JD-M06 composes the JD-M10 tables (`githubInstallations`, `githubRepositories`, `githubDeliveries`) into `schema`, adds migration 0006 (`0006_jd_m10_github`, rollback `rollback/0006_down.sql`), and `purgeEventsBefore` now also deletes GitHub delivery hashes older than 3 days. Its return value is unchanged.
