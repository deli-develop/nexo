# Threat model

What Nexo protects, what it does not, and who it does not protect you from.

This document is the one place allowed to be blunt about limitations. Rule 5 of
the brief says be honest about what is and is not encrypted; a threat model that
oversells is worse than none, because it makes people act on a protection they
do not have.

Status: written at M2, revised at M9, and corrected after the client moved into
the page (v0.1.27 on), which took away the encrypted local store it described.
Everything described here is built and tested unless a line says otherwise.

---

## 1. What is protected

| Data | Protection | Server can read it? |
|---|---|---|
| Direct and group message bodies | End-to-end encrypted with MLS (RFC 9420) via OpenMLS | **No** |
| A team's name, description, picture, posts, comments, reactions and pins | The same MLS encryption: a team is a conversation, and all of this travels as its messages (§2.16) | **No** — the server knows the team exists, who is in it and their roles, not a word of what is in it |
| Message attachments | AES-256-GCM, key inside the MLS-encrypted message (M6; the round-trip test refetches the raw object and proves it is ciphertext) | **No** |
| Private identity keys | Generated on device, never transmitted (M2). Kept in the same unencrypted local store as the history below | **No** |
| Local message history | **Not encrypted at rest.** IndexedDB in the app's WebView profile — or the browser's, on the web — readable by anyone who can read this account's files. Windows disk encryption, where it is on, protects a powered-off machine; Nexo adds nothing to it. This was SQLCipher under a DPAPI-wrapped key until the client moved into the page, which has no keystore to hold a key (`docs/REWORK.md`) | n/a — never leaves the machine |
| Passwords | Argon2id on the client; server stores a hash of a verifier | **No** — the server never sees the password |
| App updates | Manifests minisign-signed; verified against the public key pinned in the app before anything installs (M9, `docs/RELEASING.md`) | n/a — the update *server* is untrusted by design |

## 2. What is NOT protected — read this part

### 2.1 Feed posts and profiles are public and server-readable

This is a design decision, not a gap. End-to-end encryption and a feed readable
by strangers are structurally incompatible: content encrypted to a closed group
cannot also be readable by people who are not in it.

| Data | Reality |
|---|---|
| Home feed posts and their media | Server-readable. Visible to any logged-in user. |
| Profile picture, banner, display name, handle, bio, location, links | Server-readable and public. |

Consequences worth stating plainly:

- **Feed and profile images are stored as plaintext** in the `nexo-media`
  bucket. The server, and anyone who compromises it, can view them.
- **`location` is a free-text profile field.** No geolocation API is used, but
  whatever a user types there is stored server-readable. Per-field visibility
  (M7, G2): bio, location, links and join date each carry an audience —
  everyone, contacts, or only me — **location defaults to private**, and the
  filtering is done by the server in `visible_fields`, never by the client
  choosing what to render. Visibility limits *other users*; it does not limit
  the server, which stores the field either way.

The UI must say this where a user can see it, not only here: a Privacy panel in
Settings carrying this table, and a lock icon shown **only** in E2EE
conversations.

> This differs from the original build prompt, which scoped the feed to the
> user's contacts and asked object storage to hold "only encrypted blobs, never
> plaintext media at rest". The public-feed decision (PLAN.md, "Decisions
> taken") is what changed it. If that decision is revisited, this section and
> the `nexo-media` bucket both change with it.

### 2.2 Metadata

The server sees, and therefore anyone controlling the server sees:

- who talks to whom, and when
- message sizes and timing
- when each account is online
- group membership and when it changes

**It also keeps the ciphertext.** BRIEF §4.3 asks for delivered ciphertext to
be deleted on acknowledgement and undelivered ciphertext after 30 days. Neither
is built: acknowledging marks an envelope delivered and nothing deletes it, so
every envelope stays in the database until its conversation, or the sending
device, is deleted. It is still MLS ciphertext and the server still has no key
that opens it, and a device that has moved past an epoch no longer has the keys
either — so this is a store of sealed envelopes, not a cloud history. But it is
more than the design promised, it grows without bound, and a copy of the
database is a copy of all of it. The obvious fix is not available: the
`delivered_at` stamp is one per envelope, set by whoever acknowledges first, so
deleting on it would take messages from group members who had not fetched them
yet. Deletion needs delivery recorded per recipient.

