---
'@javis-dog/realtime': minor
'@javis-dog/web': minor
---

S5h (ADR-0019 Changes "S5h decisions"): JD-M07 `GithubCounts` gains `ciNoResult: Counter` for CI threads whose newest event is `task.started` and whose last delivery is more than 6 h before the snapshot clock; `ciRunning` keeps only the ones within 6 h. New exports `GITHUB_NO_RESULT_AFTER_MS` (6 h) and `githubNoResult(thread, now)`. JD-APP reads such a thread's result as "No result received" (never "Failed") in the GitHub table, shows the count on the overview's GitHub card when there is one, and applies the same rule when the dashboard ages a snapshot in the browser.
