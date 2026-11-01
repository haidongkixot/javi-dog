# JD-M10 · `@javis-dog/github-bridge` — GitHub App bridge

Status: **in-progress** (S5g, ADR-0019 and its design review D0). Pure functions that turn a **verified** GitHub App webhook delivery into JGR events, plus the installation and repository-link tables (composed by JD-M06, migration 0006) and their repository. No GitHub API calls, no runtime dependency beyond `node:crypto` and the workspace's own `drizzle-orm`. The webhook handler lives here, framework-free; JD-APP mounts it as the route.

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
| `deliveryCutoff(now)`, `deliveryHashKind(kind)`, `DeliveryHashKind` | `now − 3 days`, JD-M06's daily `purgeEventsBefore` purges **activity** delivery hashes with it; the retention class of a delivery's hash |
| `UUID_NAMESPACE_URL` | RFC 9562 `NAMESPACE_URL`, the parent of `GITHUB_EVENT_ID_NAMESPACE` |
| `createGithubWebhookHandler(deps)` and its types (`GithubWebhookDeps`, `GithubWebhookStore`, `GithubWebhookSecrets`, `GithubWebhookLogEntry`, `GithubWebhookOutcome`, `GithubEventRow`, `GithubWebhookHandler`), `consoleGithubWebhookLog`, `githubWebhookNotConfigured()` | The webhook handler; see "Webhook handler" below |
| `readRawBody(request, maxBytes)`, `WEBHOOK_MAX_BODY_BYTES` | Bounded raw-byte body reader (1 MiB); `{ ok: true, bytes } \| { ok: false, reason: 'too_large' \| 'unreadable' }` |

## Webhook handler (`createGithubWebhookHandler`)