Message *content* stays unreadable throughout. But metadata is often enough to
infer what matters, and Nexo does not claim otherwise. Sealed-sender-style
techniques are not implemented and are not planned for v0.1.

### 2.3 Link previews tell the link's owner that you read the message

Off by default, and this is why. With previews **on**, opening a conversation
makes this machine fetch the first `https` link in a message — so whoever
controls that URL learns your IP address and roughly when you read it. A
sender can plant a link precisely to find that out.

The alternative is worse, which is why the setting exists at all rather than
the feature being dropped: a *server-side* fetcher would tell the server which
links its users read — metadata the rest of the app refuses to hold — and
would turn the server into a request forwarder for anyone who can send a
message.

What the client will not do, whatever a message asks for: no `http`, no
redirects, no URL that resolves to a private, loopback or link-local address
(checked after DNS resolution, so a public name pointing at `127.0.0.1` is
caught), no response over 256 KB, nothing but HTML, and no image fetch. The
rules live in `apps/desktop/src-tauri/src/preview.rs` next to their tests.

### 2.4 Encrypted attachments are opaque, but their existence is not

The server knows a conversation transferred an object of a given size at a given
time. It cannot learn the filename, the type, or the contents.

---

### 2.5 The unlock PIN is a convenience, and it guards the screen

A PIN is offered once after signing in, and can be skipped; Settings sets one
at any time, and once set it can be changed but not removed.

That is a usability decision doing security work, and it is worth being exact
about which. The PIN protects nothing on its own. It is a salted Argon2id
verifier in the local store, and that store is not encrypted: someone who can
read this machine's files does not need the PIN, because the messages are
there beside it. Five wrong guesses and only the password will do.

What it actually buys is that **auto-lock stays switched on**. Locking drops
the session and the MLS state from memory (see §3), and it only protects an
unattended machine if people leave it enabled. Without a cheap way back in,
every lock costs a full password, so timers get lengthened and the feature gets
turned off — and a protection that everyone disables is worth less than one
that is slightly weaker and stays on.

It is not a second factor. The server has never heard of it and it cannot sign
anyone in anywhere: it only ever resumes a session that is already on this
machine.

### 2.6 Blocking is enforced by the server, and does not reach backwards

Blocking removes someone's posts from your feed in both directions and stops
either of you opening a conversation with the other. It is enforced on the
server, not in the client, because a client-side block changes only what one
app draws while the other person goes on sending.

Three limits, stated because the word promises more than it can deliver:

- **It does not stop a second account.** Nexo has no identity verification by
  design, so nothing stops someone registering again.
- **It does not reach messages already delivered.** Those are on the other
  person's machine and the server never had the keys.
- **It does not apply inside a group.** A group is one MLS state shared by
  everyone in it; dropping one member's envelope would leave the others at an
  epoch that member never reaches. Leaving the group is the answer there, and
  the client cannot do that yet.

The blocked person is not told. A refused delivery returns what any other
failure returns, so being blocked is indistinguishable from a message that did
not go through — the one asymmetry the person doing the blocking gets.

### 2.7 The WebView can read the clipboard

The capability set (`apps/desktop/src-tauri/capabilities/default.json`) starts
from empty and grows only deliberately. It grew here. The clipboard used to be
write-only — enough to offer "copy the device key" and nothing more — and it is
now readable as well.

**Why.** The window is transparent, and a menu drawn by the operating system
takes no background from the document: Chromium's own right-click menu inside a
text field came out as unreadable text floating over the desktop. The app draws
that menu itself now, and a text field's menu without Paste is not one.

**What it costs.** Clipboard text already reached the WebView on every Ctrl+V —
the browser puts it in the DOM, where the page can read it. What changes is who
starts it: code running in the WebView can now ask without being asked, so
whatever is on the clipboard at that moment (a password from a manager, say) is
reachable by a compromised renderer rather than only by a paste. In an app whose
WebView already holds decrypted messages this is a small step, but it is a step.

**What it is not.** It is not clipboard *history*, which Windows keeps and Nexo
never asks for, and it does not survive the app: nothing is stored, logged, or
sent anywhere.

