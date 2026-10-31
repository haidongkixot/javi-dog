---
name: client-held-key-encryption
description: Ship end-to-end ("the server never sees it") encryption of selected fields with a key only the user holds — a recovery key generated in the user's browser, keys derived per purpose and per context with HKDF, keyed HMAC (never a plain or salted hash) for identifiers the server must group by, AES-GCM with associated data (AAD) bound to the context the reader DISPLAYS rather than to context the server supplies, fixed-length padding with real byte arithmetic, protected fields on their own message so a rejection never drops the operational signal, a canary that proves the server accepts the class before anything is installed, browser key lifecycle (memory by default, "remember on this device" gated on CSP evidence, keys bound to the signed-in user and cleared on every signed-out path), honest labels ("checked" only after an AAD-verified decryption in this browser), and a verification ladder (owner custody decisions → design review → known-answer vectors from two independent reference implementations → runner with mutations → end-to-end → security review). Use when adding client-side or end-to-end encryption, "zero-knowledge" or "encrypted with a key only you hold" claims, hashed or pseudonymised identifiers, a recovery key or passphrase flow, WebCrypto (`crypto.subtle`) code shared between Node and browsers, AES-GCM/AAD, HKDF, HMAC key derivation, or when a UI says "encrypted" and you need to know whether that is true.
metadata:
  version: "0.1.0"
  origin: "javis-dog ad-hoc-privacy (S5f, ADR-0018)"
  confidence: "medium (one iteration through six gates, each with recorded findings; known answers agreed between two independent reference implementations, 366 checks; every review finding fixed red-first); low (real browsers, the owner's machine, Windows file modes, the signed-in CSP run: NOT RUN)"
---

# Client-held key encryption

"Encrypted with a key only you hold" is one of the strongest claims a product can make, and one of the easiest to make falsely. In the origin, the product's settings page already said it before a single byte was encrypted. Getting it right needs decisions only the owner can take (who holds the key, what is lost when it is lost), byte-level rules exact enough for two independent implementations to agree, and a reader that cannot be tricked by the server it does not trust.

The rule: **the owner decides custody; every byte rule is written down and checked by known answers from two independent implementations; ciphertext is bound to what the reader shows; the UI says "encrypted" only after this browser has proven it.**

## Forces

- **Usability vs. custody.** A recovery key the user must store is honest and simple; it also means a lost key is lost data. Per-member key wrapping is friendlier for teams and needs device keys, verified public keys and a recovery group.
- **Grouping vs. hiding.** The server must still group events by repository or branch. Any deterministic token for a name leaks equality and frequency; a plain or salted hash also leaks the name to anyone who can guess it.
- **One codebase vs. two runtimes.** The same crypto code should run in the collector (Node) and the browser; WebCrypto is available in both, with permissive defaults.
- **Server as transport vs. server as adversary.** The server stores and selects the ciphertext; it must not be able to make the reader show the wrong plaintext in the wrong place.

## 1. Decide custody with the owner, before design

Ask, with trade-offs and a recommendation (these are owner decisions, not engineering ones):

| Option | Server can read? | Key loss | Team removal |
|---|---|---|---|
| Recovery key generated in the browser, shown once | No | Data lost | Needs rotation |
| Passphrase + PBKDF2, salt and wrapped key on the server | Offline guessing possible | Recoverable by passphrase | Needs rotation |
| Per-member key wrapping (X25519/ECDH) | No | Recoverable via other members | Re-wrap |
| Key in the URL fragment | No | Data lost | Needs rotation |

The origin chose the recovery key and rejected the passphrase (the server would hold everything needed for an offline attack) and the URL fragment (history, shared links, screenshots). Write the rejected options and reasons into the decision record. Say "a lost key means unreadable data" on the page **before** the key is generated.

Also decide: which fields (the origin: repository and branch names only), which classes (hashed only vs. hashed + encrypted), and whether identifiers are keyed by the same secret.

## 2. One secret, many derived keys

- 32 random bytes from `crypto.getRandomValues` in the user's browser.
- Show it once in a human format: a version prefix, an alphabet without ambiguous characters (Crockford base32), groups of 4 (base64url breaks on double-click), and a checksum (first characters of SHA-256 over the bytes) that catches typos and is not secret. Parse strictly: remove only spaces and the group separator, ignore case, require the prefix, refuse characters outside the alphabet (decide about aliases explicitly), require zero padding bits.
- Derive every key with **HKDF-SHA256** from the raw secret bytes (never from the text form), with versioned `info` labels that end in the context (`<label>|<project-slug>`), so the same secret reused in two contexts gives unrelated keys:
  - a **key id** (`kid`): the first bytes of HKDF output, encoded — derived, so it needs no storage, and the reader can tell which key an event used;
  - the encryption key (AES-256-GCM);
  - one HMAC key **per identifier field** (domain separation).
