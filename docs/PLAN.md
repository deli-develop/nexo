# Nexo v0.1 — build plan

Approved 2026-08-24. Source specification: [`BRIEF.md`](BRIEF.md).

## Decisions taken

Four questions the brief (§2) said not to guess on, and the answers given:

| | |
|---|---|
| Profile "number" | **In-app numeric ID.** No phone number is collected anywhere — no SMS provider, no contact upload, no discovery by phone. Discovery is by `handle` only. |
| Devices | **One device per account.** The MLS group member is the *device*, not the user, so a second device is later an added member rather than a schema migration. Logging in on machine B revokes machine A. |
| Hosting | **Self-hosted Hetzner CAX21 (ARM64), Falkenstein.** LUKS, Caddy TLS 1.3, Postgres 17 + Redis. The server is `aarch64-unknown-linux-gnu` and the client is `x86_64-pc-windows-msvc` — two build targets from M0. |
| Feed | **Public to any logged-in user.** One global reverse-chronological feed, no follow graph, no per-post visibility filtering in v0.1. |

Non-goals, in addition to §11 of the brief: no phone, no SMS, no follow graph,
no account recovery flow.

## Milestones

Each ends with its check green and a commit. Nothing starts before the previous
check passes.

| # | Milestone | Done when | Status |
|---|---|---|---|
| M0 | Monorepo scaffold, CI, toolchain spikes | `cargo build --release` and `pnpm build` both pass clean | **complete** |
| M1 | Design system, three page shells, mock data | Matches §7 at 100/125/150% Windows scaling | **complete** |
| M2 | Auth, identity keypair, encrypted store, DPAPI keyring, `docs/THREAT-MODEL.md` (G1) | Register → restart → still signed in; `store.db` unreadable with plain `sqlite3` | **complete** — verified end to end against a running server by `crates/client/tests/live_auth.rs`, and `store.db` is proven unreadable by an unkeyed connection. The HTTP transport was pulled forward from M4: a login screen with no transport is a mock. |
| M3 | `crates/crypto`: OpenMLS 1:1, in isolation | Two in-process clients exchange, rekey, and reject a stale commit | **complete** — `crates/crypto/tests/conversation.rs`, 18 tests through the `mls` API rather than raw OpenMLS. Risk 4(b) is designed and tested, not just described: commits stage rather than merge, so a client cannot assume its own commit won. |
| M4 | WebSocket transport, wired into the UI, Redis presence and fan-out (G5). *The HTTP half already landed in M2.* | Two machines exchange real E2EE messages; safety numbers match | **complete in one process; two machines untested.** `crates/client/tests/live_messaging.rs` runs two independent clients through the real server: messages flow both ways and the safety numbers match. The Messages screen reads the core rather than `src/mock`. Outstanding: the client WebSocket loop (the app polls; `sync` is the source of truth either way), and an actual two-machine run. |
| M5 | Group conversations, add/remove | A member added at epoch N provably cannot read anything before N | **complete** — `a_member_added_later_cannot_read_earlier_messages` against a real server. Not a rule the server enforces (it cannot read any of it) but a property of the ratchet. |
| M6 | Encrypted attachments via Hetzner, Rust-side S3 | A 20 MB file round-trips; the stored object is verifiably ciphertext | **complete** — `a_twenty_megabyte_attachment_round_trips_as_ciphertext` against real buckets. The test refetches the raw object and asserts the plaintext marker is absent, so "ciphertext" is measured rather than assumed. |
| M7 | Home feed, Profile, media upload, per-field privacy (G2), extracted design tokens (G3) | Post, react, edit profile, upload avatar and banner; each profile field's visibility is settable | **complete** — 10 integration tests, including G2 over HTTP. Location defaults to private; the filtering is done by the server in `visible_fields`, never by the client choosing what to render. |
| M8 | Settings, tray, notifications, auto-lock, offline queue, component library (G4) | Network killed mid-send; the message delivers on reconnect, once | **complete** — the check itself is proven by four live outbox tests, including exactly-once delivery after a lost reply. Tray, toasts, single-instance, autostart, close-to-tray, auto-lock and the Settings wiring are built, with the privacy-relevant rules (`toast_text`, `close_action`, `arrivalDecision`) unit-tested on both sides of the IPC boundary. G4 is `docs/COMPONENTS.md`. Outstanding: exercising the tray/toast/lock paths on a real Windows machine — they compile only there. |
| M9 | Signed installer, updater, threat model | Clean Windows 11 VM: install, register, message, update | **repo side complete; VM run outstanding.** NSIS (per-user) plus updater artifacts are configured, `check_update`/`install_update` are wired to the About panel, the release workflow drafts a signed release, and `docs/RELEASING.md` / `docs/PIN-ROTATION.md` / the revised `docs/THREAT-MODEL.md` carry the rest. Blocked on externals by design: the code-signing certificate (risk 1) and the minisign keypair exist outside the repo, and the clean-VM install/update pass cannot run in CI. |

