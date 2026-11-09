# ADR-0019: GitHub App bridge for PR and CI signals (JD-M10)

- Status: **Accepted** 2026-11-01. Owner answers:
  - "JD-M10 prep";
  - "PRs + CI only";
  - "Owner link + L1/L2 warning";
  - "Local helper";
  - "Yes, apply 0006".
- Date: 2026-11-01
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules:
  - JD-M10 (new, `@javis-dog/github-bridge`, `packages/github-bridge`);
  - JD-M06 (migration 0006);
  - JD-APP (webhook route, link UI, Integrations status);
  - JD-M07 (source label);
  - consumes JD-M01.

## Context and problem statement

Coding tools without hooks (hosted builders, plain git workflows) send Javi's Dog nothing. Pull requests and CI results are the next-best signal (FEASIBILITY row 3, "GitHub App fallback"). They are also how sessions will later be tied to outcomes (row 8). Readiness item B6 has waited for a manifest-based GitHub App since S0.

### Research (2026-11-01)

docs.github.com is blocked from the sandbox, so these sources were read instead:

- `github/docs` content at raw.githubusercontent.com;
- GitHub's REST OpenAPI description (`github/rest-api-description`);
- Probot's manifest flow;
- the Next.js 16.4.2 docs bundled in `node_modules`.

The orchestrator re-checked two facts:

- GitHub's documented signature test vector reproduces with `node:crypto` (`757107ea…3e17`);
- the OpenAPI text says a branch or tag event "a GitHub App must have at least read-level access for the "Contents" repository permission".

| Fact | Evidence |
|---|---|
| A manifest is POSTed to `github.com/settings/apps/new?state=…`. GitHub redirects back with `code`, and `POST /app-manifests/{code}/conversions` returns `id, slug, client_id, client_secret, webhook_secret, pem`. All within one hour; the code is the credential. | `github/docs` "registering a GitHub App from a manifest"; OpenAPI |
| Events need permissions: `pull_request` needs Pull requests read; `check_suite` needs Checks read (read gets `completed`); `workflow_run` needs Actions read; `push` needs Contents read. Without the permission the event is not offered. `installation*` events are always delivered. | OpenAPI webhook summaries |
| The signature is `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`, compared in constant time. `X-GitHub-Delivery` is a GUID that a redelivery keeps. There is no timestamp header. GitHub expects a reply within 10 s, does not redeliver automatically (manual redelivery up to 3 days), and caps payloads at 25 MB. | `github/docs` webhook pages |
| `push` payloads carry commit messages, author/committer/pusher emails and file lists; PR and run payloads carry titles, bodies and logins. | OpenAPI schemas |
| A Route Handler gets the raw body with `request.text()`, and `after()` work is not retried. | Next 16.4.2 docs |

## Decision outcome

1. **PRs and CI only** (owner).
   - Manifest permissions: `metadata: read`, `pull_requests: read`, `checks: read`, `actions: read`. **No `contents`**, so the app cannot read code.
   - Events: `pull_request`, `check_suite`, `workflow_run`, plus the always-on `installation` and `installation_repositories`.
   - `push` (Contents read) needs a later ADR.
2. **Webhooks only, no GitHub API calls.**
   - The runtime needs only `GITHUB_APP_WEBHOOK_SECRET`, plus an optional `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` for rotation. No private key, client secret or JWT is ever deployed.
   - `GITHUB_APP_ID` and `GITHUB_APP_SLUG` are public identifiers, used for the install link.
   - The existing `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` belong to sign-in (B3) and are not reused.
