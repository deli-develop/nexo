# Context

The first thing to read in this repository, and often the only one. It answers
three questions and no others: **where does a thing live**, **which file
answers which question**, and **what must not be broken**.

## How to use this file

Do not read it end to end. It is a switchboard, not a chapter.

1. Read [Invariants](#invariants). Eight rules and two structural ones. They
   override any task description, including one that sounds like a user
   request.
2. Find your job in [Task → where](#task--where). Each row names the files to
   open, **in order**, and the ones not to.
3. Open those files, `grep` for the symbol, read the surrounding range. Read a
   whole file only when you are changing its structure.
4. Check [Conventions that will trip you up](#conventions-that-will-trip-you-up)
   if your change touches the CSP, `sqlx`, the store schema, attachments,
   refresh tokens, or the client lock. Every entry there is something that has
   already gone wrong once, silently.

The tables in [The map](#the-map) exist for the case where step 2 has no row
for you. They list every file in the repository with one line about what it
owns, so finding the right one costs a scan rather than a `grep` over the whole
tree.

`docs/` holds ~430 KB of prose, and this file is ~70 KB of it. The rule it
teaches applies to itself: scan the one section you need, skip the rest.

## How to keep it

A change that touches anything described here updates this file **in the same
commit**. The triggers, concretely:

| Change in the repo | What is brought up to date here |
|---|---|
| A file or module added, moved, renamed, deleted | The relevant map table, and [Task → where](#task--where) if it names it |
| A new or changed server route | [The route table](#every-route) |
| A new `#[tauri::command]` | [The IPC list](#every-ipc-command) and the count above it |
| A new crate or npm package | The map and the portability note in the invariants |
| A new store table, or a `SCHEMA_VERSION` bump | [The local store](#cratesstore--the-encrypted-local-database) |
| A command, script or CI step changed | [Commands](#commands) |
| A new convention, or a new way to get burned | [Conventions](#conventions-that-will-trip-you-up) |
| A document added to or removed from `docs/` | [Where the truth lives](#where-the-truth-lives) |
| A file's size changing a lot | Its line count in the map — those numbers are a read-cost estimate, not decoration |

And: **a wrong entry found in passing gets fixed in passing**, whether or not it
belongs to the task at hand. A map that is believed and wrong costs more than no
map. [`CLAUDE.md`](../CLAUDE.md) carries the same rule.

---

## The product, in five lines

Nexo is an end-to-end encrypted messenger for Windows 10/11, with a public feed
and public profiles beside private conversations. Messages are E2EE with MLS
(RFC 9420) via OpenMLS; the server stores and forwards ciphertext it cannot
read. Feed posts and profiles are **not** encrypted — they are public to any
logged-in user, and the UI says so rather than implying otherwise. Conversation
metadata (who, when, how big) is visible to the server. Android is a later port
that must not require a rewrite, which is why the layering below is strict.

Current version: `0.1.23`. The authority is `[workspace.package] version` in
`Cargo.toml`, and `apps/desktop/src-tauri/tauri.conf.json` has to agree with it
— the release workflow refuses a tag that does not match.
Current state: [`STATUS.md`](STATUS.md). Milestones: [`PLAN.md`](PLAN.md).
Upstream: <https://github.com/deli-develop/nexo>.

---

## Invariants

From [`BRIEF.md` §1](BRIEF.md). If a task conflicts with one of these, the rule
wins and the conflict gets flagged rather than resolved silently.

| # | Rule | Where it lives / is enforced |
|---|---|---|
| 1 | Never invent cryptography. | `crates/crypto` only wraps OpenMLS; no primitive is written here. |
| 2 | No key material in the WebView. | The seam is `apps/desktop/src-tauri`. The frontend receives decrypted strings over IPC and nothing else. |
| 3 | No remote code in the client. | Strict CSP in `tauri.conf.json`; everything bundled, no CDN, no `eval`. |
| 4 | The server must never read message contents. | `crates/protocol` carries no plaintext types; `apps/server/src/delivery` moves opaque envelopes. |
| 5 | Be honest in the UI about what is encrypted. | Feed and profile surfaces say they are public. Never "military grade", never "unhackable". |
| 6 | Zeroize secrets. | `zeroize` on key material, MLS buffers, password bytes — `crates/store/src/key.rs`, `crates/client/src/pin.rs`. |
| 7 | Fail closed. | A decryption failure renders as "can't decrypt", never a plaintext fallback and never a silent skip. |
| 8 | Every dependency pinned. | `=x.y.z` in `Cargo.toml`, exact versions in `package.json`, both lockfiles committed, `cargo deny` + `cargo audit` + `pnpm audit` in CI. |

Two structural rules of the same weight:

- **`crates/protocol`, `crates/crypto` and `crates/platform` must compile
  unchanged for Android.** No I/O, no OS calls, no HTTP. Every platform call
  goes behind `nexo-platform`. Adding a dependency to one of those three is a
  portability decision, not a convenience.
- **`crates/client` has no platform calls and no HTTP client of its own.** It
  reaches the OS through `SecureStore` and the network through the `Transport`
  trait, both supplied by the shell around it. The `http` feature adds
  `HttpTransport` (ureq) *and* the WebSocket, and stays off for anything that
  wants to remain portable.

---

## The map

Line counts are source only — tests are counted with the crate they test, in the
tables below.

```
crates/protocol       1 608 ln   Wire types shared by client and server. No I/O, no crypto.
crates/crypto         1 863 ln   MLS, the identity keypair, safety numbers, attachment crypto.
crates/crypto-wasm      479 ln   The same, through wasm-bindgen, for a browser engine.
crates/platform         427 ln   The OS seam: SecureStore, and the Windows DPAPI backing.
crates/store          4 113 ln   The client's SQLCipher database.
crates/client         7 248 ln   Session logic, portable across Windows and Android.
apps/server           8 299 ln   axum API + MLS Delivery Service (Linux aarch64).
apps/desktop/src-tauri
                      6 968 ln   The Windows shell: 103 Tauri commands, windowing, IPC.
apps/desktop/src     22 314 ln   React 19 client (TypeScript, Tailwind, Zustand).
packages/design-tokens           Colour, type, radius, motion. CSS authored, JSON derived.
packages/crypto-wasm             Builds crates/crypto-wasm into an npm package. Generated, not committed.
```

Counted the same way each time: every `.rs` under a crate's `src/`, every
`.ts`/`.tsx` under the page, tests included where they live inside those files
and excluded where they have a directory of their own. The figures above were
remeasured in full after several were found to have drifted; adjusting a stale
number by a delta keeps it stale.

The dependency direction is one-way and worth holding in your head:

```
protocol  ←  crypto   ←  client  ←  src-tauri  ←  src (React, over IPC)
             crypto   ←  crypto-wasm  ←  packages/crypto-wasm  (the web path)
             store    ←  client
             platform ←  store, client
protocol  ←  server                    (the server shares only the wire types)
```

Nothing below `client` knows about Tauri. Nothing in `src` (React) knows about
Rust except through `invoke()` in `lib/*.ts`.

### A consumer outside this repository

`nexo-web` — <https://github.com/deli-develop/nexo-web> — is the web client,
deployed to `nexo.delidev.net` on Netlify. It is a **separate repository**, not
a package here, and it is the reason three things in this one look the way they
do:

- **`apps/server` has a CORS layer.** `NEXO_CORS_ORIGINS` names the browser
  origins allowed to call the API, and unset means no layer at all. The desktop
  app sends no `Origin` header, so this is invisible to it. Never `*` —
  `parse_origins` refuses one at startup.
- **`packages/design-tokens` has a second consumer**, which holds a *copy*
  pinned to a commit here rather than importing the package. Generated values
  only; the exception does not extend to anything with logic in it.
- **`crates/crypto` compiles to WASM, and this is now true rather than
  aspirational.** An earlier version of this paragraph claimed it before it
  was, which is why it is worth saying plainly: `crates/crypto-wasm` is a
  `wasm-bindgen` facade over it, `packages/crypto-wasm` builds that into an npm
  package, and the `crypto-wasm` job in `ci.yml` drives two devices through a
  real MLS conversation against it. `crates/client` will **not** compile for
  WASM, and that one is genuine: `crates/store` is SQLCipher over vendored
  OpenSSL, which is C and has no business in a browser. That is why session
  logic is being reimplemented in TypeScript — see [`REWORK.md`](REWORK.md)
  wave 6.

Its own map is `docs/CONTEXT.md` in that repository, and its threat model is
`docs/WEB-THREAT-MODEL.md` there — the web build does not inherit invariants 2,
3 and 6 unchanged, and that file is where the differences are written down.

---

### `crates/protocol` — the wire

Shared by both sides, so a change here is a change to both. **Change this
first**; the server and client follow it.

| File | Ln | Owns |
|---|---|---|
| `src/lib.rs` | 1 938 | Every request and response body on the wire, `PROTOCOL_VERSION` (currently **3**), the envelope shape, the error codes. No plaintext message types — that is rule 4's enforcement point. |
| `src/window.rs` | 125 | How long a message may be taken back or edited. `features/messages/MessageList.tsx` mirrors this constant; the two must agree. |

---

### `crates/crypto` — MLS and the keys

Wraps OpenMLS. Rule 1 lives here: nothing in this crate implements a primitive.

| File | Ln | Owns | Open it when |
|---|---|---|---|
| `src/lib.rs` | 131 | The crate doc, the ciphersuite choice, `KEY_PACKAGE_TARGET` (**50**). | Getting oriented before touching anything else here. |
| `src/mls.rs` | 569 | Group creation, membership, commits, `credential_for`. | Anything touching group membership or message encryption. |
| `src/identity.rs` | 435 | The long-term identity keypair, safety numbers, fingerprints. | Identity, verification, the Security screen. |
| `src/attachment.rs` | 728 | Attachment encryption — **two encodings**, whole and segmented. | Media that must stay unreadable to the server. Read the encoding note in [Conventions](#conventions-that-will-trip-you-up) first. |

Tests: `tests/conversation.rs` (433 ln) drives two members through a real group;
`tests/mls_smoke.rs` (153 ln) is the shortest path that proves OpenMLS is wired
up. Do not touch OpenMLS internals.

---

### `crates/crypto-wasm` — the same crypto, for a browser engine

A `wasm-bindgen` facade over [`crates/crypto`](#cratescrypto--mls-and-the-keys)
and **not** a second implementation: nothing in it computes anything, so rule 1
is where it always was. It exists because a browser has no Rust process under
it, and [`REWORK.md`](REWORK.md) makes one page serve web, Windows and Android.

| File | Ln | Owns |
|---|---|---|
| `src/lib.rs` | 479 | `Device` (identity, credential, signer, MLS provider) and `Group` (one conversation). Also the state blob, encoded exactly as `crates/client/src/mls_state.rs` encodes it. |

Three things to know before touching it:

- **The wasm-only dependencies are target-scoped**, in a
  `[target.'cfg(target_arch = "wasm32")'.dependencies]` table. Cargo unifies
  features across a workspace build, so moving `getrandom/js` up into the
  ordinary `[dependencies]` would switch the JavaScript backend on for
  `nexo-client` and `nexo-server` as well.
- **getrandom 0.3 also needs a cfg**, not only a feature. It is in
  `.cargo/config.toml`, scoped to the wasm target. Without it the build fails
  at link time with a message about the `wasm_js` backend.
- **`wasm-bindgen-cli` must match the `wasm-bindgen` crate exactly.**
  `packages/crypto-wasm/scripts/build.mjs` refuses to run when they disagree,
  because a mismatch produces a module that loads and then fails on the first
  call.

The state codec is written twice today — here and in
`crates/client/src/mls_state.rs`, byte for byte — and wave 6 moves it into
`crates/crypto` so there is one of it.

---

### `crates/platform` — the OS seam

| File | Ln | Owns |
|---|---|---|
| `src/lib.rs` | 54 | The `SecureStore` trait and `STORE_KEY_NAME`. **The whole seam.** Adding an OS capability means adding a trait method here and implementing it per platform. |
| `src/dpapi.rs` | 371 | Windows DPAPI. **The only `unsafe` in the workspace**, confined to `dpapi::ffi`. `src-tauri` carried the other until calls were removed; it is `forbid(unsafe_code)` again. One file per secret under `%APPDATA%\Nexo`, with name-bound extra entropy so one blob cannot be unwrapped as another. |

Read `dpapi.rs`'s module header before touching it. The named secrets in use are
`store-db-key`, `nexo-unlock-pin` and `nexo-unlock-pin-attempts`; each becomes
`<name>.bin` in that directory beside `store.db`.

---

### `crates/store` — the encrypted local database

SQLCipher, one file at `%APPDATA%\Nexo\store.db`. **`src/lib.rs` is 4 019 lines
— never read it top to bottom.** `grep` the table name and read the range around
it.

| File | Ln | Owns |
|---|---|---|
| `src/lib.rs` | 4 019 | `SCHEMA_VERSION`, `migrate()`, and every query. Also `default_path()` and `delete()`. |
| `src/key.rs` | 201 | The store key: zeroized in memory, OS-wrapped on disk, nowhere else. `load_or_create` reports whether it *created* one, which is how a caller tells "first run" from "orphaned database". |

`SCHEMA_VERSION` is **19**. The tables:

```
account          conversation_peers   conversations   drafts
folder_members   folders              forgotten_conversations
identity         message_reactions
messages         mls_state            outbox          pinned_messages
refresh_token    stories              view_once
messages_fts   (fts5 virtual table — backs conversation search)
```

Add a column with the `add_column` helper, never a bare
`ALTER TABLE ... ADD COLUMN` — see [Conventions](#conventions-that-will-trip-you-up).

---

### `crates/client` — the portable core

No platform calls, and no HTTP client except behind the `http` feature. This is
the crate that has to survive the Android port.

| File | Ln | Owns | Open it when |
|---|---|---|---|
| `src/lib.rs` | 813 | The crate doc, the re-exports, and the in-crate `FakeTransport` its own tests use. | Getting oriented; finding what is public. |
| `src/conversations.rs` | 2 622 | Conversation lifecycle: create, join, send, sync, attachments, reactions, edits, retractions, key packages, call signalling. `Context<'a, T>` is the borrow bundle every call takes. | Most messaging behaviour. |
| `src/session.rs` | 582 | `register`, `login`, `restore`, `resume`, `change_password`, `logout`, `delete_account_on_server`, `wipe_local`. The session state machine. | Auth on the client. |
| `src/http.rs` | 1 262 | `HttpTransport` over `ureq`: retries, error mapping, and the access-token refresh with its **rotated-token hand-off**. Behind `http`. | Wire-level client behaviour. |
| `src/transport.rs` | 492 | The `Transport` trait — the network seam. | Adding a call. Then implement it in **all seven** places (see Conventions). |
| `src/stream.rs` | 357 | The WebSocket client. Behind `http`. | Live events. |
| `src/feed.rs` | 343 | Feed and profile calls. Not encrypted, on purpose. | Feed or profile behaviour. |
| `src/pin.rs` | 323 | The unlock PIN: a salted Argon2id verifier, DPAPI-wrapped, attempt-limited (`MAX_ATTEMPTS = 5`, 4–12 digits). | The lock screen path. |
| `src/people.rs` | 87 | Search, invitations, reporting — what Meet&Greet left behind. | Finding somebody, or letting a stranger past a private account. |
| `src/stories.rs` | 215 | Stories: encrypted once, the key handed to every contact. | Stories. |
| `src/mls_state.rs` | 209 | Persisting and restoring the MLS provider across restarts. | A restart losing group state. |
| `src/outbox.rs` | 188 | The offline queue. | Send-while-offline behaviour. |
| `examples/peer.rs` | 215 | A headless second client — register, start, send, sync, list — keeping its store under a per-handle directory in `%TEMP%`. Behind `required-features = ["http"]`. | Driving the desktop app against a real peer. The GUI is one process with one account and the single-instance plugin means no second window, so the other side of a conversation runs here. |

Tests (`crates/client/tests/`), each building its own fake transport:

| Test | Ln | Proves |
|---|---|---|
| `live_messaging.rs` | 960 | Two clients exchange messages — and call signalling — against a real local server. |
| `offline_queue.rs` | 588 | A cut network queues and later flushes, in order, without duplicates. |
| `leftover_conversations.rs` | 366 | A conversation the server lists but this device cannot open is not shown as broken. |
| `stories.rs` | 348 | Story creation, listing and expiry. |
| `mls_persistence.rs` | 172 | Group state survives a restart. |
| `live_auth.rs` | 168 | Register, login, refresh, logout against a real server. |
| `wipe.rs` | 140 | Sign-out erases the PIN and the key even when the unlink fails. |

---

### `apps/server` — the API and Delivery Service

axum, Postgres via `sqlx`, Linux aarch64 in production. `src/lib.rs` (102 ln) is
the router and the crate doc; `src/main.rs` (100 ln) is startup only. **Each
module owns its own `router()`**, merged in `lib.rs`.

| File | Ln | Owns |
|---|---|---|
| `src/posts.rs` | 1 232 | The Home feed, posts, comments, votes, reactions, pinning. |
| `src/delivery/mod.rs` | 1 120 | The MLS Delivery Service: conversations, envelopes, members, key packages. Moves opaque bytes — rule 4. |
| `src/delivery/epoch.rs` | 111 | The commit-ordering rule, isolated so it can be reasoned about alone. |
| `src/profiles.rs` | 881 | Public profiles and per-field visibility (G2). The client never picks what is visible. |
| `src/invites.rs` | 321 | Invitations, and `may_reach` — **the private-account gate the delivery service calls before creating any conversation**. |
| `src/auth/mod.rs` | 754 | Register, login, refresh, logout, change-password, delete-account. |
| `src/auth/tokens.rs` | 345 | Access and refresh tokens, **rotation, and the reuse-is-theft response**. |
| `src/auth/bearer.rs` | 142 | Who is calling: the extractor every authenticated route depends on. |
| `src/auth/password.rs` | 117 | Argon2id verifiers. The server never sees a password. |
| `src/auth/salt.rs` | 98 | The per-account salt, and why an unknown handle still gets a (decoy) one. |
| `src/media.rs` | 480 | Presigned S3 URLs for upload and download. |
| `src/storage.rs` | 442 | Hetzner Object Storage. |
| `src/limits.rs` | 345 | Rate limits (BRIEF 4.5). |
| `src/stories.rs` | 294 | 24-hour encrypted stories. Owns the three access conditions. |
| `src/stories/expiry.rs` | 65 | Whether a story is still available. |
| `src/blocks.rs` | 243 | Blocking, in both directions. |
| `src/stream/mod.rs` | 220 | The WebSocket at `/v1/stream`. |
| `src/stream/hub.rs` | 212 | Fan-out, from the socket that accepted an envelope to the ones that want it. |
| `src/follows.rs` | 201 | The follow graph, and the feed that follows from it. |
| `src/reports.rs` | 166 | Reporting (BRIEF 13). |
| `src/state.rs` | 60 | `AppState`, handed to every handler. |
| `src/db.rs` | 35 | The Postgres pool. |
| `src/health.rs` | 21 | `/v1/health`. |

#### Every route

49 paths. Methods on one path share a line, as they do in the router.

| Path | Methods | Module |
|---|---|---|
| `/v1/health` | GET | `health.rs` |
| `/v1/auth/register` | POST | `auth/mod.rs` |
| `/v1/auth/login` | POST | `auth/mod.rs` |
| `/v1/auth/refresh` | POST | `auth/mod.rs` |
| `/v1/auth/logout` | POST | `auth/mod.rs` |
| `/v1/auth/salt` | POST | `auth/salt.rs` |
| `/v1/auth/change-password` | POST | `auth/mod.rs` |
| `/v1/auth/delete-account` | POST | `auth/mod.rs` |
| `/v1/conversations` | POST, GET | `delivery/mod.rs` |
| `/v1/conversations/{id}` | DELETE | `delivery/mod.rs` |
| `/v1/conversations/{id}/send` | POST | `delivery/mod.rs` |
| `/v1/conversations/{id}/sync` | GET | `delivery/mod.rs` |
| `/v1/conversations/{id}/members` | POST | `delivery/mod.rs` |
| `/v1/conversations/{id}/members/remove` | POST | `delivery/mod.rs` |
| `/v1/keypackages` | POST | `delivery/mod.rs` |
| `/v1/keypackages/count` | GET | `delivery/mod.rs` |
| `/v1/keypackages/{handle}` | GET | `delivery/mod.rs` |
| `/v1/feed` | GET | `posts.rs` |
| `/v1/posts` | POST | `posts.rs` |
| `/v1/posts/{id}` | DELETE | `posts.rs` |
| `/v1/posts/{id}/vote` | POST | `posts.rs` |
| `/v1/posts/{id}/react` | POST | `posts.rs` |
| `/v1/posts/{id}/pin` | POST, DELETE | `posts.rs` |
| `/v1/posts/{id}/comments` | GET, POST | `posts.rs` |
| `/v1/comments/{id}` | DELETE | `posts.rs` |
| `/v1/me` | GET, PATCH | `profiles.rs` |
| `/v1/me/visibility` | PATCH | `profiles.rs` |
| `/v1/users` | GET (search) | `profiles.rs` |
| `/v1/users/{handle}` | GET | `profiles.rs` |
| `/v1/users/{handle}/posts` | GET | `posts.rs` |
| `/v1/users/{handle}/follow` | POST, DELETE | `follows.rs` |
| `/v1/users/{handle}/follow-state` | GET | `follows.rs` |
| `/v1/blocks` | GET | `blocks.rs` |
| `/v1/blocks/{handle}` | POST, DELETE | `blocks.rs` |
| `/v1/media/upload` | POST | `media.rs` |
| `/v1/media/download` | POST | `media.rs` |
| `/v1/stories` | GET, POST | `stories.rs` |
| `/v1/stories/{id}/url` | POST | `stories.rs` |
| `/v1/invites` | GET, POST | `invites.rs` |
| `/v1/invites/{id}` | DELETE | `invites.rs` |
| `/v1/reports` | POST | `reports.rs` |
| `/v1/stream` | GET (upgrade) | `stream/mod.rs` |

**Before adding a route, check whether it already exists.** `/v1/stream` sat
unused for months, and `follows` was the opposite case.

#### Migrations

`apps/server/migrations/`, applied with `sqlx-cli`. Seventeen files, oldest first:

```
20260825090806_create_users_devices             20260902120000_create_meet
20260825112504_create_refresh_tokens            20260902160000_private_accounts
20260825133316_create_conversations_envelopes   20260902180000_create_stories
20260825170000_create_posts_profiles            20260904120000_create_follows
20260825190000_envelope_idempotency             20260906120000_self_conversations
20260827120000_posts_titles_votes_comments
20260829140000_create_blocks
20260829170000_pin_posts
20260831120000_retire_devices
20260831130000_create_reports
20260919120000_drop_meet_keep_invites
20260920090000_rename_invite_constraints
```

`drop_meet_keep_invites` is the only destructive migration in the list. It
drops the map, the agreement and the intro requests, and **renames
`meet_invites` to `invites` rather than dropping it** — that table is what
`may_reach` reads, so dropping it would have turned every private account into
an unreachable one.

`rename_invite_constraints` is its second half, and exists because
`ALTER TABLE ... RENAME TO` does **not** rename the indexes Postgres creates
behind a `PRIMARY KEY` or `UNIQUE` constraint. Those kept their old names, so
a product with no Meet&Greet still had a `meet_invites_pkey` in its schema. A
separate file rather than an edit to the first, because the first had already
been applied to a developer's database — and a migration that has been applied
anywhere is one that gets edited at somebody's cost.

A schema change is a **new file**, never an edit to an old one, and it is
followed by regenerating `.sqlx/` — see [Conventions](#conventions-that-will-trip-you-up).

#### Server tests

`apps/server/tests/` connect to `DATABASE_URL` and **skip when it is absent**.
They share one development database and never clean up, so a test must assert on
*its own* data. See the warning in [Conventions](#conventions-that-will-trip-you-up).

| Test | Ln | Covers |
|---|---|---|
| `delivery.rs` | 839 | Envelopes, epochs, membership, key packages. |
| `auth_flow.rs` | 718 | Register → login → refresh → rotation → logout. |
| `blocks.rs` | 588 | Blocking in both directions across every surface. |
| `feed_profiles.rs` | 488 | Feed paging, visibility, profile fields. |
| `follows.rs` | 337 | The follow graph and the filtered feed. |
| `s3_smoke.rs` | 126 | Object storage, presigned round trip. |

---

### `apps/desktop/src-tauri` — the Windows shell

**Rule 2 lives here.** What crosses into the WebView is already decrypted, and
nothing else does: no tokens, no key material, no salt.

| File | Ln | Cmds | Owns |
|---|---|---|---|
| `src/lib.rs` | 208 | — | The builder: managed state, plugins, and the `generate_handler!` list. **Every new command is registered here.** |
| `src/main.rs` | 7 | — | Calls into `lib.rs`. Nothing else. |
| `src/client.rs` | 209 | — | `LoggedIn` (session, transport, MLS provider, store, signer, credential), `ClientState`, `build()`, `resume()`, `Resumed`. One mutex covers store + MLS + transport. |
| `src/auth.rs` | 842 | 11 | Register, login, restore, change password, fingerprint, the PIN, sign-out, delete account. `SessionState` (tokens) lives here. |
| `src/conversations.rs` | 2 415 | 42 | Messaging, replies, attachments, voice, view-once, reactions, pinning, local delete, edit, retract, folders, drafts, search, outbox. Owns a `with_client` helper, which `stories.rs` borrows. |
| `src/feed.rs` | 943 | 25 | Posts, comments, votes, reactions, follows, blocks, profiles, images. Owns its own `with_client`. |
| `src/people.rs` | 235 | 5 | Search, reporting, invitations. Owns its own `with_client`. |
| `src/stories.rs` | 142 | 3 | Posting, listing and opening a story. **Borrows `conversations.rs`'s `with_client`, error view and `now_ms`** rather than copying them — a fourth copy of the rotated-token drain is a fourth place to forget it. |
| `src/commands.rs` | 330 | 15 | Version, notifications, tray count, **lock**, window backdrop, autostart, storage, cache, link preview, updater. |
| `src/stream.rs` | 142 | 2 | The live socket: opens it with the session, forwards typing to the page. |
| `src/media.rs` | 394 | — | The `nexo-media` custom scheme (served as `http://nexo-media.localhost/<envelope id>` on Windows): decrypted video, one byte range at a time, **without holding the client lock across the download**. |
| `src/preview.rs` | 534 | — | Link previews. Off by default, on purpose (§4.5). |
| `src/windows.rs` | 502 | — | Tray, notifications, single instance, autostart, window creation, DWM backdrop, `close_action`, `forget_account`. |

Managed state, all four registered in `lib.rs`: `auth::SessionState` (tokens),
`client::ClientState` (the `LoggedIn`), `windows::WindowPrefs`,
`stream::StreamState`. Plugins: single-instance, dialog, clipboard-manager,
opener, notification, autostart, updater.

The two pieces of state are deliberately separate, and the difference shows up
at the lock screen: **`lock` clears `ClientState` and leaves `SessionState`**, so
the tokens survive a lock and `unlock_with_pin` can rebuild the client from them
without touching the network.

#### Every IPC command

**103 commands.** A command needs a `#[tauri::command]` attribute *and* an entry
in `generate_handler!` in `lib.rs`; missing the second is a runtime rejection,
not a compile error.

**`auth.rs` (11)**
`register` · `login` · `restore_session` · `change_password` ·
`device_fingerprint` · `pin_status` · `set_pin` · `clear_pin` ·
`unlock_with_pin` · `logout` · `delete_account`

**`commands.rs` (15)**
`app_version` · `notify_message` · `set_unread` · `lock` · `is_unlocked` ·
`focus_window` · `set_window_backdrop` · `set_close_to_tray` · `get_autostart` ·
`set_autostart` · `storage_info` · `clear_media_cache` · `preview_link` ·
`check_update` · `install_update`

**`conversations.rs` (46)**
`list_conversations` · `delete_conversation` · `start_conversation` ·
`start_group` · `open_self_conversation` · `add_to_conversation` ·
`rename_conversation` · `set_conversation_avatar` · `conversation_avatar` ·
`conversation_messages` · `conversation_attachments` · `mark_verified` ·
`acknowledge_key_change` · `safety_number` · `search_messages` ·
`forward_message` · `send_message` · `send_reply` · `send_attachment` ·
`send_voice_message` · `send_sticker` · `send_view_once` · `open_view_once` ·
`attachment_stream_info` · `attachment_data_url` · `save_attachment` ·
`revise_message` · `react_to_message` · `set_message_pinned` ·
`delete_message_for_me` · `draft` · `set_draft` · `conversations_with_drafts` ·
`list_folders` · `create_folder` · `rename_folder` · `delete_folder` ·
`set_folder_member` · `sync_conversation` · `sync_all` · `flush_outbox` ·
`outbox_count`

**`feed.rs` (25)**
`feed` · `set_following` · `follow_state` · `posts_by` · `create_post` ·
`delete_post` · `vote` · `comments` · `add_comment` · `delete_comment` ·
`react` · `pin_post` · `unpin_post` · `blocks` · `block` · `unblock` ·
`profile` · `my_profile` · `update_profile` · `update_visibility` ·
`upload_image` · `read_image_for_crop` · `upload_image_bytes` · `image_url` ·
`image_data_url`

**`people.rs` (5)**
`search_users` · `report` · `create_invite` · `invites` · `revoke_invite`

**`stories.rs` (3)**
`story_post` · `story_list` · `story_open`

**`stream.rs` (2)**
`drain_stream` · `typing`

---

### `apps/desktop/src` — the React client

React 19, TypeScript, Tailwind, Zustand. **There is no router**: four
destinations and no deep links do not need one, and §7.4 asks for no page
transitions anyway.

```
App.tsx      331 ln  The session gate and the shell. Draws exactly one of
                     AuthPage / LockScreen / OfferPin / AppShell.
main.tsx      37 ln  Mounts, imports the design tokens, suppresses the
                     browser context menu.
```

There is **no `src/styles/`**. The design tokens live one level up, in their own
package, and `main.tsx` imports them.

#### `app/` — state and the seams to Rust

| File | Ln | Owns |
|---|---|---|
| `store.ts` | 479 | The Zustand store: `account`, `locked`, `route`, panel state, the unread ledger, `conversationOverrides`, and `preferences`. **Only `preferences` and `conversationOverrides` are persisted** (localStorage), merged by hand so a blob from an older build keeps the new defaults. `Route = "home" \| "messages" \| "profile" \| "settings"`. |
| `useConversations.ts` | 415 | Live conversation data in the shapes the UI renders. **Mounted once, in `AppShell`**, and handed to both the header and the page — two instances meant two of every call and two copies of the truth. |
| `useFeed.ts` | 292 | The Home feed, against the real server. |
| `syncAgent.ts` | 215 | The one sync loop (M8): flush the outbox, pull, badge, toast. Stops when signed out or locked. |
| `useChrome.ts` | 160 | Theme, accent hue, depth and transparency, applied to the document root. Runs above the shell so the sign-in and lock screens get the same appearance. |
| `useProfile.ts` | 143 | Your own profile and its visibility settings. |
| `useShortcuts.ts` | 90 | **The whole keyboard, in one listener.** A chord is global by nature; spreading them lets two surfaces claim the same one with no way to see the collision. |
| `useUserSearch.ts` | 88 | Debounced handle search, with the shortest term worth sending. |
| `useTyping.ts` | 83 | Who is typing, right now. |
| `useLinkPreview.ts` | 73 | The first https link in a body, when previews are on. |
| `useAutoLock.ts` | 63 | The idle timer. It lives in the WebView because idleness is only observable where the input events are; Rust does the locking. |
| `useLayout.ts` | 47 | The §7.3 breakpoints, in one place. |
| `useWindow.ts` | 46 | The frameless window's own state and controls. |
| `useAutoUpdate.ts` | 45 | Looks for a new version at launch and installs it — held back until the session gate has answered, so an install cannot discard a half-typed password. |

#### `components/`

`chrome/`: `TopBar.tsx` (100 ln — one top row across the whole app) and
`IconRail.tsx` (132 ln — the 64px rail, and where sign-out lives).

`ui/` — the component library. [`COMPONENTS.md`](COMPONENTS.md) is the reference;
this is the index.

| File | Ln | Owns |
|---|---|---|
| `Controls.tsx` | 410 | `Field`, `TextArea`, `Select`, `Toggle`, `Tabs`, `FactRow` — the whole form vocabulary. |
| `stickers.tsx` | 302 | The bundled sticker pack, drawn in the repo (rule 3 is why they are not fetched). |
| `Icon.tsx` | 295 | The hand-drawn icon set, one `<path>` each. |
| `ContextMenu.tsx` | 276 | The floating surface every menu in the app is drawn on. |
| `EmojiPicker.tsx` | 251 | The full standard set, bundled. |
| `ImageCropper.tsx` | 206 | Choosing which part of a picture to use, before it is uploaded. |
| `TextContextMenu.tsx` | 159 | The text-field menu — puts the caret back where it was, then acts. |
| `StickerPicker.tsx` | 110 | The sticker picker. |
| `RemoteImage.tsx` | 105 | An image in object storage, rendered from its key. |
| `Feedback.tsx` | 104 | `Callout`, `Pill`, empty states. |
| `DialogHost.tsx` | 98 | Where everything the app has to say is drawn. Modals **queue**, they do not stack. |
| `Button.tsx` | 88 | `Button`, `IconButton`. |
| `Surface.tsx` | 69 | `Panel` — the glass pane. Asks for `glass-0`…`glass-3`, never writes `backdrop-filter` itself. |
| `ConversationAvatar.tsx` | 69 | Whatever a conversation should look like. |
| `Avatar.tsx` | 62 | A generated avatar, from a seed. |
| `Modal.tsx` | 59 | A dialog drawn over the whole window. |
| `BrandMark.tsx` | 59 | The Nexo mark, as paths rather than type. |
| `HandleAvatar.tsx` | 54 | Somebody's avatar, resolved from their handle. |

#### `features/` — the five destinations plus auth

**`auth/`** — three screens `App.tsx` draws *instead of* the shell, never over
it, because nothing readable may sit in the DOM behind a gate.

| File | Ln | Owns |
|---|---|---|
| `AuthPage.tsx` | 177 | The one screen reachable without an account. Never says whether a handle exists. |
| `LockScreen.tsx` | 193 | The lock screen. The PIN when there is one, the password otherwise. A `null` from `unlockWithPin` is the **only** thing that means a wrong PIN; the other failures arrive as errors with a `kind`. |
| `OfferPin.tsx` | 139 | The unlock PIN, offered **once per machine** and skippable. It used to be a gate; the reasoning for the change is in its header. |
| `useSignOut.ts` | 61 | Signing out, in one place, with the busy flag around the *question* and not only the answer. |

**`home/`** — the feed.

| File | Ln | Owns |
|---|---|---|
| `HomePage.tsx` | 837 | One global reverse-chronological feed. |
| `HomeChat.tsx` | 424 | The conversation beside the feed. |
| `CommentThread.tsx` | 319 | Rebuilds a thread from a flat list. |
| `StoryViewer.tsx` | 162 | One person's stories, in the order they were posted. |
| `Splitter.tsx` | 155 | How narrow the conversation panel may get. |
| `Stories.tsx` | 146 | The read-only strip. Stories have no destination of their own, because their audience is contacts. |
| `storyGroups.ts` | 92 | **One circle per person, not one per story.** Four call sites depend on it agreeing; read it before changing how a story is grouped or matched to a person. |
| `compose.ts` | 77 | What a draft amounts to. **A post's kind is derived, never chosen** — see Conventions. |
| `useStories.ts` | 46 | Every live story this device holds, read once and re-readable. |
| `story.ts` | 32 | Picks a file and posts it as a story. |

**`messages/`** — the largest surface.

| File | Ln | Owns |
|---|---|---|
| `MessageList.tsx` | 1 474 | The bubbles, and `buildRows` (grouping). `grouping.test.ts` imports that from here — there is no `grouping.ts`. |
| `ConversationList.tsx` | 962 | The list, the folders, the multi-selection. |
| `MessagesPage.tsx` | 614 | Rail, list, chat, context panel. |
| `Lightbox.tsx` | 468 | One attachment, full size, over everything. |
| `MessagesHeader.tsx` | 426 | The Messages cells of the top row. |
| `Composer.tsx` | 390 | Typing, attaching, recording. |
| `ContextPanel.tsx` | 368 | The 280px panel. |
| `useRecorder.ts` | 213 | Voice recording, and the waveform that describes it. |
| `ConversationSearch.tsx` | 155 | Searching inside the conversation you are looking at. |
| `ForwardPicker.tsx` | 127 | Choosing where a message goes next. |
| `menu.ts` | 126 | What a right-click offers **and in what order** — a pure function whose order is asserted in `menu.test.ts` rather than read. Destructive entries sit last. |
| `selection.ts` | 97 | What a click does to a multi-selection. |
| `pinned.ts` | 76 | What the pinned list shows for one message. |
| `peer.ts` | 75 | `peerHandle` — reads the member list and answers `undefined` rather than guessing. **A conversation's title is not a handle.** |
| `pan.ts` | 69 | The arithmetic behind zooming and dragging a picture. |
| `jump.ts` | 40 | Landing on one message in a wall of them — quotes and search results both, so they land the same way. |

**`profile/`**: `ProfilePage.tsx` (922), `PublicProfile.tsx` (363),
`PrivacyPanel.tsx` (226), `MyStories.tsx` (206 — your own stories as a gallery,
one tile per story; **posting lives here, never in the strip**),
`VisibilityControls.tsx` (119).

**`settings/`**: `SettingsPage.tsx` (763), `DeleteAccount.tsx` (147),
`UnlockPin.tsx` (134), `ChangePassword.tsx` (113), `BlockedList.tsx` (107),
`PrivacyTable.tsx` (74).

#### `lib/` — the typed wrappers around `invoke()`

The IPC seam as the page sees it. **Nothing here holds a secret.**

| File | Ln | Wraps |
|---|---|---|
| `conversations.ts` | 780 | The 45 conversation commands. |
| `native.ts` | 381 | File pickers, save dialogs, clipboard, tray, lock, backdrop, autostart, updater. |
| `feed.ts` | 338 | Feed, posts, comments, profiles, images. |
| `people.ts` | 127 | Search, invitations, reporting. |
| `stories.ts` | 75 | Stories. Its errors narrow with `asConversationError`, because that is what the Rust side answers in. |
| `types.ts` | 270 | The shapes the UI renders. |
| `auth.ts` | 181 | Register, login, restore, the PIN, password, sign-out, delete. |
| `dialogs.ts` | 163 | In-app dialogs and toasts (`confirm`, `notify`) — not OS dialogs. |
| `format.ts` | 116 | Relative time, sizes, counts. |
| `palette.ts` | 83 | Deterministic colour from a string. |
| `profiles.ts` | 70 | Profiles by handle, fetched once and remembered. |
| `media.ts` | 61 | **No `invoke`** — just the rule that picks which player a bubble draws for an attachment. |
| `stream.ts` | 45 | The live socket, as the page sees it. |
| `blocks.ts` | 35 | Blocking. |
| `cn.ts` | 5 | Class-name join. |

#### `mock/`

`data.ts` (570 ln) and its test. **Nothing outside `mock/` imports it any more**
— it was the M1 fixture set, and every surface now reads the real store.
`lib/types.ts` still mentions it in comments. Treat it as historical unless you
are deliberately reviving it.

#### Frontend tests

21 vitest files, 149 tests, run by `pnpm test`. They cluster on the pure
functions rather than on the components:

```
app/          mute · syncAgent · useChrome · useFeed · useLinkPreview · useUserSearch
components/   stickers
features/     home: CommentThread · compose · storyGroups
              messages: grouping · menu · pan · peer · pinned · selection
lib/          dialogs · format · media
mock/         data
```

`packages/design-tokens` has its own suite (18 tests), one of which fails if
`tokens.json` has drifted from `tokens.css`.

---

### `packages/crypto-wasm`

```
scripts/build.mjs        cargo build --target wasm32 + wasm-bindgen, into pkg/
src/conversation.test.ts Two devices, one real MLS conversation, in wasm
pkg/                     Generated. Git-ignored; CI builds it and so does a clone.
```

`pnpm test:wasm` builds and runs it. Deliberately **not** part of `pnpm test`:
that runs in a CI job with no Rust toolchain, and a test that silently skips
when its subject is missing is worse than one that is not run at all.

---

### `packages/design-tokens`

```
tokens.css     The authored source. Every colour, size and motion value,
               with the reasoning in comments.
tokens.json    Derived from the CSS by src/generate.ts. Checked in; a test
               fails when it is stale.
```

The direction is deliberate: the CSS is authored because it carries the
comments, the JSON is generated so a second platform gets the values without a
second source of truth. Edit the CSS, then
`pnpm --filter @nexo/design-tokens build:tokens`.

**Components ask for tokens, never raw values.** A hex code in a `.tsx` is a bug.

---

## Task → where

The first column is what you were asked to do. The second is the files to open
**in that order**. The third is what not to open, because it will not help and
it is expensive.

### Changing behaviour

| Task | Open, in this order | Do not open |
|---|---|---|
| Add or change an **encrypted-path endpoint** (messages, groups, key packages) | `crates/protocol/src/lib.rs` (the type first — both sides follow it) → `apps/server/src/delivery/` → `crates/client/src/transport.rs` → `crates/client/src/http.rs` → `apps/desktop/src-tauri/src/conversations.rs` → `apps/desktop/src/lib/conversations.ts` | `BRIEF.md` |
| Add or change a **feed / profile endpoint** | `crates/client/src/feed.rs` → `apps/server/src/posts.rs` or `profiles.rs` → `crates/client/src/http.rs` → `apps/desktop/src-tauri/src/feed.rs` → `apps/desktop/src/lib/feed.ts` | `BRIEF.md` |
| Add a **route the server already has** but nothing calls | `apps/server/src/` first — check [the route table](#every-route). `/v1/stream` sat unused for months, and `follows` was the opposite case | — |
| Add a **new IPC command** | `apps/desktop/src-tauri/src/<area>.rs` → **register it in `lib.rs`'s `generate_handler!`** → `apps/desktop/src/lib/*.ts` → the calling component | — |
| Add a **`Transport` method** | `crates/client/src/transport.rs` → then **all seven implementors** (see Conventions) → `crates/client/src/http.rs` last | — |
| A **UI-only change** | the `features/*` file → `components/ui` → `packages/design-tokens/tokens.css` | Rust, usually |
| Change **what is stored on the client** | `crates/store/src/lib.rs` (`grep` the table, do not read the file) → the caller in `crates/client` → bump `SCHEMA_VERSION` and add a `migrate()` step | — |
| Change **what is stored on the server** | `apps/server/migrations/` (a **new** file) → the module → regenerate `.sqlx/` | — |
| Anything **MLS / group membership** | `crates/crypto/src/mls.rs` → `crates/client/src/conversations.rs` → `apps/server/src/delivery/` | OpenMLS internals |
| **Auth, login, tokens** | `apps/server/src/auth/` → `crates/client/src/session.rs` → `apps/desktop/src-tauri/src/auth.rs` → `apps/desktop/src/features/auth/` | — |
| **Lock screen / PIN** | `crates/client/src/pin.rs` → `apps/desktop/src-tauri/src/auth.rs` (`unlock_with_pin`, and `commands.rs::lock`) → `apps/desktop/src/features/auth/` | `PIN-ROTATION.md` — that is TLS key pinning, an unrelated subject |
| **Search, invitations, reporting** | `apps/server/src/invites.rs` or `profiles.rs` → `crates/client/src/people.rs` → `apps/desktop/src-tauri/src/people.rs` → `apps/desktop/src/lib/people.ts` | `BRIEF.md` |
| **Who may open a conversation with whom** | `apps/server/src/invites.rs::may_reach` → its call site in `apps/server/src/delivery/mod.rs`, before anything is written | The client — the rule is the server's or it is nothing |
| **Stories** | `crates/client/src/stories.rs` → `apps/server/src/stories.rs` → `features/home/storyGroups.ts` (read it before changing grouping) → `features/home/Stories.tsx`, `features/profile/MyStories.tsx` | — |
| **Attachments or media playback** | `crates/crypto/src/attachment.rs` (which encoding?) → `crates/client/src/conversations.rs::send_attachment` → `apps/desktop/src-tauri/src/media.rs` → `apps/desktop/src/lib/media.ts` | — |
| The **live socket** | `apps/server/src/stream/` → `crates/client/src/stream.rs` → `apps/desktop/src-tauri/src/stream.rs` → `apps/desktop/src/lib/stream.ts` | — |
| **Feed, posts, comments** | `apps/server/src/posts.rs` → `apps/desktop/src-tauri/src/feed.rs` → `app/useFeed.ts` → `features/home/` | — |
| **Keyboard shortcuts** | `app/useShortcuts.ts` — all of them, in one listener | Anywhere else |
| **Colours, spacing, motion** | `packages/design-tokens/tokens.css`, then regenerate the JSON | Never hardcode a value in a component |
| **Tray, notifications, window chrome, autostart** | `apps/desktop/src-tauri/src/windows.rs` → `apps/desktop/src-tauri/src/commands.rs` → `app/useWindow.ts`, `app/useChrome.ts` | — |
| **Link previews** | `apps/desktop/src-tauri/src/preview.rs` → `app/useLinkPreview.ts`. Read `THREAT-MODEL.md` §2.3 first — the refusals are the feature | — |
| **Offline behaviour** | `crates/client/src/outbox.rs` → `app/syncAgent.ts` → `crates/client/tests/offline_queue.rs` | — |
| **Rate limits** | `apps/server/src/limits.rs` → the module that calls it | — |

### Process

| Task | Open, in this order |
|---|---|
| A **dependency bump** | `Cargo.toml` / `package.json` → `deny.toml` if the licence set changes → run **both** `cargo deny` passes |
| **Release** | [`RELEASING.md`](RELEASING.md) → [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) |
| **Server operations, deploy, incident** | [`OPS.md`](OPS.md) |
| A **licensing or copyright** question | [`LICENSING.md`](LICENSING.md) — its *Quick answers* table first |
| **"Is this safe?"** | [`THREAT-MODEL.md`](THREAT-MODEL.md) → the [invariants](#invariants) above |
| **"Is this already built?"** | [`STATUS.md`](STATUS.md). It was written by walking the code, not the commit messages. Read it **before** calling a feature missing |
| **"Why was it done this way?"** | [`RESEARCH-COMPARISON.md`](RESEARCH-COMPARISON.md), or the comment at the point of the decision. Search before re-litigating |
| **"Should we build this?"** (a feature from another messenger) | [`TELEGRAM-FEATURES.md`](TELEGRAM-FEATURES.md) — what fits, what cannot, and why |

### Diagnosing

| Symptom | Look here first |
|---|---|
| An IPC call rejects with nothing useful | Is the command in `generate_handler!` in `src-tauri/src/lib.rs`? That omission is a runtime rejection, not a compile error |
| Something in the page silently does not load — a font, a video, an image, a fetch | The **CSP** in `tauri.conf.json`. It fails silently and has been wrong three times. The only way to see it is the WebView console of a real run |
| Every command answers "You are not signed in" | `ClientState` is `None` — the app is locked, signed out, or opened offline (`restore_session`'s `Offline` path reports an account without installing a client) |
| The session ends by itself | A rotated refresh token that never reached the store. See the drain rule in [Conventions](#conventions-that-will-trip-you-up) |
| The app stutters while a video plays | Something is holding the client lock across the network. See the lock rule in [Conventions](#conventions-that-will-trip-you-up) |
| A server test passes locally and fails for somebody else | It asserted on a global listing in a shared database, or `.sqlx/` was not regenerated |
| Nothing in the app works at all — sign-in, feed, messages | Ask `api.delidev.net` itself: `curl -i https://api.delidev.net/v1/health`. A 502 from Caddy means `nexo-server` is not running on the box, not that the client is wrong — `/v1/health` needs no database and no token, so anything but 200 is the service. The runbook is [`OPS.md`](OPS.md) *When `api.delidev.net` answers 502* |
| `nexo-server` restart-loops after an edit to `/etc/nexo/nexo.env` | It refuses a half-finished deployment by design: the S3 block and `NEXO_CORS_ORIGINS` are each all-or-nothing and checked at startup. `journalctl -u nexo-server -n 60` names the one that failed |
| The UI looks stale after a `cargo build --release` | `pnpm build` was not run first; the binary embeds `apps/desktop/dist` |

---

## Commands

Windows, PowerShell. Raw `cargo` needs the environment prepared once per
terminal — dot-source it, leading `. ` included:

```powershell
. .\scripts\dev-env.ps1
```

| | |
|---|---|
| `pnpm tauri dev` | The app, hot reload on the React side. Prepares its own environment. |
| `pnpm dev:server` | The API on `127.0.0.1:8080`. Needs `docker compose up -d` for Postgres on **5433**. |
| `pnpm dev` | UI alone at `localhost:1420`. Nothing that calls Rust works. Layout work only. |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm test:wasm` | Builds `crates/crypto-wasm` and drives an MLS conversation through it. Needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the pinned version. |
| `pnpm test` | Vitest, both workspaces. |
| `pnpm build` | Must run before `cargo build --release` — the binary embeds `apps/desktop/dist`. |
| `pnpm build:tokens` | Regenerates `tokens.json` from `tokens.css`. |
| `.\scripts\check.ps1` | **Exactly what CI runs.** The gate before every push. |
| `cargo test --workspace` | Rust tests. Narrow with `-p nexo-client`. |
| `cargo clippy -p <crate> --all-targets` | The cheap loop while changing Rust. |

`scripts/`: `dev-env.ps1` (MSVC, Perl, PATH), `cargo.ps1` and `tauri.ps1`
(wrappers that prepare the environment first — this is why `pnpm dev:server`
works from a cold shell), `check.ps1` (the CI gate), `release.ps1`,
`deploy-server.sh`.

**`pnpm server` does not work** — `server` is one of pnpm's own commands. The
script is `dev:server`. **Port 1420 is fixed on purpose** so Tauri and Vite
cannot disagree about it.

`check.ps1` runs, in order: `cargo fmt --all --check`, `cargo clippy --workspace
--all-targets -- -D warnings`, `cargo test --workspace`, **two** `cargo deny`
passes, `cargo audit`, `pnpm typecheck`, `pnpm build`. It keeps going after a
failure and lists everything that failed at the end.

CI (`.github/workflows/ci.yml`) runs four jobs: **Frontend** (typecheck, test,
build, `pnpm audit`, on windows-latest), **Client** (Windows x86_64),
**Server** (ubuntu-24.04-arm, Linux aarch64), and **Supply chain** (two
`cargo deny` passes plus `cargo audit`). `release.yml` builds the signed
installer on a tag and refuses to publish unsigned updater artifacts or a tag
that disagrees with the version in the tree.

Toolchain: Rust **1.97.1**, edition 2024, resolver 3, target
`x86_64-pc-windows-msvc`. pnpm **10.20.0**.

Cheapest useful loop when changing Rust: `cargo clippy -p <crate> --all-targets`
then `cargo test -p <crate>`. The full workspace build is minutes; a single
crate is seconds.

---

## Conventions that will trip you up

Every entry here is something that has already gone wrong once, and most of them
failed silently.

- **Pinned dependencies, everywhere.** `=1.0.229`, not `^1.0`. Rule 8. A bump is
  a deliberate act that goes through `cargo deny` and `cargo audit`.
- **Every authenticated call must write down a rotated refresh token.** The
  access token ages on the clock, so `HttpTransport` trades the refresh token
  for a fresh pair mid-call and parks the new one in `rotated`. The transport
  cannot persist it — it has no store — so each shell helper drains it with
  `take_rotated_refresh_token` and writes it to the store. Skipping that leaves
  a **spent** token on disk; the next resume replays it, and the server reads a
  reused refresh token as theft: it revokes every session for the account. Four
  places do it — `conversations.rs`, `feed.rs` and `people.rs`'s `with_client`,
  `media.rs`'s `persist_rotated`, and `auth.rs`'s key-package publish. The old
  `meet.rs` did not, which is how one of its calls could silently end
  somebody's session; `stories.rs` avoids the risk entirely by borrowing
  `conversations.rs`'s helper rather than copying it.
  `grep -rn "take_rotated_refresh_token"` finds them all; anything new that
  reaches the network under a bearer token joins the list.
- **An attachment has two encodings, and the reader must know which.**
  `attachment::encrypt` seals a whole file under one GCM tag; `encrypt_segmented`
  seals it in 256 KiB segments whose AAD binds each segment's index and the
  total, so a byte range can be opened without the rest — and so a reordered or
  truncated stream fails authentication instead of playing short. **Video is
  sealed segmented; everything else is sealed whole**, decided by MIME in
  `send_attachment`. The two are not distinguishable from the ciphertext, so
  `Payload::Attachment::segmented` carries the answer — defaulting to false, so
  every message sent before this stays byte-identical and still reads.
  A consequence worth knowing: anything that reaches `send_attachment` claiming
  a `video/` type gets the segmented encoding, which is why the voice command
  forces `audio/` even though `MediaRecorder` sometimes says `video/webm`.
- **Nothing in the page may reach a third party, and the CSP is what says so.**
  `img-src` and `connect-src` name no remote host, which is rule 3's
  enforcement point and not an oversight to be widened when a feature wants it.
  `THREAT-MODEL.md` §2.3 already worked this through once for link previews and
  ended with "no image fetch" — so a feature that wants remote pictures (GIF
  search is the standing example) is a threat-model decision before it is a
  frontend one. Stickers are drawn in the repo for exactly this reason.
- **CORS is off unless `NEXO_CORS_ORIGINS` names an origin, and `*` is refused
  at startup.** The desktop app makes its HTTP calls from a Rust process, which
  sends no `Origin` header, so the API had no CORS layer at all until the web
  client (`nexo-web`) existed. `parse_origins` in `apps/server/src/lib.rs`
  panics on a wildcard, on anything that is not `https://` (loopback excepted),
  and on an origin carrying a path or trailing slash — the last because an
  `Origin` header is scheme, host and port, so a value with more in it never
  matches and surfaces as a confusing CORS error rather than a configuration
  one. `allow_credentials` is deliberately never set: auth is a `Bearer`
  header, so no browser client needs an ambient cookie, and not sending that
  header keeps cross-site request forgery off the table rather than mitigated.
  A Netlify deploy-preview URL is **not** in the list on purpose — previews
  reaching production data is one pull request away from anyone who can open
  one.
- **The CSP is the whole policy, it fails silently, and it has been wrong three
  times.** `tauri.conf.json` holds all of it: Tauri appends script and style
  hashes and touches nothing else, so an absent or mistyped directive falls back
  to `default-src 'self'`, the content is refused, and **nothing in the app can
  see it happen**. No test catches this. The only way it is ever found is by
  reading the WebView console of a running build.

  The three, all found that way rather than by review:

  - **`media-src` was missing** — `img-src` listed `data:` so pictures worked,
    while no `<video>` or `<audio>` ever loaded in v0.1.19 or v0.1.20.
  - **`font-src` was missing** — the bundled faces Vite inlines as `data:`
    URLs were refused, so JetBrains Mono sat in `error` state and the app
    rendered in fallback faces.
  - **`connect-src` named `https://ipc.localhost`** — WebView2 on Windows uses
    **`http://`**. Every IPC call failed its fast path and fell back to
    `postMessage`, which works, which is why nobody noticed.

  Adding a player, a font, a worker or anything that fetches means adding its
  directive in the same change — and then *looking at the console of a real
  run*, because that is the only place the failure appears.
- **`?url` does not follow what a file imports.** The Meet&Greet map loaded
  MapLibre's worker with `?url`, which copies the file verbatim; the worker
  imports a sibling, `maplibre-gl-shared.mjs`, which was therefore never
  emitted. The worker died on a `text/html` 404, the map still drew, and every
  worker task ran on the main thread instead. Nothing bundles a worker today —
  MapLibre left with the map — so this is a rule for the next one rather than a
  description of anything here. Use `?worker&url` for anything with imports of
  its own.
- **The client lock covers the store and MLS, never the network.** One mutex
  in `apps/desktop/src-tauri/src/client.rs` guards the store, the MLS provider
  and the transport together, because neither the `rusqlite::Connection` nor
  the provider is `Sync`. Holding it across a download is what made opening a
  photo delay an unrelated draft save by a second, and a playing video stutter
  the whole app once per range request. The transport is therefore an `Arc`,
  and the media paths take the lock only to read the payload and clone that
  handle before letting go. Anything added later follows the same rule: hold
  it for the store and MLS work, release it before the network.
- **Locking clears the client, not the session.** `commands.rs::lock` drops
  `ClientState` — the SQLCipher connection and the MLS provider — and leaves
  `SessionState` alone, so the tokens are still in the process. That is what
  lets `unlock_with_pin` rebuild everything from disk with no server round
  trip, which is what the lock screen promises. Anything that reopens after a
  lock should reach for the tokens in memory before it reaches for the network.
- **An open store cannot be deleted on Windows, and the wipe erases keys
  first.** `nexo_store::delete` unlinks the database, and Windows refuses while
  any handle is open — so anything wiping the store must drop `LoggedIn` (which
  owns the `EncryptedStore`) *before* calling it. Sign-out did not, the unlink
  failed with `os error 32`, and because the wipe was written as a chain of
  `?`s that failure also skipped erasing the store key and the unlock PIN: the
  app reported a successful sign-out with the database, its key and the PIN all
  still on disk. `session::wipe_local` now erases the PIN and the key before it
  touches the file, so an unlink that still fails leaves ciphertext nobody can
  open, and no step can skip the ones after it. `delete_account` is split into
  `delete_account_on_server` and `wipe_local` for the same reason: the server
  has to answer first, and the handles have to close before the wipe, and the
  only moment that satisfies both is between the two.
- **A conversation's title is not a handle.** `title` is a label — for a DM
  with no member list yet it is literally `"Unnamed conversation"` — and
  looking it up as an account sends a doomed request on every render.
  `features/messages/peer.ts::peerHandle` reads the member list and answers
  `undefined` rather than guessing. The core records fixing the same
  conflation once for groups; it survived in the UI for the untitled DM.
- **The local store's schema version is one constant.**
  `crates/store/src/lib.rs` `SCHEMA_VERSION` and the last `PRAGMA
  user_version` in `migrate()` must agree; a test fails if they drift. Add a
  column with the `add_column` helper, never a bare `ALTER TABLE ... ADD
  COLUMN`: the helper checks `PRAGMA table_info` first, so a step that runs
  twice is harmless. Rollback tests still put the shape back along with the
  version — a test claiming to be a v9 store while carrying v11's columns is
  testing something that never existed.
- **`sqlx` is compile-time checked, offline by default.** `.cargo/config.toml`
  sets `SQLX_OFFLINE = "true"` for every cargo invocation, so `query!` macros
  check themselves against the committed `.sqlx/` cache and the Windows CI job
  compiles the server with no Postgres anywhere. Change a query and that cache
  must be regenerated, which needs a live database and an override — the
  `[env]` table deliberately has no `force = true` so the shell wins:

  ```powershell
  docker compose up -d
  $env:SQLX_OFFLINE = "false"
  cargo sqlx prepare --workspace -- --all-targets
  ```

  Forgetting this fails on someone else's machine, not yours.
- **A conversation can have one member, and `kind` has three values.**
  `'dm'`, `'group'` and `'self'` — the last is the conversation somebody has
  with themselves, an ordinary one-member MLS group whose fan-out reaches
  nobody. `create_conversation` reads an empty member list as that, and hands
  back the existing one rather than making a second, the same way it does for
  a DM. Anything matching on `kind` has to answer for the third case; the
  CHECK constraint in `20260906120000_self_conversations.sql` is what stops a
  fourth appearing by accident.
- **The server's tests share one development database and never clean up.**
  `apps/server/tests/*` connect to `DATABASE_URL` and skip when it is absent;
  they invent unique handles so they do not collide, but every run leaves its
  rows behind. So a test must assert on *its own* data, never on a global
  listing containing it. A Meet&Greet test read the first page of the pin
  listing and asked whether a handle was in it — which is "is it among the
  first five hundred alphabetically", not "is it on the map". It passed on a
  fresh database for months and started failing once the local one held more
  than a page of pins. CI never saw it because CI is always fresh, which is
  exactly what makes this class of test wrong in the direction nobody
  notices.
- **A `Transport` trait method needs an implementation everywhere the trait is
  implemented**, not just in `http.rs`. **Five** places today: the real
  `HttpTransport`, `lib.rs`'s in-crate `FakeTransport`, and three purpose-built
  fakes under `crates/client/tests/` (`Listing` in `leftover_conversations.rs`,
  `CutNetwork` in `offline_queue.rs`, `Listing` in `stories.rs`). `grep -rn "impl Transport
  for"` finds all of them; missing one is a compile error, not a silent gap.
- **Two different questions decide what an attachment is**, and only one of
  them is about safety. `lib/media.ts` reads the sender's declared MIME to pick
  a *layout* — that value is guessed from a file extension and is not evidence.
  What the page may actually be handed is decided in Rust from the bytes:
  `feed::sniff_mime`, then `is_renderable` (a picture or a video — what a story
  or a profile picture may be) or `is_playable` (also sound — what a
  conversation may be). Never widen the first to fix the second, and never test
  for `"application/octet-stream"` instead of asking one of those two: that
  spelling silently accepts whatever the sniffer learns next.
- **A menu's destructive entries sit last**, and `MenuItem` says so. The
  message menu is where that is easy to break, because its entries come and go
  with the message's state — it is built by `features/messages/menu.ts`, a pure
  function whose order is asserted in `menu.test.ts` rather than read.
- **A post's kind is derived, never chosen.** `features/home/compose.ts` reads
  it off the draft, and its order (link, then images, then text) is not a
  preference: `posts.rs` refuses a link on an image or text post, so any other
  order builds requests the server rejects. Change one and the other has to
  move with it.
- **Modals queue, they do not stack.** `lib/dialogs.ts` and `DialogHost.tsx`:
  a second `confirm` while one is open goes *behind* it, and each has to be
  answered. That is why `useSignOut` puts its busy flag around the question and
  not only around the answer.
- **A server refusal must be JSON, or its message is thrown away.**
  `HttpTransport`'s `refusal` parses the body as `{error, message}` and falls
  back to `"the server returned {status}"` when it cannot. So a handler that
  answers `(StatusCode::SERVICE_UNAVAILABLE, "some prose")` — which compiles,
  reads fine, and looks right — turns a considered sentence into a generic
  failure at the last moment. The old `calls.rs` shipped that way and it was
  found by driving the app, not by review: "Calls are not available on this
  server." arrived as "Something went wrong. Try again.", which is exactly the
  honesty rule 5 asks for, lost in translation. Every module defines its own private
  `ErrorBody` for this; a new one joins them.
- **A `--release` build ignores `NEXO_API_BASE` and talks to production.**
  `base_url()` in `stream.rs` and `HttpTransport::new` both read the override
  only under `cfg!(debug_assertions)`, deliberately, so a shipped binary cannot
  be pointed elsewhere by an environment variable. The consequence when
  *testing*: a release build driven against a local server is not talking to it,
  and a route that only exists locally comes back 404 — which maps to
  `NotFound` and then to a generic error, so it looks like a bug in the feature
  rather than a binary aimed at the wrong host.
- **Locking clears the client and the socket, and it has to do the second one
  by hand.** `commands.rs::lock` drops `ClientState` *and* `StreamState`. The
  second is not redundant: `follow_session` closes the socket when there is no
  **session**, and locking deliberately keeps `SessionState` so
  `unlock_with_pin` can rebuild from disk with no server round trip. So a locked
  app still has a session, `follow_session` would hold the connection open, and
  nothing calls it anyway — `drain_stream` is driven by the sync agent, which
  unmounts with the app shell. `stream.rs` claimed for months that locking
  closed the socket; it did not, and an authenticated WebSocket stayed open
  behind the lock screen collecting events nobody could decrypt. Anything that
  adds a long-lived connection or an open device joins that line in `lock`.
- **Two `cargo deny` passes, never one.** The Windows client and the Linux
  server have disjoint dependency graphs; a single union graph judges each
  against the other's dependencies. See the comment at the top of `deny.toml`.
- **`.ps1` files are CRLF**, everything else LF — `.gitattributes` enforces it.
- **`pnpm build` before `cargo build --release`.** The binary embeds the built
  frontend; skipping it ships a stale UI.
- **Design values live in tokens**, not in components. A hex code in a `.tsx` is
  a bug. Tokens are authored in `packages/design-tokens/tokens.css`;
  `tokens.json` is generated from it and a test fails when the two drift.
- **The commit rules in [`CLAUDE.md`](../CLAUDE.md) are not decoration.** No
  attribution trailers, no tool names, in commits or anywhere else. Run
  `git config core.hooksPath .githooks` after a fresh clone so the hook backs
  the rule up.

---

## Where the truth lives

Read cost matters. Sizes are approximate and current.

| Document | Size | Answers |
|---|---|---|
| [`CONTEXT.md`](CONTEXT.md) | 70 KB | This file. Where things are, and what not to break. |
| [`REWORK.md`](REWORK.md) | 19 KB | **Current.** Why this repository is becoming one TypeScript client for web, Windows and phone, what that costs the invariants, and the eleven waves that get there. Read before starting anything large. |
| [`STATUS.md`](STATUS.md) | 95 KB | What works today, what is known broken, and what was checked and cleared. **Read before assuming a feature is missing.** |
| [`COMPONENTS.md`](COMPONENTS.md) | 11 KB | The UI component reference. |
| [`RELEASING.md`](RELEASING.md) | 10 KB | Tag, build, sign, publish, updater manifest. |
| [`PIN-ROTATION.md`](PIN-ROTATION.md) | 3 KB | Why the client does **not** pin TLS keys, and what any future pinning must do. Nothing to do with the unlock PIN — that is `crates/client/src/pin.rs` and `THREAT-MODEL.md` §3. |
| [`SIGNAL-ANALYSIS.md`](SIGNAL-ANALYSIS.md) | 10 KB | Why MLS and not the Signal protocol. |
| [`TELEGRAM-FEATURES.md`](TELEGRAM-FEATURES.md) | 13 KB | Which Telegram features fit this app, which cannot, and why. Read before proposing one. |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | 11 KB | What must ship beside the `.exe`. |
| [`README.md`](../README.md) | 5 KB | What Nexo is, who it is for, what it does and does not protect. No build steps. |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 8 KB | Setup, prerequisites, commands, troubleshooting. For humans on a new machine. |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | 34 KB | Adversaries in and out of scope; what is deliberately not protected. |
| [`TUTORIAL.md`](TUTORIAL.md) | 19 KB | Every value you personally have to supply: accounts, costs, domains, secrets — and which of them block you today. |
| [`OPS.md`](OPS.md) | 24 KB | The Hetzner runbook. Deploy, TLS, backups, incidents. |
| [`PLAN.md`](PLAN.md) | 23 KB | Milestones M0–M9 and the open risks. |
| [`BRIEF.md`](BRIEF.md) | 27 KB | The original specification. The source of the §-numbers other docs cite. |
| [`LICENSING.md`](LICENSING.md) | 29 KB | Copyright, MIT duties, dependency licences, Swiss law, export control. |
| [`RESEARCH-COMPARISON.md`](RESEARCH-COMPARISON.md) | 38 KB | Why each technology decision beat its alternative. Background, not instruction. |

Also under `docs/`: `design/` (two reference images) and `superpowers/plans/`
(two dated planning documents — historical, not current instruction).

**The two big ones are reference, not reading.** `BRIEF.md` and
`RESEARCH-COMPARISON.md` are together 65 KB. When another document cites
"brief §4.3", open that section — `grep -n "^### 4.3" docs/BRIEF.md` gives the
line, then read the range. Reading either end to end is almost never the right
move.

---

## Working economically

Habits that keep a session's context small enough to stay useful:

1. **Route, then read.** Use [Task → where](#task--where). Opening
   `crates/store/src/lib.rs` whole costs ~50 000 tokens;
   `grep -n "TABLE IF NOT EXISTS messages" -A 20` costs almost nothing and
   usually answers the question.
2. **`grep` for the symbol, then read the range** — `sed -n '400,460p'`. Read
   whole files only when changing their structure. The line counts in the map
   are there to tell you which files that rule matters for.
3. **Trust the module headers.** Every crate's `lib.rs` and every `src-tauri`
   module opens with a doc comment stating what it may and may not do. Fourteen
   lines that save reading the crate.
4. **Narrow the build.** `cargo test -p nexo-client` over
   `cargo test --workspace`; `cargo clippy -p <crate>` over the workspace.
5. **Do not re-derive what a doc already settled.** If a decision looks odd,
   the reason is written down — usually in `RESEARCH-COMPARISON.md`, in
   `STATUS.md`, or in a comment at the point of the decision. Search before
   re-litigating.
6. **`STATUS.md` before "this feature is missing".** It was written by walking
   the code, and it is current.
7. **`.\scripts\check.ps1` before pushing**, not a guess about what CI wants.
   One validated push beats three speculative ones.
8. **Two clients need two processes.** The GUI is one process with one account
   and the single-instance plugin means no second window, so the other side of
   a conversation is `cargo run -p nexo-client --example peer --features http`.