### 2.8 Nexo no longer publishes any location, coarse or otherwise

This section used to describe the Meet&Greet map: a pin somebody typed, snapped
to a 25 km grid and offset by an amount derived from their account id, published
to every signed-in user.

**That feature is gone**, and with it the only surface in this product that
touched location at all. `meet_profiles` has been dropped, there is no
`navigator.geolocation` call in the client, and no route accepts a coordinate.
The honest statement is now the short one: Nexo does not know where you are and
has nowhere to put the answer.

What remains of that module is the part that was never about the map — the
private-account gate and its invitations, covered in §2.6 — and the reasoning
for the removal is in [`REWORK.md`](REWORK.md).

**Metadata, as everywhere else.** An intro is an ordinary MLS conversation, so
its contents are end-to-end encrypted and *who wrote to whom, and when* is not
— §2.2 applies unchanged. The one-message cap is enforced by the delivery
service rather than the app, for the reason §2.6 gives about blocking.

### 2.9 Deleting your account does not reach other people's copies

Deletion is real where the server is concerned. The account row goes and takes
its posts, comments, reactions, votes, blocks, profile fields and their
visibility settings, invitations and the uses recorded against them, reports,
refresh tokens and conversation membership with it; the device row goes and takes its
published KeyPackages and every envelope it sent that the server still held.
Conversations left with nobody in them are removed rather than kept as
unreachable rows. Locally, the store is wiped — history, keys and the unlock
PIN — the same wipe signing out performs, once the server has confirmed.

**What it cannot reach is every message that was already delivered.** Those sit
on other people's devices, and the server never held the keys to them
— it could not remove them if it wanted to, and neither can this app. The same
is true of anything anyone screenshotted or copied. Deleting an account ends
what happens next; it does not reach into what already happened.

**One consequence is genuinely surprising and is stated in the UI for that
reason.** Deleting the device deletes the ciphertext it sent that the server is
still holding — messages sent minutes ago, to somebody who has not opened the
app since. Those never arrive. The alternative would be leaving ciphertext on
the server that belongs to an account that no longer exists, which is worse in
every direction.

**The order is server first, machine second**, the opposite of signing out.
Signing out wipes the disk whatever the server says, because somebody handing
over a laptop cares about the disk. Deletion has to hear a yes first: wiping
locally and then failing would leave an account that still exists, that this
machine can no longer reach, and that has no recovery.

**A session is not enough to do it.** The route requires the password's
verifier as well as the bearer token, for the reason change-password gives
about itself in §4.1: a token is possession of an unlocked machine, not
knowledge of the password. A wrong guess costs nothing here and a right one
costs everything.

### 2.9 "Delete for me" is local, and that is all it claims

Removing a message from this device removes it from this device. Every other
person in the conversation keeps their copy, and nothing is sent to ask them
otherwise — the UI says so in those words, and the confirmation repeats it,
because "Delete" on its own is the claim this cannot make.

What it does do, it does completely. The row is deleted rather than flagged,
which takes the message out of the conversation, out of the search index
(`crates/store` withdraws its terms through the FTS delete trigger), out of the
list's preview and out of the attachment strip in one act. A hidden flag would
have to be taught to each of those separately, and the first one anybody forgot
would surface a message somebody believed gone. It cannot come back either:
`set_conversation_cursor` never moves a cursor backwards, so the sync that
would re-fetch it never asks.

The one case where local and universal coincide: a message still in the outbox
is dropped there and never sent at all.

**Pinning is local too**, for a different reason. A pin is shared state with a
cap, and no party can enforce a cap here — the server may not read a payload,
so it cannot count, and two people pinning three each would make six with no
rule saying which win. So the UI says "Pinned on this device", and means it.

### 2.10 "Delete for everyone" is a request, and the UI says so

Taking a message back sends a payload asking every Nexo installation that has
it to empty it. A well-behaved one does. **A modified one need not**, and there
is no mechanism that could make it — the bytes were delivered, decrypted and
written to somebody else's disk before the request existed. Editing is the same
act with a replacement instead of nothing.

