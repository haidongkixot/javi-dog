# ADR-0018: Privacy classes L1 and L2 with a project recovery key (JD-M11)

- Status: **Accepted** 2026-10-30. Owner answers:
  - JD-M11 as the next sprint (S5f).
  - Key custody: "Recovery key".
  - L1 hashing: "Keyed by the L2 key".
  - L2 fields: "Repo + branch names".
  - Scope: "L1 + L2 end to end".
- Date: 2026-10-30
- Deciders: Project owner (Hai), Claude (orchestrator)
- Modules:
  - JD-M11 (new, `@javis-dog/crypto`, `packages/crypto`);
  - JD-M01 (spec §7 wording, `iv` length);
  - JD-C01 (`javi init --privacy`, hook fields);
  - JD-M04 (change a project's class);
  - JD-M07 (thread fields);
  - JD-APP (key setup, decryption, Integrations copy).

## Context and problem statement

JGR v0.1 already defines three privacy classes (spec §7):

- **L0**, operational metadata (the default);
- **L1**, L0 plus hashed identifiers `repo_hash`, `branch_hash`, `file_hash`, `cwd_hash` as `sha256:<64 hex>`;
- **L2**, L1 plus an `encrypted` object `{ alg: "A256GCM", kid, iv, ciphertext }` "encrypted on the producer with a key the platform never sees".

The validator (JD-M01), the per-project ingest ceiling (`projects.privacy_class`, JD-M05) and the `events.encrypted` column (JD-M06) exist. **Nothing produces L1 or L2 yet**, nothing holds a key, and nothing decrypts.

The Integrations page nevertheless tells users that names are hashed and payloads are "encrypted with a key only you hold". That breaks CLAUDE.md §3: never call anything encrypted without runtime evidence.

### Research (2026-10-30, sources in the S5f sprint log)

Many primary hosts are blocked from the sandbox. Texts were read from their source repositories instead: `w3c/webcrypto`, `mdn/content`, `mdn/browser-compat-data`, `OWASP/CheatSheetSeries`, `vercel/next.js` docs and Excalidraw. The orchestrator re-checked these facts:

- `EncryptedPayload.iv` is `z.base64url().min(16)` in `packages/jgr-spec/src/schema.ts`, so 12 bytes are not enforced;
- X25519 works on the sandbox's Node 22.22;
- OWASP gives "PBKDF2-HMAC-SHA256: 600,000 iterations".

| Fact | Evidence |
|---|---|
| AES-GCM, HKDF, HMAC and PBKDF2 are in WebCrypto on Node 22 (`globalThis.crypto.subtle`) and every evergreen browser, in secure contexts. Argon2 is not in WebCrypto. | Node webcrypto docs; W3C Editor's Draft; BCD |
| AES-GCM needs a unique 96-bit IV per key. Random IVs allow about 2^32 encryptions per key. The 128-bit tag is appended to the ciphertext. If the AAD does not match, decryption throws. | MDN AesGcmParams; OWASP Key Management (citing NIST SP 800-38D §8.3, PDF not reachable) |
| A non-extractable `CryptoKey` can be stored in IndexedDB, but injected script can still *use* it. | W3C IDL `[Serializable]`; OWASP HTML5 cheat sheet |
| A salted plain hash of a low-entropy name (`main`, a repo name) can be guessed by anyone who knows the salt. A keyed HMAC moves the risk onto protecting the key. | Pseudonymisation guidance (ENISA: summaries only, host blocked) |
| Removing a member from a shared key is not cryptographic unless the key rotates. Old data stays readable to anyone who kept the old key. | 1Password security design; Vaultwarden CVE-2024-39925 |

## Decision outcome

1. **One project secret, held only by people and machines the owner gives it to.**
   - **Generation.** The owner's browser generates 32 random bytes (`crypto.getRandomValues`) on the project page.
   - **Recovery key.** The browser shows it **once** as `jdk1_<43 base64url>_<4 checksum>`, where the checksum is the first 4 base32 characters of SHA-256 over the 32 bytes. It catches typos and is no secret.
   - **What the server sees.** Never the secret: not in a request, a log, a server action argument, SSR output or a `NEXT_PUBLIC_*` value.
   - **Before the class changes.** The owner confirms they saved it (they type its last 4 characters).
   - **Lost key.** A lost recovery key means unreadable L2 data. The page says so before generating.
2. **Everything is derived from the secret with HKDF-SHA256** (empty salt, `info` strings fixed and versioned) in JD-M11:
   - `kid` = the first 8 base32 characters of HKDF(`jgr/kid/v1`). Being derived, it needs no storage or migration, and the browser can check which key an event used.
   - L2 encryption key = HKDF(`jgr/l2/aes-gcm/v1`), AES-256-GCM.
   - L1 key per field = HKDF(`jgr/l1/v1/<field>`), HMAC-SHA256. The fields are `repo`, `branch`, `cwd` and `file`, which gives domain separation.
3. **L1 is a keyed HMAC, never a plain salted hash.**
   - The value is `sha256:` followed by the 64 lowercase hex characters of HMAC-SHA256(field key, the UTF-8 value).
   - The wire format stays `sha256:<64 hex>` for v0.1 compatibility. Spec §7 changes from "SHOULD use a per-project salt" to "MUST be HMAC-SHA256 with a client-held key (ADR-0018)". v0.2 may rename the prefix.
   - Javi's Dog cannot reverse an L1 hash, not even `main`. It still sees **equality and frequency** (the same branch, how often), and the UI says so.
   - A later GitHub App (JD-M10) must match hashes in the browser.
4. **L2 payload v1, JSON, at most 4 KiB before encryption:** `{"v":1,"repo":"<display name>","branch":"<branch>"}`. Either field may be absent.
   - `repo` is the basename of the git work-tree root, or of the session folder outside git.
   - `branch` comes from `.git/HEAD`, read as a file, never by spawning git in a hook. A detached HEAD gives no branch.
   - **IV:** 12 random bytes per event. The spec and validator tighten `iv` to exactly 16 base64url characters.
   - **AAD:** the UTF-8 bytes of `jgr|<canonical event_id>|<project_ref>|<producer_id>|<kid>|L2`. Moving a ciphertext to another event, project, producer or key fails decryption. The collector therefore sets `event_id` itself, which the SDK already allows.
   - **Never in L2 or any other class:** prompts, code, commands, file contents, secrets, file paths (spec §7).
5. **Which events carry identifiers.** In an L1 or L2 project, the collector adds the L1 hashes `repo_hash`, `branch_hash` and `cwd_hash` to `session.started` and to the collector `heartbeat working` (prompt submit). In an L2 project these events also carry the encrypted payload.
   - These events take the project's class. Every other event stays L0, as today.
   - The installation event `x.javi.collector.installed` in an L2 project is the **canary**: L2 with `{"v":1,"canary":true}`.
   - `file_hash` is defined but not produced in this sprint.
6. **Collector (`javi init --privacy L1|L2`).**
   - **Input.** The recovery key is read from `JAVI_PRIVACY_KEY` or a hidden prompt, never from an argument. The checksum is checked, and the key is stored in the project's credentials file under `~/.javi` (mode 0600, next to the token). It is never printed: `javi status` shows only the class and `kid`.
   - **Ingest ceiling.** If the project's class on the server is lower than requested, ingest rejects the events (`privacy_class_not_allowed`). `init` checks the class through the existing verify call and refuses with a clear message before writing anything.
   - **Downgrade.** `javi init --privacy L0` removes the stored key.
7. **Changing a project's class (JD-M04, JD-APP).**
   - Owners and admins can change it with a server action (S5a role rule). It changes one existing column, so no migration is needed.
   - **Raising the class** to L1 or L2 happens in the key setup flow, after the recovery key is confirmed.
   - **Lowering the class** warns that stored L1/L2 events stay as they are and that new L1/L2 events will be rejected.
8. **Reading in the browser (JD-M07, JD-APP).**
   - **Reader.** For each thread it returns the newest `repo_hash` and `branch_hash` and the newest `encrypted` object, with its `event_id`, `producer_id` and `kid`, as opaque data. No server code decrypts or derives anything.
   - **Key entry.** The key is entered on the project page and imported as non-extractable keys. It is kept in memory for the tab by default, and in IndexedDB only with an explicit "Remember on this device" choice. "Forget on this device" and sign-out clear it.
   - **Display.** A client component decrypts. Thread rows show `repo · branch` when decryption succeeds. Without the key they show "Encrypted (key `kid`)". With a wrong key they show "Can't decrypt with the key on this device".
9. **Honest labels (CLAUDE.md §3).**
   - **"L2 set up. No encrypted event checked yet."** until this browser decrypts the canary or any L2 event of the project with the right AAD.
   - **Then:** "Encrypted on your machine (key `kid`). Javi's Dog stores only ciphertext and can't read it. It is decrypted here, in your browser."
   - **The project page always lists what Javi's Dog still sees:** status, timing, token counts, sizes, when identifiers repeat (from L1), and the sender's IP. It also states the limit of any web app: the decrypting code is served by Javi's Dog.
   - **Integrations page:** it describes L1/L2 as opt-in and per project, with this wording, and stops claiming they are on.
   - The words "secure" and "zero-knowledge" are not used.
10. **Rotation.** Generating a new key gives a new `kid`. Old events stay readable only with the old recovery key. The browser can hold several keys, matched by `kid`. Rotate before 2^32 L2 events per key; the UI does not count them in this sprint, which is logged as a follow-up.

### Rejected

- **Per-member key wrapping** (X25519 or ECDH). Better UX for teams, but it needs device keys for every CLI, verified public keys and a recovery group. Deferred; it fits as a later `kid`-compatible layer.
- **Passphrase plus PBKDF2 with server-held salt and wrapped key.** The server would hold everything needed for an offline guessing attack.
- **Salted plain hash with a server-issued salt.** It hides names only from outsiders, not from the server.
- **Key in the URL fragment** (Excalidraw pattern). It ends up in history, shared links and screenshots. A paste field is used instead.

## Consequences

- Good:
  - **First real L1/L2:**
    - grouping by repo and branch without names reaching the server;
    - repo and branch names visible only where the key is;
    - no migration and no new runtime dependency;
    - the same JD-M11 code in Node and the browser (WebCrypto only).
  - **The Integrations page tells the truth.**
- Bad:
  - **Key loss.** A lost recovery key means lost L2 data, and removing a teammate needs a rotation.
  - **Equality leaks through L1:** the server sees that identifiers repeat and how often.
  - **XSS or a compromised deploy** could use a key that is in the page. Mitigations: no third-party scripts (checked: none today), no `dangerouslySetInnerHTML` (none today), memory by default. A nonce-based CSP is follow-up F-CSP, with a readiness row.
  - **No server-side search, grouping or email on L2 fields.** Budget alerts never include them.
- Neutral:
  - `x.javi.collector.installed` becomes L2 in L2 projects. Receivers store extension events uninterpreted (spec §4).

## Verification (TEST_PLAN §S5f)

- **Known-answer vectors** for HKDF, `kid`, L1 HMAC, AAD and AES-GCM decryption. QA writes them from this ADR, and the same vectors run in Node and in a browser-like environment (jsdom with WebCrypto, or Node's WebCrypto, which is the same API).
- **Validator and ingest tests** for the tightened `iv`.
- **Collector tests:** the key is never printed, never on argv, file mode 0600; L1/L2 fields only on the named events; the canary.
- **Reader tests** for the opaque fields.
- **Component tests** for each label state.
- **An end-to-end test:** init `--privacy L2` → hook → ingest (PGlite) → reader → browser decryption, with the label switching to "checked".
- **A test that the key never reaches the server:** a sentinel key must not appear in any request body, log or SSR HTML in tests.
- **Real runs** in the owner's browser and on the owner's machine are NOT RUN until the owner does them.

## Changes

- 2026-10-30 — Created (S5f discovery, research and owner decisions).
