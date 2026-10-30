# JD-M07 · `@javis-dog/realtime` — dashboard read model

Status: **in-progress** (S4a, ADR-0012). Derives thread state, freshness, overview counters, the activity feed and project health from stored JGR events, scoped to one workspace. JD-APP serves it as a snapshot the browser polls every 10 s.

| Export | Description |
|---|---|
| `createDashboardReader(db).snapshot(workspaceId, { now? })` | `DashboardSnapshot` for the last 24 h, times from the database clock |
| `threadFreshness(lastType, lastSignalAt, now)` | `ended` / `fresh` / `stale` (180 s window, JGR §5) |
| `FRESHNESS_WINDOW_MS`, `SNAPSHOT_WINDOW_HOURS`, `ACTIVITY_LIMIT` | Constants |
| `STATUS_REASONS` | Frozen list of self-report reasons; must equal JD-C02 `SELF_REPORT` (ADR-0017 §2) |
| `THREAD_IDENTITY_TYPE` | `x.javi.thread.identity` (ADR-0018 §5) |
| `ThreadIdentity`, `EncryptedObject` | Types of `ThreadState.identity` (below) |

Agent self-report (S5d, ADR-0017 §6): a `heartbeat` with a status and a `tool_name` is the agent's own report. It sets the thread `status` until later activity (`task.*`, `attention.requested`, `session.*`, `agent.*`, or a `heartbeat working` without a `tool_name`) clears it; then the status is the latest non-null status of an event that is not a self-report. Threads and activity items carry `statusSource` (`agent` / `collector`) and `statusReason` (a listed reason from `error_code` `<status>.<reason>`, else null). A thread needs attention when its status is `waiting`, or `blocked` from the agent.

Thread identity (S5f, ADR-0018 §5, §8): `ThreadState.identity` is the thread's newest `x.javi.thread.identity` event in the window, or null. It carries the AAD parts the browser needs (`eventId`, `producerId`, `threadRef`, `type`, `projectSlug`, `privacyClass`), `at`, the L1 hashes `repoHash`, `branchHash`, `cwdHash` (only `sha256:<64 hex>`, else null) and the stored `encrypted` object `{ alg, kid, iv, ciphertext }` passed through unchanged (null when absent or of another shape). The reader never decrypts or derives anything. The identity event counts as a signal for first/last signal and freshness, but it is never a status (its `status` is ignored), never clears a self-report, is never the thread's `lastType` while another event exists, never counts as a task and never appears in the activity feed.
