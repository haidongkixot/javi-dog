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
   - **Recovery key.** The browser shows it **once** as `JDK1-` followed by the 32 bytes in Crockford base32 (52 characters) and a 4-character checksum, in groups of 4 separated by `-` (review M6: base64url breaks on double-click). The checksum is the first 4 base32 characters of SHA-256 over the 32 bytes; it catches typos and is no secret. Parsing ignores case, spaces and dashes.
   - **Input fields** for the key use `spellcheck=false`, `autocomplete=off` and `autocapitalize=off`, are masked, have no `name`, and are never inside a form that posts to the server (review M6: spellcheck services and password managers).
   - **What the server sees.** Never the secret: not in a request, a log, a server action argument, SSR output or a `NEXT_PUBLIC_*` value.
   - **Before the class changes.** The key is hidden, and the owner pastes the **full** key back; the browser checks it. "Download as a file" is offered next to "copy" (review M5: the last 4 characters were the visible checksum and proved nothing).
   - **Lost key.** A lost recovery key means unreadable L2 data. The page says so before generating.
2. **Everything is derived from the secret with HKDF-SHA256** (empty salt; `info` strings fixed, versioned and ending in `|<project slug>`, so the same key reused in two projects gives different `kid`s and hashes) in JD-M11:
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
   - `branch` comes from `.git/HEAD`, read as a file, never by spawning git in a hook. A detached HEAD gives no branch. Reading rules (review M4):
     - `lstat` first, and only a regular file is read, capped at 1 KiB, so FIFOs, devices and huge files are never read;
     - a `.git` *file* (worktree, submodule) is followed one `gitdir:` level, which must resolve to a directory;
     - only `^ref: refs/heads/(.+)$` counts;
     - names are NFC-normalised before hashing (macOS stores NFD);
     - in a linked worktree, `repo` is the worktree folder's name.

     `mapping.ts` ("cwd never read") and ADR-0010 are updated to say that the session folder is read for L1/L2 projects only.
   - **IV:** 12 random bytes per event. The spec and validator tighten `iv` to exactly 16 base64url characters.
   - **AAD:** the UTF-8 bytes of `jgr|v1|<canonical event_id>|<project slug>|<producer_id>|<thread_ref>|<type>|<kid>|L2`.
     - `canonical event_id` is the output of `canonicalEventId()`.
     - `project slug` is always the slug, never the UUID (review H3); `javi init --privacy` refuses a UUID project ref. Slugs cannot be renamed today, and an L1/L2 project's slug must stay fixed.
     - `thread_ref` and `type` are included, so that a ciphertext shown under another thread fails (review M1).
     - No part may contain `|`: the JGR ref patterns and the `kid` alphabet exclude it, and the browser rejects a part that has one.
     - Moving a ciphertext to another event, thread, project, producer or key fails decryption. The collector therefore sets `event_id` itself, which the SDK already allows.
     - The server still chooses *which* event the reader treats as newest; the AAD cannot prevent that.
   - **Padding** (review M2): the JSON is padded with spaces to exactly 256 bytes before encryption. `repo` and `branch` are each cut to 100 code points first, so the payload never exceeds 256 bytes; every L2 payload then has the same length.
   - **Never in L2 or any other class:** prompts, code, commands, file contents, secrets, file paths (spec §7).
5. **Identifiers travel on their own event** (review H1: if they rode on `session.started` and `heartbeat working`, a class mismatch would drop the status signal for good).
   - In an L1 or L2 project the collector sends `x.javi.thread.identity` right after `session.started` and after the collector `heartbeat working` (prompt submit), with the same `thread_ref`. It carries the L1 hashes `repo_hash`, `branch_hash` and `cwd_hash`, plus, in an L2 project, the encrypted payload. It takes the project's class.
   - Every other event, `session.started` and `heartbeat working` included, stays L0. A rejected identity event costs only the names, never the status.
   - The collector records the last rejection codes per project in its state, and `javi status` shows them (for example `privacy_class_not_allowed`).
   - The installation event `x.javi.collector.installed` in an L2 project is the **canary**: L2 with `{"v":1,"canary":true}`.
   - `file_hash` is defined but not produced in this sprint.
