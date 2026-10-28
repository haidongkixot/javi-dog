---
'@javis-dog/identity': patch
'@javis-dog/projects': minor
'@javis-dog/ingest': patch
'@javis-dog/jgr-spec': patch
'@javis-dog/web': patch
---

S5a review fixes. JD-M03: the organization plugin's HTTP endpoints (`/api/auth/organization/*`) are disabled and its limits closed (no creating, inviting, deleting or re-rolling workspaces over HTTP; ADR-0006); personal workspaces are still created on first sign-in. JD-M04: quotas — at most `MAX_PROJECTS_PER_WORKSPACE` (20) projects per workspace and `MAX_TOKENS_ISSUED_PER_PROJECT_PER_DAY` (10) ingest tokens issued per project per rolling 24 h by the database clock, revoked ones included; new error codes `project_limit` and `token_issue_limit`. JD-M05: a body nesting deeper than `MAX_JSON_DEPTH` (32) is a `400 malformed` instead of a retryable `503` (new export `exceedsJsonDepth`). JD-M01: `validateEvent` / `validateBatch` return a `schema` issue instead of throwing `RangeError` for values too deep to serialize. JD-APP: project creation and token issue/revoke are limited to workspace owners and admins (`canManageProject`), baseline security headers on every route, truthful copy for `/api/v1/events` on JGR & Integrations.