- **Set every output length explicitly.** WebCrypto's `deriveKey` to HMAC without `length` gives a key of the hash's block size (64 bytes for SHA-256), and every hash changes. See [`references/webcrypto-pitfalls.md`](references/webcrypto-pitfalls.md).
- Import derived keys as **non-extractable** `CryptoKey`s. Tests then prove the keys by their outputs, or through a documented test-only seam.

## 3. Identifiers: keyed HMAC, never a salted hash

A salted SHA-256 of `main` or a repository name is guessable by anyone who holds the salt — including the server that issued it. Use HMAC-SHA256 with a client-held key, over the NFC-normalised UTF-8 value (macOS file systems hand you NFD). Keep the wire format stable if one exists (`sha256:<64 hex>`), and change the spec's wording from "SHOULD use a salt" to "MUST be HMAC with a client-held key".

Tell users what remains visible: **equality and frequency** (the server sees that two events share a branch, and how often). Anything that must match these hashes later (an integration, a search) has to compute them where the key is.

## 4. Ciphertext rules, written to the byte

- **IV:** 12 random bytes per message; tighten the schema to exactly that length (the origin's schema accepted any length ≥ 16 characters). Rotate keys well before 2^32 messages per key.
- **AAD:** a fixed, versioned join of every context part the ciphertext belongs to — message id (canonical form), tenant/project slug (not a second identifier form for the same thing: pick one), producer, thread, message type, `kid`, class. Refuse any part containing the separator.
- **Padding:** pad to one fixed length so sizes do not leak names. **Do the arithmetic for the worst case**: "100 characters per field fits in 256 bytes" was false in the origin — 100 astral code points are 400 UTF-8 bytes, a quote escapes to 2 bytes, a control character to 6. The fixed rule: per field, the longest prefix of at most N code points whose escaped UTF-8 fits a byte budget; then pad with spaces to exactly the size.
- **Serialization:** name it (key order, escaping, raw UTF-8) — it decides every producer-side known answer.
- **Decryption is strict and typed:** refuse an IV that is not 12 bytes and a tag shorter than 16 bytes even though WebCrypto may accept them; return a typed result (`no-key`, `other-kid`, `unverifiable`, `malformed`) and never throw to the UI or return partial plaintext. An authentic plaintext that is not a valid payload is "unverifiable", not success.
- **Test-only IV seam** for encrypt-direction known answers, named so it cannot be mistaken for production use.

## 5. Bind to what the reader displays, not to what the server sends

The AAD only protects you if the **reader** builds it from facts it trusts. In the origin, the design put thread and type into the AAD, and the first implementation still built the AAD from the identity object the server returned — which includes the thread and type. A server (or a bug) could hand thread Y's ciphertext, with Y's metadata, to the row for thread X, and the browser would show Y's names in X's row. The security review found it; the fix:

- The row's own thread id and project slug, plus the constant message type, form the AAD. Only the message id and producer come from the event.
- An object whose thread, type or slug differs from the row is "can't verify" and is never decrypted.
- A different type (an installation canary) is checked only by the project-level check, never in a row.

Write down what the AAD cannot prevent: the server still chooses **which** message the reader treats as newest.

## 6. Protected fields travel on their own message

If identifiers ride on the operational messages (session start, heartbeat), a class mismatch — the user lowered the project's class, a collector still sends L2 — makes the receiver reject the whole message and the status signal disappears. Send protected fields on a **separate identity message** after the operational one, with the same thread; everything else stays at the lowest class. A rejected identity message costs the names, never the status. Record rejection codes where the user looks (`<cli> status`).

**Prove acceptance before installing.** The origin's draft claimed the setup command checked the server's class "through the existing verify call"; it did not, and that call ran after credentials and hooks were saved. Fix: with the privacy option, setup first sends an encrypted **canary** through an in-memory queue and reads the rejection codes; on any rejection nothing (token, key, hook) is written; the option together with "skip verification" is refused.

## 7. The key in the browser

- **Memory by default** (per tab). "Remember on this device" (IndexedDB, non-extractable keys) is a separate explicit choice and ships **only after** a Content Security Policy is verified on the pages that hold keys — one constant gates it, off until the evidence exists (see `nonce-csp-rollout`).
- **Bind remembered keys to the signed-in user.** Load only the current user's rows; delete rows of another user or without one; remember nothing while the user is unknown.
- **Clear on every signed-out path:** the sign-out button, a `401` from any data call, sign-out in another tab (`BroadcastChannel`), any page that renders signed out, a different user in the same tab. Clear memory first and bound the wait for storage (a hung IndexedDB must not block sign-out).
- **Key input fields:** masked, `spellcheck=false`, `autocomplete=off`, `autocapitalize=off`, no `name`, never inside a form that posts. Read the field once and empty it on every outcome.
- **Keep the key out of framework state.** In the origin the key text sat in React state and props (visible to devtools and error reporters); the fix writes it straight into a DOM node and wipes it on hide.
- **Confirmation proves possession:** hide the key, ask for the **full** key back (the last 4 characters were the visible checksum and proved nothing), offer a download next to copy, keep the download URL alive long enough for a slow "Save as" (the origin: ~40 s), and say "a copied key isn't saved yet".
- Before any step that deletes a machine's copy of the key, say so and what becomes unreadable.

## 8. Honest labels

| State | Label (origin wording) |
|---|---|
| Class raised, nothing decrypted here yet | "L2 set up. No encrypted event checked yet." |
| An event decrypted with the right AAD in this browser | "… encrypted on your machine (key `<kid>`). [Product] stores them only as ciphertext and can't read them. They are decrypted here, in your browser." |
| No key for the project in this tab | "Encrypted (key `<kid>`)" |
| Keys present, none with that `kid` | "Can't decrypt with the key on this device" |
| Right `kid`, decryption or payload check fails | "Can't verify this encrypted data (changed or damaged)" |

- "Checked" is earned by an **AAD-verified decryption in this browser** of the project's own data — not by the class setting, not by a received event, not by the canary alone (the origin flips the label on the first decrypted identity message). Remember "checked" per project and `kid` (not secret); clear it on sign-out and on a class change.
- Always list what the server **still** sees (timing, counts, sizes, hash equality, sender IP) and the two limits: the decrypting code is served by you, so a compromised deploy could read keys; anyone with the key can read, whatever their role.
- Do not use "secure" or "zero-knowledge". Render decrypted names as text only, with bidi and control characters removed.

## 9. Prove the key never reaches the server

Use a long sentinel key and search, as substrings, every encoding of it (text form, body without separators, raw bytes as hex) in: server-action arguments, request bodies, server writes, logs, console output and a fresh server render. Drive the **real** server action, add a positive control (a deliberately leaking call must be caught), and run one mutation. In the origin, a mutation that passed the key as an action argument was caught by the new test and **passed the old SSR-only test**. Details: `prove-secrets-and-pii-minimization` §9. For a CLI that accepts the key: `local-companion-process-hardening` §8.

## 10. Verification ladder and what each rung caught

| Gate | Caught in the origin | Class |
|---|---|---|
| Owner decisions on custody, fields, classes | Scope; rejected passphrase and URL-fragment designs | Product and threat model |
| Design review of the record | Identifiers on status messages (rejection drops status); a server-class check the draft claimed but the code did not have; "no raw HTML injection" false (grep scope too narrow); AAD ambiguity (slug vs. id); padding leak; key in env/history/agents/stdin; hostile `.git` files | Design and claims about existing code |
| Known-answer vectors from the record, two reference implementations | 14 byte-level gaps: HMAC key length (64 vs 32 bytes changes every hash), a padding bound that could not hold, alias and padding-bit parsing, serialization; first implementation then aligned (aliases, cut rule, failure class) | Byte rules |
| Runner with mutations | 145 pass, 8 NOT RUN with reasons; 38/38 mutations caught | Detection |
| End-to-end through the real pieces | A typing break across packages when one app type-checked another's sources | Integration |
| Security review of the implementation | Row swap via server-supplied AAD context; remembered keys outliving the session and user; key prompt inside an agent's terminal; a sentinel test that could not fail | Runtime and adversarial |

Plan the test layers before lanes (`efficient-testing`-style): unit + known answers for crypto, process tests for the CLI (sentinel absent from stdout, stderr, argv, spool, children's environments), component tests for each label, one end-to-end test, a bounded browser run for the CSP, and owner runs for real browsers and machines — NOT RUN until they happen.

## Pitfalls

- **Claiming encryption in copy before it exists.** Fix the copy first.
- **Salted hashes for names.** Guessable by whoever holds the salt.
- **Library defaults in byte rules.** HMAC key length, IV length, tag length.
- **AAD built from the payload you are verifying.** Bind to the reader's own context.
- **"Fits in N bytes" without the worst-case arithmetic.**
- **Protected fields on the status message.** A class mismatch silences the product.
- **Setup that writes, then checks.** Check with a canary first.
- **"Remember me" before a CSP.** Injected script can use a stored non-extractable key.
- **"Checked" from configuration.** Only a decryption here proves it.
- **A sentinel test that cannot fail.** Add a positive control and a mutation.
- **"jsdom passed" as browser evidence.** It shares Node's crypto engine.

## Evidence from origin project

Javi's Dog, Sprint 5f (2026-10-30/31): privacy classes L1/L2 for an agent-telemetry product — a collector CLI produces keyed hashes and encrypted repository/branch names; the web dashboard decrypts in the browser. Records: `docs/adr/0018-privacy-classes-l1-l2.md` (decisions, *Changes*: design review D0, QA spec gaps G1–G14, implementation decisions, security review, amendments), `docs/sprints/SPRINT-05f.md`, `docs/agent-ops/TEST_PLAN.md` §S5f, `docs/jgr/conformance/privacy/README.md`.

- False copy before the feature: ADR-0018 Context ("The Integrations page nevertheless tells users that names are hashed and payloads are 'encrypted with a key only you hold'"); rewritten in `d554f16`.
- Owner decisions: "Recovery key", "Keyed by the L2 key", "Repo + branch names", "L1 + L2 end to end"; rejected options with reasons (ADR-0018 *Rejected*).
- Design review D0 (`e3a2ad5`): 3 High, 8 Medium, 12 Low; H1 and H2 verified in code by the orchestrator. The draft (`b8c8e59`, l. 76) said "`init` checks the class through the existing verify call and refuses … before writing anything"; l. 113 said "no `dangerouslySetInnerHTML` (none today)" — one existed in a shared UI package (readiness row: "the first grep covered only `apps/web/src`").
- QA vectors (`ac8c380`): 17 vectors, 153 cases, from the record at `e3a2ad5` before any crypto code; expected values from Node 22.22 WebCrypto and, independently, Python 3.13 (`hashlib`, hand-written HKDF, `cryptography` AESGCM) plus the OpenSSL 3.0.13 CLI with a hand-written GHASH: 366 checks, 0 mismatches, a planted change caught. G4 example: the same input gives `sha256:3a02…a855` with a 32-byte HMAC key and `sha256:b71c…db9a` with the 64-byte default. G6: "100 astral characters give 417 bytes". The reference programs are not committed.
- Implementation alignment (`3fafe9c`): aliases refused, per-field cut with a 113-byte budget, non-v1 plaintext → "unverifiable", test-only IV seam. The first implementation (`914d5d0`) already set the HMAC length explicitly.
- Runner (`38a8bf2`): 145 PASS, 0 FAIL, 8 NOT RUN (named reasons), 38 of 38 README mutations killed.
- End to end (`cde4614`): setup → real collector `main()` → ingest handler on an embedded Postgres → reader → the web app's key entry and decryption in jsdom; another project's key and a one-byte tamper fail; lowering to L0 keeps the heartbeat and rejects only the identity message.
- Security review (`e3a2ad5..0b2179d`): 0 High, 3 Medium, 9 Low; "No path was found where the key reaches the server". M1 row swap → `7255d46` (red: "Y's names shown in X's row; canary decrypted to empty text"); M2 → `eec6350` (red 11 failed); M3 → `a8a123d`; L1 gate → `4a71bf2`; L5 → `f056b67`; L6 → `e41f384`; L7 → `69a23f6`, `2cb41d9`; L9 → `0489182` (red 4 failed: "key found in fiber state/props").
- Guru probe (Node 22.22.0, scratch): HMAC `deriveKey` without `length` → 64-byte key, different MACs; AES-GCM accepted a 16-byte IV and `tagLength: 96`, rejected an 11-byte IV.
- NOT RUN: real browsers, the owner's machine and Windows file modes, the signed-in CSP run that unlocks "remember on this device" (readiness rows "L1/L2 runtime", "Remember on this device").