## Settings features finished after M9

Three things §6.4 asks for were standing in as honest placeholders — a button
that said the feature was not built, a hard-coded cache size, a toggle with
nothing behind it. They are built now, and each one carried a decision worth
recording.

**Change password** — `POST /v1/auth/change-password`, one endpoint beyond
BRIEF §5.2's list. It takes the *current* verifier as well as a bearer token:
a token is possession of an unlocked machine, and without the password on top
of it, thirty seconds at someone's desk would be enough to lock them out of
their own account. Changing it retires every other session and keeps the
caller's. Nothing local is re-encrypted — the SQLCipher key comes from the OS
keystore, not from the password — so a password change cannot lose history,
which is worth stating because in most apps it would.

**Storage** now measures the store (with its WAL sidecars) and the WebView
cache separately, and "Clear cache" clears that cache and nothing else. Two
numbers rather than one total: the store is the only copy of the messages —
the server deletes ciphertext on acknowledgement — and summing them would
invite clearing the wrong thing.

**Link previews** are fetched by the client, never the server (§4.5), and
stay off by default. The trade is documented in `THREAT-MODEL.md` §2.3: a
server-side fetcher would leak which links users read *and* forward requests
for anyone who can send a message, while the client-side one tells the link's
owner your IP and roughly when you read the message. Since the URL comes from
a stranger, `preview.rs` refuses `http`, redirects, private/loopback addresses
(resolved, not pattern-matched), non-HTML, and anything over 256 KB — fifteen
tests, most of them about what it will *not* fetch.

Everything built after M9 — the fixes and features that came out of the first
real test on Windows — is recorded in [`STATUS.md`](STATUS.md), including the
one known problem still open.

## Coverage gaps against the original build prompt

Found 2026-08-25 by diffing `BRIEF.md` against the source prompt it was
written from. These were dropped silently rather than decided, so they are
scheduled here rather than left to be rediscovered.

| # | Requirement in the source prompt | Status | Now due |
|---|---|---|---|
| G1 | `SECURITY.md` describing the threat model, in the repo | Renamed to `docs/THREAT-MODEL.md` and deferred to M9 | **M2** — it is cheap, and it is where the §4.4 honesty lives |
| G2 | Per-field profile visibility controls ("who can see my location") | Absent from brief and plan | **done** — `profile_visibility`, four fields, three audiences. Per-field defaults, not a blanket one: a bio is written to be read, a location can put someone in danger. |
| G3 | Shared `design-tokens` package for Android reuse | Tokens live inside `apps/desktop/src/styles` | **done** — `packages/design-tokens`. The CSS stays authored (its comments carry the reasoning); `tokens.json` is derived from it for Android, and a test fails if it drifts. |
| G4 | Documented component library (Storybook or equivalent) | Absent | **done** — `docs/COMPONENTS.md`: the catalogue and the rules over `components/ui`. No Storybook, deliberately: fourteen components that the app itself exercises on real data; the trade-off and its revisit trigger are recorded there. |
| G5 | Redis for presence and pub/sub fan-out | Named in BRIEF §3, in no milestone | **Seam built in M4, Redis deferred** — see below |
| G6 | Docker Compose deployment, environment-agnostic config | `OPS.md` is a bare-metal apt + systemd runbook | **Decided** — systemd in production, Compose for dev only. See below. |

**G6 — decided 2026-08-25: Compose is a development tool, production is
systemd.**

The rule, so the repo cannot drift into half of each: `docker-compose.yml`
exists to give a developer a local Postgres in one command. It deploys nothing.

Reasoning:

- The server is a **single static Rust binary**. Docker's largest win is
  packaging a runtime and its dependency tree, and there is none here.
- The systemd unit in `OPS.md` already carries `ProtectSystem=strict`,
  `NoNewPrivileges`, `MemoryDenyWriteExecute`, `RestrictAddressFamilies` and
  the rest. A default container is *looser* than that, and a Docker daemon
  would add a root process to a box whose threat model names the server
  operator as an adversary.
- `docker compose down -v` destroys volumes. On a database with no account
  recovery by design, that is one keystroke from losing every account. Host
  Postgres has no equivalent.
