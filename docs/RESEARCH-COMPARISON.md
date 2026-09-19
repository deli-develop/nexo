# Nexo against the apps with the same idea

What Signal and Telegram do that Nexo does not, what of that matters, and what
an external reviewer would find in this repository today.

Written 2026-08-31 against the working tree at v0.1.7. Every claim about Nexo
carries a `path:line`; every external claim carries a URL to the party that owns
it — Signal's own specs and blog, Telegram's own documentation, the RFC itself,
Microsoft, Tauri, OWASP. No comparison articles, no summaries of summaries.
Where a primary source could not be found, the claim is marked unverified
rather than dressed up.

This document does not argue with the decisions in `docs/PLAN.md`. One device
per account, no follow graph, no account-recovery flow and a public feed are
settled. Where one of those settled decisions makes a user test harder, it is
recorded as a **trade-off you are choosing**, not as a recommendation to
reverse it.

---

## 1. Where Nexo stands

The cryptographic core is in better shape than the product around it. That is
an unusual place to be and it is worth being precise about, because it changes
what the remaining work is.

**What is genuinely built and tested.**

- MLS over OpenMLS on the mandatory-to-implement ciphersuite, chosen in one
  place (`crates/crypto/src/lib.rs:43`) with a padding size and out-of-order
  tolerance set deliberately (`crates/crypto/src/lib.rs:101`). RFC 9420 §16.6
  asks for periodic Update commits; the policy exists as a pure function with
  boundary tests (`crates/crypto/src/mls.rs:181`).
- Commits are **staged, not merged** until the delivery service says the commit
  won (`crates/crypto/src/mls.rs:89`, `:66`, `:84`), and the server orders them
  under a row lock (`apps/server/src/delivery/mod.rs:762`). This is the part
  most hand-rolled MLS integrations get wrong, and it is right here.
- Attachments are AES-256-GCM with a fresh key and nonce per file, the key
  travelling inside the MLS message (`crates/crypto/src/attachment.rs:86`), and
  decryption checks both the GCM tag and the sender's published SHA-256
  (`:116`) — two different claims, correctly separated.