`createGithubWebhookHandler(deps: GithubWebhookDeps)` returns `GithubWebhookHandler` = `(request: Request) => Promise<Response>`: the whole `POST /api/github/webhook` behaviour, framework-free. JD-APP mounts it (`apps/web/src/lib/github-webhook.ts`, `apps/web/src/app/api/github/webhook/route.ts`). JD-M10 cannot import JD-M06 or JD-M05 (JD-M06 composes this module's tables), so the event store is injected. A conformance runner drives this export directly.

| `GithubWebhookDeps` field | Real wiring (JD-APP) | Notes |
|---|---|---|
| `secrets: { current?, previous? }` | `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` | Read per request through `githubWebhookSecretsState` (review L-1): unset or whitespace-only is absent (a blank `previous` is ignored); no usable `current` → 503, even with `previous` set (G13); leading or trailing whitespace on either secret → 503, logged as `misconfigured_secret` (never the value) |
| `store: GithubWebhookStore` | `createGithubRepository(db)` | `Pick` of `hasDelivery`, `recordDelivery`, `applyInstallationDelivery`, `refreshRepositoryName`, `routeTarget`, `touchVerifiedDelivery` |
| `insertEvents(rows: GithubEventRow[])` | JD-M06 `createEventRepository(db).insertEvents` | `GithubEventRow` is structurally a JD-M06 `NewEvent` (L0, `status` and `agent_ref` null) |
| `touchSignal(scope, at)` | JD-M06 `touchSignal` | For the linked project (D0 M1) |
| `readBody?(request, maxBytes)` | default `readRawBody` | Raw bytes, never decoded (D0 L1). JD-M05 `readBoundedBody` decodes UTF-8 (drops a BOM, fails before the signature is known), so it is not used |
| `now?()` | default `new Date()` | Inject to pin the clock (3-day rule, JD-M01 skew check, receipt time) |
| `log?(entry: GithubWebhookLogEntry)` | default `consoleGithubWebhookLog` | One entry per request: `level`, `module`, `msg`, `status`, `outcome` and, when known, `delivery` (GUID, only after verification, only GUID-shaped, lower case), `event` (classified kind, or `ping`/known kinds from the header of an ignored delivery), `action` (classified action) |

Checks, in this order (ADR-0019 §3 with D0 L1/H2/H3/H4 and gaps G3, G13, G14, G18–G23):

| # | Check | Answer |
|---|---|---|
| 1 | No usable current secret, or a whitespace-padded current/previous secret (`githubWebhookSecretsState`) | `503 { error: "not_configured" }` |
| 2 | `Content-Encoding` present and not `identity` (case-insensitive), before the body is read | `415 { error: "unsupported_media_type" }` |
| 3 | `X-Hub-Signature-256` missing or not `^sha256=[0-9a-f]{64}$`, before the body is read | `401 { error: "unauthorized" }` |
| 4 | Raw body over 1 048 576 bytes (`WEBHOOK_MAX_BODY_BYTES`; a declared larger `Content-Length` is refused unread); an aborted stream | `413 { error: "too_large" }`; `400 { error: "unreadable" }` |
| 5 | HMAC-SHA256 over the raw bytes, current then previous secret, `timingSafeEqual` on 32-byte buffers | `401`, byte-identical to check 3 |
| 6 | Body SHA-256 already in `github_deliveries` | `202 duplicate` |
| 7 | Not UTF-8 (fatal decoding; a BOM is kept and refused) or not JSON | `202 not_json` (G18) |
| 8 | `classifyDelivery`: no or ambiguous shape, `X-GitHub-Event` missing or disagreeing, unmapped action, no `installation`, GitHub Actions' own suite, `null` or unknown conclusion (G22) | `202 ignored:<reason>` |
| 9 | `installation` / `installation_repositories`: `applyInstallationDelivery` (exempt from the 3-day rule); `new_permissions_accepted` changes nothing | `200 applied` / `202 duplicate`; `202 ignored:action` |
| 10 | Run, suite, PR: per-event `updated_at` more than 3 days old | `202 too_old` |
| 11 | `refreshRepositoryName` (G20), then `routeTarget` (same installation, claimed, unsuspended, linked) | `202 unrouted` |
| 12 | `mapDelivery` with JD-M01 validation at `now` (e.g. more than 5 min in the future, G21) | `202 rejected`, nothing stored, **no hash** |
| 13 | `insertEvents` → `touchSignal` + `touchVerifiedDelivery` → `recordDelivery(sha, 'activity')` **last** (G14) | `200 stored` |

Every `202` except `rejected` records the body hash (`installation` class for `installation*` bodies, kept for good; `activity` otherwise, purged after 3 days). Any store failure answers `500 { error: "unavailable" }` before the hash is recorded, so GitHub's manual redelivery is processed (activity events also dedupe on their body-derived `event_id`). `200`/`202` bodies are `{ ok: true, outcome }`; no response echoes request data; every response is `Cache-Control: no-store`. `githubWebhookNotConfigured()` is the same `503` for a host without a database.

## Mapping (ADR-0019 §5, D0)

Common fields: `jgr` `0.1`, `privacy_class` `L0`, **no `status`**, `producer_id` `gh-app_<installation_id>`, `project_ref` the linked project's slug, `occurred_at` GitHub's `updated_at`, `event_id` = lower-case UUIDv5 of `<body_sha256>:<index>` under the namespace **`fbb354ba-6443-5e61-8995-5f0d8fb04b91`** = UUIDv5(NAMESPACE_URL `6ba7b811-9dad-11d1-80b4-00c04fd430c8`, `https://javisdog.vercel.app/api/github/webhook`) (fixed; changing it breaks redelivery dedupe).

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

**Delivery-hash order for the webhook route (D0 H2, QA G14):** `hasDelivery` first (a known body → `202`, nothing changes); then process (events inserted, or the installation change applied); then `recordDelivery` **last**. A failure in between answers `500` with nothing recorded, so GitHub's manual redelivery is processed. Activity redeliveries also dedupe on their body-derived `event_id`; installation changes are idempotent. `applyInstallationDelivery` does all three for `installation*` deliveries.

| Method | Behaviour |
|---|---|
| `hasDelivery(bodySha256)` | `true` when this body was already processed |
| `recordDelivery(bodySha256, kind, receivedAt?)` | Insert-if-absent after processing; `true` new, `false` repeat. `kind` (`DeliveryHashKind`, from `deliveryHashKind(kind)`): `activity` (runs, suites, PRs) or `installation` (`installation*`) |
| `purgeDeliveriesBefore(cutoff)` | Deletes **activity** hashes older than `cutoff`; installation hashes are never purged. Returns the count |
| `applyInstallationDelivery(change, bodySha256, at?)` | `'duplicate'` for a known body; else applies the change, then records the hash as `installation` → `'applied'`. A failing change throws with nothing recorded |
| `applyInstallationChange(change, at?)` | Ordered, idempotent: installation upsert (account fields set once) → suspend/unsuspend → repository upserts (a repository that moved installation loses its link) → removals (only while still under this installation). `delete` cascades to repositories |
| `refreshRepositoryName(installationId, repo)` | Refreshes `full_name` from a signed run/suite/PR delivery, same installation only |
| `claimInstallation({ workspaceId, installationId, githubAccountId })` | `claimed` · `already_yours` · `claimed_elsewhere` · `organization` · `account_mismatch`. The account is checked **first**: unknown, foreign and malformed ids all return `account_mismatch`, so ids cannot be enumerated (review L-2). First claim wins (a concurrent loser gets `claimed_elsewhere`); `User` installations whose `account_id` equals the signed-in GitHub id only. Role checks stay with the caller |
| `releaseInstallation(workspaceId, installationId)` | Clears the claim, its links and `last_verified_delivery_at` in one statement (review L-3) |
| `linkRepository({ workspaceId, repoId, projectId, userId })` | `linked` · `not_found` · `linked_elsewhere` (one project per repository; the UPDATE re-checks the row's own `project_id`, so a concurrent second link cannot overwrite the first, review L-5) |
| `unlinkRepository(workspaceId, repoId)` | Clears this workspace's link |
| `routeTarget(installationId, repoId)` | `{ workspaceId, projectId, projectSlug }` only for a linked repository of that installation, claimed, unsuspended, same workspace; else `null` |
| `touchVerifiedDelivery(installationId, at)` | Forward-only `last_verified_delivery_at`, capped by the database clock |
| `workspaceInstallations(workspaceId)`, `claimableInstallations(githubAccountId)` | Reads for the project page and the claim prompt |

## Schema (migration 0006)

- `github_installations`: `installation_id` PK, `account_id`, `account_type` (`User`/`Organization`), `claimed_workspace_id` → `workspaces` `ON DELETE SET NULL`, `suspended_at`, `last_verified_delivery_at`, timestamps; `UNIQUE (installation_id, claimed_workspace_id)`.
- `github_repositories`: `repo_id` PK, `installation_id` → installations `ON DELETE CASCADE`, `full_name`, `workspace_id`, `project_id`, `linked_at`, `linked_by`, timestamps. `(project_id, workspace_id)` → `projects(id, workspace_id)` `ON DELETE SET NULL` (clears both columns); `(installation_id, workspace_id)` → `github_installations(installation_id, claimed_workspace_id)`; check: `project_id` and `workspace_id` are both null or both set.
- `github_deliveries`: `body_sha256` PK (64 lower-case hex), `kind` (`activity` default, or `installation`), `received_at`; partial index on `received_at` for activity rows. Activity hashes are purged after 3 days (older bodies fail the 3-day rule anyway). Installation hashes are **kept for good**, because `installation*` bodies are exempt from the 3-day rule: a captured `removed`, `suspend` or `created` body can never be replayed. They are not deleted with their installation either, or an old `created` body could bring it back. They are tiny and rare.

Database tests live in `packages/event-store/test/github.test.ts` and `migrations.test.ts` (same pattern as JD-M12). The handler is unit-tested here against an in-memory store (`test/webhook.test.ts`; this package cannot depend on JD-M06's migrations or PGlite) and end to end on PGlite with every migration in `apps/web/test/github-webhook-route.test.ts`.
