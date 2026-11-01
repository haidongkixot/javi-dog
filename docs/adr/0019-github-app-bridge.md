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
   2. **Body size.** The raw body is bounded at 1 MiB with JD-M05 `readBoundedBody` (`413` above it).
   3. **Signature.** It is checked against the current secret, then the previous one, in constant time. Missing, malformed or wrong → `401`, without saying which. Nothing is parsed before the signature passes.
   4. **Unwanted deliveries.** Unknown events or actions, `ping`, and deliveries for unlinked repositories → `202`, and nothing is stored.
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
   - `thread_ref` is `gh_` plus 32 hex characters of SHA-256 over `pr|<repo_id>|<number>` (one thread per PR) or `run|<run_id>` (one per workflow run). These are only opaque, well-formed references: numeric ids are not secret, and this is **not** L1.
   - `event_id` is a UUIDv5 under a fixed namespace from `<delivery GUID>:<index>`, so a redelivery deduplicates.
   - `occurred_at` is GitHub's own timestamp for the change.
   - `sequence` is the action ordinal for a run thread (requested 0, in_progress 1, completed 2); for a PR thread, `updated_at` in epoch seconds.

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
  - CI and PR signals for any repository, even without agent hooks;
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