So the confirmation says *"This asks every Nexo app that has this message to
remove it. Copies on a modified app can remain."* It does not say "deleted for
everyone", and `crates/store` says in as many words that no such thing exists
here.

**Who may do it is enforceable, and is enforced.** An arriving edit or
retraction is applied only when the envelope carrying it comes from the same
device that sent the message being changed. MLS authenticates the sender, so
this is a real check rather than a convention — without it any member of a
group could empty anybody else's messages. A change that fails it is dropped
silently: there is nobody to report it to, and a notice in the conversation
would tell everyone that somebody tried.

**When is not enforceable, and is not pretended to be.** Ten minutes is a
courtesy the sending app observes; a modified one sends whenever it likes. What
the ten minutes actually buy is agreement between honest clients, which is why
the receiver allows a minute more than the sender takes — see
`crates/protocol/src/window.rs`. Both sides judge by the server's timestamps on
the two envelopes, so neither is trusting a clock the other controls.

**A retracted message keeps its row.** It is emptied, not deleted, because
`envelope_id` is the sync cursor's key and the FTS rowid — a hole there is
indistinguishable from a message that never arrived, and the next sync would
fetch it again. Emptying the body is what withdraws it from the search index.

### 2.11 What "private" covers, and what it does not

A private account is absent from search and cannot be written to by somebody
new without a live invitation. **Both halves are enforced on the server**, and
that is the only reason the word is offered: `profiles.rs` refused a visibility
switch for handle and display name precisely because it could not be kept, and
a "private" that only hid you from a directory while leaving you writable would
be the same empty switch.

Being **added** to a conversation is being written to, and it is asked the same
question of whoever does the adding. Up to and including v0.1.31 it was not:
starting a conversation checked, adding someone to one did not, so anybody
could start a conversation with anyone and then add a private account to it.
That gap is closed on the server (`add_member`), not in the client.

What it does not cover, and the panel says so rather than letting it be
assumed:

- **People already in touch stay in touch.** Sharing a conversation is this
  server's definition of a contact, and going private does not revoke it.
  Blocking is the tool for that, and it is separate on purpose.
- **Anything already sent has been sent.** Privacy is about who can start
  something, not about recalling what happened.
- **Your handle still works if you are public.** Search is the thing being
  switched off, not addressability.
- **An invitation is bearer-shaped.** Whoever holds the secret can use it until
  it expires or is withdrawn; it is not bound to a person, because binding it
  would require knowing who the person was before they had a way to reach you.
  It lasts at most seven days, and the ceiling is a CHECK on the table as well
  as a rule in the handler.

The secret is stored as a SHA-256 and never in the clear, so a leaked table
hands out no working invitations — and a lost secret cannot be recovered, only
withdrawn and replaced. The UI says that at the moment it shows one.

### 2.12 Who can see a story, and what the server sees anyway

A story is encrypted once, like an attachment: a fresh AES-256-GCM key, the
ciphertext in the **encrypted** bucket, and the key only ever inside MLS
messages. The server cannot read one.