6. **Collector (`javi init --privacy L1|L2`).**
   - **Input** (review M3). The recovery key is read in one of three ways, never from an argument:
     - a hidden prompt read from the terminal itself (`/dev/tty`, `CONIN$` on Windows), so a token piped on stdin does not conflict;
     - `--privacy-key-file <path>`;
     - `JAVI_PRIVACY_KEY`. It is deleted from `process.env` right after reading, and every child process javi starts (flush, receiver, git) gets an explicit environment without it.

     The checksum is checked, and the key is stored in the project's credentials file under `~/.javi` (mode 0600 on POSIX; on Windows the user profile's access rules apply, as for the token). It is never printed: `javi status` shows only the class and `kid`.
   - **Guidance** in the output and the docs: run `javi init --privacy` yourself in a terminal; never paste the key into an agent chat or an agent's command, because it would land in the model provider's transcript.
   - **Ingest ceiling, checked before anything is written** (review H2: no read API exists, and the old verify ran after the credentials and hooks were saved). With `--privacy`, `init` first sends the canary through an in-memory spool and reads `rejected[].issues[].code`. On `privacy_class_not_allowed` or any other rejection it stops: no token, key or hook is saved. `--privacy` together with `--no-verify` is refused.
   - **Downgrade.** `javi init --privacy L0` removes the stored key.
7. **Changing a project's class (JD-M04, JD-APP).**
   - Owners and admins can change it with a server action (S5a role rule). It changes one existing column, so no migration is needed.
   - **Raising the class** to L1 or L2 happens in the key setup flow, after the recovery key is confirmed.
   - **Lowering the class** warns that stored L1/L2 events stay as they are and that new L1/L2 events will be rejected.
8. **Reading in the browser (JD-M07, JD-APP).**
   - **Reader.** For each thread it returns the newest `repo_hash` and `branch_hash` and the newest `encrypted` object, with its `event_id`, `producer_id` and `kid`, as opaque data. No server code decrypts or derives anything.
   - **Key entry.** The key is entered on the project page and imported as non-extractable keys. It is kept in memory for the tab by default.
   - **"Remember on this device"** (IndexedDB, explicit choice) ships only together with the CSP of decision 11 (owner 2026-10-30).
   - **Clearing.** "Forget on this device", the sign-out button, a `401` from the dashboard snapshot (session expired), and a sign-out in another tab (`BroadcastChannel`) all clear keys. Safari may delete stored keys after 7 days without a visit, and the page says so.
   - **Display.** A client component decrypts and renders the names as text only, with bidi control characters removed. Thread rows show `repo · branch` when decryption succeeds. The other states:
     - no key for that `kid`: "Encrypted (key `kid`)";
     - a key with another `kid`: "Can't decrypt with the key on this device";
     - the right `kid` but decryption fails: "Can't verify this encrypted data (changed or damaged)" (review M8).
9. **Honest labels (CLAUDE.md §3).**
   - **"L2 set up. No encrypted event checked yet."** until this browser decrypts the canary or any L2 event of the project with the right AAD.
   - **Then:** "Repo and branch names from javi are encrypted on your machine (key `kid`). Javi's Dog stores them only as ciphertext and can't read them. They are decrypted here, in your browser." The browser remembers per project and `kid` that it checked once (not secret), so the label survives the reader's 24-hour window.
   - **The project page always lists what Javi's Dog still sees:**
     - status, timing, token counts and event sizes;
     - which threads share a repo, branch or folder (L1 hash equality);
     - the sender's IP.

     It also states two limits:
     - the decrypting code is served by Javi's Dog, so a compromised deploy could read keys;
     - anyone holding the key can read the names, whatever their role in the workspace.
   - **Integrations page:** it describes L1/L2 as opt-in and per project, with this wording, and stops claiming they are on.
   - The words "secure" and "zero-knowledge" are not used.
10. **Rotation.** Generating a new key gives a new `kid`. Old events stay readable only with the old recovery key. The browser can hold several keys, matched by `kid`. Rotate before 2^32 L2 events per key; the UI does not count them in this sprint, which is logged as a follow-up.

11. **Content Security Policy before keys are remembered** (owner 2026-10-30, review M7). A nonce-based CSP covers every page of the app:
    - `script-src 'self' 'nonce-<per request>' 'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`;
    - `style-src 'self' 'unsafe-inline'` for the CSS that Next.js and Tailwind inline;
    - pages render dynamically, which nonces require.

    It is checked by a bounded browser run (no screenshots): every app route loads with zero CSP violations. Until it passes, "Remember on this device" stays off.
