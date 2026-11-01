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
| `GITHUB_PRODUCER_PREFIX`, `GITHUB_TERMINAL_TYPES` | `gh-app_`; the six event types that end a GitHub thread (ADR-0019 D0 M1) |
| `ThreadSource`, `GithubKind`, `GithubCounts` | Types of `ThreadState.source` / `.githubKind` and `DashboardSnapshot.github` (below) |

Agent self-report (S5d, ADR-0017 §6): a `heartbeat` with a status and a `tool_name` is the agent's own report. It sets the thread `status` until later activity (`task.*`, `attention.requested`, `session.*`, `agent.*`, or a `heartbeat working` without a `tool_name`) clears it; then the status is the latest non-null status of an event that is not a self-report. Threads and activity items carry `statusSource` (`agent` / `collector`) and `statusReason` (a listed reason from `error_code` `<status>.<reason>`, else null). A thread needs attention when its status is `waiting`, or `blocked` from the agent.

Thread identity (S5f, ADR-0018 §5, §8): `ThreadState.identity` is the thread's newest `x.javi.thread.identity` event in the window, or null. It carries the AAD parts the browser needs (`eventId`, `producerId`, `threadRef`, `type`, `projectSlug`, `privacyClass`), `at`, the L1 hashes `repoHash`, `branchHash`, `cwdHash` (only `sha256:<64 hex>`, else null) and the stored `encrypted` object `{ alg, kid, iv, ciphertext }` passed through unchanged (null when absent or of another shape). The reader never decrypts or derives anything. The identity event counts as a signal for first/last signal and freshness, but it is never a status (its `status` is ignored), never clears a self-report, is never the thread's `lastType` while another event exists, never counts as a task and never appears in the activity feed.

GitHub threads (S5g, ADR-0019 decision 6, design review D0 M1, M2):

- **Source.** `ThreadState.source` is `github` when every event of the thread has a `producer_id` starting with `gh-app_` (only the JD-M10 bridge writes that prefix; ingest rejects it and `gh_` thread refs for everyone else), otherwise `agent`. Nothing else (tool name, thread ref) makes a thread GitHub. `ThreadState.githubKind` is `ci` (`task_kind` `ci.*`) or `pr` (`task_kind` `pr` / `pr.*`), falling back to the type family `x.github.ci.*` / `x.github.pr.*`; null for agents.
- **No status.** A GitHub thread's `status` is always null (`statusSource` `collector`, no reason), so it never needs attention. Events with a `gh-app_` producer never count towards any thread's `status`, never set or clear a self-report and never count as agent tasks, even in an agent's thread.
- **Ended.** A GitHub thread's `lastType` is its event with the highest `sequence` (strictly increasing per thread, D0 M3), because GitHub may deliver out of order. When that type is in `GITHUB_TERMINAL_TYPES` (`task.completed`, `task.failed`, `x.github.ci.cancelled`, `x.github.ci.skipped`, `x.github.pr.merged`, `x.github.pr.closed`) the thread is `ended`; otherwise the usual 180 s fresh/stale rule applies. `x.github.ci.attention` is not terminal. A re-run (`run_attempt` > 1) is its own thread; nothing assumes one thread per run id.
- **Counters.** `overview.agentsWorking` and `overview.tasksCompleted24h` count agents only, and `ThreadState.tasksCompleted` is 0 for a GitHub thread. `overview.activeProjects` and `ProjectHealth.freshThreads` count fresh threads of either source, because a GitHub delivery is a verified signal of the project (the bridge also touches `last_signal_at`). `DashboardSnapshot.github` holds `{ ciRunning, ciFailed24h, prsOpen }` as `Counter`s over GitHub threads in the window: CI threads whose newest event is `task.started`, CI threads whose newest event is `task.failed`, and PR threads that are not ended. Each `lastSignalAt` is the newest delivery that counted; GitHub sends no heartbeat, so a run stays in `ciRunning` until its result arrives.
- **Activity.** GitHub events appear in `activity` with their `tool_name` (the CI app) and no status; `ActivityItem` is unchanged.
