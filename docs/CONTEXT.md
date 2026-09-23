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
   refresh tokens, or locking. Every entry there is something that has
   already gone wrong once, silently.

The tables in [The map](#the-map) exist for the case where step 2 has no row
for you. They list every file in the repository with one line about what it
owns, so finding the right one costs a scan rather than a `grep` over the whole
tree.

`docs/` holds ~480 KB of prose, and this file is ~75 KB of it. The rule it
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
| 2 | ~~No key material in the WebView.~~ | **Retired in wave 7.** See below — this one changed, and pretending otherwise would be the worst thing this file could do. |
| 3 | No remote code in the client. | Strict CSP in `tauri.conf.json` **and in `netlify.toml`**; everything bundled, no CDN, no `eval`. `wasm-unsafe-eval` is present and is not `eval`: it permits compiling WebAssembly and nothing else. |
| 4 | The server must never read message contents. | `crates/protocol` carries no plaintext types; `apps/server/src/delivery` moves opaque envelopes. |
| 5 | Be honest in the UI about what is encrypted. | Feed and profile surfaces say they are public. Never "military grade", never "unhackable". |
| 6 | Zeroize secrets. | Still true in Rust — `crates/crypto` zeroizes key material and MLS buffers. **Not achievable in the page**: JavaScript cannot guarantee a string is erased, and `packages/core` holds verifiers in `Uint8Array` and clears them where it can, which is weaker and is meant to be read as weaker. |
| 7 | Fail closed. | A decryption failure renders as "can't decrypt", never a plaintext fallback and never a silent skip. |
| 8 | Every dependency pinned. | `=x.y.z` in `Cargo.toml`, exact versions in `package.json`, both lockfiles committed, `cargo deny` + `cargo audit` + `pnpm audit` in CI. |

### Invariant 2, and what replaced it

Until wave 7 the tokens, the MLS state, the identity key and every message
plaintext lived in the Rust process, and a script that got into the WebView
could reach none of them. **There is no such other side in a browser.** The
session now lives in the page: `packages/core` holds it, IndexedDB stores it,
and anything that runs script in that origin can read all of it.

That is the price of one client across three targets, and
[`REWORK.md`](REWORK.md) records it as a decision rather than an accident. The
consequences, stated plainly because they are what somebody deserves to be
told:

- **Nothing is encrypted at rest.** No keystore exists to hold a key a browser
  could use, so there is no SQLCipher and nothing to unlock.
- **"Lock" guards the screen, not the disk.** `lib/auth.ts` says so in the
  code, and the settings screen says so to the person.
- **An XSS is a total compromise.** It always was severe; it is now fatal.
  This is why invariant 3 matters more than it used to, and why the CSP is now
  maintained in two files rather than one.

What did **not** change, and it is the half that matters to somebody who is not
holding the device: the server still holds no key and a message is still opaque
to it. Invariants 1, 4, 5 and 7 are untouched.

Two structural rules of the same weight:

- **`crates/protocol` and `crates/crypto` must compile unchanged for
  `wasm32-unknown-unknown`.** No I/O, no OS calls, no HTTP. That is no longer
  aspirational — the page will not start without it, and the `web` job in CI
  fails the moment it stops being true. Adding a dependency to either is a
  portability decision, not a convenience.
- **`packages/core` has no React in it and no platform calls.** The network
  arrives as `Transport`, storage as `Store`, MLS as `CryptoModule`. Anything
  that knows which host it is on belongs in `apps/desktop/src/lib/runtime.ts`,
  which is the only file that may ask.

---

## The map

Line counts are source only — tests are counted with the crate they test, in the
tables below.

```
crates/protocol       1 608 ln   Wire types shared by client and server. No I/O, no crypto.
crates/crypto         1 894 ln   MLS, the identity keypair, safety numbers, object crypto.
crates/crypto-wasm      699 ln   The same, through wasm-bindgen, for a browser engine.
apps/server          11 565 ln   axum API + MLS Delivery Service (Linux aarch64).
apps/desktop/src-tauri
                      2 373 ln   The desktop shell: 17 Tauri commands, windowing, tray, the relay.
apps/desktop/src     23 035 ln   React 19 page (TypeScript, Tailwind, Zustand). Every host runs this.
packages/core         7 293 ln   The client's brain in TypeScript. Session, transport, store, MLS.
packages/design-tokens           Colour, type, radius, motion. CSS authored, JSON derived.
packages/crypto-wasm             Builds crates/crypto-wasm into an npm package. Generated, not committed.
```

**Three crates are gone**, and their absence is the shape of the rework:
`crates/client` (7 248 ln), `crates/store` (4 113 ln) and `crates/platform`
(427 ln) were the Windows client, and every line of what they did now lives in
`packages/core` where a browser can run it too. `docs/REWORK.md` wave 11.

Counted the same way each time: every `.rs` under a crate's `src/`, every
`.ts`/`.tsx` under the page, tests included where they live inside those files
and excluded where they have a directory of their own. The figures above were
remeasured in full after several were found to have drifted; adjusting a stale
number by a delta keeps it stale.

The dependency direction is one-way and worth holding in your head:

```
protocol  ←  crypto   ←  crypto-wasm  ←  packages/crypto-wasm  ←  packages/core  ←  src
protocol  ←  server

src-tauri  →  nothing of ours. It is a window, a tray and an updater.
```

**Nothing in `src` knows about Rust any more.** It imports `@nexo/core`, which
imports `@nexo/crypto-wasm`, which is `crates/crypto` compiled for a browser
engine. `invoke()` survives in exactly one file — `lib/native.ts` — for the
seventeen shell things a page cannot do: a tray icon, a toast, a startup entry,
an updater, a relay for other people, a proxy for its own WebView.

### One page, three hosts

The same `apps/desktop/src` is served three ways, and the difference is what
is around it, not what is in it.

| Host | Shell | What it adds | What it cannot do |
|---|---|---|---|
| Windows | `apps/desktop/src-tauri` | Tray, toasts, autostart, updater, Save dialog | — |
| Web | none | — | No tray, no updater, no path to a file |
| Android | the same shell, `cfg(mobile)` | Nothing yet | Autostart and the updater answer honestly that the platform owns them |

`lib/runtime.ts` is the only file that knows which of the three it is, and
`inTauri()` is the only test. Everything else is written once.

Three consequences worth knowing before reading anything else:

- **`apps/server` has a CORS layer.** `NEXO_CORS_ORIGINS` names the browser
  origins allowed to call the API, and unset means no layer at all. The
  packaged desktop app uses `http://tauri.localhost`, which the deployment
  helper adds whenever the layer is configured. Never `*` — `parse_origins`
  refuses one at startup.
- **Nothing is encrypted at rest.** `crates/store` was SQLCipher with a key
  from the OS keystore; a browser has no such place, so `packages/core`'s
  IndexedDB holds the session and the history in the clear. That is the price
  of one client across three targets, recorded in [`REWORK.md`](REWORK.md)
  rather than left to be discovered.
- **`crates/crypto` compiles to WASM**, and this is true rather than
  aspirational: `crates/crypto-wasm` is a `wasm-bindgen` facade over it,
  `packages/crypto-wasm` builds that into an npm package in two layouts
  (`pkg/` for Node, `web/` for a browser), and the `web` job in `ci.yml`
  drives two devices through a real MLS conversation against it — through
  `packages/core`, not around it.

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
| `src/lib.rs` | 699 | `Device` (identity, credential, signer, MLS provider), `Group` (one conversation; `members()` answers each device and its signing key, for safety numbers), `Sealed` (`sealObject` / `openObject` for attachments and stories; `openSegmentedObject` for what the Rust client sealed in segments, and `sealSegmentedObject`, which only the tests call), `peek`, and `deriveVerifier`. Also the MLS state blob codec. |

Three things to know before touching it:

- **The wasm-only dependencies are target-scoped**, in a
  `[target.'cfg(target_arch = "wasm32")'.dependencies]` table. Cargo unifies
  features across a workspace build, so moving `getrandom/js` up into the
  ordinary `[dependencies]` would switch the JavaScript backend on for
  `nexo-server` and the desktop shell as well.
- **getrandom 0.3 also needs a cfg**, not only a feature. It is in
  `.cargo/config.toml`, scoped to the wasm target. Without it the build fails
  at link time with a message about the `wasm_js` backend.
- **`wasm-bindgen-cli` must match the `wasm-bindgen` crate exactly.**
  `packages/crypto-wasm/scripts/build.mjs` refuses to run when they disagree,
  because a mismatch produces a module that loads and then fails on the first
  call.

The state codec is written twice today — here and in
the codec the deleted `crates/client/src/mls_state.rs` used, byte for byte —
and wave 6 moved it into
`crates/crypto` so there is one of it.

---

### The three crates that are gone

`crates/platform` (the OS seam and Windows DPAPI), `crates/store` (SQLCipher)
and `crates/client` (session logic, 7 248 lines) were deleted in
[`REWORK.md`](REWORK.md) wave 11. Everything they did is in `packages/core`.

They are named here rather than simply removed, because a year of commit
messages and half the older documents point at them, and "that file does not
exist" is a worse answer than knowing where it went:

| Was | Is |
|---|---|
| `crates/client/src/session.rs` | `packages/core/src/session.ts` |
| `crates/client/src/conversations.rs` | `packages/core/src/conversations.ts` |
| `crates/client/src/http.rs`, `transport.rs` | `packages/core/src/transport.ts` |
| `crates/client/src/feed.rs` | `packages/core/src/feed.ts` |
| `crates/client/src/pin.rs` | `packages/core/src/pin.ts` |
| `crates/client/src/mls_state.rs` | the state blob codec in `crates/crypto-wasm` |
| `crates/store/src/lib.rs` | `packages/core/src/store.ts` + `idb.ts` |
| `crates/platform` | nothing — a browser has no keystore to seam to |

That last row is the one with a consequence rather than a new home. See
*Invariants* below.


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

### `apps/desktop/src-tauri` — the desktop shell

**What this is not, any more.** Until wave 7 it was the application: it held
MLS, the identity keypair, the SQLCipher key and every message plaintext, and
rule 2 lived here — what crossed into the WebView was already decrypted and
nothing else did. That arrangement cannot exist in a browser, which has no
other side, so all of it moved to `packages/core`.

What is left is 2 373 lines and **seventeen commands**: a window, a tray, toasts,
autostart, a link preview, an updater, a relay for other people and a relay to
connect through. `src-tauri/Cargo.toml` depends on no
Nexo crate and no OpenMLS crate — it is a Tauri app with no cryptography in it.

| File | Ln | Cmds | Owns |
|---|---|---|---|
| `src/lib.rs` | 146 | — | The builder: plugins, the managed state (`WindowPrefs`, `Relay`), `setup` — which **builds the main window** — and the `generate_handler!` list. **Every new command is registered here.** Desktop-only plugins sit behind `cfg(desktop)`. |
| `src/main.rs` | 7 | — | Calls into `lib.rs`. Nothing else. |
| `src/commands.rs` | 295 | 17 | Version, toasts, tray count, focus, window backdrop, close-to-tray, autostart, `forget_account`, link preview, updater, start/stop/status for the relay, and get/set for the relay to connect through. `cfg(mobile)` variants answer honestly where Android owns the feature. |
| `src/preview.rs` | 534 | — | Link previews. Off by default, on purpose (§4.5). |
| `src/relay.rs` | 665 | — | The volunteer's relay ([`RELAY.md`](RELAY.md)): an HTTP `CONNECT` proxy on every interface that forwards to `NEXO_HOSTS` and nowhere else — `403` for any other host, `405` for any other method, a ceiling on tunnels. Logs no client address. Stopping it ends every tunnel. [`STATUS.md`](STATUS.md#relay-m5) says what is still missing. |
| `src/via_relay.rs` | 194 | — | The blocked user's half: the relay this app's WebView uses as its proxy, as `host:port` in `via-relay` in the app config dir. Read before the window is built; changing it restarts the app. Refuses port 80, which Tauri would drop. |
| `src/windows.rs` | 532 | — | Tray, notifications, single instance, autostart, window creation (`create_main_window`, with the proxy), DWM backdrop, `close_action`, `forget_account`. |

#### Every IPC command

**Seventeen.** A command needs a `#[tauri::command]` attribute *and* an entry in
`generate_handler!` in `lib.rs`; missing the second is a runtime rejection, not
a compile error.

`app_version` · `notify_message` · `set_unread` · `focus_window` ·
`set_close_to_tray` · `set_window_backdrop` · `forget_account` ·
`preview_link` · `get_autostart` · `set_autostart` · `check_update` ·
`install_update` · `start_relay` · `stop_relay` · `relay_status` ·
`get_via_relay` · `set_via_relay`

Four went when the page took over what they did: `lock` and `is_unlocked` (the
lock is now `lib/auth.ts`, and there is no SQLCipher handle to close),
`storage_info` and `clear_media_cache` (`navigator.storage.estimate()`, and the
Cache API).

---


### `apps/desktop/src` — the React client

React 19, TypeScript, Tailwind, Zustand. **There is no router**: four
destinations and no deep links do not need one, and §7.4 asks for no page
transitions anyway.

**Mobile-first since wave 5.** Below 768px the app is one pane at a time with a
bottom tab bar; the conversation list *is* a screen, and opening a conversation
replaces it rather than sliding a drawer over it. It used to be a desktop that
shrank, which meant a narrow window always had a conversation underneath
whether or not one had been chosen.

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
| `useLayout.ts` | 91 | The three widths, in one place: phone below 768, list beside chat at 768, context panel at 1280. `matchMedia`, not a resize listener. Exports `layoutNow()` for `useShortcuts`, which is not in a render pass. |
| `useWindow.ts` | 46 | The frameless window's own state and controls. |
| `useAutoUpdate.ts` | 45 | Looks for a new version at launch and installs it — held back until the session gate has answered, so an install cannot discard a half-typed password. |

#### `components/`

`chrome/`: `TopBar.tsx` (100 ln — one top row across the whole app),
`IconRail.tsx` (134 ln — the 64px rail, at 768px and up), `BottomBar.tsx`
(92 ln — the same destinations across the bottom, below 768px) and
`destinations.ts` (27 ln — **the four destinations, shared by both**, so which
tab is second does not change when a window is resized).

Sign-out is in `features/settings/SettingsPage.tsx`, and on the rail as well.
Not in the bottom bar: it is safe on the rail because it is red only on hover,
a touch screen has no hover, and a red control in the thumb zone beside Profile
is one mis-tap from the action that cannot be undone.

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
| `RemoteImage.tsx` | 92 | An image in object storage, rendered from its key — fetched, never linked, because `img-src` names no remote host. |
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

**`settings/`**: `SettingsPage.tsx` (843), `Relay.tsx` (214 — the Connection
section: `ViaRelay` and `RunRelay`, both halves of [`RELAY.md`](RELAY.md)),
`DeleteAccount.tsx` (147), `UnlockPin.tsx` (134), `ChangePassword.tsx` (113),
`BlockedList.tsx` (107), `PrivacyTable.tsx` (81).

#### `lib/` — the typed wrappers around `invoke()`

The IPC seam as the page sees it. **Nothing here holds a secret.**

| File | Ln | Wraps |
|---|---|---|
| `conversations.ts` | 780 | The 45 conversation commands. |
| `native.ts` | 381 | File pickers, save dialogs, clipboard, tray, lock, backdrop, autostart, updater. |
| `feed.ts` | 341 | Feed, posts, comments, profiles; uploading a picture, and fetching one as a `blob:` URL. |
| `images.ts` | 102 | Pictures from object storage for `RemoteImage`: one `blob:` URL per key, shared and reference-counted, revoked once nothing draws it. |
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

24 vitest files, 163 tests, run by `pnpm test`. They cluster on the pure
functions rather than on the components:

```
app/          mute · syncAgent · useChrome · useFeed · useLinkPreview · useUserSearch
components/   stickers
features/     home: CommentThread · compose · storyGroups
              messages: grouping · menu · pan · peer · pinned · selection
lib/          auth · dialogs · format · forward · images · media · viewonce
mock/         data
```

`packages/design-tokens` has its own suite (18 tests), one of which fails if
`tokens.json` has drifted from `tokens.css`.

---

### `packages/core` — the brain, in TypeScript

What the deleted `crates/client` was for the desktop app, this is for every
target. No React
in it and no platform calls: the network arrives as `Transport`, storage will
arrive the same way, so one implementation runs in a browser, a WebView and
Node's test runner. [`REWORK.md`](REWORK.md) wave 6.

**Started, not finished.** Present today:

| File | Ln | Owns |
|---|---|---|
| `src/conversations.ts` | 1 249 | The MLS orchestration: start, send, sync, discover, and the revision rules. The two invariants it exists to hold are at the top of the file — **a commit is staged until the server takes it**, and **the ratchet moves even when nothing is stored**. |
| `src/store.ts` | 951 | Everything this device keeps, over IndexedDB. Deliberately the same vocabulary the deleted `crates/store` used, which is what made wave 7 a swap rather than a rewrite. |
| `src/payload.ts` | 369 | What is inside a ciphertext, mirroring `Payload` in `crates/protocol`. `forwardedText` builds a forward as `Payload::forwarded` does — a name of its own. `voiceMeta` holds a voice note to `VoiceMeta`'s shape both ways — `decodePayload` checks nothing past the kind. Snake_case kinds, because that is what serde emits — a kind missing from `KNOWN` renders an ordinary message as "needs a newer version". |
| `src/transport.ts` | 232 | `fetch` against the API: bearer tokens, the single-flight refresh, and the **rotated-token hand-off**. A rotation that is not persisted is replayed on the next start, and the server reads a reused refresh token as theft — it revokes every session for the account. |
| `src/idb.ts` | 301 | A promise over IndexedDB and the schema ladder, written rather than pulled in — eighty lines of what a library offers, and rule 8 makes a dependency a decision. |
| `src/types.ts` | 140 | The wire, mirroring `crates/protocol`, which stays the authority. |
| `src/auth.ts` | 83 | Salt, register, login, logout. The password never reaches this file. |
| `src/crypto.ts` | 85 | The MLS **seam**: `CryptoModule`, `Device`, `Group`. Nothing in core imports the wasm package, because the glue is generated per target and a core that imported one could only run where that one runs. |
| `src/errors.ts` | 54 | `TransportError` and its five kinds, ported from `transport.rs`. |
| `src/wasm.ts` | 126 | `bindWasm`, `bindObjectWasm` and `bindPasswordWasm`: the lines between the facade's static constructors and the seam above. |
| tests | 2 726 | 124 cases in 11 files. Most were learned by the Rust client being wrong about them first; `conversations.test.ts` is about **ordering**, which is the only way this package loses a message. |

**Two things about the store that were not true of the old Rust one, and both are
load-bearing:**

- **Every read is a promise.** IndexedDB answers later, which is why all of
  `packages/core` is async where the Rust client was not.
- **Nothing is encrypted at rest.** SQLCipher had a key from the OS keystore;
  a browser has no such place. That is the price of one client across three
  targets, recorded in [`REWORK.md`](REWORK.md) rather than left to be found.

**The doubles are not the whole story.** Doubles agree with whatever the code
believes, so the seam is also driven against the real module, in
`packages/crypto-wasm/src/orchestration.test.ts`: two devices, real MLS, a
forty-line fake delivery service, a message each way. It found a cursor that
never moved for a conversation the store had not heard of — which every
invitee's first sync is — within a minute of being written.

Still to come in this wave: the WebSocket stream, and the feed, people and
story calls.

---

### `packages/crypto-wasm`

```
scripts/build.mjs          cargo build --target wasm32 + wasm-bindgen, into pkg/ and web/
src/conversation.test.ts   Two devices, one real MLS conversation, in wasm
src/orchestration.test.ts  packages/core driving the real module, nothing faked but the network
src/segmented.test.ts      Segmented attachments opened whole, through core's reader
pkg/, web/                 Generated. Git-ignored; CI builds them and so does a clone.
```

`pnpm test:wasm` runs it, and builds `pkg/` **only when it is missing** —
after changing `crates/crypto-wasm`, run `pnpm --filter @nexo/crypto-wasm
build` first, or the tests run against the old module and a new function is
simply not there. `check.ps1` builds before it tests. Deliberately **not** part of `pnpm test`:
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
| Add or change an **encrypted-path endpoint** (messages, groups, key packages) | `crates/protocol/src/lib.rs` (the type first — both sides follow it) → `apps/server/src/delivery/` → `packages/core/src/types.ts` → `packages/core/src/conversations.ts` → `apps/desktop/src/lib/conversations.ts` | `BRIEF.md` |
| Add or change a **feed / profile endpoint** | `apps/server/src/posts.rs` or `profiles.rs` → `packages/core/src/feed.ts` → `apps/desktop/src/lib/feed.ts` | `BRIEF.md` |
| Add a **route the server already has** but nothing calls | `apps/server/src/` first — check [the route table](#every-route). `/v1/stream` sat unused for months, and `follows` was the opposite case | — |
| Add a **new IPC command** | Ask first whether it belongs in the page. Only seventeen things are the shell's: `apps/desktop/src-tauri/src/commands.rs` → **register it in `lib.rs`'s `generate_handler!`** → `apps/desktop/src/lib/native.ts` | — |
| A **UI-only change** | the `features/*` file → `components/ui` → `packages/design-tokens/tokens.css` | Rust, always |
| Change **what is stored on the client** | `packages/core/src/idb.ts` (the `STORES` table) → `packages/core/src/store.ts` → bump `SCHEMA_VERSION` and add a rung | — |
| Change **what is stored on the server** | `apps/server/migrations/` (a **new** file) → the module → regenerate `.sqlx/` | — |
| Anything **MLS / group membership** | `crates/crypto/src/mls.rs` → `crates/crypto-wasm/src/lib.rs` (the facade) → `packages/core/src/conversations.ts` → `apps/server/src/delivery/` | OpenMLS internals |
| **Auth, login, tokens** | `apps/server/src/auth/` → `packages/core/src/session.ts` → `apps/desktop/src/lib/auth.ts` → `apps/desktop/src/features/auth/` | — |
| **Lock screen / PIN** | `packages/core/src/pin.ts` → `apps/desktop/src/lib/auth.ts` (`lockSession`, `unlockWithPin`) → `apps/desktop/src/features/auth/` | `PIN-ROTATION.md` — that is TLS key pinning, an unrelated subject |
| **Search, invitations, reporting** | `apps/server/src/invites.rs` or `profiles.rs` → `packages/core/src/people.ts` → `apps/desktop/src/lib/people.ts` | `BRIEF.md` |
| **Who may open a conversation with whom** | `apps/server/src/invites.rs::may_reach` → its call site in `apps/server/src/delivery/mod.rs`, before anything is written | The client — the rule is the server's or it is nothing |
| **Stories** | `packages/core/src/stories.ts` → `apps/server/src/stories.rs` → `features/home/storyGroups.ts` (read it before changing grouping) → `features/home/Stories.tsx` | — |
| **Attachments or media playback** | `crates/crypto/src/attachment.rs` (which encoding?) → `packages/core/src/attachments.ts` → `apps/desktop/src/lib/conversations.ts` → `apps/desktop/src/lib/media.ts` | — |
| The **live socket** | `apps/server/src/stream/` → `packages/core/src/stream.ts` → `apps/desktop/src/lib/stream.ts` | — |
| **Feed, posts, comments** | `apps/server/src/posts.rs` → `packages/core/src/feed.ts` → `app/useFeed.ts` → `features/home/` | — |
| **Keyboard shortcuts** | `app/useShortcuts.ts` — all of them, in one listener | Anywhere else |
| **Anything about width** | `app/useLayout.ts` — the three breakpoints and nothing else has any | A media query in a component |
| **Colours, spacing, motion** | `packages/design-tokens/tokens.css`, then regenerate the JSON | Never hardcode a value in a component |
| **Tray, notifications, window chrome, autostart** | `apps/desktop/src-tauri/src/windows.rs` → `apps/desktop/src-tauri/src/commands.rs` → `app/useWindow.ts`, `app/useChrome.ts` | — |
| **Relays** — running one, or connecting through one | [`RELAY.md`](RELAY.md) → `apps/desktop/src-tauri/src/relay.rs` (running one) or `via_relay.rs` (connecting through one) → `features/settings/Relay.tsx`. A new host in the CSP's `connect-src` goes into `NEXO_HOSTS` too | — |
| **Link previews** | `apps/desktop/src-tauri/src/preview.rs` → `app/useLinkPreview.ts`. Read `THREAT-MODEL.md` §2.3 first — the refusals are the feature | — |
| **Offline behaviour** | `packages/core/src/conversations.ts` (`sendPayload`, `flushOutbox`) → `packages/core/src/store.ts` (the outbox) → `app/syncAgent.ts` | — |
| **Which host am I on** | `apps/desktop/src/lib/runtime.ts` — `inTauri()` is the only test, and it lives in one file for a reason | A `window.__TAURI__` check in a component |
| **The web build or its deploy** | `netlify.toml` → the `web` job in `.github/workflows/ci.yml` → `docs/DEPLOY.md` step 8 | — |
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
| **A feature Nexo itself wants, not copied from another app** | [`RELAY.md`](RELAY.md) if it is about reaching a blocked user past a block; otherwise the [invariants](#invariants) and the route table |

### Diagnosing

| Symptom | Look here first |
|---|---|
| An IPC call rejects with nothing useful | Is the command in `generate_handler!` in `src-tauri/src/lib.rs`? That omission is a runtime rejection, not a compile error |
| Something in the page silently does not load — a font, a video, an image, a fetch | The **CSP** in `tauri.conf.json`. It fails silently and has been wrong three times. The only way to see it is the WebView console of a real run |
| Every call answers "You are not signed in" | `Session.context` found no account or no device: the app is locked (`lockSession` reset the runtime) or signed out. After a lock, a PIN (`Session.resume`) or a sign-in puts it back |
| The session ends by itself | A rotated refresh token that never reached the store. See the rotation rule in [Conventions](#conventions-that-will-trip-you-up) |
| A server test passes locally and fails for somebody else | It asserted on a global listing in a shared database, or `.sqlx/` was not regenerated |
| Nothing in the app works at all — sign-in, feed, messages | Ask `api.delidev.net` itself: `curl -i https://api.delidev.net/v1/health`. A 502 from Caddy means `nexo-server` is not running on the box, not that the client is wrong — `/v1/health` needs no database and no token, so anything but 200 is the service. The runbook is [`OPS.md`](OPS.md) *When `api.delidev.net` answers 502* |
| Every upload fails — profile picture, banner, feed image, chat attachment — while sign-in, messages and posts work; the message is "Can't reach the server: Failed to fetch" | The **buckets' CORS**, not the API's. `curl -si -X OPTIONS https://fsn1.your-objectstorage.com/nexo-enc/probe -H "Origin: http://tauri.localhost" -H "Access-Control-Request-Method: PUT" -H "Access-Control-Request-Headers: content-type"` — a `403` means no rule matches that origin. [`OPS.md`](OPS.md) Phase 8, *Bucket CORS* |
| `nexo-server` restart-loops after an edit to `/etc/nexo/nexo.env` | It refuses a half-finished deployment by design: the S3 block and `NEXO_CORS_ORIGINS` are each all-or-nothing and checked at startup. `journalctl -u nexo-server -n 60` names the one that failed |
| The app starts with no window, or a window property in `tauri.conf.json` is ignored | The main window says `"create": false` and is built by `windows::create_main_window` in `lib.rs`'s `setup`, found by `"label": "main"`. A `setup` that returns early, or a renamed label, is no window at all |
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
| `pnpm test:wasm` | Drives an MLS conversation and the object crypto through `crates/crypto-wasm`. Builds it only when `pkg/` is missing; after a facade change run `pnpm --filter @nexo/crypto-wasm build` first. Needs the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the pinned version. |
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
- **A rotated refresh token must reach the store before the next bearer call.**
  Every refresh issues a new refresh token and spends the old one; a spent one
  replayed on the next start reads as theft, and the server revokes every
  session for the account. In `packages/core` the `Transport` hands each
  rotation to the handler `Session` installs in its constructor
  (`setRotationHandler` → `Store.setRefreshToken`) and awaits it before the
  next authenticated request. So every authenticated call goes through the one
  `Transport` that `lib/runtime.ts` builds and hands to `Session`: a second
  `Transport`, or one no `Session` owns, refreshes into nowhere. The Rust
  client had the same rule as a drain helper repeated in four modules, and the
  one that forgot it (`meet.rs`) could silently end somebody's session.
- **An attachment has two encodings; the page reads both and writes one.**
  `crates/crypto`'s `attachment.rs` seals a file whole under one GCM tag, or
  in 256 KiB segments whose AAD binds each segment's index and the total, so a
  byte range can be opened alone and a reordered or truncated stream fails
  authentication instead of playing short. The two are not distinguishable from
  the ciphertext, so `Payload::Attachment::segmented` says which — absent means
  whole, so every older message still reads. The Rust client sealed video
  segmented. **The page seals everything whole** (`sendAttachment` →
  `ObjectCrypto.seal`) and opens a segmented one whole too:
  `attachments.open` picks `openSegmented` from the payload's flag, because
  opening it as a whole object fails its tag — which is how every such video
  read as "can't decrypt" until it did. The declared `size` is the sender's
  number, so `decrypt_segmented` checks it against the ciphertext's length
  before allocating anything. Playing a range before the rest arrives needs a
  ranged player the page does not have.
- **Nothing in the page may reach a third party, and the CSP is what says so.**
  `img-src` names no remote host, and `connect-src` names only the two the
  page cannot work without — the API and the object store, added when the page
  became the client. That is rule 3's enforcement point and not an oversight to
  be widened when a feature wants it.
  `THREAT-MODEL.md` §2.3 already worked this through once for link previews and
  ended with "no image fetch" — so a feature that wants remote pictures (GIF
  search is the standing example) is a threat-model decision before it is a
  frontend one. Stickers are drawn in the repo for exactly this reason.
  **A host added to `connect-src` goes into `NEXO_HOSTS` in
  `src-tauri/src/relay.rs` as well.** A relay forwards only what that list
  names, so a host missing from it works at home and fails for exactly the
  people relays exist for. A test in `relay.rs` reads the CSP and fails when
  the two disagree.
- **CORS is off unless `NEXO_CORS_ORIGINS` names an origin, and `*` is refused
  at startup.** Both the web client and packaged desktop app make HTTP calls
  from browser contexts; the latter uses `http://tauri.localhost`. The
  deployment helper adds that exact loopback origin when CORS is configured.
  `parse_origins` in `apps/server/src/lib.rs`
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
- **The buckets have CORS rules of their own, and nothing in the repo sets
  them.** The page uploads and downloads every picture and attachment itself,
  with a URL the API signed, so each bucket must allow the same origins as
  `NEXO_CORS_ORIGINS`. It is bucket configuration, applied by hand with
  `put-bucket-cors` (`OPS.md` Phase 8, *Bucket CORS*), and it was missing for
  the whole first round of testing after the rework: sign-in, messages and
  posts worked, and every picture failed.
- **Anything thrown that is not a `TransportError` becomes "Something went
  wrong. Try again."** — the fallback in `asConversationError`, `asFeedError`
  and their siblings in `lib/`. A `fetch` to anywhere but the API has to wrap
  its own failures the way `fetchStoryObjects` does, or a browser's bare
  `TypeError: Failed to fetch` reaches the screen as that sentence and hides
  its cause. The object-store fetches in `lib/runtime.ts` and
  `core/src/feed.ts::uploadBytes` did exactly that until they were wrapped.
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
- **Locking drops the session from memory, and each piece by hand.**
  `lockSession` in `lib/auth.ts` closes the live socket (`closeStream`),
  clears the transport's tokens, and resets the runtime so the MLS provider
  goes with it. Nothing leaves the disk: the refresh token, the identity and
  the messages stay in IndexedDB, unencrypted, so the lock guards the screen —
  and every screen that mentions it says exactly that. Unlocking always needs
  the server: a PIN is checked on this machine and then `Session.resume`
  refreshes; a password is a sign-in. The socket is the piece that was missed
  once: the Rust `lock` left an authenticated WebSocket open behind the lock
  screen for months. Anything that adds a long-lived connection joins
  `lockSession`.
- **Safety numbers rest on `recordMembership`, and it runs after every
  membership change.** `Store.recordPeers` keeps each other device's signing
  key; `safetyNumber` is computed from it and a key that differs from it is the
  "safety number has changed" warning (`THREAT-MODEL.md` §4). `recordMembership`
  in `core/src/conversations.ts` reads `Group.members()` and records everyone
  but this device — at the end of every `sync`, before the cursor moves; on a
  quiet `sync` once, when nothing has been recorded for that conversation yet
  (never for `self`, which has nobody to record); and after `startWith`,
  `startGroup` and `addTo`. After the port nothing called
  `recordPeers` at all: no number could be shown and no change noticed. A new
  path that changes membership calls it too. The members come from wasm as
  getter classes, so copy their fields; a spread records nothing.
- **A view-once's key lives in `viewOnce` and nowhere else.** Opening burns it
  there (`burnViewOnce`), so a copy anywhere else outlives the promise. The
  message row keeps `viewOnceBubble` — id, type, size — and `appendViewOnce`
  writes both rows in one transaction. The port once stored the whole payload
  in `messages` and never filled `viewOnce`, so every view-once was unopenable
  *and* unburnable; `openable` is read from the table, never from the payload.
- **Signing out wipes in a `finally`, and the wipe is one transaction.** The
  Rust client once reported a successful sign-out with the database, its key
  and the PIN all still on disk, because one failed step skipped the ones after
  it. `Session.logout` asks the server to end the session and wipes in a
  `finally`, and `Store.wipe` clears every object store in one transaction, so
  no step can skip another. `Session.deleteAccount` is the other way round,
  server first: a refusal must leave this device able to reach the account.
- **A conversation's title is not a handle.** `title` is a label — for a DM
  with no member list yet it is literally `"Unnamed conversation"` — and
  looking it up as an account sends a doomed request on every render.
  `features/messages/peer.ts::peerHandle` reads the member list and answers
  `undefined` rather than guessing. The core records fixing the same
  conflation once for groups; it survived in the UI for the untitled DM.
- **The local store's schema version is one constant, and a rung is never
  rewritten.** `SCHEMA_VERSION` in `packages/core/src/idb.ts` is what
  `openDatabase` asks for, and `onupgradeneeded` climbs one
  `if (event.oldVersion < N)` rung per version. A rung a released build has
  climbed is never edited — add one. A rung that adds an index over existing
  rows backfills them, as rung 2 does for `searchTerms`, or older data is
  invisible to the new read; rung 3 rewrites rows, moving view-once keys out of
  `messages` into `viewOnce`. `openDatabase` takes an optional version so a
  test can build a database as an older build left it. No test checks that the
  constant and the last rung agree: bump both in the same change.
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
- **A method added to a seam needs every implementation, and the compiler
  finds them.** `CryptoModule` is implemented by `bindWasm` in
  `packages/core/src/wasm.ts` and by the doubles in `conversations.test.ts` and
  `session.test.ts`; `pnpm typecheck` covers the tests, so a missing method is
  an error, not a silent gap. `Transport` is a class, not an interface: tests
  inject `fetch` rather than replacing it.
- **Two different questions decide what an attachment is**, and only one of
  them is about safety. `lib/media.ts` reads the sender's declared MIME to pick
  a *layout* — that value is guessed from a file extension and is not evidence.
  What the page may actually be handed has to be decided from the bytes, and
  a `blob:` URL carries this page's origin, so the type it is given matters.
  **Until the rework** that was Rust: `feed::sniff_mime`, then `is_renderable`
  or `is_playable`. That file was deleted with the Rust client. **Today** only
  pictures from the bucket are sniffed — `feed.sniffImage` in `packages/core`,
  called by `downloadImage` for `RemoteImage`. Attachments and stories still
  build their `blob:` URLs from the sender's declared MIME; nothing navigates
  to one, which keeps that latent rather than exploitable, and restoring the
  sniffer there is its own piece of work. Never widen the first question to fix
  the second, and never test for `"application/octet-stream"` instead of
  asking a sniffer: that spelling silently accepts whatever it learns next.
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
  `classify` in `packages/core/src/transport.ts` parses the body as
  `{error, message}` and falls back to "The server returned {status}." when it
  cannot. So a handler that answers `(StatusCode::SERVICE_UNAVAILABLE, "some
  prose")` — which compiles, reads fine, and looks right — turns a considered
  sentence into a generic failure at the last moment. The old `calls.rs`
  shipped that way and it was found by driving the app, not by review. Every
  server module defines its own private `ErrorBody` for this; a new one joins
  them.
- **A production bundle ignores `VITE_NEXO_API_BASE` and talks to production.**
  `baseUrl()` in `lib/runtime.ts` reads the override only when
  `import.meta.env.DEV`, so a shipped bundle contains the literal and nothing
  can point it elsewhere; the live socket derives its URL from the same
  transport. The consequence when *testing*: `pnpm build`, or any
  `tauri build`, driven against a local server is not talking to it, and a
  route that only exists locally comes back 404 — `not_found`, then a generic
  error — so it looks like a bug in the feature rather than a bundle aimed at
  the wrong host.
- **Two `cargo deny` passes, never one.** The Windows client and the Linux
  server have disjoint dependency graphs; a single union graph judges each
  against the other's dependencies. See the comment at the top of `deny.toml`.
- **`.ps1` files are CRLF**, everything else LF — `.gitattributes` enforces it.
- **The main window is built in code, not by config.** It says `"create": false`
  in `tauri.conf.json` because a WebView's proxy is fixed when it is made, and
  the relay to connect through (`via_relay.rs`) is chosen at runtime. The
  config entry still describes the window — `from_config` reads it — but
  `lib.rs`'s `setup` makes it, on every platform.
- **`app.restart()` only from an `async` command.** Called on the main thread —
  where a sync command runs — Tauri spawns the new process before the
  single-instance lock is released, and the new process hands itself to the
  dying one and exits: the app just closes. From another thread it goes through
  `RunEvent::Exit` first, which releases the lock. `install_update` and
  `set_via_relay` are both `async` for this reason.
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
| [`CONTEXT.md`](CONTEXT.md) | 75 KB | This file. Where things are, and what not to break. |
| [`REWORK.md`](REWORK.md) | 19 KB | **Current.** Why this repository is becoming one TypeScript client for web, Windows and phone, what that costs the invariants, and the eleven waves that get there. Read before starting anything large. |
| [`STATUS.md`](STATUS.md) | 117 KB | What works today, what is known broken, and what was checked and cleared. **Read before assuming a feature is missing.** |
| [`COMPONENTS.md`](COMPONENTS.md) | 11 KB | The UI component reference. |
| [`RELEASING.md`](RELEASING.md) | 10 KB | Tag, build, sign, publish, updater manifest. |
| [`PIN-ROTATION.md`](PIN-ROTATION.md) | 3 KB | Why the client does **not** pin TLS keys, and what any future pinning must do. Nothing to do with the unlock PIN — that is `packages/core/src/pin.ts` and `THREAT-MODEL.md` §3. |
| [`SIGNAL-ANALYSIS.md`](SIGNAL-ANALYSIS.md) | 10 KB | Why MLS and not the Signal protocol. |
| [`TELEGRAM-FEATURES.md`](TELEGRAM-FEATURES.md) | 13 KB | Which Telegram features fit this app, which cannot, and why. Read before proposing one. |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | 11 KB | What must ship beside the `.exe`. |
| [`README.md`](../README.md) | 5 KB | What Nexo is, who it is for, what it does and does not protect. No build steps. |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 10 KB | Setup, prerequisites, the three builds (Windows, web, Android), troubleshooting. For humans on a new machine. |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | 35 KB | Adversaries in and out of scope; what is deliberately not protected. |
| [`TUTORIAL.md`](TUTORIAL.md) | 19 KB | Every value you personally have to supply: accounts, costs, domains, secrets — and which of them block you today. |
| [`DEPLOY.md`](DEPLOY.md) | 22 KB | **The straight line from a fresh server to a live API, and from CI to the website.** Eight steps, exact commands, and the failure table. Read this at the terminal; read `OPS.md` when a step misbehaves. |
| [`OPS.md`](OPS.md) | 27 KB | The Hetzner runbook — the reasoning behind every step `DEPLOY.md` takes, plus TLS, backups and incidents. |
| [`PLAN.md`](PLAN.md) | 23 KB | Milestones M0–M9 and the open risks. |
| [`BRIEF.md`](BRIEF.md) | 27 KB | The original specification. The source of the §-numbers other docs cite. |
| [`LICENSING.md`](LICENSING.md) | 29 KB | Copyright, MIT duties, dependency licences, Swiss law, export control. |
| [`RESEARCH-COMPARISON.md`](RESEARCH-COMPARISON.md) | 39 KB | Why each technology decision beat its alternative. Background, not instruction. |
| [`RELAY.md`](RELAY.md) | 9 KB | A user's device as a path past a block: why a volunteer relay works, what it sees (nothing), and the three hard parts — finding a relay, home routers, and relay location. **A design, not a status line; nothing here is built yet.** |

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
   `packages/core/src/store.ts` whole costs ~12 000 tokens;
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