- The prompt's portability requirement is about the **app**, not the process
  manager, and the app already satisfies it: every setting arrives through an
  environment variable, and there is no provider SDK, no metadata service and
  no Hetzner API client anywhere in it.

Revisit when there is a second machine, a second region, or a second person
deploying — the point at which a runbook stops being reliable, because
executing one identically twice is exactly what runbooks are worst at.

**G5 — the fan-out seam exists; Redis does not, yet.** `stream::hub::Fanout`
is the trait, and `LocalHub` is a single-process implementation over a
broadcast channel. That is the *correct* implementation today, because there is
one process: `OPS.md` Phase 7 runs one systemd unit. Redis pub/sub earns its
place the moment there is a second instance, and slots in behind the same trait
with no change above it. Building the seam rather than the client now is
deliberate — an unused Redis dependency is one more thing to audit for no
benefit, and the seam is what makes the change cheap later. Revisit together
with the G6 trigger (a second machine).

Two of the prompt's requirements are **deliberately not** scheduled, because the
brief overrides them with reasons: phone-number registration with SMS OTP (see
"Decisions taken" — no phone number is collected anywhere), and Signal Protocol
/ `libsignal` (AGPL-3.0-only; see §3 of the brief).

One override deserves re-confirmation rather than silent acceptance: the source
prompt scopes the Home feed to "the user's contacts/network" and says object
storage must hold "only encrypted blobs, never plaintext media at rest". The
brief made the feed **public**, which forces feed and profile media to be
server-readable plaintext in `nexo-media`. That is documented honestly in §4.4,
but it is a different product and a different security posture from the one the
prompt described. If the feed should be contacts-scoped, that decision has to
change before M7, because M6 and M7 both build on it.

## Changes to the brief, taken after M10

Four, and they are product decisions rather than technical corrections — which
is exactly why they are written down. `BRIEF.md` is untouched, because other
documents cite its section numbers.

**Message editing ships.** §11 lists it as out of scope for v0.1. It is now a
`Payload::Edit` inside the ciphertext, within ten minutes, and only for one's
own messages. Nothing about it reaches the server, which is what made it cheap
enough to reverse: no route, no migration, no `.sqlx`.

**Reactions on direct messages ship.** §11 lists them as out of scope. Same
reasoning and the same shape — `Payload::Reaction`, inside the encryption. A
server-side reaction endpoint was never on the table: an emoji is content, and
rule 4 says the server never holds content.

**Taking a message back ships**, in two forms that are named differently
because they promise differently: *Delete for me* is local and absolute,
*Delete for everyone* is a request that a modified client need not honour. The
UI says which is which; `THREAT-MODEL.md` §2.9 and §2.10 say why.

**Discovery is no longer by handle only.** This file recorded *"Discovery is by
handle only"* as a decision taken. A public account is now findable by search.
The reversal is only defensible because the other half was built with it: an
account can be private, and private is enforced on the server in both places it
could be evaded — absent from search, and unreachable without a live invitation.
Had only the search half shipped, this would have been the switch `profiles.rs`
refused to add, one that offers privacy it cannot keep.

**Meet&Greet is withdrawn.** Built as M10, deleted in 0.2.0. The map, the pins,
the characters, the agreement and the intro requests are gone; the half of the
module that was never about the map — the private-account gate and its
invitations — stays, which is what keeps the decision above defensible. The
reasoning is in [`REWORK.md`](REWORK.md), and the record of what was built is
still in [`STATUS.md`](STATUS.md) rather than deleted with the code.

**The domain moved, and three hosts became one.** The brief's header fixes
`dice.fit` with `api.`, `nexo.` and `updates.` under it, and says to use those
exact hosts everywhere. None of them is in use now. The API is
`api.delidev.net`; the app is a website at `nexo.delidev.net`, served by
Netlify rather than by the box; and the updater reads `latest.json` from the
GitHub release, which is what `tauri.conf.json` has actually pointed at since
the bug recorded in `.github/workflows/release.yml` was fixed. `OPS.md`
Phase 0.1 is the short version.

**Voice and video calls are withdrawn.** §11 listed them as out of scope for
v0.1; they were built anyway, in six waves, and removed in 0.2.0. So the brief
is accurate again — by a route nobody planned. What the six waves learned is
kept in [`STATUS.md`](STATUS.md), and the invariant they bent is written up in
[`THREAT-MODEL.md`](THREAT-MODEL.md) §5b rather than deleted with them: the
next person to propose calls should read what they cost first.

## Changes to the brief, taken during M1

Two, both in §7 and neither structural. They are recorded here rather than
edited into `BRIEF.md`, which stays as the original specification.

