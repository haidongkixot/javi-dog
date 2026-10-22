---
name: presence-only-health-endpoint
description: Ship a small public health/diagnostics endpoint that reports which configuration variables are set as booleans only (never values), which build answered (environment name and commit), and whether the database responds (status word, latency, migration count) — so an agent or developer without access to the hosting platform's settings can observe a deployed environment, detect that a config change has not reached the running build yet, and catch wrong assumptions about deployment targets. Covers the security rules (no values, no driver messages, no caching, timeouts), a database ping that works on an unmigrated database, and tests that prove no secret leaks. Use when an agent gets 403 on listing or setting platform env vars, when you cannot tell what is configured in preview or production, after changing env vars on Vercel/Netlify/Render/Fly/Heroku/Kubernetes, when adding /health, /healthz, /status or readiness probes, or when a deploy "works locally but not in production".
metadata:
  version: "0.1.0"
  origin: "javis-dog G2-prep"
  confidence: "high (observing deployed config); medium (DB ping)"
---

# Presence-only health endpoint

Coding agents often have deploy rights but not configuration rights: they can push a build but get 403 when listing or creating environment variables. Humans have the same blind spot across preview, staging and production. Without a view into the running environment, every "is it configured?" question becomes a guess or a request to the owner.

A deployed endpoint can answer that question safely if it reports **presence, not values**. Variable names and booleans reveal very little; values reveal everything.

The rule: **the running build describes itself — which variables exist, which commit and environment it is, whether its database answers — and never says anything a secret could hide in.**

## Forces

- **Observability vs. disclosure.** A public endpoint is reachable by anyone. Booleans for a fixed list of names leak little (that you use a given provider); values, hosts, error messages and stack traces can leak credentials.
- **Public vs. protected.** A token-protected health view adds a secret to manage; the origin chose public booleans because the agent needed the view precisely when it could not manage secrets. Choose deliberately and record it.
- **Freshness vs. cost.** The response must reflect this request (no caching), and a hung dependency must not hang the endpoint.

## 1. Define the response

```json
{
  "status": "ok | degraded",
  "checkedAt": "2026-10-22T19:25:00.000Z",
  "deployment": { "env": "production", "commit": "9cdc766" },
  "env": { "DATABASE_URL": true, "AUTH_SECRET": true, "OAUTH_CLIENT_ID": false },
  "db": { "status": "ok | error | not_configured", "latencyMs": 136, "migrationsApplied": 1 }
}
```

- **`env`:** an explicit allowlist of names in code — never iterate over the process environment. A blank or whitespace-only value counts as missing.
- **`deployment`:** environment name and short commit from the platform's build variables (for example `VERCEL_ENV` / `VERCEL_GIT_COMMIT_SHA`; other platforms expose similar ones). This is what tells you *which build* answered.
- **`db`:** a state word; latency and migration count only when the state is `ok`.
- **`checkedAt`:** the server's time for this check. The endpoint reports a check, not a "live" status.
- **HTTP status:** 200 when every hard dependency is ok, 503 otherwise, so uptime monitors and load balancers can use it unchanged.

## 2. Hold the security rules in code and tests

- No values, hosts, connection strings, driver error messages or stack traces. Catch dependency errors and return the state word only — drivers can echo the connection string in their message.
- `Cache-Control: no-store`, and make the route dynamic in frameworks that would otherwise pre-render or cache it.
- Time out the dependency ping (origin: 3 s) and report `error`; never let it hang the request.
- Never ping without a configured URL: return `not_configured` without touching the driver.
- Run on the full server runtime if the database driver needs it.

Tests at the lowest layer (unit, fake ping, fake timers): every name is reported as a boolean; serialized output contains none of the fake secret values; blank counts as missing; `not_configured` never calls the ping; a throwing ping whose message contains the fake secret yields `error` and no secret; a hung ping yields `error` after the timeout; the route sends `no-store`.

A dependency-free core with a self-test: [`templates/health-core.mjs`](templates/health-core.mjs) (`node health-core.mjs --self-test`). At G2-prep its self-test passed, and a variant that echoed values instead of booleans failed it with exit 1.

## 3. Ping the database in a way that survives an empty schema