- Safety numbers are twelve groups of five digits over the sorted identity
  keys, domain-separated from the single-key device fingerprint
  (`crates/crypto/src/identity.rs:129`, `:172`, `:198`). The same 12×5 shape
  Signal settled on ([Signal, *Safety number
  updates*](https://signal.org/blog/safety-number-updates/)).
- Token lifecycle: EdDSA access tokens with the algorithm pinned rather than
  read from the header (`apps/server/src/auth/tokens.rs:131`), a 15-minute TTL
  (`:23`), refresh tokens as 256 bits of CSPRNG stored only as SHA-256 (`:151`,
  `:166`), rotation with reuse detection that revokes the family (`:201`).
- An anti-enumeration salt endpoint that returns a stable, seed-derived decoy
  for handles with no account (`apps/server/src/auth/salt.rs:27`) — a detail
  most projects skip.
- Local store: SQLCipher keyed by 32 CSPRNG bytes wrapped by DPAPI, with the
  key existing in exactly two places (`crates/store/src/key.rs:41`), and a
  first-read probe that turns "wrong key" into a distinct error rather than
  apparent corruption (`crates/store/src/lib.rs:109`).
- The offline queue holds **ciphertext**, encrypted once, with a
  `client_msg_id` the server matches on (`crates/store/src/lib.rs:266`,
  `crates/client/src/outbox.rs:143`, `apps/server/src/delivery/mod.rs:733`).
  The reasoning — that re-encrypting on retry burns MLS generations — is
  correct and is written down where the code is.
- The IPC boundary is narrow and tested for what it must not carry: the
  attachment view is asserted to contain no key, nonce or object key
  (`apps/desktop/src-tauri/src/conversations.rs:918`).
- Supply chain: `cargo deny` run per target rather than over a union graph,
  with every ignored advisory carrying a written, checkable reason
  (`deny.toml`, `.cargo/audit.toml`). This is better than most commercial
  projects manage.

**What is built but thinner than it looks.**

- **Verification is a boolean in the WebView.** `ConversationOverride.verified`
  lives in Zustand and is persisted to `localStorage`
  (`apps/desktop/src/app/store.ts:19`, `:353`). It records *that* someone
  pressed "Mark as verified"
  (`apps/desktop/src/features/messages/ContextPanel.tsx:219`), not *which key*
  they verified. Nothing in the Rust core knows a conversation was ever
  verified.
- **There is no key-change detection at all.** No table stores a peer's
  identity key (`crates/store/src/lib.rs` has eight tables; none is a contacts
  table), and no code compares a current key against a remembered one. See §4.1
  — this is the single most important finding in this document.
- **The client polls.** `SYNC_INTERVAL_MS = 4000`
  (`apps/desktop/src/lib/conversations.ts:272`). The server has a working
  authenticated WebSocket with per-conversation fan-out
  (`apps/server/src/stream/mod.rs:45`), and the client crate has no WebSocket
  dependency at all. `docs/PLAN.md` M4 says this openly.
- **Search covers one message per conversation.** The filter runs over
  `lastMessages[id]`
  (`apps/desktop/src/features/messages/ConversationList.tsx:49`). The comment
  above it (`:42`) still promises an FTS5 query "at M2"; there is no FTS5
  anywhere in `crates/store`.
- **Read receipts and typing indicators are preferences with nothing behind
  them.** The toggles exist (`apps/desktop/src/app/store.ts:116`), the tick is
  drawn from local send state
  (`apps/desktop/src/features/messages/MessageList.tsx:331`), and
  `showPresence` is explicitly discarded with `void showPresence`
  (`apps/desktop/src/features/messages/ConversationList.tsx:364`,
  `apps/desktop/src/features/messages/MessagesHeader.tsx:51`). Nothing crosses
  the wire: the `Transport` trait has no receipt, typing or presence call
  (`crates/client/src/transport.rs:153`).
- **No rate limiting exists anywhere on the server.** `router()` composes the
  route groups and one `TraceLayer` (`apps/server/src/lib.rs:38`); there is no
  limiter crate in `apps/server/Cargo.toml`. BRIEF §4.5 asks for three specific
  limits.

**What is honest, and should stay that way.** `docs/THREAT-MODEL.md` §2.1 says
the feed and profile media are plaintext and server-readable, §2.2 refuses to
claim metadata privacy, §2.5 says exactly what the PIN is and is not worth, and
§5 says the password scheme is not a PAKE. That is a better threat model than
most shipped messengers have. One claim in it is not true of the code, and §4.1
below is about that one.

---

## 2. Feature comparison

Marked against what a user notices. **Built** means it works end to end today;
**partial** means the mechanism exists but does not do what a user would assume
from the label; **absent** means there is no code for it.

| | Nexo | Signal | Telegram |
|---|---|---|---|
| **E2EE by default** | **Built** — every conversation is an MLS group, no plaintext mode (`crates/crypto/src/mls.rs:170`) | Yes, all chats | **No.** Cloud chats are client–server encrypted; only Secret Chats are E2EE ([Telegram FAQ](https://telegram.org/faq)) |
| **Multi-device** | **Absent** — one device per account, by decision (`docs/PLAN.md`, "Decisions taken"); the login handler replaces the session (`apps/server/src/auth/mod.rs:308`) | Yes — Sesame gives each device its own session ([Sesame §3.1](https://signal.org/docs/specifications/sesame/)) | Cloud chats: yes. Secret chats: no — "associated with specific devices (or rather with authorization keys), not users" ([core.telegram.org](https://core.telegram.org/api/end-to-end)) |
| **Message editing** | **Absent** — no command exists (`apps/desktop/src-tauri/src/lib.rs:89`) | Yes, up to 10 edits in 24 h ([Signal, Fall 2023](https://signal.org/blog/new-features-fall-2023/)) | Yes |
| **Delete for me / for everyone** | **Absent for messages**; conversations can be removed from *this device* with a tombstone (`crates/store/src/lib.rs:346`) | Yes | Yes |
| **Disappearing messages** | **Absent** — out of scope in BRIEF §11 | Yes, including a default timer ([Signal](https://signal.org/blog/disappearing-by-default/)) | Secret chats only |
| **Read receipts** | **Partial** — a preference and a locally derived tick; nothing on the wire (`apps/desktop/src/app/store.ts:116`, `crates/client/src/transport.rs:153`) | Yes, opt-out | Yes |
| **Typing indicators** | **Absent** — preference only, `void showPresence` (`ConversationList.tsx:364`) | Yes | Yes |
| **Presence / last seen** | **Absent** — same | Optional | Yes |
| **Replies / quotes** | **Absent** — `Payload` has no reply variant; the message menu offers Copy, View, Save (`MessageList.tsx:236`, `:418`) | Yes | Yes |
| **Forwarding** | **Absent** | Yes | Yes |
| **Search over history** | **Partial** — conversation titles plus the single newest message (`ConversationList.tsx:49`); FTS5 promised in a comment (`:42`), never built | Yes, local index | Yes, server-side for cloud chats |
| **Backup / restore** | **Absent** — no export path; the store is the only copy (`apps/desktop/src-tauri/src/commands.rs:164`) | Yes | Cloud chats are the backup |
| **Account recovery** | **Absent by decision** (`docs/PLAN.md` risk 7); the UI says so at registration (`features/auth/AuthPage.tsx:143`) and in Settings (`SettingsPage.tsx:576`) | Yes — a PIN plus Secure Value Recovery, Argon2-stretched client-side, guess-limited in an enclave ([Signal](https://signal.org/blog/secure-value-recovery/)) | Yes, cloud account |
| **Notifications while closed** | **Partial** — tray, toasts and a 4 s poll while the process runs (`app/syncAgent.ts:160`, `src-tauri/src/commands.rs:28`); nothing after quit | Push | Push |
| **Group management** | **Partial** — create, rename, add, set a picture (`apps/desktop/src-tauri/src/lib.rs:92`); **no remove-member and no leave**, though the transport has both calls (`crates/client/src/transport.rs:268`) | Full | Full |
| **Media viewing** | **Built** — lightbox, media strip, inline images capped by size (`features/messages/Lightbox.tsx`, `src-tauri/src/conversations.rs:814`) | Yes | Yes |
| **Contact discovery** | **Built, by handle only** — no phone number is collected anywhere (`docs/PLAN.md`, "Decisions taken") | Phone number, with private contact discovery | Phone number, plus usernames |
| **Blocking** | **Built, server-enforced** (`apps/server/src/blocks.rs`, `THREAT-MODEL.md` §2.6) | Yes | Yes |
| **Reporting** | **Absent** — the feed's post menu says so out loud (`features/home/HomePage.tsx:503`) | Yes | Yes |
| **Safety numbers** | **Built for display**, **absent for change detection** — see §4.1 | Yes, with an in-conversation notice on change ([Signal](https://signal.org/blog/safety-number-updates/)) | A key image, in secret chats only |
| **Sealed sender / metadata reduction** | **Absent**, and `THREAT-MODEL.md` §2.2 says so | Yes ([Signal](https://signal.org/blog/sealed-sender/)) | No |
| **Signed installer** | **Absent** — minisign on updates only; no Authenticode certificate (`docs/RELEASING.md`) | Yes | Yes |

**The one comparison that must not be blurred.** Telegram's default is not
end-to-end encrypted. Its own FAQ says: "We support two layers of secure
encryption. Server-client encryption is used in Cloud Chats (private and group
chats), Secret Chats use an additional layer of client-client encryption," and
"All secret chats in Telegram are device-specific and are not part of the
Telegram cloud" ([telegram.org/faq](https://telegram.org/faq)). So the features
Telegram is admired for — cloud history, search across every device, seamless
multi-device — exist precisely because the server can read the messages. Copying
them is not free; it is the trade Telegram made. Nexo has already made the
opposite trade, and should not be measured against Telegram's convenience
without that being said each time.

---

## 3. The gap list, ordered by what blocks a user test

"User test" here means what `docs/PLAN.md` M9 describes: real people, real
accounts, on the production server at `api.delidev.net`, installing from a link.

### Blocking — do not run a public test without these

**B1. Key-change detection and durable verification state.**
*What it is.* Store each conversation peer's identity public key at first
contact; compare on every sync; when it differs, drop the verified state and
show a warning that survives a restart.
*Why it matters here.* `docs/THREAT-MODEL.md:227` currently tells the reader
that Nexo "warns loudly and non-dismissably when a key changes." Nothing does.
`SafetyNumber::new` is computed on demand from the live group
(`crates/client/src/conversations.rs:1196`) and the verified flag is a
`localStorage` boolean (`apps/desktop/src/app/store.ts:353`) not bound to any
key. The same document names a key-substituting server as the adversary that
safety numbers exist to catch, and puts it out of scope only *because* users
can compare them. Without change detection the ceremony is one-shot: a user who
compared digits in week one is never told when the answer changes in week two.
Signal's own framing is that "when a user's key changes, Signal has required a
manual approval process," later softened to an in-conversation notice
([Signal, *Safety number updates*](https://signal.org/blog/safety-number-updates/))
— but never to silence.
*What it touches.* One new table in `crates/store/src/lib.rs` (schema v8), a
comparison in the sync path in `crates/client/src/conversations.rs`, a field on
`ConversationView` (`apps/desktop/src-tauri/src/conversations.rs:16`), the
banner in `MessagesHeader.tsx`, and moving `verified` out of `localStorage`.
*Size.* 2–3 days. The highest value per hour in this list.

**B2. Rate limits on the auth and delivery endpoints.**
*What it is.* BRIEF §4.5's three limits: 10/min/IP on auth, 60/min/account on
KeyPackage fetches, 30/s/account on send.
*Why it matters here.* `apps/server/src/lib.rs:38` composes the router with no
limiter. `/v1/auth/login` verifies with server-side Argon2id at 19 MiB per
attempt (`apps/server/src/auth/password.rs:38`), so an unlimited login endpoint
is simultaneously an unlimited password-guessing oracle and a
memory-exhaustion lever against a single CAX21. `/v1/auth/salt` is
unauthenticated by construction. `/v1/keypackages/{handle}` consumes a
KeyPackage on every call (`apps/server/src/delivery/mod.rs:239`), so a loop can
exhaust another account's supply and stop anyone starting a conversation with
them — a denial of service the victim never sees an error for.
*What it touches.* One `tower` layer in `apps/server/src/lib.rs`, keyed by IP
for auth and by `Caller` for the rest.
*Size.* 1 day, including tests that prove the limit fires.

**B3. Authenticode signing, or an honest download page.**
*What it is.* Either the certificate from `docs/PLAN.md` risk 1, or a download
page that tells people exactly what warning they will see and why.
*Why it matters here.* Microsoft is explicit: "If a URL, a file, an app, or a
certificate has an established reputation, users don't see any warnings. If
there's no reputation, the item is marked as a higher risk and presents a
warning to the user" ([Microsoft Defender SmartScreen
overview](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)).
An unsigned installer for a *security* product is the worst possible first
impression, and teaching testers to click through "Windows protected your PC"
teaches them exactly the habit the product exists to discourage.
`docs/RELEASING.md` already models this correctly as two signatures answering
two different questions.
*What it touches.* `bundle.windows.signCommand` in `tauri.conf.json`, the
release workflow. No application code.
*Size.* Days of lead time, hours of work. Start now; it is the long pole.

**B4. Leave a group, and remove a member.**
*What it is.* Two IPC commands over transport calls that already exist
(`crates/client/src/transport.rs:268`).
*Why it matters here.* `docs/THREAT-MODEL.md` §2.6 states plainly that blocking
does not apply inside a group and that "leaving the group is the answer there,
and the client cannot do that yet." In a real test with strangers, someone
unable to leave a group they were added to is not a missing feature; it is a
harassment vector shipped knowingly.
*What it touches.* `remove_member` in `crates/crypto/src/mls.rs:126` is built;
wire it through `crates/client/src/conversations.rs`, add two commands at
`apps/desktop/src-tauri/src/lib.rs:89`, add two menu entries.
*Size.* 1–2 days.

**B5. Wrap the outbox write and the MLS state save in one transaction.**
*What it is.* `send_message` enqueues
(`crates/client/src/conversations.rs:597`) and then saves MLS state (`:601`) as
two separately autocommitted statements on the same connection.
*Why it matters here.* RFC 9420 §6.3.1 names this exact failure: "If this
persistent state is lost or corrupted, a client might reuse a generation that
has already been used, causing reuse of a key/nonce pair." A crash between the
two statements leaves a queued ciphertext at generation *N* and a persisted
ratchet at *N−1*; the next message encrypts at *N* again. The four-byte
`reuse_guard` the RFC mandates in the same section — "The sender of a message
MUST generate a fresh random four-byte 'reuse guard' value and XOR it with the
first four bytes of the nonce" — makes an actual collision a 2⁻³² event rather
than a certainty, which is why this is *medium* and not catastrophic. But the
fix is one `BEGIN`, and a reviewer will ask why it was not taken.
*What it touches.* `crates/client/src/conversations.rs` around `:597`; both
writes already go to the same `rusqlite::Connection`.
*Size.* An hour.

**B6. The server disk-encryption decision.**
*What it is.* `docs/OPS.md` Phase 0.2, still open. `docs/THREAT-MODEL.md` §8
says it is due "before the production server is built, because there is no
in-place path afterwards."
*Why it matters here.* The document is right. This is not a code change and it
cannot be deferred past the moment the machine exists.
*Size.* A decision, then a provisioning step.

### Wanted — the test will produce these as complaints

**W1. Use the WebSocket the server already has.** A 4-second poll
(`apps/desktop/src/lib/conversations.ts:272`) is 900 authenticated `sync_all`
calls per client per hour. It is visible latency in a chat app, it multiplies
the cost of B2's limits, and the server side is written and authenticated
before the upgrade (`apps/server/src/stream/mod.rs:45`). ~3 days on the client.

**W2. Search over real history.** The comment at `ConversationList.tsx:42`
describes a feature the code does not have. FTS5 inside the SQLCipher file is
the design BRIEF §6.1 already chose, and it keeps the search term off the
network by construction. ~2 days.

**W3. Delete a message, at least for yourself.** Absent entirely. It is the
most-reached-for action in any chat app. "Delete for everyone" can wait; a
local delete cannot, because there is no other way to remove something from a
store that is the only copy.

**W4. Replies.** `Payload` (`crates/protocol/src/lib.rs`) needs one variant
carrying a referenced envelope id. Threading is what makes a group conversation
legible, and Nexo's groups are otherwise complete.

**W5. Read receipts and typing indicators — or remove the toggles.** Settings
offers three privacy switches (`features/settings/SettingsPage.tsx:514`) that
control nothing leaving the machine. That is a small dishonesty in a Privacy
panel, which is the worst possible place for one. Either implement them over
the WebSocket (W1) or label them as not yet active. Removing them entirely is
also defensible: they are the two features that leak the most about a user's
attention.

**W6. Report a user.** Blocking exists; reporting does not, and the feed
already admits it (`features/home/HomePage.tsx:503`). For a public feed with
real accounts this is closer to blocking in importance than it looks — you will
need somewhere for "this person posted something illegal" to go, which is also
`BRIEF.md` §13's point about obligations.

### Later — genuinely not needed for a first test

- **Multi-device.** Sesame ([Signal](https://signal.org/docs/specifications/sesame/))
  shows the shape, and `crates/crypto/src/mls.rs:37` already makes the MLS
  member a *device*, so the schema does not change. Deferred correctly.
- **Sealed sender.** A real metadata improvement
  ([Signal](https://signal.org/blog/sealed-sender/)) and explicitly out of
  scope in `THREAT-MODEL.md` §2.2.
- **Disappearing messages, forwarding, post-quantum ciphersuite.** BRIEF §11.
- **Encrypted key backup behind a recovery code.** `docs/PLAN.md` risk 7 calls
  this the v0.2 answer. It stays a v0.2 answer — but see the trade-off below.
- **TLS pinning.** `docs/PIN-ROTATION.md` records the decision not to pin and
  why. That reasoning holds.
- **Redis fan-out.** One process, one machine. `docs/PLAN.md` G5 has it right.

### Trade-offs you are choosing, stated as such

- **No account recovery, one device.** Survivable for a first test, and the UI
  says so twice (`AuthPage.tsx:143`, `SettingsPage.tsx:576`). Understand what it
  means for the test itself: every tester who reinstalls Windows, replaces a
  laptop, or clears `%APPDATA%` is gone, along with the conversation you were
  trying to observe. Signal solved this with a guess-limited enclave rather than
  by accepting the loss ([Signal](https://signal.org/blog/secure-value-recovery/)).
  You are choosing attrition over that complexity, which is defensible for
  v0.1 — just plan for a cohort that shrinks.
- **A public feed with no follow graph.** Settled, and `THREAT-MODEL.md` §2.1 is
  honest about the consequence. What to watch in a real test is that one global
  reverse-chronological feed with no filtering is also one global surface for
  whatever the first stranger decides to post — which is why W6 sits higher than
  its feature weight suggests.

---

## 4. Security review preparation

What an external reviewer would ask for, and what they would find.

### 4.1 Key handling — the finding that matters

Private key material is handled well. The Ed25519 identity keypair has no
`Debug`, no `Clone`, no `Serialize`, and the only way out is a greppable
`secret_bytes()` returning `Zeroizing` (`crates/crypto/src/identity.rs:51`,
`:82`). The SQLCipher key exists in memory in a `Zeroizing` buffer and on disk
only DPAPI-wrapped (`crates/store/src/key.rs:41`), rendered as a raw `x'…'`
blob literal so SQLCipher does not re-derive it (`:84`). `Conversation` and
`EncryptedStore` both have hand-written `Debug` impls that refuse to print
state (`crates/crypto/src/mls.rs:155`, `crates/store/src/lib.rs:79`).

**The gap is not in handling keys; it is in noticing when one changes.**

Four facts compound:

1. `login` generates a **fresh** identity keypair whenever the local store has
   none — `None => IdentityKeypair::generate()`
   (`crates/client/src/session.rs:201`). Reinstalling, or signing in on a
   second machine, silently gives the account a new cryptographic identity. The
   doc comment above it explains why key reuse matters, and then the `None` arm
   does the other thing — correctly, because there is nothing else it can do.
2. The server accepts that new key and **inserts an additional device row**:
   `INSERT INTO devices … ON CONFLICT (identity_pubkey) DO UPDATE SET last_seen`
   (`apps/server/src/auth/mod.rs:319`). Old device rows are not deleted; only
   refresh tokens are revoked (`:311`). So "one device per account" is enforced
   at the session, not at the device table.
3. `claim_key_package` selects the oldest unconsumed KeyPackage across **all**
   of a handle's devices (`apps/server/src/delivery/mod.rs:239`). After a
   reinstall, a peer starting a conversation can therefore claim a KeyPackage
   belonging to a device that no longer exists, and the Welcome goes nowhere.
   *Read from the code; not reproduced against a running server — treat this as
   a strong suspicion, not a confirmed defect.*
4. No peer identity key is ever recorded locally (`crates/store/src/lib.rs` —
   eight tables, none for contacts), so nothing can detect (1) from the other
   side. `docs/THREAT-MODEL.md:227` says the app "warns loudly and
   non-dismissably when a key changes."

A reviewer will read that sentence, grep for the warning, find nothing, and
then discount the rest of the document — which would be unfair, because the
rest of it is unusually accurate. **Fix the code (B1), and until it lands,
correct the sentence.**

RFC 9420 §5.3.1 defines the Authentication Service as the party that validates
"that the credential's presented identifiers are correctly associated with the
`signature_key` field", and §3 states that MLS "assumes a trusted AS but a
largely untrusted DS"
([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)). Nexo's server is
both, and its own threat model names it as an adversary — so the safety-number
path is not a nicety here. It is the only thing standing between the design and
its stated adversary.

### 4.2 The IPC boundary

Strong, and deliberately so. `apps/desktop/src-tauri/src/lib.rs:63` lists every
command in one place, and `AttachmentView` is asserted by test to leak neither
the AES key, the nonce, nor the S3 object key
(`apps/desktop/src-tauri/src/conversations.rs:918`). Tokens live in
`SessionState` inside the Rust process (`apps/desktop/src-tauri/src/auth.rs:28`)
and never cross. The CSP in `tauri.conf.json` matches BRIEF §4.5 exactly.

Two things a reviewer will question:

- **`fs:scope` allows writing anywhere under `$HOME`**
  (`apps/desktop/src-tauri/capabilities/default.json`): `$DOWNLOAD/**`,
  `$DOCUMENT/**`, `$DESKTOP/**`, **`$HOME/**`**. The last subsumes the other
  three and includes `%APPDATA%`, which is where `store.db` and the
  DPAPI-wrapped keyring live. Tauri's own guidance is that capabilities exist to
  "Minimize impact of frontend compromise"
  ([Tauri, *Capabilities*](https://v2.tauri.app/security/capabilities/)), and
  BRIEF §4.5 says "no broad `fs`". Since every save already goes through the
  native Save dialog (`apps/desktop/src/lib/native.ts:56`), the scope can
  almost certainly drop to the three named folders — or to nothing, if the
  dialog's returned path is written by Rust rather than by the WebView.
- **Clipboard read** is documented and justified in `THREAT-MODEL.md` §2.7.
  That is the right way to record a widened capability. Leave it; a reviewer
  accepts a reasoned exception far more readily than an unexplained one.

### 4.3 The local store

Correct in structure. The plaintext history, the identity secret, the MLS blob,
the refresh token, and the attachment payloads that carry AES keys all live
inside the single SQLCipher file (`crates/store/src/lib.rs:146`, `:266`), and
the v3 migration explains *why* the payload must be written at arrival —
because MLS refuses a replay, so the key cannot be recovered by decrypting a
second time. That is exactly the reasoning a reviewer wants beside a stored key.

Two questions to expect:

- **DPAPI is called with no `pOptionalEntropy`.** Microsoft's documentation is
  that "Typically, only a user with logon credentials that match those of the
  user who encrypted the data can decrypt the data" and — importantly — that "a
  user with a roaming profile can decrypt the data from another computer on the
  network"
  ([CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)).
  Any process running as that user can unwrap the keyring blob. That is already
  out of scope in `THREAT-MODEL.md` §4 ("malware running as the user"), and
  adding entropy would not change the scope — but the roaming-profile sentence
  is a real qualification on "useless on any other machine"
  (`crates/platform/src/dpapi.rs:1`), and the module comment should say so.
- **MLS state is one serialised blob**, rewritten wholesale on every change
  (`crates/client/src/mls_state.rs:59`). The reasoning at `:7` is sound for one
  device and one process; the decode is length-checked against overrun (`:105`)
  with tests for truncation and absurd lengths, and the revisit trigger is
  written down. A reviewer will accept this. What they will catch is B5 — the
  missing transaction around it.

### 4.4 Token lifecycle

The best-covered area in the server. Algorithm pinned to EdDSA rather than read
from the token header (`apps/server/src/auth/tokens.rs:131`) with a test for a
token signed by another key (`:290`); claims deliberately carry identifiers and
no personal data (`:31`); refresh tokens stored only as SHA-256, with the
reasoning for *not* using Argon2 on 256 bits of uniform randomness written down
(`:166`); reuse outranks every other rejection and revokes the family (`:201`,
`:314`). The client serialises refreshes behind a mutex specifically so that two
concurrent 401s cannot look like theft (`crates/client/src/http.rs:63`) — a
subtle bug most implementations ship.

Expect one question: `change-password` requires the current verifier *as well
as* a bearer token (`crates/client/src/session.rs:340`,
`crates/client/src/transport.rs:192`) and retires other sessions. Good. But
`THREAT-MODEL.md` §4 correctly notes that someone who knows the password can
change it first, and there is no second factor by design. That is a stated
limitation, not a finding.

### 4.5 Transport

TLS is terminated by Caddy; the server listens plaintext on loopback
(`apps/server/src/lib.rs:1`). The base URL is compiled in, and `NEXO_API_BASE`
overrides it **only in debug builds** (`crates/client/src/http.rs:96`), with a
test asserting the default is `https://` (`:666`). That is the right shape: a
shipped binary cannot be redirected by an environment variable. No pinning, by
recorded decision (`docs/PIN-ROTATION.md`).

The link-preview fetcher is the most adversarial input surface in the client
and is treated as one: no `http`, no redirects, no private/loopback/link-local
address *after* DNS resolution, HTML only, a 256 KB ceiling
(`apps/desktop/src-tauri/src/preview.rs:320`, and `THREAT-MODEL.md` §2.3). Off
by default. A reviewer will spend twenty minutes here and leave satisfied.

### 4.6 The unsigned installer

Covered in B3. `docs/RELEASING.md` already separates Authenticode ("who
published this file?") from minisign ("did the same project sign this
update?") and does not pretend one substitutes for the other. The updater path
is the stronger half and is already done: manifests verified against a public
key pinned in `tauri.conf.json`, with no unsigned install path.

### 4.7 Dependency posture

`cargo deny` runs twice, once per target, because a union graph would judge the
Windows client against the Linux server's dependencies (`deny.toml`, and the
`supply-chain` job in `.github/workflows/`). Copyleft is denied at the licence
level with the reason — `libsignal` is AGPL-3.0-only — written into the policy
file. `libsignal-protocol` and `openssl` are explicitly banned crates. Every
ignored advisory carries a reachability claim a reviewer can check, and
`.cargo/audit.toml` goes further by recording one advisory that is deliberately
**not** ignored, with the reasoning for leaving the warning in place.

One thing to schedule rather than argue about: `RUSTSEC-2026-0212`
(constant-time swap on aarch64) is ignored on the grounds that v0.1 ships
x86_64 Windows only. That is true today and false the moment `BRIEF.md` §12's
Android port starts. Both files already say so. Keep saying so.

Nothing sensitive is committed: `git ls-files` shows no `.env`, `.pem`, `.key`
or `keyring.bin`, and `.gitignore` covers all of them.

### 4.8 Is `docs/THREAT-MODEL.md` honest?

Mostly, and unusually so. Verified line by line against the code:

| Claim | Verdict |
|---|---|
| §1 message bodies E2EE with MLS | True (`crates/crypto/src/mls.rs:274`) |
| §1 attachments AES-256-GCM, key inside the MLS message | True (`crates/crypto/src/attachment.rs:86`) |
| §1 store SQLCipher under a DPAPI-wrapped key | True (`crates/store/src/key.rs:41`) |
| §1 updates minisign-verified against a pinned key | True (`tauri.conf.json`, `src-tauri/src/commands.rs:307`) |
| §2.1 feed and profile media are plaintext, server-readable | True, and said in the UI |
| §2.2 metadata is visible to the server | True, understated if anything |
| §2.3 link previews and the refusal list | True (`src-tauri/src/preview.rs`) |
| §2.5 the PIN is a convenience bound to DPAPI, five attempts | True (`crates/client/src/pin.rs:39`, `:163`) |
| §2.6 blocking is server-enforced, does not apply in groups | True (`apps/server/src/delivery/mod.rs:711`) |
| §2.7 the WebView can read the clipboard | True, and the cost is stated |
| §3 auto-lock drops the store and the MLS state | True (`src-tauri/src/commands.rs:81`) |
| §4 "warns loudly and non-dismissably when a key changes" | **False.** No such code exists |
| §5 not a PAKE; a live-compromised server sees the verifier | True (`apps/server/src/auth/password.rs:1`) |

One false line in thirteen is a good ratio. It is also the most consequential
line in the document, which is why B1 is first.

Two further things a reviewer would note as *not stated anywhere*: the absence
of any rate limiting (BRIEF §4.5 promises it; the threat model does not mention
that it is missing), and the fact that "one device per account" is enforced by
session revocation rather than by the device table (§4.1 above).

Mapped to a review framework, the residual findings cluster in three of OWASP
MASVS's groups ([MASVS](https://mas.owasp.org/MASVS/)): **MASVS-AUTH** (no rate
limiting, B2), **MASVS-CRYPTO** (no key-change detection, B1; the untransacted
ratchet save, B5), and **MASVS-PLATFORM** (the `$HOME/**` filesystem scope,
§4.2). MASVS-STORAGE, MASVS-NETWORK and MASVS-CODE would pass on what is here.

---

## 5. A path to a production user test

Five milestones. The order is chosen so each one removes a reason the *next*
one's findings would be untrustworthy.

**T1 — Make the honest documents true again (½ day).** Either land B1 or amend
`docs/THREAT-MODEL.md:227`, and add the missing rate-limiting line. This comes
first because everything downstream — a reviewer's confidence, a tester's
trust, your own risk register — is calibrated against that document, and one
false sentence in it costs more than the feature it describes.

**T2 — Close the blocking security gaps (4–6 days).** B1 (key-change
detection), B2 (rate limits), B5 (the transaction), in that order. B1 is the
largest and touches the schema, so it should not race anything else; B2 is
independent and can run in parallel on the server; B5 is an hour and should ride
along with B1's changes to the same file. B6, the disk-encryption decision, has
to be made before the machine is provisioned and depends on none of this.

**T3 — Close the blocking product gaps (2–3 days).** B4 (leave and remove
member), and W6 (report) if the feed will be public during the test, which it
will be. These come before T4 because they are the two things a tester can
encounter that you cannot fix for them remotely.

**T4 — Sign, and install for real (lead time, then 1 day).** B3. Start the
certificate purchase during T1 — weeks, not days (`docs/PLAN.md` risk 1). Then
run M9's outstanding clean-VM pass: install, register, message, update. Also
outstanding from M8: tray, toast and lock on a real Windows machine, since those
paths compile only there. This comes after T2 and T3 because a signed installer
is what you hand to people, and handing out a build you then have to replace
burns the SmartScreen reputation you have just started accruing.

**T5 — Two machines, two people, one week (ongoing).** `docs/PLAN.md` M4's
outstanding item — "an actual two-machine run" — is still open, and M9's VM pass
is not the same test. Run W1 (the WebSocket) *before* this if you can spare
three days, because a 4-second poll under real rate limits is the first thing a
second machine makes visible; run it after if you cannot, because polling works
and slowness is a finding you can act on. W2 (search), W3 (delete), W4 (replies)
and W5 (receipts) are what the test itself should decide the order of. That is
what a test is for.

---

## Sources

Primary sources only. Everything below is published by the party that owns the
claim.

**Signal**
- Sesame Algorithm specification — https://signal.org/docs/specifications/sesame/
- Safety number updates — https://signal.org/blog/safety-number-updates/
- Secure Value Recovery — https://signal.org/blog/secure-value-recovery/
- Sealed sender — https://signal.org/blog/sealed-sender/
- New Features Roll Call: Fall 2023 (message editing) — https://signal.org/blog/new-features-fall-2023/
- Embrace ephemerality with default disappearing messages — https://signal.org/blog/disappearing-by-default/

**Telegram**
- Telegram FAQ (cloud chats versus secret chats) — https://telegram.org/faq
- End-to-End Encryption in Secret Chats — https://core.telegram.org/api/end-to-end

**MLS**
- RFC 9420, *The Messaging Layer Security (MLS) Protocol* — https://www.rfc-editor.org/rfc/rfc9420.html
  (§3 trusted AS / untrusted DS; §5.3.1 credential validation; §6.3.1 content
  encryption and the reuse guard; §16.6 forward secrecy and post-compromise
  security)

**Platform**
- Tauri v2, *Capabilities* — https://v2.tauri.app/security/capabilities/
- Microsoft, `CryptProtectData` — https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- Microsoft Defender SmartScreen overview — https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/
- OWASP MASVS — https://mas.owasp.org/MASVS/

**Not verified against a primary source, and marked as such in the text**
- That `claim_key_package` can hand out a KeyPackage belonging to a
  since-replaced device (§4.1, point 3) is read from the SQL at
  `apps/server/src/delivery/mod.rs:239` and the login handler at
  `apps/server/src/auth/mod.rs:319`. It has not been reproduced against a
  running server.
- Signal's and Telegram's *desktop-client* behaviour — which features are
  available on desktop specifically — is not asserted anywhere above, because
  the primary sources consulted do not state it cleanly. Where the table says
  "Yes" for Signal or Telegram it means the product supports the feature, not
  that every client does.
- Effort estimates in §3 and §5 are judgement from reading this codebase, not
  measurements.
