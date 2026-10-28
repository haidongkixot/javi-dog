# Release checklist (S5 release gate)

The release gate (roadmap, end of S5) has four parts: working end-to-end telemetry, verified access boundaries, test evidence, and a rollback plan. Each item needs **evidence**: a command with its exit code, a CI run id, or a count, recorded in the named sprint file. "Done" with no evidence counts as NOT RUN. Statuses are PASS / FAIL / BLOCKED / NOT RUN / ACCEPTED RISK.

| # | Item | Evidence required | Where | Status |
|---|---|---|---|---|
| G1 | Production has its own database | `main` ledger = committed migrations (6), schema diff vs `dev-agent` empty | SPRINT-05a R1 | PASS (2026-10-28) |
| G2 | Production reads `main` | `users` count on `main` > 0 after the owner signs in; `/api/health` ok, 6 migrations | SPRINT-05a R2 | NOT RUN (owner cutover) |
| G3 | Access boundaries verified | Access-boundary suite green in CI; security review has no open critical/high finding | SPRINT-05a R5, R8 | NOT RUN |
| G4 | Ingest performance measured | One bounded production run: p95 < 2 s (JGR hypothesis) or the miss recorded as a finding; near-limit payload (≈ 255 KiB decompressed) accepted | SPRINT-05a R6 | NOT RUN |
| G5 | End-to-end telemetry | Packed `javi` → production → rows on `main` (count) → dashboard reader shows the thread | SPRINT-05a R7 | NOT RUN |
| G6 | Real agent session | The owner's real Claude Code session with `javi init --usage`: hooks fire, usage attributed (session-id match, ADR-0011) | SPRINT-03c/03e | NOT RUN (owner) |
| G7 | Rollback plan | `docs/how-to/roll-back-a-release.md` reviewed; down files exist for every migration | SPRINT-05a R3 | PASS (docs) / real rollback NOT RUN |
| G8 | Runbooks | `docs/how-to/operate-production.md` | SPRINT-05a R4 | PASS (docs) |
| G9 | Retention purge active | `env.CRON_SECRET` true on `/api/health`; one cron run returns 200 | SPRINT-03b | BLOCKED (owner) |
| G10 | Secrets | Exposed `neondb_owner` password and GitHub client secret | Readiness matrix | ACCEPTED RISK (owner, 2026-10-28) |
| G11 | Second and third collectors | Codex and Gemini CLI collectors (S5b) with conformance tests | SPRINT-05b | NOT RUN |
| G12 | CI green on the release commit | GitHub Actions run id on the release commit | Sprint log | NOT RUN |
| G13 | Plans and terms | Free tiers. Vercel Hobby is for non-commercial use only, so a commercial beta needs paid plans | Readiness matrix (Budget) | OPEN (owner) |
| G14 | Guru G4 | `guru/WISDOM_LOG.md` G4 entry; Orcasus PR proposal written, not opened | `guru/` | NOT RUN |

## Before tagging a release

1. Run `git fetch`, then confirm the release commit is the branch head and CI is green on it (G12).
2. Every row is PASS or ACCEPTED RISK, or the owner has accepted an explicit exception, written here with the date.
3. Record the release in `docs/memory/PROJECT_MEMORY.md` and `SESSION_LOG.md`.
