# Rework — one client, three targets

Nexo was built Windows-first: a Rust core behind 116 Tauri IPC commands, with
the React app as a thin page on top. The website was never part of that — it is
a **second implementation** in `deli-develop/nexo-web`, because `crates/store`
is SQLCipher over vendored OpenSSL and has no business in a browser. Every
feature therefore got built twice, and that is the concrete reason this project
became hard to move.

This document is the plan that ends the duplication. It is written before the
first line changes, as [`CLAUDE.md`](../CLAUDE.md) asks, and it supersedes
nothing in [`PLAN.md`](PLAN.md) — M0–M9 happened, this is what comes after.

Target version: **0.2.0**. Target domains: `nexo.delidev.net` for the app,
`api.delidev.net` for the server. Both of the old hosts are down —
`nexo.delidev.net` and `api.dice.fit` answer nothing at all — so there is no
live deployment to preserve, and no better moment to do this.

---

## The decision

Four questions were answered before this was written:

| Question | Answer |
|---|---|
| How does one codebase serve web + Windows + phone? | **One TypeScript app.** The same source builds a website, a Windows app and an Android app. |
| Do private chats stay end-to-end encrypted? | **Yes, MLS stays.** `crates/crypto` goes to WASM and runs in every webview. |
| What survives besides chat? | **Stories, the Home feed, public profiles and follows, attachments and voice.** |
| Where does the server run? | **A new Hetzner VPS**, by the runbook that already exists. |

Meet&Greet and calls are deleted. Everything else keeps working.

---

## The end state

```
packages/core          TypeScript. Session, transport, sync, outbox, MLS
                       orchestration, IndexedDB. The brain. Runs anywhere
                       a browser engine runs.
packages/crypto-wasm   crates/crypto compiled to wasm32-unknown-unknown.
                       MLS, identity, attachment crypto. Built by CI, not
                       committed.
packages/design-tokens Unchanged.
apps/web               The one React app. Mobile-first, comfortable on a
                       desktop. Builds three ways:
                         - static site  -> Netlify -> nexo.delidev.net
                         - Tauri v2     -> Windows .msi
                         - Tauri v2     -> Android .apk  (iOS later)
apps/server            Unchanged in kind: axum + Postgres, Linux aarch64.
                       Minus meet and calls.
crates/protocol        Stays. The wire, shared by the server and the client.
crates/crypto          Stays. The source of packages/crypto-wasm.
```

And these go away:

```
crates/client      7 668 ln   reimplemented in packages/core
crates/store       4 220 ln   replaced by IndexedDB
crates/platform      425 ln   no OS seam left to hide
src-tauri          7 317 ln   thinned to a shell: window, tray,
                              notifications, autostart, file dialogs,
                              updater. ~12 commands, not 116.
```

The dependency direction becomes one line:

```
crates/protocol -> crates/crypto -> packages/crypto-wasm -> packages/core -> apps/web
crates/protocol -> apps/server
```

---

## What this costs the invariants