**Who gets the bytes** is three conditions on the download route, all made of
checks that already existed: not expired, shares a conversation with the author
(this server's one definition of *contact*), and not blocked in either
direction. All three give the same refusal, because which one failed is a fact
about somebody else's account.

**Blocking works here without a line of story-specific code**, and that is why
a story is not its own MLS group. `blocked_between` is applied only to
two-member conversations — widening it to groups would break the group, and
`delivery/mod.rs` explains why. A story group would therefore have kept
reaching somebody who blocked its author until an explicit removal commit
landed. Sending the key down conversations that already exist inherits the
check that works.

**The 24 hours are three layers, none of them a scheduled job.** The reader
purges expired stories *and their keys* whenever it looks — that is the layer
that matters, because ciphertext without its key is nothing, and it is the only
one that reaches the reader's disk. The server refuses a URL for an expired
story, which makes the limit a property rather than a courtesy. The object
store drops the bytes on a lifecycle rule, for the case where the server does
nothing for a week.

**What a modified client can still do** is the same truth as "delete for
everyone": somebody who was allowed to see a story, while they were allowed to,
can keep it. Nothing can prevent that, and the UI says so rather than implying
a story is recallable.

**What the server sees regardless**, named rather than left implied:

- that you posted, and when;
- how large the ciphertext is;
- who asked for a URL, and when;
- **a burst of envelopes to every one of your conversations at the same
  moment**. That is the shape of the fan-out, and it is the price of not having
  built a story group. It is the same *kind* of metadata the server already has
  for messages — who talks to whom, and when — but it arrives in a recognisable
  pattern, and a pattern is information.

### 2.13 View-once destroys a key, and nothing else

What it does, exactly: the key that opens the ciphertext is stored apart from
the message — in `view_once`, never in `messages.payload`, which outlives the
opening — and it is overwritten with `NULL` the moment the file has been
decrypted. After that **this device cannot read that object again**. Not
"declines to": the bytes in the bucket are AES-256-GCM ciphertext and the only
copy of their key is gone. A modified build has nothing to modify.

That is a stronger claim than most apps make here, and it is worth being precise
about why: a client that merely *refuses* to show something it could still
decrypt is one patch away from showing it. Deleting the key removes the
question.

What it does **not** do, and what the UI therefore says out loud beside the
button — *"Once. Nexo cannot stop a screenshot."*:

- A screenshot, a screen recorder, or a camera pointed at the monitor. The
  viewer's own device is out of scope (§4), and nothing here changes that.
- A modified build that keeps the plaintext after decrypting it. The bytes are
  decrypted on the viewer's machine because they must be, and that machine is
  theirs.

**There is no screenshot notification, deliberately.** Telegram sends one, and
it is the part of the feature that should not be copied: it tells the sender
something happened only when a cooperating client chooses to say so, which
means its silence proves nothing while reading as an assurance. Sending it here
would imply exactly the guarantee this section disclaims. Rule 5 covers this
case precisely — say the true thing, not the reassuring one.

Two smaller consequences, both deliberate:

- **One-to-one only.** "Once" in a group would have to mean "once each", which
  is a different promise wearing the same word — and people would assume the
  stricter one. The control is absent in a group rather than present and
  redefined.
- **The sender's copy was never openable.** The sender keeps the file they
  picked, so nothing is taken from them; but their copy of the message keeps
  no key at all once the server has it, because a sender who could reopen what
  the recipient cannot would make the bubble's own wording untrue on one side
  of the conversation.

### 2.14 A follow graph is a new social graph the server holds

Following somebody writes a row the server can read: `(follower, followed,
when)`. That is **not** a restatement of §2.2, and it should not be filed under
it. §2.2 concedes that the server sees who talks to whom — a *contact* graph,
produced as a side effect of routing messages it has to route. This is an
*interest* graph, produced on purpose, and it includes people you have never
messaged and may never message.

Two consequences worth being plain about:

- **It is durable and explicit.** Conversation metadata accumulates as a
  by-product of use; a follow is a deliberate, dated statement that persists
  until withdrawn. It is the single most useful thing in the database for
  anybody trying to work out who somebody's people are.
- **A follower count is public; a follower list is not.** The count discloses
  nothing the feed does not — anyone who can read somebody's posts can count the
  people reacting to them. **Who** the followers are is offered by no route,
  because a follower list is a social graph handed out on request, which is a
  different decision and has not been made.

What it deliberately does **not** change: following alters what you are shown,
never what you are allowed to see. Every post the Following feed can return is
one the Everyone feed would have returned to the same caller, because both apply
the same block list. There is a test for that (`apps/server/tests/follows.rs`),
and it is there because a Following feed is easy to write in a way that reaches
past a block, and nothing in the UI would ever reveal it.

Following a private account is refused, and refused with the same `404` a
handle that does not exist gets — a `403` would confirm the account is there,
which is exactly what being absent from search is meant to prevent.

### 2.15 The live socket carries no content, and no new metadata

The client now connects to `/v1/stream`. What crosses it is typing notices,
presence, receipts and envelope notices — the events `nexo_protocol` already
defined, with ciphertext hex inside them and no key anywhere near the server
(rule 4). It is a delivery path, not a decryption point.

It discloses **when a connection is open**, which the 4-second poll already
disclosed in a noisier form: an account that is polling is an account that is
running. Typing notices are new information — that somebody is composing, in
which conversation — and they are opt-out-able through the presence preference,
which now genuinely governs both sending and showing rather than only being read
by a control that did nothing.

The socket is authenticated with an ordinary `Authorization` header rather than
a token in the URL. A browser could not do that on a WebSocket and would have to
put the token in the query string, where every proxy on the way logs it; a Rust
client does not have to make that trade, and does not.

### 2.16 Teams: private boards, and what their roles can and cannot hold

A team is an MLS conversation with `kind = 'team'`. Its name, description,
picture, and every post, comment, reaction, pin and removal are messages in
it, encrypted exactly like a group's. The server has no column for any of
them.

**What the server sees**, beyond what it sees for any group (§2.2): that the
team exists; who is in it; **who is its owner and who are its admins**; when
envelopes flow and how large they are. A post and a comment are
indistinguishable to it, and so are a pin and a message.

**What the server enforces.** Who may add and remove people (the owner and
admins; an admin cannot remove the owner or another admin), who may change a
role, a cap of 200 people, and that a block or a private account keeps somebody
out of a team exactly as it keeps them out of a conversation. These are
routing rules, and the server holds them, because a rule only the client
applied would be one a modified client ignored.

**What the server cannot enforce, and nothing here pretends it can:**

- **The inside of an MLS commit.** A member running a modified client can
  build a commit that removes somebody from the group; the server orders
  commits without reading them. Every group here has this property. The
  routing table still stops a removed person fetching anything.
- **Who may pin, remove for everyone, or rename.** These are content. Every
  Nexo installation checks, as each one arrives, whether the device that sent
  it belongs to an owner or admin *now*, and drops it otherwise. A modified
  client can ignore that check on its own screen, and nothing else.
- **"Remove for everyone"** is a request, like taking back your own message
  (§2.10): honoured by every Nexo app, not by a modified one, and it cannot
  reach a copy somebody already saved. The dialog says so.

**Somebody added later reads nothing from before.** MLS gives a new member
no earlier keys, and the ciphertext the server still holds (§2.2) does not
help them. The board says so, where that history would have been. Somebody
removed stops receiving the team — an open socket included — and the removal
commit rekeys the group, so they cannot read what is posted after it even
with the ciphertext in hand (`packages/crypto-wasm/src/teams.test.ts`).

**Deleting a team** deletes its conversation, membership and envelopes on the
server. What members already have on their devices stays there, and the
objects its posts' files point at stay in the bucket as ciphertext nobody
holds a key for.

## 3. Adversaries in scope

**A network attacker.** Defeated by TLS 1.3 for transport plus MLS for content.
Someone who fully controls the network still cannot read messages, and cannot
forge them without a private identity key.

**A curious server operator.** Can read feed posts, profiles, media in
`nexo-media`, and all metadata in §2.2. Cannot read message bodies or
attachments, and cannot derive the group secrets to try.

**Anyone who can send the server requests.** **Bounded.**
`apps/server/src/limits.rs` enforces a fixed-window limit on every mutating
route, and the two cases that motivated it are both covered:

- `/v1/auth/login` runs Argon2id at 19 MiB per attempt on the server, which
  makes it simultaneously a password-guessing oracle and a memory-exhaustion
  lever. Limited to 10/min per client address — per address rather than per
  account because `/v1/auth/salt` is unauthenticated by construction, so there
  is no account to key on for the whole router.
- `/v1/keypackages/{handle}` **consumes** a KeyPackage per call, so a loop
  could exhaust an account's supply and quietly prevent anyone starting a
  conversation with that person. Limited to 60/min per account.

Two limits of the mechanism, stated rather than left to be discovered:

- A fixed window permits up to `2 * max` across a window boundary. Accepted
  deliberately — these limits exist to stop sustained abuse, and doubling the
  burst for one instant does not change what any of them protect.
- `NEXO_RATE_LIMITS=off` disables them for the integration suite. It announces
  itself loudly at startup, and a production process started with it set is
  the unlimited case above.

Was B2 in `docs/RESEARCH-COMPARISON.md`; see `docs/STATUS.md` for what shipped.

**Someone holding the disk from a decommissioned server.** **Open — no disk
encryption is configured, and the decision is deliberately deferred**
(`OPS.md` Phase 0.2, which now lists what is actually on that disk). Until it
is made, assume the unencrypted case, which is this: message content is safe
regardless — it is MLS ciphertext and the group keys never leave the devices —
while the JWT signing key, the S3 credentials, the profile and feed data, the
password hashes and all of §2.2's metadata would be readable. Rotating the JWT
key and the S3 credentials at decommissioning is what neutralises the first
two, and belongs in the shutdown checklist whichever way the decision goes.
The decision itself has to be made **before the production server is built**:
encrypting a root volume afterwards means rebuilding the machine.

**Someone who steals the user's laptop, powered off.** **Not defended by
Nexo.** The local store — history, identity keys, the unlock PIN's verifier —
is IndexedDB, unencrypted, in the app's WebView profile. What stands between a
thief and it is whatever the operating system does: Windows disk encryption
(BitLocker, or Device Encryption), where it is switched on. Until the client
moved into the page this was a SQLCipher store under a DPAPI-wrapped key; a
page has no keystore to hold such a key (`docs/REWORK.md`), and nothing has
replaced it.

**Someone who sits down at an unattended, unlocked machine.** Auto-lock (M8):
after a configurable idle period the app's screen is replaced, the live socket
closes, and the tokens and the MLS state are dropped from memory; getting back
in takes the PIN or the password, and the server. What lock does *not* claim:
it guards the app's screen, not the disk — someone at that desk, signed in as
that user, can read the store's files without the app at all — and it cannot
guarantee freed memory is zeroed. `lockSession` in
`apps/desktop/src/lib/auth.ts` states the same limits next to the code.

**A compromised or impersonated update server.** It can refuse updates
(freeze attack — visible, since checks are user-initiated from the About
panel) but cannot inject one: manifests are minisign-signed and verified
against the public key pinned in the app, and there is no unsigned install
path. Losing control of the *signing key* is out of this defence's scope —
see `docs/RELEASING.md` for how it is held.

**A stranger reading the feed.** Not an adversary — the feed is public by
design. Listed here so it is never mistaken for a breach.

---

## 4. Adversaries explicitly OUT of scope

**Malware running as the user on their own machine.** It can read the store
straight off the disk — it is not encrypted — read what is in the app's memory,
or screenshot the window.
No messenger defends against this; claiming otherwise would be dishonest.

**A compromised server that swaps public keys.** The server distributes identity
keys, so a malicious one can hand you an attacker's key for a contact. The only
defence is users actually comparing **safety numbers** out of band.

> **What Nexo does.** Every other device in a conversation is recorded with
> the key it signs with (`recordMembership` in
> `packages/core/src/conversations.ts`), and compared on every sync. The
> verified mark is bound to the key that was compared, not a boolean: when a
> recorded key changes, the mark is gone and "The safety number here has
> changed" appears above the conversation. Ignoring it or restarting does not
> clear it. Comparing the numbers again does, and so does pressing Dismiss —
> which hides the banner and leaves the conversation unverified.
>
> **Where it stops: trust on first use.** The first key recorded for a device is
> its baseline, not a change, and nothing checks it. A server that substituted
> a key before this device first recorded it is not detected, by this or by any
> scheme like it. That includes every conversation that existed before keys
> were recorded at all: after the move to the page, nothing recorded them until
> it was put right (`docs/STATUS.md`, *Since v0.1.27*), so whatever key a
> device had on its first sync afterwards became the baseline. Only comparing
> the digits over a channel you already trust catches a substitution that
> predates the baseline — which is what the unverified state says: "Until you
> do, nothing proves the keys belong to who you think."
>
> **A new device looks like the attack.** Signing in on a machine with no local
> store generates a **fresh identity keypair** (`Session.login` in
> `packages/core/src/session.ts`), and the server accepts it as an additional
> device. So does signing out and back in on the same machine: sign-out wipes
> the store, keys included. Both raise the warning for everyone who talks to
> that person, correctly — Nexo cannot tell a new device from a substituted
> key, and the banner says so.
>
> Tracked as B1 in `docs/RESEARCH-COMPARISON.md`.

A user who never checks is vulnerable to this regardless.

**Traffic analysis.** See §2.2.

**Someone who knows the password.** Changing it (§6.4) requires the current
password as well as a signed-in session, and retires every other session — but
someone who knows the current password can simply change it first. There is no
second factor and no recovery flow to appeal to, by design (§4 above).

**The hosting provider, against a running machine.** Hetzner can snapshot the
RAM of a live VM, and a LUKS key sits in that RAM the whole time the server is
up. Disk encryption protects a disposed disk, not a running one. If a provider
with physical access is genuinely in your threat model, the answer is hardware
you own.

**A user who loses their only device.** One device per account, and the identity
key is local-only. Losing it loses the account and all history, because
the keys that open the server's ciphertext (§2.2) existed only on that device.
This is the correct
security posture and a permanent support burden; the registration UI must say so
before it happens. Encrypted key backup behind a recovery code is a v0.2 answer.

---

## 5. Cryptographic choices, and what they are not

- **No cryptography is invented here.** OpenMLS and its audited primitives only.
- The ciphersuite is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` — the
  mandatory-to-implement suite.
- **Not post-quantum.** A harvest-now-decrypt-later adversary recording traffic
  today may be able to read it if a cryptographically relevant quantum computer
  arrives. A hybrid suite is a config seam, deliberately off in v0.1.
- **The password scheme is not a PAKE.** The client derives a verifier with
  Argon2id and sends it over TLS; the server stores a hash of that verifier. A
  server that is compromised *at the moment you log in* sees the verifier. This
  is better than sending a password and worse than a real PAKE (OPAQUE), and it
  is chosen for implementation simplicity in v0.1.

## 5b. Calls, and the invariant they used to bend

Voice and video calls were built, shipped and then removed in 0.2.0. This
section used to describe the one place the product knowingly bent invariant 2:
`RTCPeerConnection` generated the DTLS certificate and the SRTP session keys
**in the page**, because a media stack in Rust would have meant writing or
wrapping an echo canceller, a jitter buffer and an Opus pipeline — worse calls
and, for the crypto, a larger violation of rule 1 than the one it avoided.

None of that applies any more. There is no `RTCPeerConnection` in the client,
no relay, no `/v1/calls/ice`, and no signalling payload on the wire. The
exception is withdrawn along with the feature, and the reasoning is kept here
because the next person to propose calls should read what it cost before
building it again.

What has *not* changed: the bend was always narrow. The identity keypair, the
MLS state and the store key never crossed the IPC boundary for a call, and they
still do not. The removal of calls does not make invariant 2 stronger than it
was for everything else — and [`REWORK.md`](REWORK.md) explains why that
invariant is being retired for a different reason entirely.

## 6. Object storage

Two buckets, deliberately separated:

| Bucket | Contents | Encrypted? |
|---|---|---|
| `nexo-media` | feed and profile images | **No** — plaintext, server-readable by design (§2.1) |
| `nexo-enc` | message attachments | Yes — AES-256-GCM, key never leaves the clients |

Hetzner S3 credentials are **project-wide by default**: every key reaches every
bucket in the project. Two separate credential pairs are not sufficient on their
own. A bucket policy on `nexo-enc` denying the media key is what makes the
separation real, and
`cargo test -p nexo-server --test s3_smoke -- --ignored` is the only evidence it
holds. Re-run it after any credential rotation — a newly generated key is
unrestricted, and the policy names the old one.

---

## 7. Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
There is no bug bounty.

## 8. What must be updated here, and when

- the disk-encryption decision from `OPS.md` Phase 0.2, once made — **still
  open, and deferred deliberately**; §3 assumes the unencrypted case and says
  what that exposes. Due before the production server is built, because there
  is no in-place path afterwards.
- ~~M2, when the local store and keyring exist~~ — done, markers removed
- ~~M7, when per-field profile visibility ships~~ — done, §2.1 revised
- ~~M9, the update channel~~ — done: §1, §3, and `docs/RELEASING.md`
- TLS pinning, if it ever ships — `docs/PIN-ROTATION.md` records the decision
  not to pin in v0.1 and what shipping it would require
- any change to the public-feed decision, which rewrites §2.1 and §6
