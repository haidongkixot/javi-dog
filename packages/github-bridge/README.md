# JD-M10 · `@javis-dog/github-bridge` — GitHub App bridge

Status: **in-progress** (S5g, ADR-0019 and its design review D0). Pure functions that turn a **verified** GitHub App webhook delivery into JGR events, plus the installation and repository-link tables (composed by JD-M06, migration 0006) and their repository. No GitHub API calls, no runtime dependency beyond `node:crypto` and the workspace's own `drizzle-orm`. The webhook route itself belongs to JD-APP.

## Public contract

| Export | Description |
|---|---|
| `verifyGithubSignature(rawBody, header, secrets)` | `'ok' \| 'missing' \| 'malformed' \| 'mismatch'`. `X-Hub-Signature-256` must be `sha256=` + 64 lower-case hex; HMAC-SHA256 over the **raw bytes**, tried per secret (current, then previous); `timingSafeEqual` on equal-length buffers only; no usable secret → `mismatch` |
| `classifyDelivery(payload, headerEvent)` | `ClassifiedDelivery`: `workflow_run`, `check_suite`, `pull_request`, `installation`, `installation_repositories` or `ignored` (with an `IgnoredReason`). The kind comes from the payload shape; `X-GitHub-Event` must agree or the delivery is `ignored` (`event_mismatch`) |
| `deliveryTimestamp(kind, payload)`, `isTooOld(kind, payload, now)`, `DELIVERY_MAX_AGE_MS` | D0 H4: `workflow_run` / `check_suite` / `pull_request` `.updated_at`; older than 3 days, missing or invalid → too old; `installation*` exempt |
| `mapDelivery(classified, ctx)` | `{ ok: true, events } \| { ok: false, issues }`: JGR events per ADR-0019 §5 and D0 M1/M3/M6, each validated with JD-M01 against `ctx.receivedAt`. `installation*` and `ignored` → no events. Throws `RangeError` for a malformed context (body hash, installation mismatch) |
| `installationChange(classified)` | `InstallationChange` (`upsert` or `delete`) from a signed `installation*` delivery |
| `githubTables` (`github_installations`, `github_repositories`, `github_deliveries`) | Drizzle tables composed into the JD-M06 schema |
| `createGithubRepository(db)` | See "Repository" below |
| `deliveryEventId`, `uuidV5`, `GITHUB_EVENT_ID_NAMESPACE`, `githubProducerId`, `runThreadRef`, `suiteThreadRef`, `prThreadRef`, `sha256Hex`, `isSha256Hex` | Id and ref helpers |
| `deliveryCutoff(now)` | `now − 3 days`; JD-M06's daily `purgeEventsBefore` purges `github_deliveries` with it |

## Mapping (ADR-0019 §5, D0)

Common fields: `jgr` `0.1`, `privacy_class` `L0`, **no `status`**, `producer_id` `gh-app_<installation_id>`, `project_ref` the linked project's slug, `occurred_at` GitHub's `updated_at`, `event_id` = lower-case UUIDv5 of `<body_sha256>:<index>` under the namespace **`a12f7c76-a99e-4db8-8b03-f0b8638b36da`** (fixed; changing it breaks redelivery dedupe).

| Source | `type` | `thread_ref` key (`gh_` + 32 hex of SHA-256) | `sequence` | `attributes` |
|---|---|---|---|---|
| `workflow_run` `requested` / `in_progress` | `task.started` | `run\|<run_id>\|<run_attempt>` | 0 / 1 | `tool_name` `github-actions`, `task_kind` `ci.workflow`, `attempt` |
| `workflow_run` `completed` | by conclusion (below) | same | 2 | the same, plus `duration_ms` = `updated_at − run_started_at` |
| `check_suite` `completed` (not GitHub Actions) | by conclusion | `suite\|<check_suite.id>` | `updated_at` in seconds | `tool_name` (a `CI_APP_SLUGS` entry or `other`), `task_kind` `ci.check_suite` |
| `pull_request` `opened` / `reopened` | `x.github.pr.opened` | `pr\|<repo_id>\|<number>` | `updated_at` seconds × 8 + ordinal | `task_kind` `pr` or `pr.draft` |
| `pull_request` `synchronize` / `converted_to_draft` | `x.github.pr.updated` | same | same | same |
| `pull_request` `ready_for_review` | `x.github.pr.ready` | same | same | same |
| `pull_request` `closed` | `x.github.pr.merged` (when `merged`) or `x.github.pr.closed` | same | same | same |

