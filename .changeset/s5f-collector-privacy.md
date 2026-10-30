---
'@javis-dog/collector-claude-code': minor
---

JD-C01 privacy classes L1/L2 (ADR-0018 §4–§6, review H1–H3, M3, M4, G13): `javi init --privacy L1|L2 [--privacy-key-file <path>]` reads the recovery key from a hidden terminal prompt, a key file or `JAVI_PRIVACY_KEY` (never argv), checks the installation canary through an in-memory spool before anything is written, and stores the key in the project's credentials entry; `--privacy L0` removes it. L1/L2 projects add `x.javi.thread.identity` (keyed hashes, L2 ciphertext) after `session.started` and the collector `heartbeat working`; every other event stays L0. Child processes get an environment without the key; `javi status` shows the class, the `kid` and the last rejection codes. New exports: `readSessionFolder`, `buildIdentityRecord`, `buildCanaryRecord`, `isIdentityTrigger`, `loadProjectKeys`, `promptHiddenFromTerminal`, `readKeyFile`, `childEnv`, `detachedSpawner` and related constants and types.