The trade is real and gets written down rather than glossed. Three of the eight
rules in [`CONTEXT.md`](CONTEXT.md#invariants) change:

- **Rule 2 — "No key material in the WebView" — is retired.** It cannot survive
  a browser target: a website has no process below the page to hold a key. Keys
  move into WASM linear memory and IndexedDB, on *every* platform including
  Windows. This is the same trade `nexo-web` already made; it now applies
  everywhere. DPAPI stops protecting the store key because there is no store
  key.
- **Rule 3 — "No remote code in the client" — holds on Windows and Android,
  and cannot hold on the web.** A website is remote code by definition. The web
  target gets Subresource Integrity, a strict CSP and no third-party origins;
  that is the most it can have, and the difference gets stated in the threat
  model rather than hidden.
- **Rule 6 — "Zeroize secrets" — weakens.** WASM memory can be wiped; a
  JavaScript string cannot. The boundary moves: secrets stay inside WASM and
  cross into JS as rarely as possible.

Rules 1, 4, 5, 7 and 8 are untouched, and rule 5 gets *more* work: the app now
has to say plainly that a browser is a weaker place to keep a key than a
desktop process was. [`THREAT-MODEL.md`](THREAT-MODEL.md) gets a chapter per
target, not one shared chapter.

---

## The one thing that is not a simple deletion

`apps/server/src/meet.rs` holds `may_reach`, and
`apps/server/src/delivery/mod.rs:389` calls it before creating any
conversation. It is the **private-account gate**: if an account is private, a
stranger cannot open a chat with it unless they already share a conversation or
hold a live invite link. It lives in the Meet&Greet module but has nothing to
do with the map.

So Meet&Greet is not deleted whole:

| Part | Fate |
|---|---|
| The map, pins, pin coarsening, NexoChar, the agreement | Deleted. |
| Consent, intro requests, the one-message rule (`delivery/mod.rs:855`) | Deleted with them. |
| `may_reach` + `meet_invites` + invite create/list/revoke | **Kept**, moved to `apps/server/src/invites.rs`. Private accounts keep working. |
| `story_post` / `story_list` / `story_open`, which live in `src-tauri/src/meet.rs` today | **Rescued** into `src-tauri/src/stories.rs` with their own error type, and `lib/meet.ts`'s story half into `lib/stories.ts`. |

Deleting the module whole would quietly remove private accounts and take
stories down with it.

---

## The waves

Each ends with `.\scripts\check.ps1` green, its own commit, and the repository
in a state where stopping is fine.

| # | Wave | Ends with |
|---|---|---|
| 1 | Meet&Greet out; private accounts and stories kept | The app builds and runs, with four destinations instead of five |
| 2 | Calls out | One fewer `unsafe` block in the workspace |
| 3 | **Spike: MLS in WASM** — **done, and it works** | A browser encrypts and decrypts a real MLS message. It does; see below |
| 4 | The server: cleaned, redeployed, `api.delidev.net` — **done** | It answers 200, with `protocol_version: 5` |
| 5 | Mobile-first layout — **built, not yet seen running** | The existing app, correct from 360px to 2560px |
| 6 | `packages/core` — the TypeScript session layer — **started** | Headless tests pass against a real local server |
| 7 | The React app swapped onto `packages/core` | `invoke()` gone from feature code; the Windows app still works |
| 8 | The web build | `nexo.delidev.net` is live |
| 9 | The Tauri shell, thinned | Windows `.msi`, ~12 commands |
| 10 | Android | A signed `.apk` |
| 11 | The dead crates retired, the docs redrawn | `crates/client`, `crates/store`, `crates/platform` gone; `CONTEXT.md` true again |

### Wave 1 — Meet&Greet out

Delete `crates/client/src/meet.rs`, `crates/client/tests/meet_offline.rs`,
`apps/desktop/src/features/meet/` (9 files), `apps/desktop/src-tauri/src/meet.rs`
and `apps/server/tests/meet.rs`. Split `apps/server/src/meet.rs` into
`invites.rs`, which is kept, and nothing, which is the rest. Rescue the three
story commands into `src-tauri/src/stories.rs` and `lib/stories.ts`.

Remove 14 of the 17 `meet_*` IPC commands from `generate_handler!`, the eight
`/v1/meet/*` routes except the invite ones, the `meet` and `meet_requests`
rate-limit buckets, the `Route = "meet"` member and its rail entry, and the
Meet&Greet half of `crates/client/src/transport.rs` — which means touching
**all seven** `Transport` implementors.

A new migration drops `meet_pins`, `meet_consents` and `meet_requests`, and
renames `meet_invites` to `invites`. `meet_pins` leaves `crates/store` with a
`SCHEMA_VERSION` bump. `maplibre-gl`, `world-atlas`, `topojson-client`,
`@dicebear/core` and `@dicebear/styles` leave `package.json` — the biggest
single bundle saving in this plan.

**One gap this wave found and did not close.** The desktop client can *mint* an
invitation and cannot *redeem* one. `Transport::create_conversation` takes a
conversation id and a list of handles and no secret, so nothing in the Windows
app has ever put a value in the `invite` field the server reads — the field was
exercised by the server's own tests and by nothing else. This predates the
removal rather than following from it, and it means the use counter in
`PrivacyPanel` reads zero for a desktop-only account no matter what happens.
Closing it is a feature, not a fix, so it does not belong in a deletion wave;
it wants an invite parameter on `start_conversation` and somewhere to paste a
link.

### Wave 2 — Calls out

Seventeen files. `apps/desktop/src/features/calls/`, `lib/calls.ts`,
`apps/server/src/calls.rs` and its route, the four call commands in
`src-tauri/src/conversations.rs`, `Payload::Call` in `crates/protocol`, the
signalling in `crates/client/src/conversations.rs`, the `ice_servers` method on
`Transport` and its seven implementors, and the call half of
`crates/client/tests/live_messaging.rs`.

`apps/desktop/src-tauri/src/permissions.rs` goes with them — 181 lines of COM
FFI and one of the workspace's two `unsafe` blocks, needed only to answer
WebView2's camera prompt during a call.

Docs: `CALLS-HANDOVER.md` deleted, `OPS.md` Phase 8b (coturn) deleted, the two
call rows in `CONTEXT.md`'s task table deleted.

**What this estimate missed**, recorded because a plan that is quietly
corrected afterwards is not a plan. "Seventeen files" counted the signalling
path and not the *record* a finished call left behind: `CallRecordView` in the
shell, `CallRecord` and `CallBubble` in the page, and the `call` field on every
message view between them. Three dependencies went too — `hmac`, `sha1` and
`base64` existed in the server only to mint the coturn REST credential, and
nothing else in the workspace used the first two. And `commands.rs::lock` had a
fourth call site for the media gate that the survey did not turn up. The wave
was roughly half again the size it was scoped at; nothing was dropped to make
it fit.

### Wave 3 — Spike: MLS in WASM ✅

**This was the go/no-go for the entire plan, and the answer is yes.**

`crates/crypto-wasm` is a `wasm-bindgen` facade over `nexo-crypto` — a facade
and not a second implementation, so rule 1 is untouched and nothing in it
computes anything. `packages/crypto-wasm` builds it into an npm package. Two
devices hold a real MLS conversation: identity, safety number, KeyPackage,
add-member, Welcome, encrypt, decrypt, and a state blob that survives being put
away and taken out again. Six tests in Node, and the same flow checked by hand
in a real browser.

**What was actually in doubt, and how each one landed:**

| Risk | Outcome |
|---|---|
| `std::time::SystemTime` traps on `wasm32`, and OpenMLS stamps KeyPackage lifetimes with it | **Solved upstream.** `openmls/src/key_packages/lifetime.rs` swaps in `fluvio_wasm_timer::SystemTime` under `cfg(target_arch = "wasm32")`, and OpenMLS's own `js` feature pulls it in. |
| `getrandom` needs a browser backend | **Two majors, two mechanisms.** `rand 0.8` (used by `nexo-crypto` *and* `openmls_rust_crypto`) is on getrandom 0.2 and needs its `js` feature; OpenMLS's `js` feature is on getrandom 0.3, which needs `--cfg getrandom_backend="wasm_js"` as well. Both are set, the cfg in `.cargo/config.toml`. |
| **`rayon`.** OpenMLS uses parallel iterators in `treesync`, and single-threaded wasm has no threads | **The one that could not be answered by reading**, and the reason this was a spike rather than a survey. It compiles and it runs: `addMember` reaches that code and returns a Welcome. |

**Two decisions taken while building it, both worth knowing:**

- **`wasm-bindgen-cli`, not `wasm-pack`.** wasm-pack fetches its own toolchain
  at build time — a network dependency in the middle of a build, at a version
  this repository does not pin, against rule 8. The CLI is installed once at an
  exact version, `packages/crypto-wasm/scripts/build.mjs` does the twenty lines
  of layout wasm-pack would have done, and it *checks* that the CLI version
  equals the crate's: a mismatch produces a module that loads and then fails on
  the first call, which is a bad way to find out.
- **The wasm deps are `[target.'cfg(target_arch = "wasm32")']`-scoped.** Cargo
  unifies features across a workspace build, so an ordinary `getrandom/js`
  dependency here would switch the JavaScript backend on for `nexo-client` and
  `nexo-server` too. A target table is the one form cargo does not unify.

**What the spike deliberately did not do.** No transport, no store, no session
— those are wave 6, in TypeScript. And the state codec is written twice for
now, here and in `crates/client/src/mls_state.rs`, byte-identical on purpose;
wave 6 moves it into `nexo-crypto` so there is one of it.

`pnpm test:wasm` runs it. It is **not** part of `pnpm test`, because that runs
on a machine with no Rust toolchain in CI; the `crypto-wasm` job has one. The
built package is generated and not committed.

### Wave 4 — The server

Two halves, and only one of them is mine to do.

**The half in the repository, done:** every `api.dice.fit` in the tree is now
`api.delidev.net`, including the one that matters — `DEFAULT_BASE_URL` in
`crates/client/src/http.rs`, which is compiled into the client and is what a
shipped build talks to. `OPS.md` is rewritten around one domain and one host,
and the runbook is shorter than it was because two of the three hosts turned
out to be obsolete rather than moved:

| Old host | What happened |
|---|---|
| `api.dice.fit` | Moved to `api.delidev.net`. Still the API, still on this box. |
| `nexo.dice.fit` | Gone. It was a marketing and download page; the app itself is now a website at `nexo.delidev.net` on Netlify, and the Windows installer comes from the GitHub release. |
| `updates.dice.fit` | Gone, and already was. The updater fetches `latest.json` from the GitHub release — `tauri.conf.json` has pointed there since the bug in `.github/workflows/release.yml` was fixed, so `OPS.md`'s Phase 10 was describing a host nothing used. |

One thing that reads like a simplification and is not: **the app and the API
are still cross-origin.** They share a registrable domain now, which they did
not before, but an origin is scheme, host and port — `nexo.delidev.net` and
`api.delidev.net` are different hosts and a browser treats them as strangers.
`NEXO_CORS_ORIGINS` is still required, and still has to name the origin
exactly.

**The half that needed an account, not a commit — also done.** A CAX21 in
Falkenstein, `delidev.net` moved to Hetzner's nameservers from Dynadot, and
`api.delidev.net` answering through Caddy:

```
HTTP/1.1 200 OK
Via: 1.1 Caddy
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload

{"status":"ok","protocol_version":5}
```

`protocol_version: 5` is the part worth reading: it proves the running binary
is from after Meet&Greet and calls came out, rather than an older build that
would answer 3 and quietly fail against this client.

**One thing is configured and not yet in effect.** The CORS layer is off: the
`NEXO_CORS_ORIGINS` support in `scripts/deploy-server.sh` was written *after*
the rework was committed, so the box cloned a script that did not know the
variable existed. Adding the line to `/etc/nexo/nexo.env` and restarting is
enough — no rebuild — and nothing needs it until wave 8, because
`nexo.delidev.net` does not exist yet. It is written down here rather than
discovered then.

The original list of what this half needed, for the next time: `OPS.md` Phases 1–7 are
the steps, unchanged except for the names; Phase 8 adds object storage when
attachments are wanted; Phase 8b is gone with calls. Nothing in the repository
can do this part, and it is the gate on wave 8 — `nexo.delidev.net` cannot go
live against a server that does not exist.

### Wave 5 — Mobile-first layout

The mockups, applied to the app that exists today. Under 768px: a bottom tab
bar, a full-width conversation list, the chat as its own screen with a back
arrow, a story strip above the list. At 768px and up: the list and the chat
side by side, the way the desktop mockup shows. Above 1280px: the context panel
returns.

`app/useLayout.ts` already owns the breakpoints and is where this is decided.
`components/chrome/IconRail.tsx` becomes a rail on a desktop and a bottom bar
on a phone. Touch targets reach 44px. This wave changes no data path, which is
why it can happen before the plumbing is replaced — and it means the look can
be judged long before wave 8.

### Wave 6 — `packages/core`

The mountain. `crates/client`'s 7 668 lines become TypeScript: `session.ts`
(register, login, restore, refresh with the rotated-token hand-off, logout,
wipe), `transport.ts` (fetch against the server, retries, error mapping),
`store.ts` (IndexedDB — the 17 tables `crates/store` holds), `conversations.ts`
(the MLS orchestration over `packages/crypto-wasm`), `outbox.ts`, `stream.ts`
(the WebSocket), `feed.ts`, `stories.ts` and `pin.ts`.

Headless, with no React in it, and tested the way `crates/client/tests` are
tested: against a real local server, with the fake-transport suites ported to
vitest. `offline_queue.rs`, `mls_persistence.rs`, `live_auth.rs` and `wipe.rs`
are the four that must pass before this wave is done — they encode behaviour
that took a while to get right the first time.

This is large enough that it reports progress in thirds: auth and transport;
the store; conversations and MLS.

### Wave 7 — The swap

`apps/desktop/src/lib/*.ts` keeps its exported signatures and changes what is
behind them: `packages/core` instead of `invoke()`. That is the whole point of
that directory existing, and it turns a rewrite into a swap — `features/` code
mostly does not change.

What genuinely changes: `media.ts` and the `nexo-media://` scheme (a browser
gets a blob URL instead), `native.ts` (file dialogs and the tray exist only in
the Tauri build, so it grows a capability check), and `syncAgent.ts` (the sync
loop moves into `packages/core`).

The Windows app keeps working throughout this wave. It just stops being the
only thing that can.

### Wave 8 — The web build

A Vite config without Tauri, a PWA manifest, a service worker that caches the
shell and never the messages, and a Netlify deploy at `nexo.delidev.net`.
Deploy previews point at a staging API or at nothing — `OPS.md` already says
why, and that paragraph stays true.

### Wave 9 — The Tauri shell, thinned

116 commands become roughly twelve: window state, tray, notifications,
autostart, save-file, the updater and the lock. Everything else moved into
`packages/core` in wave 6 and can be deleted here. `src-tauri` stops being an
application and becomes what its name says.

### Wave 10 — Android

Tauri v2's Android target, `cargo tauri android init`, a signed APK. The thin
shell from wave 9 is most of the work already done. Push notifications are the
open question and are scoped separately — with MLS, a push can carry nothing
but "a message arrived". iOS follows when there is a Mac to build it on.

### Wave 11 — Retire the dead crates

`crates/client`, `crates/store` and `crates/platform` deleted. `CONTEXT.md`
redrawn end to end — it describes a repository that will no longer exist.
`STATUS.md` re-walked. `BRIEF.md`'s invariants updated to the three changes
above. `DEVELOPMENT.md` gets the three build commands.

---

## What is already wrong in the docs

Found while reading this plan out, and fixed as the waves reach them, per the
rule in `CLAUDE.md`:

- ~~`CONTEXT.md` claims `crates/protocol` and `crates/crypto` "compile for
  `wasm32-unknown-unknown`".~~ **Fixed in wave 3**, by making it true rather
  than by deleting the sentence. `crates/crypto` compiles to wasm and a CI job
  proves it; `crates/protocol` does so as its dependency.
- ~~`CONTEXT.md` gives upstream as `github.com/YungDice/nexo` in one place and
  `github.com/deli-develop/nexo` in another.~~ **Fixed**, and it was worse than
  a documentation error: `tauri.conf.json`'s updater endpoint and the licence
  button in Settings both pointed at the dead organisation, so a shipped build
  would have looked for its update manifest at a 404.
- Every `api.dice.fit` in `OPS.md`, `CONTEXT.md` and `TUTORIAL.md` points at a
  host that no longer resolves.
- `STATUS.md` is headed "Status at v0.1.16" and says of itself that its first
  two sections stop at v0.1.3. The version is 0.1.23.