3. **Webhook route `POST /api/github/webhook`** (Node runtime, dynamic). Checks run in this order:
   1. **Configuration.** Without a configured secret: `503 not_configured`, with no claim of being connected.
   2. **Body size.** The raw body is bounded at 1 MiB with JD-M05 `readBoundedBody` (`413` above it). *(Superseded: the bridge's own `readRawBody` reads raw bytes; see Changes, wave 2.)*
   3. **Signature.** It is checked against the current secret, then the previous one, in constant time. Missing, malformed or wrong → `401`, without saying which. Nothing is parsed before the signature passes.
   4. **Unwanted deliveries.** Unknown events or actions, `ping`, and deliveries for unlinked repositories → `202`, and nothing is stored. *(Superseded by D0 H2 and Y11: no event is stored, but the body hash is recorded; see Changes, review M-1.)*
   5. **Old deliveries.** A delivery whose source timestamp is more than 3 days old is acknowledged and dropped (GitHub's redelivery window). This bounds replay of a captured body.
   6. **Inline handling.** Mapping, JD-M01 validation and the insert through JD-M06 all happen inline, inside GitHub's 10 s.
   7. **Failures.** A database failure → `500`, so the delivery shows as failed and can be redelivered.
   8. **Logs** carry only the delivery GUID, event, action and outcome. Never headers or bodies.
4. **Installations and links (migration 0006, additive; owner-approved).**
   - **Tables:**
     - `github_installations`: `installation_id` (PK), `account_id` (GitHub numeric id), `account_type` (`User`/`Organization`), `claimed_workspace_id` (nullable FK), `suspended_at`, timestamps.
     - `github_repositories`: `repo_id` (PK), `installation_id` (FK), `full_name`, `project_id` (nullable FK, with a composite workspace check as in migration 0005), `linked_at`, `linked_by`.
   - **Where they are filled from:** only signed `installation` / `installation_repositories` deliveries. A removed repository or a deleted installation deletes its rows, and links go with them. `full_name` is refreshed from every signed delivery.
   - **Who can claim an installation:** a workspace owner or admin, and only when the signed-in user's GitHub account id (Better Auth `accounts`, provider `github`) equals the installation's `account_id` from the signed webhook. The claim is verifiable without any API call. GitHub's `setup_url` `installation_id` parameter can be spoofed, so it is only a hint.
   - **Organization installations** cannot be verified without API calls and are refused with a clear message (follow-up).
   - **Linking:** an owner or admin links a repository of a claimed installation to a project of the same workspace. One project per repository.
   - **L1/L2 projects:** the link UI warns that Javi's Dog will then know the repository's name, which L1/L2 otherwise hide (ADR-0018), and asks for confirmation (owner decision).
   - **Where `full_name` lives:** only in `github_repositories`, to show "linked to owner/repo" to members of that workspace. It never appears in events.
5. **JGR mapping** (pure functions in JD-M10). The common fields:
   - `producer_id` is `gh-app_<installation_id>`, and `project_ref` is the linked project's slug.
   - `thread_ref` is `gh_` plus 32 hex characters of SHA-256 over `pr|<repo_id>|<number>` (one thread per PR) or `run|<run_id>` (one per workflow run). These are only opaque, well-formed references: numeric ids are not secret, and this is **not** L1. *(Superseded by D0 M3: run threads are `run|<run_id>|<run_attempt>`, check suites `suite|<id>`.)*
   - `event_id` is a UUIDv5 under a fixed namespace from `<delivery GUID>:<index>`, so a redelivery deduplicates. *(Superseded by D0 H2 and G1: the name is `<body_sha256>:<index>` under namespace `fbb354ba-…`.)*
   - `occurred_at` is GitHub's own timestamp for the change.
   - `sequence` is the action ordinal for a run thread (requested 0, in_progress 1, completed 2); for a PR thread, `updated_at` in epoch seconds. *(Superseded by D0 M3, G4 and G5: PR sequence = `updated_at` × 8 + action ordinal; check suites use `updated_at`.)*

   | Source | JGR |
   |---|---|
   | `workflow_run` `requested` / `in_progress` | `task.started`, `tool_name: "github-actions"`, `task_kind: "ci.workflow"`, `attempt` = `run_attempt` |
   | `workflow_run` `completed` | `task.completed` for success; `task.failed` for failure, timed_out or startup_failure. Cancelled or skipped → `task.completed` with `error_code: "ci.cancelled"` / `"ci.skipped"`. `duration_ms` = `updated_at − run_started_at`. |
   | `check_suite` `completed`, other than GitHub Actions' own | `task.completed` / `task.failed`; `tool_name` from a fixed list of CI app slugs, otherwise `"other"`; `task_kind: "ci.check_suite"` |
   | `pull_request` opened / reopened / ready_for_review / synchronize / closed | `x.github.pr.opened`, `.updated`, `.ready`, `.merged` (when `merged`), `.closed`, with `task_kind` `pr` or `pr.draft` |

   **Never stored:**
   - commit messages and `head_commit`;
   - `display_title`, PR titles and bodies;
   - labels and reviewers;
   - any login, name or email;
   - file lists, URLs and workflow paths;
   - **branch and tag names**.

   A server-side hash of a branch name would be either guessable or not L1 (ADR-0018). Mapping a session to its PR therefore happens in the browser later, which is an open design question.
6. **Status from GitHub** (JD-M07, JD-APP).
   - Threads whose `producer_id` starts with `gh-app_` are labelled with their source ("GitHub CI", "GitHub PR") wherever an agent thread could be shown. They are never presented as agents.
   - Their freshness follows the existing rules.
   - GitHub events never set an agent's status or clear a self-report.
7. **Owner setup with a local helper** (owner): `node scripts/github-app-create.mjs`, run on the owner's machine, never in the cloud session.
   - **What it does:**
     - serves the manifest form on `localhost`, with a random `state`;
     - sends the browser to GitHub's "Create GitHub App" page with every value pre-filled: `url` `https://javisdog.vercel.app`, `hook_attributes.url` `…/api/github/webhook`, `setup_url` `…/integrations/github`, `public: false`, `request_oauth_on_install: false`, and the permissions and events of decision 1;
     - checks `state` on the localhost callback and exchanges the code;
     - writes the result to a 0600 file outside the repository.
   - **What it prints:** only the app slug and id, and the next steps. It never prints secrets.
   - **The owner then:**
     1. puts `GITHUB_APP_WEBHOOK_SECRET` (Sensitive), `GITHUB_APP_ID` and `GITHUB_APP_SLUG` into Vercel Production and redeploys;
     2. keeps the `pem` and `client_secret` offline or deletes them (they can be regenerated);
     3. installs the app on selected repositories;
     4. claims the installation and links a repository on the project page.
8. **Honest labels.**
   - The Integrations page shows **"GitHub: not set up"** until the secret is configured, **"Waiting for the first delivery"** until a signed delivery has been stored, and **"Connected"** only with the time of the last verified delivery.
   - It never shows "secure" or "live" without that evidence (CLAUDE.md §3).

## Consequences

- Good:
  - CI and PR signals for the owner's repositories, even without agent hooks (owner-only MVP, design review D0 H1);
  - no code access, no runtime private key, no API rate limits, no new runtime dependency.
- Bad:
  - **Organization installations wait** for a verified claim path.
  - **No branch-level view on the server.** Session↔PR linking needs a browser-side design.
  - **No automatic redelivery.** A webhook outage loses signals unless redelivered within 3 days (stated in the runbook).
  - **Linking an L1/L2 project reveals the repository name** to Javi's Dog (warned and confirmed).
- Neutral: one new table pair. The code works one migration behind, so instant rollback stays safe.

## Verification (TEST_PLAN §S5g)

- **QA conformance vectors from this ADR:** signature, routing, mapping and the never-stored rules, with sentinel strings planted in every forbidden field.
- **A runner** for those vectors.
- **Route tests on PGlite:** signatures, the 1 MiB cap, 503/401/202/200/500.
- **Claim and link tests:** the role matrix, the GitHub-id rule, organization refusal.
- **Migration tests:** up, down and ledger.
- **A test of the local helper** against a stub GitHub, checking that no secret appears in its output.
- **Real proof is an owner step:** one real delivery, shown as 200 in the app's "Recent Deliveries", plus a stored event. NOT RUN until then.

## Changes

- 2026-11-01 — Created (S5g discovery, research and owner decisions).
- 2026-11-01 — Design review D0, before any code: 4 High, 6 Medium, 5 Low. The orchestrator verified H1 (GitHub docs: a private app "can only be installed on the account that created it") and H2 (the dedupe key is `(project, producer, event_id)`, `event-store/src/events.ts:50`, and the delivery GUID header is unsigned). The rules below are **binding** and supersede the decisions above where they differ.

  - **H1 Scope.**
    - The MVP covers the app owner's own GitHub account only (`public: false`).
    - The Integrations page and project page say this plainly to every other user: "available only to this deployment's owner". No install link is shown that cannot work.
    - Any move to `public: true` needs its own ADR, covering purging unclaimed installations after N days, storing `full_name` only for claimed installations, and abuse limits.
  - **H2 Replay and dedupe, signed content only.**
    - Every verified delivery's raw-body SHA-256 goes into `github_deliveries(body_sha256 PK, received_at)`, purged after 3 days. A repeated body is acknowledged (`202`) and dropped. GitHub's own redeliveries have identical bodies, so they deduplicate too.
    - `event_id` is a lower-case UUIDv5 (version nibble 5) from `<body_sha256>:<index>`.
    - The event kind comes from a strict check of the payload's shape. `X-GitHub-Event` is only a hint and must agree, otherwise the delivery is ignored (`202`).
    - The delivery GUID is used only in logs, only after verification, and only if it looks like a GUID.
  - **H3 Schema and routing.** `github_repositories` gains `workspace_id`, with these constraints:
    - FK `(project_id, workspace_id) → projects(id, workspace_id) ON DELETE SET NULL (project_id)`;
    - FK `(installation_id, workspace_id) → github_installations(installation_id, claimed_workspace_id)`, backed by a matching UNIQUE;
    - `claimed_workspace_id … ON DELETE SET NULL`.

    The lifecycle rules:
    - An upsert that changes a repository's `installation_id` clears its link.
    - Routing requires the payload's `installation.id` to equal the row's `installation_id`, the installation to be unsuspended, and the claimed workspace to be the project's workspace.
    - A missing `installation` in a `workflow_run` or `check_suite` payload → `202` and drop.
    - Deleting a project, workspace or claim clears the link and never deletes the repository row.
  - **H4 The 3-day rule, per event.** The timestamps are `workflow_run.updated_at`, `check_suite.updated_at` and `pull_request.updated_at`. `installation*` events are exempt: they carry no event time, and H2 protects them.
  - **M1 GitHub threads on the dashboard.**
    - GitHub `task.*` and `x.github.*` events carry **no `status`**.
    - A thread whose last event is terminal (run completed, PR merged or closed) counts as `ended`.
    - `ThreadState` gains `source: 'agent' | 'github'` (changeset).
    - GitHub threads are left out of the squad, the "agents working" count and agent-task counters, and have their own CI and PR counts.
    - Cancelled and skipped runs map to `x.github.ci.cancelled` / `x.github.ci.skipped`, not to `task.completed`.
    - The bridge calls `touchSignal` for the linked project.
  - **M2 Reserved provenance.** Ingest (`/api/v1/events`) rejects any `producer_id` starting `gh-app_` and any `thread_ref` starting `gh_`. Only the bridge writes them, and the "GitHub" label comes only from those prefixes.
  - **M3 Strictly increasing sequences (JGR-R06).**
    - Run threads are `run|<run_id>|<run_attempt>`, sequence = the action ordinal.
    - Check-suite threads are `suite|<check_suite.id>`.
    - PR sequence = `updated_at` in seconds × 8 + the action ordinal.
  - **M4 Evidence for "Connected".** `github_installations.last_verified_delivery_at` is shown only to the claiming workspace. The Integrations copy loses "Commits" (push is out of scope).
  - **M5 Claim lifecycle.**
    - A claim is `UPDATE … WHERE claimed_workspace_id IS NULL` and the first claim wins.
    - Owners can release a claim, which clears its links; re-claiming follows the same rule.
    - Unlinking the GitHub account does not drop existing claims. The page shows that the claim can no longer be re-verified.
    - Today a workspace has only its owner (`membershipLimit: 1`), so the "admin" rows are tested at the logic level only.
  - **M6 Mapping gaps.**
    - `neutral` → `task.completed`.
    - `action_required` and `stale` → `x.github.ci.attention`, with no status.
    - `converted_to_draft` → `x.github.pr.updated`.
  - **L1 Body handling.** Before the body is read, any `Content-Encoding` other than identity is refused (`415`), as is a signature header that is not `sha256=` plus 64 hex characters (`401`). The HMAC covers the **raw bytes**, never decoded text. The decoded signature is length-checked before `timingSafeEqual`. A Vercel Firewall rate rule on this path is recommended for the owner.
  - **L2 Privacy.** The sentinel tests also cover installation payloads (`contact_email`, `suspended_by`, `requester`, `sender`). The how-to recommends "Only select repositories".
  - **L3 Local helper.**
    - The manifest lists `redirect_url` explicitly.
    - The helper binds to 127.0.0.1, checks the Host header, uses `state` once, and exits after the callback.
    - On Windows it writes under the user profile and warns that file modes do not apply.
  - **L4 Runbook.** If the first `installation` delivery is lost and not redelivered within 3 days, uninstall and reinstall.
  - **L5 Secret rotation.** `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` must be removed once the rotation is done.
- 2026-11-01 — QA spec gaps (vectors in `docs/jgr/conformance/github/`, 2 756 independent checks). These rules are binding:

  | Gap | Rule |
  |---|---|
  | G1 | The event-id namespace is `fbb354ba-6443-5e61-8995-5f0d8fb04b91` = UUIDv5(NAMESPACE_URL, `https://javisdog.vercel.app/api/github/webhook`). The name is `<64 lower-case hex>:<index from 0>`. |
  | G2 | `occurred_at` is the same per-event `updated_at` the 3-day rule uses. |
  | G3 | 200 when a delivery is handled (an event stored or an installation change applied); 202 whenever it is acknowledged and dropped. |
  | G4 | The check-suite sequence is `check_suite.updated_at` in epoch seconds. |
  | G5 | PR action ordinals: opened 0, reopened 1, synchronize 2, converted_to_draft 3, ready_for_review 4, closed 5. |
  | G6 | `reopened` → `x.github.pr.opened`. |
  | G7 | `check_suite` uses the `workflow_run` conclusion table; the attributes are `tool_name` and `task_kind` only. |
  | G8 | `error_code` is absent on success, otherwise absent or `ci.<conclusion>`. |
  | G9 | The CI app slug list is the implementation's documented list; the owner confirms it. An unknown slug → `other`. |
  | G10–G12 | Strict shape: exactly one kind must match; the signature header is `^sha256=[0-9a-f]{64}$`; a missing `X-GitHub-Event` counts as disagreeing (→ 202). |
  | G13 | With only the previous secret set: 503. |
  | G14 | The body hash is recorded only after successful processing. A 500 leaves no hash, so GitHub's redelivery is processed; activity events also deduplicate by their body-derived `event_id`. |
  | G15 | GitHub events carry no `agent_ref`, and their attribute set is closed. |
  | G16 | `installation created` inserts its `repositories[]` as unlinked rows. |
  | G17 | Hashes of `installation*` deliveries are never purged (a replay after 3 days would otherwise act again); only `activity` hashes are purged after 3 days. |
  | G20 | `full_name` is refreshed from any signed delivery that carries `repository.full_name` for a known repository. |
  | G23 | A missing `installation` in any activity payload → 202. |

  Still open, with no vector: G18 (a valid signature over a body that is not JSON or not UTF-8 → 202 and dropped); G19 (check order: encoding 415 before a malformed-header 401; `identity` matched case-insensitively); G21 (an event time more than 5 minutes in the future → validation rejects it and nothing is stored); G22 (a null or unknown `conclusion` → 202 and dropped). These rules are adopted here, and the route tests cover them.
- 2026-11-01 — Orchestrator decision for D0 H1 ("no install link is shown that cannot work"): a new **public** env `GITHUB_APP_OWNER_ID`, the numeric GitHub account id that owns the private app. The local helper prints it from the manifest conversion's `owner.id`. The install link appears only to a signed-in viewer whose linked GitHub account id equals it; everyone else reads "available only to this deployment's owner". It is an identifier, not a secret, and grants nothing: claims still need the signed installation's `account_id`.
- 2026-11-01 — Webhook lane (Developer B) and orchestrator, S5g wave 2:
  - **G24** (QA vector M12): a `check_suite` whose `app` has no string `slug` is an unknown app → `tool_name` `other`, not a malformed delivery. `classify.ts` changed accordingly.
  - **Raw body reader.** Decision 3.2 named JD-M05 `readBoundedBody`, but it returns decoded text (drops a BOM, fails on non-UTF-8 before the signature is known), which conflicts with L1. The bridge has its own `readRawBody` (bytes, 1 MiB, a declared `Content-Length` above the cap refused unread). An aborted request stream → `400 unreadable` (no rule existed).
  - **G21 and the hash.** A mapped event that JD-M01 rejects (e.g. more than 5 minutes in the future) → `202 rejected`, nothing stored and **no hash recorded**; every other `202` records the hash. The signed body cannot change, so a later redelivery is judged again on its own time.
  - **GitHub Actions' own suites** are dropped by classification before the repository is read, so they do not refresh `full_name` (G20 still holds for every routed kind).
  - **Health.** `/api/health` reports `GITHUB_APP_WEBHOOK_SECRET` presence as a boolean, like the other names.
- 2026-11-01 — Wave-2 adversarial review (0 High, 2 Medium, 6 Low), fixed before release:
  - **M-1.** A delivery that arrives before the claim or link is acknowledged (`202 unrouted`) and its hash is recorded (H2 and Y11 unchanged). Redelivering it after linking stores nothing, so the runbook now says: after linking, trigger a new event. Redelivery helps only after a `500` or a lost delivery.
  - **M-2.** "Connected" uses the newest verified delivery of **unsuspended** installations only. Older than 7 days → "No verified delivery since <time>" (warn). The project card says "Connected" only when a repository is linked to that project.
  - **L-1.** One secret rule (`githubWebhookSecretsState`) for the handler, the setup status and `/api/health`: unset or whitespace-only is absent; leading or trailing whitespace on either secret → `503`, logged as `misconfigured_secret`.
  - **L-2.** `claimInstallation` checks the account first; unknown and foreign ids get one generic answer. Organization installations are explained as not supported yet.
  - **L-3.** Releasing a claim clears `last_verified_delivery_at`.
  - **L-5.** A concurrent second link to another project cannot overwrite the first.
  - **Follow-ups, not fixed:** L-4 (a late delivery can briefly restore an old `full_name`, display only); L-6 (a run whose `completed` delivery was lost counts as running for 24 h; an L0 → L1/L2 class change keeps an existing link without a warning).
- 2026-11-09 — S5h decisions (follow-ups L-6 from the wave-2 review):
  - **No result received.** A CI thread whose newest event is `task.started` and whose last signal is more than 6 hours old is counted as `ciNoResult`, not as running, and reads "No result received". GitHub-hosted jobs stop at 6 hours; a longer run on a self-hosted runner reads the same until its result arrives, which is still a true statement.
  - **Class change with a linked repository.** Raising a project to L1 or L2 while a repository is linked needs an explicit confirmation on the server, like the link itself (decision 4). The GitHub card on such a project says the repository name stays known to Javi's Dog until the repository is unlinked. Lowering a class never asks.
  - L-4 stays open (a late delivery can briefly restore an old `full_name`; display only, needs a migration).
