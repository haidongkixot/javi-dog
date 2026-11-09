---
'@javis-dog/web': minor
---

S5h (ADR-0019 Changes "S5h decisions", ADR-0018 §7): `changePrivacyClassAction(projectId, privacyClass, options?)` takes an optional `{ confirmLinkedRepo?: boolean }`. Raising a project L0 → L1/L2 or L1 → L2 while a GitHub repository is linked to it answers `{ needsConfirm: true, repository, repositories, error }` and changes nothing, unless `confirmLinkedRepo` is exactly `true` (checked on the server). Lowering, keeping the class and projects without a linked repository behave as before; a failed read of the links changes nothing. The key setup flow shows the linked-repository warning with a confirm button that retries with the confirmation and a cancel that keeps the class. The project's GitHub card on an L1/L2 project with a linked repository says the name stays known to Javi's Dog until it is unlinked.
