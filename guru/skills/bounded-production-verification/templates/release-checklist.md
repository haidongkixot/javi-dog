# Release checklist — <product> <version>

Each item needs **evidence**: a command with its exit code, a CI run id, or a count, recorded where the item says. "Done" with no evidence counts as NOT RUN.

Statuses (only these): PASS · FAIL · BLOCKED · NOT RUN · ACCEPTED RISK.

| # | Item | Evidence required | Environment | Where recorded | Status |
|---|---|---|---|---|---|
| R1 | Production has its own data store | migration ledger = committed migrations; schema diff vs. staging empty | production | iteration record | |
| R2 | Production reads it | a count that only production writes grows after a real sign-in | production | iteration record | |
| R3 | Access boundaries | access suite green in CI (run id); security review: no open critical/high | CI | iteration record | |
| R4 | Ingest/API performance | one bounded run: p95 vs. target, near-limit payload accepted; budget in the decision record | production | iteration record | |
| R5 | End-to-end | packed artifact → production → counts → product reader shows it; privacy sentinels 0 hits | production | iteration record | |
| R6 | Real user session | a real client session on a real machine: events arrive, attribution matches | user machine | iteration record | |
| R7 | Rollback plan | how-to reviewed; down migrations exist; restore window stated | docs | how-to | |
| R8 | Runbooks | symptom → check → action → escalation per failure mode | docs | how-to | |
| R9 | Scheduled jobs | secret configured; one run observed | production | iteration record | |
| R10 | Secrets | exposed secrets rotated, or accepted risk with owner and date | — | readiness record | |
| R11 | CI green on the release commit | run id on the exact commit | CI | iteration record | |
| R12 | Plans and terms | hosting/database/email plans allow the intended use | — | readiness record | |

## Exceptions (owner-approved, dated)

| Item | Exception | Owner | Date |
|---|---|---|---|
| | e.g. "R4/R5 measured on the staging database, which production still reads" | | |

## Before tagging

1. Fetch; the release commit is the branch head; R11 has a run id on it.
2. Every row is PASS or ACCEPTED RISK, or has an exception above.
3. Record the release in the project memory and session log.