Conclusions: `success`, `neutral` → `task.completed`; `failure`, `timed_out`, `startup_failure` → `task.failed`; `cancelled` → `x.github.ci.cancelled`; `skipped` → `x.github.ci.skipped`; `action_required`, `stale` → `x.github.ci.attention`. PR action ordinals: opened 0, reopened 1, synchronize 2, converted_to_draft 3, ready_for_review 4, closed 5.

## Fields read

Only these payload paths are ever read (enforced by a Proxy read recorder in `test/privacy.test.ts`): `action`; `workflow_run.{id, run_attempt, conclusion, run_started_at, updated_at}`; `check_suite.{id, conclusion, app.slug, updated_at}`; `pull_request.{number, draft, merged, updated_at}`; `installation.{id, account.id, account.type}`; `repository.{id, full_name}`; `repositories[]`, `repositories_added[]`, `repositories_removed[]` `.{id, full_name}`. Titles, bodies, labels, reviewers, logins, names, emails, commit data, branch and tag names, URLs and workflow paths are never read. `full_name` is stored only in `github_repositories`, never in events.

## Repository (`createGithubRepository(db)`)

Single statements (neon-http has no interactive transactions); workspace ids come from the caller's verified session.

| Method | Behaviour |
|---|---|
| `recordDelivery(bodySha256, receivedAt?)` | Insert-if-absent; `true` new, `false` repeat (D0 H2) |
| `forgetDelivery(bodySha256)` | Removes a recorded hash, for a route whose processing failed after recording it (so GitHub's manual redelivery is processed) |
| `purgeDeliveriesBefore(cutoff)` | Deletes older hashes; returns the count |
| `applyInstallationChange(change, at?)` | Ordered, idempotent: installation upsert (account fields set once) → suspend/unsuspend → repository upserts (a repository that moved installation loses its link) → removals (only while still under this installation). `delete` cascades to repositories |
| `refreshRepositoryName(installationId, repo)` | Refreshes `full_name` from a signed run/suite/PR delivery, same installation only |
| `claimInstallation({ workspaceId, installationId, githubAccountId })` | `claimed` · `already_yours` · `claimed_elsewhere` · `not_found` · `organization` · `account_mismatch`. First claim wins; `User` installations whose `account_id` equals the signed-in GitHub id only. Role checks stay with the caller |
| `releaseInstallation(workspaceId, installationId)` | Clears the claim and its links in one statement |
| `linkRepository({ workspaceId, repoId, projectId, userId })` | `linked` · `not_found` · `linked_elsewhere` (one project per repository) |
| `unlinkRepository(workspaceId, repoId)` | Clears this workspace's link |
| `routeTarget(installationId, repoId)` | `{ workspaceId, projectId, projectSlug }` only for a linked repository of that installation, claimed, unsuspended, same workspace; else `null` |
| `touchVerifiedDelivery(installationId, at)` | Forward-only `last_verified_delivery_at`, capped by the database clock |
| `workspaceInstallations(workspaceId)`, `claimableInstallations(githubAccountId)` | Reads for the project page and the claim prompt |

## Schema (migration 0006)

- `github_installations`: `installation_id` PK, `account_id`, `account_type` (`User`/`Organization`), `claimed_workspace_id` → `workspaces` `ON DELETE SET NULL`, `suspended_at`, `last_verified_delivery_at`, timestamps; `UNIQUE (installation_id, claimed_workspace_id)`.
- `github_repositories`: `repo_id` PK, `installation_id` → installations `ON DELETE CASCADE`, `full_name`, `workspace_id`, `project_id`, `linked_at`, `linked_by`, timestamps. `(project_id, workspace_id)` → `projects(id, workspace_id)` `ON DELETE SET NULL` (clears both columns); `(installation_id, workspace_id)` → `github_installations(installation_id, claimed_workspace_id)`; check: `project_id` and `workspace_id` are both null or both set.
- `github_deliveries`: `body_sha256` PK (64 lower-case hex), `received_at`; purged after 3 days.

Database tests live in `packages/event-store/test/github.test.ts` and `migrations.test.ts` (same pattern as JD-M12).