**Light mode ships in v0.1.** §6.4 says "dark only in v0.1, theme seam in
place". The seam turned out to cost nothing to finish: once every surface, line
and fill is a named token, a second theme is the same names with a second set of
values, and no component has to know which one it is in. Settings → Appearance
offers System, Light and Dark, with System meaning `prefers-color-scheme`
rather than a third palette.

**Colour is spent on content, not on chrome.** §7.1's surfaces carried a violet
cast and the field behind the window was a full-colour gradient. Both are now
neutral: the interface is one grey scale plus the accent, and the semantic
colours appear only where a status is being reported. Avatars, images and file
marks keep their colour, because those are content and stripping them makes the
app harder to scan. `--text-lo` also moved (#6E6E85 → #7D7D86 dark, #6E6E78
light): the brief's value does not reach the 4.5:1 §7.4 asks for at 11px on
either theme's panes.

## Risks

Ranked. Items marked **resolved** were settled during M0; the rest stand.

### 1. Code signing is the longest-lead item, and the definition of done may be unachievable as written — `HIGH`

"Installs without a SmartScreen block" is only reliably true with an **EV**
certificate. Since June 2023 all OV and EV code-signing keys must sit on
FIPS 140-2 L2 hardware (token or cloud HSM), and an OV-signed installer still
has to accumulate SmartScreen reputation — it can warn on day one. EV needs a
validated legal entity and takes days to weeks.

**Action:** start the purchase now, in parallel with M1. If EV is not viable,
the definition of done gets rewritten honestly as "signed, with reputation
accruing" rather than quietly shipping something that fails its own check.

### 2. Leaf SPKI pinning plus automatic renewal will brick every client — `HIGH`

Let's Encrypt issues a fresh key on each renewal unless the ACME client is told
to reuse one, and Caddy rotates by default. A pinned client meeting a rotated
key fails closed, and cannot be fixed remotely — that is the definition of a
bricked install.

**Action:** generate a long-lived keypair offline, configure Caddy to reuse it,
pin that SPKI plus one offline backup, and write `docs/PIN-ROTATION.md`. Keep
pinning **off until M9** so development and staging are not self-bricking. Ship
a hard pin expiry after which the client falls back to normal PKI validation and
warns loudly: a degraded client beats a dead one.

**Resolved at M9 by deciding not to pin in v0.1.** `docs/PIN-ROTATION.md`
records the reasoning — the updater already pins at the application layer
(minisign), which covers the highest-value target, and TLS pinning without
staged rollout and update telemetry is a fleet-wide brick waiting on a Caddy
default — and the full design any future pinning must follow.

### 3. SQLCipher's vendored OpenSSL on MSVC — `MED` — *partly resolved in M0*

- **NASM is not required.** `openssl-src` configures with `no-asm` on
  `VC-WIN64A`, so the assembler never runs. This risk was overstated.
- **A full Perl is required, and is still missing on the dev machine.** Git for
  Windows ships a cut-down Perl that fails OpenSSL's `Configure` on a missing
  `Locale::Maketext::Simple`. Strawberry Perl is the supported answer, and
  GitHub's `windows-latest` runners already have it.

**Blocks M2, not M0.** `winget install StrawberryPerl.StrawberryPerl`.

### 4. Two corrections to the brief's MLS wording — `MED` — *(a) resolved in M0*

**(a) Out-of-order commits.** M3's original wording — "recover from an
out-of-order commit" — does not describe how MLS works. Application messages
tolerate bounded reordering through the secret tree; **commits are strictly
epoch-ordered** and a stale one must be rejected. Both halves are now pinned
down by a passing test in `crates/crypto/tests/mls_smoke.rs`.

**(b) Commit races — client half built in M3, server half still M4.** §4.2 says
the server "orders commits" but does not say what happens when two arrive for
the same epoch, and with the every-100-messages rekey policy they will collide.
The rule: a commit must cite the current epoch; first writer wins; losers get
`StaleEpoch`, resync, and rebuild.

The **client** side is now built and tested. `Conversation::rekey`,
`add_member` and `remove_member` return a *staged* commit and do not apply it;
the caller then calls `confirm_commit` or `abandon_commit` depending on what
the delivery service said. This was found the hard way: the first version of
the API merged its own commit immediately, which quietly assumes your commit
always wins — a client doing that would believe it had moved to an epoch nobody
else was in, and everything it sent afterwards would be undecryptable to
everyone. `a_commit_that_lost_the_race_is_rejected_as_a_stale_epoch` is the
regression test.

What remains for M4 is the **server** half: actually ordering commits and
returning `ProtocolError::StaleEpoch` to the loser.