12. **Packaging.** `@javis-dog/crypto` is added to `transpilePackages` in `apps/web/next.config.ts`.

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
  - **XSS or a compromised deploy** could use a key that is in the page. Mitigations: no third-party scripts (checked: none today); one `dangerouslySetInnerHTML` in `packages/ui/src/components/icons.tsx:37`, which renders a static map of icon paths (review M7 corrected the earlier "none"); memory by default; the CSP of decision 11.
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
- 2026-10-30 — Design review D0, before any code: 3 High, 8 Medium, 12 Low. The orchestrator verified H1 (`jgr-sdk/src/client.ts:224-230`, the whole batch leaves the spool) and H2 (`cli.ts`: credentials and hooks are saved before the verify call). Fixes written into the decisions above:

  | Finding | Problem | Fix |
  |---|---|---|
  | H1 | Identifiers on status events: a rejection drops the status signal | Separate `x.javi.thread.identity` event; rejection codes shown in `javi status` |
  | H2 | A class check `init` claimed but did not have | The canary is sent first through an in-memory spool; `--privacy` with `--no-verify` is refused |
  | H3 | `project_ref` in the AAD could be a slug or a UUID | Slug only; a UUID ref is refused with `--privacy`; slugs stay fixed |
  | M1 | A ciphertext could be shown under another thread | `thread_ref` and `type` in the AAD |
  | M2 | Ciphertext length leaked the name lengths | 256-byte padding |
  | M3 | The key could leak through env inheritance, shell history, agents and stdin | Deleted from the env, explicit child env, `/dev/tty` prompt or key file, guidance |
  | M4 | Hostile `.git` files | Strict reading rules |
  | M5 | The confirmation proved nothing | Full paste-back and a download |
  | M6 | Key fields leaked to spellcheck and password managers; base64url split on double-click | Field attributes; Crockford base32 groups |
  | M7 | "No raw HTML injection" was wrong | Corrected (`icons.tsx`); CSP added this sprint by owner decision |
  | M8 | Test-plan gaps and untestable rows | Rows added; IndexedDB and Windows file-mode rows marked as owner or browser runs |

  Accepted Lows: per-project HKDF `info`, `|` rejection, `canonicalEventId()`, sign-out clearing across tabs and session expiry, a persisted "checked" state, scoped copy, the role note, text-only rendering, `transpilePackages`. Deferred: storing the current `kid` on the server (needs a migration); counting events per key.
- 2026-10-30 — QA spec gaps (known-answer vectors from this ADR only, `docs/jgr/conformance/privacy/`). These byte-level rules are binding:

  | Gap | Rule |
  |---|---|
  | G1 | Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, RFC 4648 §6 bit order, last group zero-padded on the right, no `=`, upper case. The same rule applies to the key body (52 characters), the checksum (4) and the `kid` (8). |
  | G2 | Parsing removes only U+0020 and `-` and ignores case. The prefix `JDK1` is required. `O`, `I`, `L` and `U` are refused (no aliases). Padding bits must be zero. |
  | G3 | HKDF input is the 32 raw secret bytes with an empty salt. `info` is the UTF-8 of `<label>\|<slug>`, with the labels `jgr/kid/v1`, `jgr/l2/aes-gcm/v1` and `jgr/l1/v1/{repo,branch,cwd,file}`. |
  | G4 | Output lengths: `kid` 5 bytes, giving 8 characters; L2 key 32 bytes; L1 HMAC keys exactly 32 bytes. Set the length explicitly, because WebCrypto's HMAC default is 64 bytes and gives other hashes. |
  | G5 | The L1 function applies NFC to every field; the payload builder applies NFC before the cut. |
  | G6 | Decision 4's "100 code points keeps it within 256 bytes" was wrong: 100 astral characters give 417 bytes. The cut is per field: the longest prefix of at most 100 code points whose JSON-escaped UTF-8 is at most 113 bytes. Then the payload is padded with spaces to exactly 256 bytes. |
  | G7 | base64url is unpadded everywhere; `=` is refused. |
  | G8 | `{"v":1}` with either field absent is valid. The UI shows the one name present, or nothing. |
  | G9 | No key in the tab gives "Encrypted (key `kid`)". One or more keys with none matching gives "Can't decrypt with the key on this device". |
  | G10 | Decryption succeeds but the plaintext is not a valid v1 payload → "Can't verify" (`unverifiable`). |
  | G12 | Serialisation is `JSON.stringify` with key order `v`, `repo`, `branch` (canary: `v`, `canary`), as raw UTF-8. |
  | G13 | `cwd_hash` hashes the session folder exactly as the hook payload's `cwd` gives it (absolute, NFC). When the payload has no `cwd`, no `cwd_hash` is sent. |
  | G14 | After a rotation, the "checked" label names the `kid` of the newest successfully decrypted event. |

  G11 was two stale TEST_PLAN rows, now fixed. Encrypt-direction known answers need a test-only IV input on the encrypt function; it is documented as test-only.
