---
'@javis-dog/realtime': minor
'@javis-dog/web': minor
---

S5g (ADR-0019 decision 6, design review D0 M1, M2): JD-M07 `ThreadState` gains `source: 'agent' | 'github'` (from the reserved `gh-app_` producer prefix only) and `githubKind: 'ci' | 'pr' | null`; `DashboardSnapshot` gains `github: { ciRunning, ciFailed24h, prsOpen }` counters. GitHub threads carry no status, end on a terminal event by sequence (`GITHUB_TERMINAL_TYPES`), and never set or clear an agent status or count as agent tasks; new exports `GITHUB_PRODUCER_PREFIX`, `GITHUB_TERMINAL_TYPES` and the types `ThreadSource`, `GithubKind`, `GithubCounts`. JD-APP labels GitHub threads "GitHub CI" / "GitHub PR", keeps them out of the agent squad, the agent counts and the thread monitor, and shows their CI and PR counts on their own.