The health check runs before and between migrations, so the ping must tolerate missing bookkeeping tables. In Postgres, **a `CASE` or `COALESCE` guard around a query on a possibly-missing table still fails**: relation names are resolved before the statement executes, so `relation ... does not exist` is raised even on the branch that would not run. Use two statements: an existence check (`to_regclass(...) is not null`), then the count only if it exists. SQL: [`references/db-ping.sql`](references/db-ping.sql).

Test it against a real engine with an empty schema (an in-process Postgres such as PGlite, or a throwaway container): "0 migrations on an empty database" is a test case, not an assumption.

## 4. Use it as the source of truth for deployed configuration

After every deploy that matters, read the endpoint and record the result (HTTP status, booleans, commit) in the iteration record. Typical findings:

| Observation | Meaning | Action |
|---|---|---|
| Expected variable `false` | Not set **for this environment** | Owner sets it on the platform; record names only |
| You changed variables but the response is unchanged and `deployment.commit` is the old build | Many platforms apply env changes only to **new** builds | Trigger a new deployment (any commit or a redeploy), then re-read |
| `deployment.env` differs from the plan (e.g. `production` where you planned `preview`) | The branch deploys to a different target than assumed | Stop: plans keyed to the assumed environment do not apply; ask the owner |
| `db.status = error` with variables present | Wrong value, network policy, or the DB is down | Diagnose before retrying; the endpoint deliberately hides the reason, so reproduce locally |
| `migrationsApplied` lower than the repository | Migration not applied to this environment's database | Apply by the explicit migration command, not at build time |

Write each finding into the readiness record with the commit it came from. When the agent's own attempt to change platform config fails (403), record that as a permission fact and hand the change to the owner instead of looking for a workaround.

## Pitfalls

- **Reading a stale build.** Always compare `deployment.commit` with the commit you expect before trusting the booleans.
- **Echoing `error.message`.** The most common leak path; tests must include a fake secret in the thrown message.
- **Iterating over all environment variables.** The allowlist is the privacy boundary.
- **Calling it "live".** It is a point-in-time check with a timestamp.
- **Cached health.** A pre-rendered or CDN-cached health page reports the build-time state forever.

## Evidence from origin project

Javi's Dog, Sprint 2a (2026-10-22) and later use in S2b. Confidence **high** for observing deployed configuration (four recorded reads of the deployed endpoint, each acted on; one hosting platform, one project) and **medium** for the DB ping details (one implementation, tested once on PGlite and Neon).

- Code: `apps/web/src/lib/health.ts`, `apps/web/src/app/api/health/route.ts`, tests `apps/web/test/health.test.ts` (`dc6ef61`). Owner decision Q2 (public, booleans only) in `docs/sprints/SPRINT-02a.md`, recorded because env listing was 403 for the agent.
- Read 1 (`dc6ef61`): production returned 503 `not_configured`; three of nine variables were `false`. The platform's deployment list showed the branch builds as **production**, so the plan "preview → dev database" had no environment to apply to → new owner question (`SPRINT-02a.md` Log and Q5; `docs/agent-ops/READINESS_MATRIX.md` Environments row, `ce143d0`).
- Agent attempt to set a production variable: 403 "Additional permissions are required" → owner set them (`docs/memory/SESSION_LOG.md`, `9b6ea0b`).
- Read 2: after the owner's change, the running build (`9b6ea0b`) still reported the same three `false`; no redeploy had run. A docs commit triggered a new build. Read 3 (`9cdc766`): 200, all nine `true`, DB `ok`, 136 ms, 1 migration (`SESSION_LOG.md`, `26db144`).
- Read 4 (`a55b415`): DB ok, 2 migrations, 9/9 — used as S2b deployment evidence (`docs/sprints/SPRINT-02b.md`).
- DB ping defect: the first `pingDb` used a `CASE` guard and failed on an unmigrated PGlite database; split into two statements (`packages/event-store/src/client.ts`; test "reports 0 applied migrations on an empty database" in `packages/event-store/test/migrations.test.ts`; ADR-0005 *Changes*). Reproduced at G2-prep on PGlite 0.5.8: the `CASE` form raises `relation "drizzle.__drizzle_migrations" does not exist`; `to_regclass` returns `false`.
- Retro: "the health route immediately answered the long-standing 'what is set on Vercel' question" (`SPRINT-02a.md`).
- Not verified: behavior on other platforms (the env-applies-to-new-builds rule was observed once, on Vercel); whether public booleans ever helped an attacker (no incident, no measurement).
