---
'@javis-dog/github-bridge': minor
---

S5g adversarial review fixes (ADR-0019, review L-1, L-2, L-3, L-5):

- **Webhook secrets (L-1).** A secret that is unset or whitespace only is absent (a blank `previous` is ignored). A secret with leading or trailing whitespace, current or previous, is a configuration error: `503 { error: "not_configured" }`, logged with the new outcome `misconfigured_secret` (never the value). `githubWebhookSecretsState(secrets)` → `'configured' | 'not_configured' | 'misconfigured_secret'` holds the rule in `webhook.ts` (not yet re-exported from the index).
- **`claimInstallation` (L-2, breaking).** The account is checked first. An installation the claimer's GitHub account does not own, an unknown id and malformed input all answer `account_mismatch`, so ids cannot be enumerated; `ClaimResult` loses `not_found`. `already_yours`, `claimed_elsewhere` and `organization` now describe only the claimer's own installations.
- **`releaseInstallation` (L-3)** also clears `last_verified_delivery_at`, so a re-claim starts at "Waiting for the first delivery".
- **`linkRepository` (L-5)** re-checks the row's own `project_id` in the UPDATE, so a concurrent link to another project that committed first is not overwritten (`linked_elsewhere`).