### 5. Playwright cannot drive a Tauri WebView2 window — `MED`

The CI row in the brief's §3 needs revising. The workable split is: Vitest and
Testing Library for components; Playwright against the Vite dev server with a
mocked IPC bridge for UI smoke; and `tauri-driver` with `msedgedriver`
(WebDriver) for one real installed-app smoke test at M9.

### 6. Known advisories in the MLS dependency chain — `MED` — *assessed in M0*

`openmls_rust_crypto` → `hpke-rs` pulls `libcrux-sha3` and `libcrux-secrets`,
which carry three advisories. Patched libcrux exists (0.0.10), but every `0.0.z`
bump is a breaking change under cargo's semver rules, so reaching it requires
`hpke-rs` 0.7 → `openmls_rust_crypto` 0.6, which is published **only as a
release candidate**.

Decision: **stay on stable OpenMLS 0.8.1.** A release candidate in the crypto
core is a worse risk than three advisories that are unreachable for what v0.1
ships:

- `RUSTSEC-2026-0207` — incremental SHAKE squeeze. Our ciphersuite is
  DHKEM-X25519 / HKDF-SHA256 / AES-128-GCM / Ed25519 and uses no SHAKE.
- `RUSTSEC-2026-0208` — AVX2 SHAKE-256 for ML-KEM/ML-DSA. Post-quantum
  ciphersuites are out of scope for v0.1 and the feature is off.
- `RUSTSEC-2026-0212` — constant-time swap on aarch64. v0.1 ships x86_64 Windows
  only, and the aarch64 server does not link `nexo-crypto`.

**Move to OpenMLS 0.9 as soon as it is stable, and before any Android work** —
Android is aarch64, which makes the third one live. Tracked in `deny.toml` and
`.cargo/audit.toml`, each entry carrying its reasoning.

A separate scare turned out to be nothing: `cargo audit` reports libcrux
**AES-GCM** advisories, including a non-constant-time authentication tag check.
AES-128-GCM is our ciphersuite, so that would have been serious. It is not on
our path — `cargo tree -i libcrux-aesgcm --target all` finds nothing, because it
belongs to an optional `hpke-rs` feature Nexo never enables. Nexo's AES-GCM is
RustCrypto `aes-gcm` 0.10.3. `cargo audit` reads `Cargo.lock`, which records the
union of all platforms and optional features, so it over-reports; `cargo deny`
resolves per target and is the stricter gate.

### 7. Single device plus a local-only identity key means no account recovery — `MED, accepted`

Lose the machine, lose the account and all history: server-side ciphertext is
deleted on acknowledgement. That is the correct security posture, but the UI
must say so plainly at registration, and it is a permanent support burden.
Encrypted key backup behind a recovery code is the v0.2 answer.

### 8. The password scheme is not a PAKE, and the threat model must say so — `LOW`

Client-side Argon2id protects the password against reuse elsewhere and against a
stolen database. It does **not** hide anything from the server at login time:
the verifier the server receives is password-equivalent. Only a PAKE such as
OPAQUE would fix that, and it is out of scope. This belongs in
`docs/THREAT-MODEL.md` as a stated limitation, not glossed over.

### 9. `backdrop-filter` cost on integrated GPUs — `LOW` — *resolved in M1*

Anticipated by §7.1. The opaque fallback is a real Settings toggle, not just an
`@supports` branch: **Settings → Appearance → Frosted panels**. It sets
`data-glass="off"` on the document root, which drops `backdrop-filter` and swaps
every pane to its solid surface colour in one place. The `@supports` branch is
still there for WebView versions that cannot blur at all, so a machine that
cannot afford the effect and a person who does not want it take the same path.

Components never write `backdrop-filter` themselves — they ask for `glass-0`
through `glass-3` — which is what keeps both fallbacks working everywhere at
once. Measuring the cost on a real integrated GPU is still outstanding and
belongs with the M9 performance pass.

### 10. Rule 4 needs a written carve-out — `LOW`

"The server must never read message contents" and a public feed are both
required. They do not actually conflict — feed posts are not messages — but the
boundary gets stated explicitly in `docs/THREAT-MODEL.md`, and feed code and
envelope code never share a module, so the distinction cannot erode quietly.

## External dependencies with their own clocks

- **Code-signing certificate** — start now; weeks of lead time (risk 1).
- **Hetzner VPS and `delidev.net` DNS** — needed by M4, and needed again: the box this described was deleted. See [`REWORK.md`](REWORK.md) wave 4.
- **Hetzner Object Storage credentials** — needed by M6.
- **Strawberry Perl on the dev machine** — needed by M2 (risk 3).
