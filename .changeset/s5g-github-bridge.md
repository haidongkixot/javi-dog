---
'@javis-dog/github-bridge': minor
---

S5g (ADR-0019 and design review D0): new module JD-M10. `verifyGithubSignature` (HMAC-SHA256 over the raw body, current and previous secret, constant-time on equal-length buffers), `classifyDelivery` (kind from a strict payload-shape check; `X-GitHub-Event` must agree), `deliveryTimestamp` / `isTooOld` (3-day rule per event, `installation*` exempt), `mapDelivery` (L0 JGR events without `status`: `task.*`, `x.github.ci.*`, `x.github.pr.*`; `gh-app_<installation_id>` producers, `gh_` thread refs, UUIDv5 event ids from the body hash under namespace `fbb354ba-6443-5e61-8995-5f0d8fb04b91` (UUIDv5 of NAMESPACE_URL and the webhook URL)), `installationChange`, the `github_installations` / `github_repositories` / `github_deliveries` tables and `createGithubRepository` (delivery dedupe, installation upserts, claims, links, routing, verified-delivery evidence).
