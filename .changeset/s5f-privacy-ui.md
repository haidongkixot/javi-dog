---
'@javis-dog/realtime': minor
'@javis-dog/projects': minor
'@javis-dog/web': minor
---

S5f privacy classes L1/L2 in the dashboard (ADR-0018, K4): JD-M07 adds `ThreadState.identity` (the newest `x.javi.thread.identity` event as opaque data: AAD parts, L1 hashes, the `encrypted` object), `THREAD_IDENTITY_TYPE`, `ThreadIdentity` and `EncryptedObject`; the identity event is a freshness signal but never a status, task, last type or activity item. JD-M04 adds `setPrivacyClass()`. JD-APP adds the project page's privacy card (key setup with full paste-back, key entry, remember/forget on this device, lowering with the warning, honest L2 labels), `repo · branch` on thread rows decrypted in the browser, key clearing on sign-out, session end and sign-out in another tab, the `changePrivacyClassAction` server action (class only) and the rewritten Integrations privacy copy.
