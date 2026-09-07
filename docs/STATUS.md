# Status at v0.1.16

What the app actually does today.

**The two sections below stop at v0.1.3.** Everything after that heading was
written against that release and has not been re-walked; several things it
calls absent have since been built. What landed after it is listed under
*Since v0.1.3* at the foot of this file. Re-walking the older sections is worth
doing and has not been done — saying so is better than leaving a reader to
discover it.

Written by walking the code, not the commit messages: every line below was
checked against the file it names. `docs/PLAN.md` tracks the milestones M0–M9;
this document covers what landed after them, in the round of fixes and
features that followed the first real test on Windows.

---

## Fixed

Twelve problems were found by using the app rather than by reading it. All
twelve are fixed.

| # | What was wrong | Where it was fixed |
|---|---|---|
| D1 | Attachment images were never drawn. `ImageGrid` rendered an empty `div` with a generated gradient, and the filename survived only as a tooltip — so a photo arrived as a coloured rectangle. | `attachment_data_url` in `apps/desktop/src-tauri/src/conversations.rs`, capped by `MAX_INLINE_IMAGE_BYTES`. Rust still decrypts and verifies before anything is shown. |
| D2 | Links sat under the message as an attachment instead of being part of it. | `MessageList.tsx` renders the URL inside the text and hands it to `openUrl`, so it opens in the system browser and never inside the WebView. The context menu offers *Open link* and *Copy address*. |
| D3 | Link previews appeared not to work. | Nothing was broken: the machinery was already there and the setting is **off by default** (§4.5). Left as it was, deliberately — a preview is a request to a stranger's server, and that stays opt-in. |
| D4 | Every avatar in a conversation was generated from an id, so nobody's real picture ever appeared. | `ConversationAvatar.tsx` and `HandleAvatar.tsx` resolve the member's profile and pass a real `imageUrl` through to `Avatar`. |
| D5 | Images inside a profile did not load. | `ProfilePage.tsx` now routes them through `RemoteImage`, the same presigned-GET path the banner and avatar already used. |
| D6 | The profile's tabs mixed two ideas: selection was marked with an underline, but hovering filled a rounded box — a preview of a shape that never appeared. | `Tabs` in `components/ui/Controls.tsx` now uses one underline in three states, so hovering previews where the indicator will land. Keyboard focus gained an explicit ring, which the box had been standing in for. |
| D7 | The button beside the chats carried the sign-out icon but read *Leave this conversation* — and did nothing but open a dialog. Sign-out itself was buried in the profile. | The real sign-out moved to `IconRail.tsx`, visible from every page, red on hover. |
| D8 | Home had a button that toggled a search box which the page already showed. | Removed; the search field is simply always there. |
| D9 | The Appearance section always showed the moon, whichever theme was on. | Its icon is now derived from the active theme — the list entry carries a placeholder that the render replaces. |
| D10 | Auto-lock did not lock. Content disappeared, but the session stayed open — a security promise the app did not keep. | Locking now ends the session for real. Getting back in needs the PIN (see N11) or the password. |
| D11 | Confirmations and notices were operating-system dialogs that looked nothing like the app. | `DialogHost.tsx` and `Modal.tsx` replace them; `notify` and `confirm` route through the app's own surfaces. |
| D12 | Right-clicking anywhere produced the browser's menu. | Suppressed globally in `main.tsx`, with the app's own menu in its place (N7). |

Nothing from that round is outstanding.

---

## Built

Twelve features, in the order they matter to someone using the app.

### Messages

- **Full-size media viewer** — clicking an image or video opens it over the
  conversation. `features/messages/Lightbox.tsx`.
- **Media strip** — under the viewer, every image and video in the
  conversation, so you jump straight to one instead of scrolling back.
- **Jump to latest** — scrolling up reveals a button back to the bottom, and
  when messages arrive meanwhile it carries the count of what you missed.
  `MessageList.tsx`.
- **Composer in an empty conversation** sits with the invitation in the middle
  of the page and only moves to the bottom once there is history above it.
- **Full emoji set** with categories and search, replacing the eight that were
  hardcoded. `components/ui/EmojiPicker.tsx`.

### Throughout

- **The app's own context menu** on right-click, with entries that suit what
  was clicked — a message, an image, a link, a conversation.
  `components/ui/ContextMenu.tsx`.

### Profiles

- **Other people's profiles** can be opened, with the server deciding
  per field what a viewer may see (G2 — the client never picks).
  `features/profile/PublicProfile.tsx`.
- **Message someone from their profile**, which starts the conversation and
  goes straight to it.

### Security

- **PIN unlock.** After auto-lock, a PIN gets you back in instead of the full
  password. `crates/client/src/pin.rs`.

  What it does and does not buy, plainly: the PIN unwraps a stored copy of the
  store key, and that copy is itself bound to the Windows account through
  DPAPI. So an attacker needs the PIN *and* the signed-in Windows session — a
  four-digit code alone is roughly ten thousand guesses and would be no
  protection on its own. Attempts are limited, and the password remains the
  way back in. This deliberately trades a little of the stolen-laptop
  protection for a lock people will actually leave switched on;
  `docs/THREAT-MODEL.md` §3 is where that trade belongs.

### Appearance

- **Accent colour** as a hue rather than a free colour: saturation and
  lightness stay fixed so every accent still clears the 4.5:1 the design
  system asks for (§7.4). `preferences.accentHue`.
- **Background depth** — a slider from the designed palette to pure black in
  dark mode, pure white in light. Every surface moves proportionally, so
  panels stay distinguishable at the far end. `preferences.contrast`.
- **Blur strength** as a slider rather than a switch, where zero drops
  `backdrop-filter` entirely instead of setting it to zero — the property
  costs the GPU whatever its radius, which is why the switch existed
  (PLAN.md risk 9). `preferences.glassStrength`.
- **A translucent window.** The same switch asks Windows for an acrylic
  backdrop, so the desktop behind the app is genuinely visible through it,
  blurred by the window manager. CSS cannot do this on its own:
  `backdrop-filter` blurs what is behind an element *in the document*, and the
  wallpaper is not in the document. The window is created transparent and Rust
  asks DWM (`windows::set_backdrop`); the WebView only makes its own field
  translucent once that call reports the effect actually applied, because a
  transparent window without it is a hole through to the desktop rather than
  glass over it.
- **A draggable divider on Home**, between the feed and the most recent
  conversation. Replaces three fixed hairlines with one line that means
  something. `preferences.homeChatWidth`.

---

## Since v0.1.3

Written the same way as the rest: walked against the code, not the commit log.

### Messaging

- **Search across history**, not just the newest message per row. FTS5 inside
  the encrypted store, so the term never leaves the machine
  (`crates/store`, schema 9).
- **Key-change detection.** `conversation_peers` records the key a peer was
  last seen with, so a change is noticed and reported rather than assumed
  benign. `mark_verified` and `acknowledge_key_change` are deliberately
  separate: having seen a change is not the same as having re-compared digits.
- **Conversations that could never be entered are now escaped.** A `start_with`
  whose commit reached the server but whose Welcome did not used to leave a
  chat that was listed, opened, and answered every message with "You are not in
  that conversation." for ever. `open_with` syncs, and if no Welcome exists it
  leaves the conversation so a usable one can be made.

### Server

- **Rate limits across every mutating route** — posts, comments, reactions,
  media, profile and membership, beside the auth and send limits that already
  existed. `NEXO_RATE_LIMITS=off` exists for the integration suite and is
  loud about itself at startup.
- **Device retirement** on login, and **reporting** (`/v1/reports`).

### Meet&Greet (M10)

A fifth destination: a world map on which a person may place one pin saying
roughly where they are, wearing a character they built.

- **Nexo never reads device location.** No `navigator.geolocation` call exists
  in the feature, and `meet_profiles` has no column that could hold a
  measurement. A pin is a claim somebody typed.
- **The pin is coarsened before it is stored** — snapped to a 0.25° grid and
  offset by a fixed amount derived from the account, so repeated saves disclose
  no more than the first. The submitted figure is never written anywhere.
- **The map is bundled**, not tiled: MapLibre over 105 KB of public-domain
  Natural Earth data. No tile server, no API key, no attribution obligation,
  and nothing fetched at runtime.
- **A NexoChar is stored as its config**, never as an image — a couple of
  hundred bytes of JSON rendered by whichever client draws it. Nothing in
  object storage, and no picture to moderate.
- **An intro buys exactly one message** until it is answered, enforced by the
  delivery service rather than the app.
- **Blocking removes both pins**, in both directions, reusing `blocks`.
- The whole feature is behind a lazy import: the map chunk is 288 KB gzipped
  and the startup bundle is unchanged.

**Known gap:** on this machine the map shows horizontal banding while being
dragged, under a transparent window with the DWM acrylic backdrop. WebGL,
the worker and zoom all work; the banding is cosmetic and unresolved. Three
candidate fixes were identified and none has been confirmed.

### Since v0.1.18

- **A payload this build cannot read is shown as one**, rather than rendered
  as raw text. `Payload::decode` used to fall back to text for *any* parse
  failure, including a `kind` from a newer client — so the first new variant
  ever sent would have put JSON in a chat bubble on every installation that
  had not updated. It now separates "tagged JSON I do not know" from "not JSON
  at all"; the latter is still read as text, because the project's first
  messages were bare UTF-8 and refusing them would be self-inflicted data
  loss. The undecoded bytes are kept in the store — MLS will not decrypt that
  envelope twice, so a later build reads what arrived today or never does.
- **The conversation beside the feed can be chosen.** It still follows the most
  recent by default; the header is now also a picker, and picking one suspends
  the following until it is taken back. The choice does not survive a restart,
  which is deliberate: a conversation sitting there for a week while everything
  happens elsewhere is the silent staleness the default exists to avoid.
- **The profile picture is changed from the picture.** Hovering or focusing the
  avatar offers it, the way the banner already did. The button that used to do
  this sat in the row underneath, away from the thing it acted on and giving no
  hint the picture was changeable at all.
- **"Until I turn it off" is a mute entry you can see.** It always was the
  behaviour of a plain click on Mute; beside four durations, a bare "Mute" read
  as "for how long?" instead. Naming it costs one line.
- **A message has a name of its own** (protocol version 3, store schema 11).
  `Payload::Text` and `Payload::Attachment` carry an optional `id` that the
  sender mints before encrypting, and the store keeps it beside the message and
  in the outbox. Nothing user-visible yet; it is what reacting to, editing or
  taking back a message will refer to. Not the envelope id, because the server
  assigns that and a message still in the outbox has none — which is exactly
  the window in which somebody wants to take one back. Not the `client_msg_id`
  either: that is the server's idempotency key, and a value that was both would
  sit in the server's tables in cleartext *and* inside everyone's ciphertext.
  Messages sent before this carry no name, keep working, and are simply not
  offered the actions that need one.
- **An account can be deleted.** `POST /v1/auth/delete-account`, a *Delete
  account* group at the foot of Settings → Security, and the wipe of the local
  store, its key and the unlock PIN that signing out already performed. The
  dialog asks for two things doing two jobs: the handle typed out, which cannot
  be answered by reflex and names which account is going, and the password,
  which the server checks — a bearer token is possession of a session, the rule
  change-password already applies to itself. The server talks first and the
  machine is wiped second, the opposite of signing out and for the opposite
  reason: a local wipe followed by a refusal would leave a live account nothing
  here could reach. `docs/THREAT-MODEL.md` §2.9 has what deletion does and does
  not reach.
- **Blocking is reachable from the conversation.** It was already built and
  already server-enforced, but only offered on their profile, on their pin on
  the map, and in the undo list in Settings — none of which is where you are
  when somebody starts being a problem. The conversation's own menu now offers
  it, for a two-person conversation whose member list has arrived; a group and
  a conversation that cannot name anybody get no entry rather than a broken
  one. Not in the conversation header: that toolbar is for the things people
  do often, which is the rule it already applies to mute durations.

### Messages: pinning and local delete (wave 5b/5c)

- **Pin a message on this device.** Local by design: a shared pin would need a
  cap nobody can enforce, because the server may not read the payload and so
  cannot count. Pinned messages get a section in the conversation's details
  panel, headed "Pinned on this device".
- **Delete for me.** The row is deleted, not flagged — so the message leaves
  the conversation, the search index, the list preview and the attachment strip
  together. Everyone else keeps their copy and the confirmation says so. A
  message still queued is dropped from the outbox and never sent.
- Neither is offered on a message that is still sending: both are keyed by the
  envelope id, which the server has not assigned yet.

### Messages: reactions (wave 5d)

- **React to a message with an emoji**, and take it back with the same tap.
  Sent as an encrypted payload, not to an endpoint: an emoji is content, and
  the server never holds content. There is no reaction route and there must
  not be one.
- The emoji rule now lives in `crates/protocol` as `is_reaction_emoji` and is
  called by the feed on the server *and* by a conversation on the receiving
  client — the server cannot check a payload it never reads, so the receiver
  has to.
- A reaction to a message this device never received is kept rather than
  refused, and shows up if that message arrives later.
- The pills are the feed's, unchanged: the reaction data was given the same
  `{ emoji, count, mine }` shape so the component did not need a second
  version.

### Messages: edit and take back (wave 5e)

- **Edit your own message** within ten minutes, in place in the bubble. A quiet
  "edited" mark sits beside the time; nothing claims the original is gone.
- **Delete for everyone**, within the same ten minutes. The confirmation says
  what it really is: *"This asks every Nexo app that has this message to remove
  it. Copies on a modified app can remain."*
- Both entries **disappear** once the window closes rather than greying out —
  an action that is gone was never offered.
- A retracted message keeps its row and loses its words. The row is the sync
  cursor's key and the FTS rowid; a hole there would look like a message that
  never arrived.
- **Only the sender's own device may do either**, checked on arrival against
  the envelope's MLS-authenticated sender. Without that check any group member
  could empty anybody's messages.
- The receiver allows one minute more than the sender takes, deliberately: a
  slightly fast clock would otherwise leave the group permanently disagreeing
  about what a message says, with every side behaving correctly by its own
  lights.

### Also in this round

- The store's `ALTER TABLE` steps are now re-runnable, like the rest of the
  ladder. SQLite has no `ADD COLUMN IF NOT EXISTS`, and without this a
  migration re-run failed the whole upgrade with `duplicate column name`.

### Public and private accounts, invitations, requests (wave 6)

- **An account can be private.** Private means two enforced things: absent from
  search, and unreachable by somebody new without a live invitation. Both are
  checked on the server, in `search_users` and in `create_conversation` beside
  the block rule that was already there. Existing accounts stay public.
- **People search** — `GET /v1/users?q=` — reversing `PLAN.md`'s "discovery is
  by handle only". Public accounts only, blocks applied in both directions, and
  a two-character floor so it cannot be used to download the user table.
- **Invitations**, at most seven days, enforced by the handler *and* by a CHECK
  on the table. The secret is stored as a SHA-256 and shown exactly once; a
  lost one is withdrawn and replaced. Expiry is decided in the query, never by
  a cleanup job — there is no scheduled work in this server, and an invitation
  that stops working only when a sweeper runs is one that still works.
- **A withdrawn invitation keeps its row**, so a request can still say which
  invitation it came through.
- **Requests are answerable from the profile** as well as from the Meet&Greet
  card — the same data and the same endpoints, not a second mechanism.

### Stories, 24 hours, end-to-end (wave 7)

- **A story is encrypted once**, like an attachment — a fresh AES-256-GCM key,
  ciphertext in the encrypted bucket — and the key is then sent down every
  conversation the author already has. It is *not* an MLS group per author.
- **Blocking therefore works with no story-specific code.** That is the reason
  for the shape: `blocked_between` applies only to two-member conversations, so
  a story group would have kept reaching somebody who blocked its author.
- **Contacts** means what the server already meant by it — sharing a
  conversation. `shares_a_conversation` moved out of `profiles.rs`'s privacy
  for exactly that reason: two definitions of "contact" drift, and the one that
  drifts is the one guarding something.
- **The 24 hours come from three places, none of them a scheduled job:** the
  reader purges expired stories *and their keys* whenever it looks (the layer
  that matters, and the only one that reaches the reader's disk); the server
  refuses a URL for an expired story; and an object-store lifecycle rule drops
  the bytes.
- A story that has already expired when it arrives is **not written down at
  all** — the key is never put on disk.

**There is a UI now**, and there was not when this section was first written —
the whole of wave 7 existed as protocol, server, store, client and IPC with no
screen, which is not a shippable state and should not have been written up as
one. The strip sits at the top of Home rather than in its own destination,
because a story's audience is contacts and Home is already where other
people's things appear. Opening Home is also what purges expired stories and
their keys.

**Layer 3 is applied.** `nexo-enc` carries one lifecycle rule, `story/` after
two days. It could not have been applied before: stories and attachments shared
the `enc/<uuid>/<uuid>` key space, so any rule reaching stories would have
deleted every attachment in every conversation. Stories now upload through
their own route to their own prefix.

**A received story now carries the server's id** (`Payload::Story::story_id`).
It could not be opened before: MLS names a device, the envelope carries no
story id, and the receive path filed the row under an FNV hash of the object
key instead. Every later step then asked the server for that number —
`POST /v1/stories/{id}/url` on open, and the id-matching that `stories::live`
uses to put a name under somebody's circle — and no route has ever known it.
A contact's story was listed as `—` and refused to open; the author's own
worked, because that path had the real id all along. The field defaults to `0`
for a story from an older build, which the reader reads as "unknown" and treats
exactly as it did before, so no protocol version moved.

**The strip and the gallery are two different questions.** The Stories tab on
your own profile used to draw the Home strip, which is one circle per *person*
— so under a heading saying "Your stories" it listed your contacts, and your
own posts were a single circle however many of them there were. It is a gallery
now (`profile/MyStories.tsx`): one tile per story, newest last, with what it
looks like and how long it has left. Each tile fetches and decrypts, because
nothing decrypted is written down and there is therefore no thumbnail to draw
instead. The strip on Home is read-only; posting is the `+` on your picture.

**A story circle wears the person's own picture.** The strip drew the generated
gradient seeded from a handle, so somebody with a photograph had two different
faces on one screen — the gradient in their story circle and the photograph on
their post below it. It goes through `HandleAvatar` like every other avatar in
the app, and the gradient stays for what it means: an account without a
picture, or an author this device has not resolved yet.

**And the ring is drawn around the picture again.** It is a `box-shadow`, and
the wrapper it sat on was a bare `<span>` — `display: inline` — so it was drawn
around the *line box*, a strip of text height across the middle of a 52px
avatar, which the scroll container then clipped. That was the cropped frame.

**The chat beside the feed has three controls in its header**, not one. The
picture, the name, and the way out to Messages. The picture used to be part of
the button that opened the conversation switcher, which made somebody's face
mean "switch conversation" in this one pane and "open their profile"
everywhere else; it opens the profile now, and the name beside it — with its
chevron, and the panel that slides across the pane — is the switcher. A group's
picture leads nowhere and is not a button at all.

**Still not applied:** the 30-day `enc/` cleanup `BRIEF.md` describes. That one
deletes attachments whose messages are still in people's conversations — those
bubbles would keep their file name and lose their file — so it is a product
decision rather than configuration.

### Since v0.1.19

- **A notice that happens twice is said once and counted.** Refresh and "check
  for updates" are buttons people press again when nothing appears to happen,
  and every press used to add another identical toast until the corner of the
  window was a column of the same sentence covering the thing being refreshed.
  An identical notice now increments a `×n` beside its title and starts its
  five seconds over, so it outlives the last press rather than the first; a run
  of *different* notices is capped at three, oldest out.
- **The emoji picker opens at once.** It took seconds. All 1,914 emoji are in
  the DOM on purpose — the group rail scrolls one list rather than swapping
  nine — but the cost was never the elements, it was the glyphs: the browser
  rasterised the entire standard set out of the system emoji font before it
  could paint the first row. Each group now carries `content-visibility: auto`
  with an intrinsic size, so an off-screen group is laid out and painted when
  it is scrolled to, and the grids are memoised so typing in the search box no
  longer rebuilds every button.
- **The two deletions are the last two entries of a message's menu**, in that
  order: the one that only touches this device, then the one that asks every
  other device. "Delete for everyone" used to sit in the middle, above React
  and Pin, which put the most far-reaching entry where the hand lands first and
  broke the rule `MenuItem` states for itself — destructive entries sit last.
  The menu is now built by a pure function with the order under test, because
  the entries appear and disappear with the message's state and "last" means
  something different in each case.
- **Pictures in a conversation arrive at the size they were sent at.** They were
  drawn as a background image inside a forced 4:3 box, so anything that was not
  4:3 — most photographs — sat letterboxed in a corner of a box sized for
  something else, inside a column capped at 64%. They are now real `img`
  elements at their own ratio, up to 440px tall, and a message carrying media
  gets a wider column than a message carrying a paragraph.
- **Video and sound play in the bubble.** An mp4 gets a player, and so does an
  mp3, an m4a or an ogg.

  **This did not actually work in v0.1.19 or v0.1.20**, and the entry was written by
  walking the code rather than by playing a file. The players were built
  correctly and were handed a `data:` URL, but the CSP in `tauri.conf.json`
  named no `media-src`, so media fell back to `default-src 'self'` and every
  such URL was refused. `img-src` listed `data:`, which is why pictures worked
  throughout and hid the problem. Tauri appends script and style hashes to a
  CSP and nothing else, so nothing was going to add the directive at runtime.
  Fixed by naming `media-src 'self' data: blob:` — `blob:` because the recorder
  produces one.

  A `.wav` or a `.flac` is shown as a voice message
  instead — those are what a recorder writes before anything has compressed it.
  That is a reading of what arrives, not a fact about it: there is no recorder
  in the app yet, so nothing marks a file as speech, and when there is one the
  payload should say so and the extension list becomes the fallback.
- **The byte-sniffer knows sound**: WAV, FLAC, Ogg, MP3 and the M4A family,
  which used to be called `video/mp4` because it wears MP4's boxes — a player
  with a black rectangle where the picture would be. What a *story* or a profile
  picture may be did not widen with it: those ask `is_renderable`, a
  conversation asks `is_playable`, and five call sites that asked "is this not
  `application/octet-stream`?" now name what they want, because that spelling
  would have accepted sound the moment the sniffer learned it.
- Two smaller things found on the way: the cropper accepted a video (it tested
  for "anything the sniffer knew" and got one frame of nothing to crop), and the
  RIFF and ISO branches guarded a `[8..12]` slice with `len() > 12`, so a file
  that was exactly its own header fell through to "unknown".
- **A picture in the viewer zooms and drags.** The zoom was there and did half a
  job: past 100% you were looking at the middle of the picture with no way to
  reach the rest of it. Dragging moves it now, the wheel zooms about the cursor
  rather than the middle (zoom about the middle is the version where you point
  at a face, zoom, and the face leaves the screen), a double-click toggles 200%,
  and the picture is held inside the frame so it cannot be thrown off the edge.
  The arrow keys pan while zoomed and step through the conversation's media at
  rest, so panning is not a mouse-only feature next to zoom controls that are
  not. The zoom buttons are disabled on a video, where they never did anything.
- **Pinning works on every kind of message, and the panel shows what was
  pinned.** Pinning a photograph already worked and looked like it had not: the
  pinned list rendered the message body or, failing that, the literal words
  "(no text)", so a pinned picture, video, voice message or file appeared as a
  row saying nothing. Each now shows its own mark and a line that describes it —
  a caption where there is one, the file name where there is not, "Voice
  message" for a recording whose name says nothing, and what happened to a
  message that was taken back or could not be opened.
- **Home's chat pane switches conversation by sliding the chat aside.** The
  header opened a dropdown before, capped at eight entries because a menu does
  not scroll — somebody with two hundred conversations could not reach most of
  them from here. A panel slides across the pane instead, showing the Messages
  tab's own rows (the component is exported and reused, so "looks like the chat
  tab" stays true when a pin mark or a preview rule changes there), scrolling,
  searchable by name, with "Most recent" as the first row rather than a control
  somewhere else. It covers the chat and nothing else: the feed keeps its width
  and its scroll position, which is the difference between switching a
  conversation and navigating away from what you were reading.
- **A story starts from the plus on your profile picture.** It was reachable
  only from the dashed circle at the head of the Home strip. The badge is a
  sibling of the avatar button rather than something inside it — the picture is
  itself the control that changes the picture, and a button inside a button is
  neither valid nor clickable. Small and in the corner so the two are not
  confused: the circle changes the picture, the badge posts a story, and both
  say which they are out loud, because a plus over a photograph could mean
  either. Posting moves to the Stories tab rather than raising a toast; the
  story is a better confirmation than a sentence saying it worked, and it is
  where taking it back happens.
- **Adding somebody filters as you type.** The box wanted an exact handle and
  showed nothing at all while you typed it, so one wrong letter told you
  nothing until the conversation failed to start. It now searches as you type —
  debounced, and each request numbered so a slow answer for "al" cannot land
  after a fast one for "alice" and replace the right list with a stale one.
  Typing a handle out in full still works and has to: a private account is
  absent from every search by design and the *server* is what leaves it out, so
  the empty result says so rather than implying nobody is there.
- **The feed composer is one editor.** It opened on a row of tabs — Text, Link,
  Image — that had to be chosen before anything was written, which meant
  deciding what you were going to write before writing it and then being stuck:
  a "text" post could hold a picture but adding one did not make it an image
  post, and an "image" post refused a link outright. There is one box now.
  Write, attach up to four pictures, add a link if there is one; what kind of
  post that adds up to is derived, in `compose.ts`, against the rules
  `posts.rs` enforces — a link wins (the server lets a link post carry images
  and refuses to let an image post have a link, so the order is the only one
  that does not produce a rejected request), then images, then text. A link
  without a scheme is now said while it can still be fixed rather than coming
  back as a refusal.

### Since v0.1.20

- **Stories name who posted them, and stop drawing the same person twice.** A
  received story arrives over MLS, which names a device, not an account —
  `author_handle` started blank and stayed that way forever, because nothing
  ever called the reconciliation its own doc comment already promised.
  `GET /v1/stories` already existed on the server for exactly this (it joins
  against `users`, filtered to contacts and the unblocked — the same boundary
  the fan-out itself respects) and the client never called it.
  `stories::live` now does, matching by id and filling in only what was
  blank; a failed request (offline) falls back to the unresolved list rather
  than losing the read. On the strip, several posts from the same person used
  to be drawn as separate, unlabelled circles — the flat list has no grouping
  of its own — and are now one circle with a `×n` badge, opened with
  Prev/Next in the order they were posted. The ring around each circle also
  used to lose its top and bottom edge: the scroll row had no padding to draw
  it into, and `overflow-x: auto` forces the vertical axis to clip too.
- **An avatar shows a ring when this device holds a live story for that
  person** — your own profile, and anyone else's. This was nowhere: the strip
  was the only place a story showed at all, so finding out somebody had one
  meant already being on Home when it happened to still be live. On somebody
  else's profile the ring is also how you open it — there is no separate
  "their Stories tab" to send you to instead. On your own it is a signal only:
  the picture is already the control that changes the picture, and the
  Stories tab is one tap away for actually watching what you posted. Reads the
  same local, contact-scoped list the strip does, so it shows nothing for
  anyone who is not a contact or has posted nothing right now — no new
  privacy surface, since a non-contact's stories never reach this device to
  begin with.
- The strip's viewer (Prev/Next, the progress dots, the fetch-per-story dance)
  moved into its own `StoryViewer` component so the new rings could open the
  same one rather than a second implementation of it.

### Voice messages (wave 1)

- **Voice messages record.** The microphone in the composer was a label with
  nothing behind it; now it captures. Holding it turns the whole composer row
  into the recorder — a pulsing dot, a running timer, a waveform that grows as
  you speak, a bin on the left and send on the right — because while it runs the
  text box does nothing and leaving it there only invites typing into it.

  **The sender says it is a recording; the receiver does not guess.**
  `Payload::Attachment` gained `voice`, carrying the duration and a coarse
  amplitude envelope of at most 64 bytes. That was the design `lib/media.ts`
  asked for in a comment when it had no recorder to serve: the WAV/FLAC
  extension list was only ever a reading of what arrived, and it now answers
  for old messages and picked files while the flag answers for everything a
  recorder made. It has to, because a recorder writes WebM/Opus, which by MIME
  type alone is a video clip.

  The peaks are sampled from the analyser *while recording* rather than by
  decoding the finished blob — decoding a minute of speech to draw sixty-four
  bars would mean holding several megabytes of PCM for a picture. They are
  capped twice, on the way in and again in `drawable_peaks`, so neither the
  ciphertext nor the renderer is sized by whatever a sender felt like sending.

  **The bytes cross IPC here, against the rule the file picker follows**, and
  the reason is where the plaintext starts: a picked file is on disk, so passing
  its path keeps it out of the WebView entirely, while a recording is made in
  the WebView by `MediaRecorder` and is already there. Sending it down is moving
  plaintext out, not letting it in. No key comes back, and the encryption still
  happens in Rust. Five minutes is the ceiling.

  A denied microphone says so in the composer and points at Windows privacy
  settings. A tap rather than a hold sends nothing — under 400 ms is room tone
  somebody would have to delete.

### Replies and quotes (wave 2)

- **A message can answer another one.** `Payload::Reply` names its target the
  way `Edit` and `Retract` already do — by the sender's own name for the
  message, not the envelope id — so a message sent before names existed cannot
  be replied to and the menu does not offer it. Reply is the menu's first entry,
  because it is what somebody usually opened the menu for.

  **A reply carries no copy of what it answers.** Only the name. Copying the
  quoted words in would put a second, unrevocable copy of somebody's sentence
  inside a message they did not send: retracting the original would leave it
  quoted forever, and quoting would become the way to defeat taking a message
  back. There is a test for that shape, not just a comment.

  The reader resolves the quote against what it holds, and the three answers are
  drawn differently because they are different things: the message is here (jump
  to it), it was taken back, or this device never received it. The last is
  ordinary — somebody joined the conversation after the message being answered —
  so the quote says so rather than rendering a blank strip that looks broken.
  A quote you cannot jump to is not drawn as a button.

  Resolution happens in Rust over the conversation already loaded, not with a
  query per bubble, and `reply_to` is a column (schema 16) rather than something
  decoded out of the payload per message. It is deliberately **not** a foreign
  key: the answered message may never have reached this device, and a constraint
  would turn that into a refused insert — losing a reply that was perfectly
  readable.

  Jumping flashes the message you land on. In a wall of similar bubbles,
  arriving somewhere with no signal leaves you unsure anything happened; the
  wash fades rather than a border appearing, since a border would resize the
  bubble exactly as you start reading it. `prefers-reduced-motion` keeps the
  mark and drops the animation.

  A pending reply is cleared when the conversation changes — it names a message
  in the thread it was written for — and an attachment does not spend it: a file
  and a reply are two different messages.

### View-once media (wave 3)

- **A photo or clip the other person can open once.** The eye beside the
  paperclip, in a one-to-one conversation only.

  **The key is the mechanism, not a flag.** A view-once arrives split in two: an
  ordinary message row that draws a bubble, and a row in a new `view_once` table
  (schema 17) holding the key. Opening fetches, decrypts, and *then* overwrites
  the key with `NULL` — in that order, because burning first would lose the
  picture to a dropped connection, and there is no second copy of that key
  anywhere. Afterwards this device cannot read the object again: not "declines
  to", cannot.

  The key is deliberately **not** in `messages.payload`, where every other
  attachment keeps its own. That column outlives the opening, so a key in it
  could be read again by anything that could read it once — and "destroyed when
  you open it" would be a sentence with nothing behind it.

  The row survives the burn, with `opened_at_ms` set, because the bubble still
  has to say what used to be there; a deleted row would be indistinguishable
  from a message that was never view-once at all.

  **What the UI claims is exactly what is true.** Beside the button: *"Once.
  Nexo cannot stop a screenshot."* There is no screenshot notification, and
  that is a decision rather than an omission — it would imply a guarantee
  `THREAT-MODEL.md` §4 disclaims, and its silence would prove nothing while
  reading as an assurance. The spent bubble says the key was destroyed, not
  that the message "expired" (no clock was involved) or was "deleted" (it went
  nowhere).

  **One-to-one only.** "Once" in a group would have to mean "once each", a
  different promise wearing the same word — and people would assume the
  stricter one. The control is absent there rather than present and redefined.

  **Our own copy was never openable.** We keep the file we picked, so nothing
  is lost; but the key row is written already spent, because a sender who could
  reopen what the recipient cannot would make the bubble untrue on one side.

  The type is sniffed from the bytes on the way out *and* on the way in — a
  chosen extension is not evidence about what a page will be asked to render.
  `docs/THREAT-MODEL.md` §2.13 is the long version.

### Segmented attachment crypto (wave 5a)

- **The foundation for playing a video before it has finished arriving.**
  `crates/crypto/src/attachment.rs` gained `encrypt_segmented`,
  `decrypt_segment` and `segment_count`: the same AES-256-GCM from the same
  crate (rule 1), applied per 256 KiB segment, so a byte range can be decrypted
  without the whole file. Whole-object `encrypt` is untouched and is still what
  every attachment on the wire uses.

  Per-segment encryption invites three attacks, and each is closed rather than
  noted:

  - **Reordering.** Independently sealed segments under one key would be
    interchangeable, so the segment's index goes in the AAD — a segment moved
    from its position fails its tag.
  - **Truncation.** Cutting the tail off leaves every remaining segment
    individually valid, so the total count goes in the AAD too. A reader lied
    to about the length is refused at the *first* segment it opens, not the
    last. That is rule 7 at its smallest scale: a stream cut short refuses
    rather than playing a shortened video.
  - **Nonce reuse**, the catastrophic one for GCM. The nonce is the file's
    random 96-bit base with the index added into its last eight bytes, so no
    two segments under one key share a nonce and no two files share a base.
    Tested directly over ten thousand indices rather than inferred from a round
    trip passing.

  An empty file is one empty segment rather than none, so "no segments at all"
  is never a valid encoding — otherwise a truncation to zero would be
  indistinguishable from an empty file.

  `SEGMENT_LEN` is fixed rather than carried in the payload: a reader that took
  it from the sender would have to trust it to compute segment boundaries, and
  a lie there is a way to make a reader index past its own buffer.

  **Nothing sends segmented attachments yet.** The reader side, the ranged
  fetch and the player are wave 5b — see the plan.

### Streaming video (wave 5b)

- **A video plays without being fetched first.** `src-tauri/src/media.rs`
  registers a `nexo-media` URI scheme, and the bubble points `<video>` at it
  instead of at a `data:` URL. A request for a byte range turns into the two or
  three segment fetches and decryptions that range touches, and nothing else
  moves.

  This is what wave 5a's segment framing was for. Video is sealed with
  `encrypt_segmented`, everything else stays whole-object, and
  `Payload::Attachment::segmented` carries which — defaulting to false, so every
  message sent before this is byte-identical on the wire and still reads.

  **The 12 MB inline cap no longer applies to video.** It was never a policy
  about video; it was the size at which base64-ing a whole file through IPC into
  the page became unreasonable. A ranged URL does not do that, so the ceiling
  goes with the mechanism that needed it.

  `preload="metadata"` in `MessageList` finally means what its comment always
  claimed. Against a `data:` URL it could not: the whole file was in the page
  before the element saw it. Against this URL the element fetches the header,
  draws the first frame, learns the duration and stops — which is also why no
  poster frame is carried in the payload. An earlier draft of this wave put a
  JPEG in every recipient's ciphertext to solve a problem that ranged reading
  had already solved.

  Range parsing answers the forms a player actually sends — `bytes=N-`,
  `bytes=N-M`, and the suffix `bytes=-N` that finds an MP4 index at the end of a
  file. Multi-range is refused rather than half-answered. A range past the end
  is clamped, because players routinely ask for more than exists at the tail.

  **It fails closed.** A segment that does not authenticate — reordered, cut
  short, or fetched against a `size` the sender lied about — becomes a 404 with
  no body rather than partial bytes. A player that gets nothing stops; there is
  no shortened video (rule 7).

  The handler carries the same duty `with_client` does: a range fetch is an
  ordinary authenticated call and can rotate the refresh token, and a spent one
  replayed at the next launch is what the server reads as theft.

- **`Transport::get_object_range`.** A default implementation fetches the whole
  object and slices, so every existing transport keeps working and correctness
  never depends on the store honouring `Range`; `http.rs` overrides it with a
  real ranged request, and handles a 200 answer by slicing — a store that
  ignores the header is slow rather than wrong.

### Stickers (wave 6)

- **Twelve stickers, drawn in the repo as inline SVG**, in the same idiom as the
  icon set and for the same reason: rule 3 wants everything bundled, and inline
  SVG is the strongest form of that — there is no request to make, so no third
  party learns which sticker you sent or that you were browsing them at two in
  the morning.

  **A sticker sends a name, not a picture.** `Payload::Sticker { pack, id }` is
  a few bytes inside the ciphertext; sending art would mean an upload, an object
  in the bucket, a key and a download. That is the only reason sending one feels
  free, and it means the server learns nothing from a sticker it does not learn
  from any other message — no object appears in storage at all.

  The cost of naming rather than sending is that an old build cannot draw a
  sticker added after it shipped. It says so, in the shape `UnsupportedBubble`
  already uses, rather than drawing nothing.

  **Nothing in a pack can execute**: these are components compiled into the app,
  not data interpreted at runtime, so there is no format for a hostile pack to
  abuse. Colour is deliberate — `README.md` says the interface stays neutral
  while content keeps its colour, and a sticker is content somebody chose.

  Six of them animate in CSS, and every one holds a readable pose under
  `prefers-reduced-motion`: a joke that only works while it moves is not a
  picture, and somebody who turned movement off is owed a picture.

  The picker mirrors `EmojiPicker` — same shell, same search, same recents —
  because they are the same interaction, and closes after one pick where the
  emoji picker stays open: an emoji joins a sentence, a sticker *is* the message.

### GIF search — not built, and why

Asked for alongside stickers, and it is the one thing in this round that the
invariants refuse rather than merely complicate.

- The CSP names **no remote host** in `img-src` or `connect-src`. That is rule
  3's enforcement point, not an oversight.
- `THREAT-MODEL.md` §2.3 already decided this class of question for link
  previews, and its list of what the client will not do ends with **"and no
  image fetch."**
- A GIF search is strictly worse than a link preview. A preview reacts to a link
  somebody else sent; a search sends **what you type**, keystroke by keystroke,
  plus your IP, to Tenor or Giphy. It would also need a provider API key shipped
  in the binary, where it is extractable by anyone who wants it.

A design that would fit the repo does exist, and it is the shape §2.3 already
chose: fetch in **Rust** rather than in the page (so the CSP does not move, and
results reach the WebView as `data:` URLs), off by default, with the setting
saying plainly what it leaks — and the API key supplied by the operator, listed
in `TUTORIAL.md` beside the other values you have to provide.

That is a threat-model decision and a new credential, so it is the owners' to
make rather than something to slip in under a feature request. Until then the
expressive need is met by the bundled pack, which is the half of engine 6 that
actually carries the network effect.

### Folders (wave 7, first part)

- **Folders are local and never leave the device.** How somebody files their own
  conversations is a reading of who matters to them; the server has no use for
  it and no business holding it. That also makes this the cheapest feature in
  the app to be sure about — it changes the threat model not at all.

  Membership is a table rather than a column (schema 18), so a conversation can
  sit in more than one folder, and filing something twice is a no-op instead of
  a duplicate row.

  **Deleting a folder never touches what is in it.** Filing is not owning, and
  there is a test that says so rather than a comment.

  The rail is absent until there is a folder: a row of chips reading "All" and
  nothing else is a control that does nothing. Folders are therefore made from
  the conversation you want to file, which also means naming one and filing that
  conversation happen in a single step rather than two.

  A folder narrows what search covers rather than the other way round — somebody
  looking at "Work" who types into the box expects to search Work.

### Archive and drafts (wave 7, rest)

- **Archive** is a flag beside pinned and muted, in the same local store, and it
  means the third thing those two do not: muting is about interruption,
  removing is about the history, and archiving is about the list you look at all
  day. An archived conversation still notifies and still exists. A message
  arriving does **not** unarchive it — that would make the feature useless for
  the one case it exists for, a chat that keeps talking and that you have
  finished with. The chip appears only when something is behind it, and leaving
  the archive when it empties is automatic: standing in an empty room with no
  door is worse than being returned to the list.

- **Drafts live in the encrypted store, not in the page.** The app store's own
  header says nothing persisted in the WebView is a secret, and a half-written
  message plainly is one — it is the same words the message would have carried,
  so it gets the same protection the sent ones get. Schema 19, one row per
  conversation, replaced in place: there is no history of drafts and there
  should not be, since keeping the versions somebody typed and deleted would be
  keeping the sentences they thought better of. Clearing one deletes the row
  rather than storing a blank, so an abandoned draft leaves nothing behind.
  Saved on a 400 ms delay, because this is a write to an encrypted database and
  one per keystroke would be one per keystroke.

### The follow graph (wave 8)

- **The feed can be narrowed to people you follow.** A `follows` table, two
  routes, and a bound parameter on the three feed queries — not three more
  copies of them, because `query_as!` can only check a statement that exists in
  the source, and a filter kept in step in six places will eventually be applied
  in five.

  **Following changes what you are shown, never what you may see.** Every post
  the Following view can return is one the Everyone view would have returned to
  the same caller: both run the same block list. There is a test for exactly
  that, because a Following feed is easy to write in a way that reaches past a
  block and nothing in the UI would ever reveal it.

  Three relations now exist and are kept apart on purpose: a **block** is mutual
  by effect, a **contact** means sharing a conversation and gates stories, and a
  **follow** is one-sided and grants nothing. Blocked, private and non-existent
  all answer `404` — a `403` would confirm an account is there, which is what
  being absent from search exists to prevent. Unfollowing deliberately skips
  that check: somebody blocked after following must still be able to remove
  their own edge, or the row would be stranded.

  **This is a new disclosure**, and `THREAT-MODEL.md` §2.14 says so rather than
  filing it under §2.2. Conversation metadata accumulates as a by-product of
  routing; a follow is a deliberate, dated statement of interest in somebody you
  may never have messaged. A follower *count* is public because the posts
  already are; a follower *list* is offered by no route.

### The live socket (wave 4, unblocked)

- **`/v1/stream` has a client now.** It had none: the server has relayed typing
  since M4 and nothing ever connected, which is why the earlier estimate of
  "an afternoon" for typing indicators was wrong by an order of magnitude.

  `tungstenite`, not `tokio-tungstenite`: Argon2id and SQLCipher block
  regardless, so a runtime would buy a function colour and no concurrency. One
  thread owns the socket, behind the same `http` feature as the ureq transport
  so a shell bringing its own network stack is not handed one.

  **It adds promptness, never correctness.** The server's own module says the
  socket is not the source of truth, and this keeps to it: the 4-second poll
  continues underneath, `sync` repairs anything missed, and a socket that never
  connects leaves the app behaving exactly as it did before. That is why nothing
  in it reports failure to the user, and why the backoff is polite rather than
  aggressive.

  The connection follows the session rather than being started by login:
  `drain_stream` connects when there is a session and disconnects when there is
  not, so signing in, locking and signing out all take care of themselves and
  `auth.rs` never learns that sockets exist. Locking closing it matters — a
  socket still delivering into a locked app is a session that did not end.

  Authenticated with an `Authorization` header. A browser would have to put the
  token in the URL, where every proxy logs it; a Rust client does not have to
  make that trade.

- **Typing indicators, finally.** Throttled rather than debounced — debouncing
  would send nothing until somebody *stopped*, which is the opposite of the
  point. There is no stop event: each notice lasts a few seconds and lapses, so
  silence is what stopped means, and a sender who closes the window mid-word
  cannot leave "typing…" on screen for ever. The `presence` preference now
  governs both sending and showing, rather than being read by a control that
  did nothing.

### Three bugs found by driving the running app

Found by attaching to the built app's WebView2 over CDP and reading its console
— not by review, and not by any test. All three were invisible from outside:
the app worked, so nothing looked wrong.

- **Every IPC call was taking the slow path.** The CSP named
  `connect-src ... https://ipc.localhost`, and WebView2 on Windows uses
  **`http://`**. So the custom-protocol fetch was refused every time, Tauri
  caught it and fell back to `postMessage`, and everything kept working —
  one failed fetch and one console error per call, on every call, since the CSP
  was written. `restore_session`, `set_window_backdrop` and every plugin call
  went through it.

- **The bundled fonts were being refused.** There was no `font-src`, so the
  faces Vite inlines as `data:` URLs fell back to `default-src 'self'` and were
  blocked. `document.fonts` had JetBrains Mono in `error` state and the app was
  rendering in fallback faces rather than the ones it ships.

- **The Meet&Greet map worker never loaded.** `MeetMap.tsx` imported it with
  `?url`, which copies a file verbatim without following its imports — and
  MapLibre's worker imports a sibling, `maplibre-gl-shared.mjs`, which was
  therefore never emitted. The worker asked for it, Tauri's asset protocol
  answered with `index.html`, and the browser refused the module: *"Expected a
  JavaScript-or-Wasm module script but the server responded with a MIME type of
  text/html."*

  The map still drew — WebGL canvas, pins, zoom — so nothing looked broken,
  while everything MapLibre means to do off the main thread was happening on
  it.

  **The banding is not this, and the guess here was wrong.** This paragraph
  used to name the worker as the likely cause of the horizontal banding the
  Meet&Greet section records, and asked for a re-test. The re-test has now been
  done, by attaching to a release build and reading the target list: a `worker`
  target is present and the module loads, so `?worker&url` did what it was
  supposed to. The banding is still there, and visible while the map sits
  still rather than only while dragging. Whatever causes it, it is not the
  worker. The gap stays open with one cause ruled out.

  Fixed with `?worker&url`, which builds the worker with its imports included
  and still yields a same-origin asset URL — so the CSP reasoning in that file's
  comment still holds.

All three verified fixed by running a dev build with the same CDP attachment:
the console goes from many blocked-IPC, blocked-font and failed-module errors to
none, and no font remains in `error` state.

**Not a bug, checked and cleared:** every conversation reads "No messages yet".
That is expected after the reinstall — the conversation *list* is server-side
metadata, while history is local-only and went with the old store. Worth knowing
that it also means a fresh identity keypair was generated for this device, which
is the silent-rotation case §4 of the threat model calls out.

---

### Since v0.1.22: nine bugs found by driving the running app

Found the way the last three were — attaching to the WebView2 of a real build
over CDP and driving every surface — plus, this time, watching the process's
own TCP connections from outside and running the client's live tests against a
local server. Two of the nine were only visible from outside the process, and
none of them failed a test that existed.

**The socket itself was checked and is healthy**, which is worth writing down
because it was the thing under suspicion: signed out, the app holds no
connection and makes no IPC call; signing in brings up two long-lived TLS
connections that then survived 32 minutes and a send without dropping;
`send_message` took 101 ms and reused the pooled connection rather than
opening one. `drain_stream` running every 500 ms is deliberate and costs about
2 ms a call.

- **Signing out did not delete the local store.** The worst of the nine.
  `nexo_store::delete` unlinks the database, Windows refuses while it is open,
  and `logout` ran with `LoggedIn` — which owns the connection — still in
  place. The unlink failed with `os error 32`, and since the wipe was a chain
  of `?`s that failure also skipped erasing the store key and the unlock PIN.
  So sign-out reported success and left the database, the DPAPI-wrapped key
  that opens it, and the PIN on disk, under a dialog that says "deletes its
  local message store. Anything not synced is gone." Fixed by closing the
  client first and by erasing the keys before the file, so a unlink that still
  fails leaves ciphertext with no key rather than readable history.
  `crates/client/tests/wipe.rs` covers both.

- **Signing out left the previous conversation on screen.** `App` kept the
  account in a local `useState` *and* mirrored it into the store; `useSignOut`
  cleared only the mirror. The account chip emptied while the shell stayed
  mounted — conversation list, message bodies, safety numbers and a live
  composer, all belonging to a session that had ended. One copy now, in the
  store.

- **A second account inherited the first one's store.** Nothing keyed the store
  by user, so signing a different handle in showed that account another's
  conversations and message bodies — and `login` reused the stored identity
  keypair, giving two accounts one cryptographic identity. Reachable without
  doing anything strange: a retired refresh token drops the app to the sign-in
  screen with the store still there. `register` and `login` now refuse a store
  that belongs to someone else, and name them.

- **A group could be marked verified against no digits.** A safety number is a
  fingerprint over two identity keys, so there is none for a group — but the
  panel drew the compare-these-digits instruction over an empty box with a live
  "Mark as verified" under it, and pressing it recorded the verification and
  then claimed "You compared these digits with this group and they matched",
  green shield included. Rule 5, in the one place being wrong about what is
  proven matters most. Groups now get an honest panel and no button.

- **A group's name never reached its members.** `rename` has always sent the
  title as an encrypted `Payload::Rename`, because the server holds no title;
  creation only wrote it locally. The person who named the group was the only
  one who saw the name. Now sent at creation too, after every member is
  admitted so they are at an epoch that can read it.

- **A conversation's title was used as a handle.** For a DM with no member list
  the title is the literal string "Unnamed conversation", and `MessageList`
  handed it to `HandleAvatar` as an account — so every visit to Messages or
  Home sent `profile("unnamed conversation")` to the server and took a 404 for
  it, twelve times in one session. The same conflation the core already
  records fixing once for groups.

- **A 404 arrived as an internal error.** `TransportError::NotFound` fell
  through to `_` in the feed's error mapping and reached the page as
  `kind: "internal"`, "Something went wrong. Try again." — so a thing that is
  not there and a client that is broken were the same answer.

- **Videos sealed whole could never play.** `stream_info` answers only for the
  segmented encoding, and everything sent before `encrypt_segmented` existed
  has `segmented: false`; the media scheme turned that into a 404. Meanwhile
  the page picks the player from the declared MIME alone, so those attachments
  got a `<video>` whose source always failed and which drew a dead player at
  0:00. The scheme now falls back to the whole file and answers ranges out of
  it.

- **The profile's post list dropped everything but the body**, so a link post
  — which has a title and a URL and no body — rendered as a blank card, an
  image post as an empty one, and every title everywhere vanished. The feed had
  always shown all of it.

Smaller, in the same round: reactions survived "Delete for everyone", leaving a
thumbs-up under "You took this back"; deleting a post asked for no confirmation
while taking back a message always has; a folder's delete button was
`hidden group-hover:flex`, which takes it out of the tab order as well as out
of sight, and a folder chip has no menu; and the header's magnifier opened a
notice promising full-text search "with the local encrypted store (M2)" — long
shipped, and the conversation list has been running it against the FTS index
ever since.

**Checked and cleared, so nobody re-opens them:** Enter *does* submit the
new-folder name — that field sits in a real `<form>` with a submit button, and
an earlier report to the contrary was an artifact of dispatching a synthetic
key event, which does not trigger a native default action. And auto-lock could
not be shown to be broken: the timer registers and ticks, and the one run that
overshot its deadline had pointer activity in it, which is what the timer
watches.

**Known and deliberately not fixed here:** one slow media decrypt blocks every
other IPC call. `with_client` holds a single mutex over `LoggedIn` for the
whole operation, so a 1.5-second `attachment_data_url` measurably delayed an
unrelated `set_draft` behind it. Fixing it is not a bug fix: `LoggedIn` owns a
SQLCipher `Connection` and the MLS provider, neither of which is `Sync`, so
real concurrency means a connection pool and reworked provider access — a
change to the two things the invariants guard hardest, and one that deserves
its own design rather than a line in a fix pass.

---

### Since v0.1.23: the lock screen refused a correct PIN

One bug with two faces, both reported from a real run, and one design decision
reversed because of them.

- **A correct PIN was answered with "That PIN is wrong."** `unlock_with_pin`
  verified the PIN locally — that part always worked — and then called
  `client::resume`, which trades the stored refresh token for a fresh access
  token over the network. All three of `resume`'s outcomes collapsed into
  `Ok(None)`, and the lock screen has exactly one reading for `None`. So a
  server that could not be reached, and a session the server had retired, both
  came back as an accusation of mistyping — followed by an offer of five more
  tries at something that could not work, since a correct PIN also resets the
  attempt counter to five.

  Fixed in two parts. `Ok(None)` now means the PIN was wrong and nothing else
  does; the two failures that are not about the PIN arrive as errors carrying
  `unreachable` and `signed_out`, which the lock screen tells apart. And
  unlocking no longer asks the server at all in the ordinary case: locking
  drops `ClientState` and leaves `SessionState`, so the tokens are still in
  the process and rebuilding the client from them reopens the store and the
  MLS state from disk. That is what the lock screen had been promising all
  along — "the PIN works on this machine only, and never leaves it" — while
  the code behind it could not unlock an offline machine whose data is
  entirely local.

- **The map never wrote down a rotated refresh token.** `meet.rs::with_client`
  was the one authenticated path missing the drain that `conversations.rs`,
  `feed.rs` and `media.rs` all perform: the transport replaces a refresh token
  in place when the access token ages, and the shell has to persist the new one
  because the next resume replays whatever is stored. A spent refresh token is
  what the server reads as theft, and it answers by revoking every session for
  the account — which is one way the resume above failed, and it took the whole
  account with it. `publish_key_packages_for` in `auth.rs` had the same gap.
  Both now drain. `client::build` also prefers the store's copy of the refresh
  token over the session's, since the store is where every rotation is written
  and the session's copy is whatever was issued when it began.

- **The unlock PIN is offered, not required.** It used to be a gate: signing in
  led to "Choose an unlock PIN" and the app would not open until one existed.
  The argument for it is still true — auto-lock only protects an unattended
  machine if getting back in is quick, so a costly unlock makes people lengthen
  the timer or switch it off — but it was being paid for in the wrong currency.
  The screen stood between somebody and their own messages at *every* sign-in,
  and hardest after a sign-out, since signing out erases the PIN along with the
  store it unwrapped. `RequirePin.tsx` is now `OfferPin.tsx`: the same screen
  with a *Not now* beside the *Set PIN*, shown once per machine
  (`preferences.pinOfferAnswered`), with Settings keeping it available
  afterwards. That flag is deliberately **not** reset by signing out, and the
  first attempt got this wrong: signing out erases the PIN, so re-arming the
  offer on top of that put the same screen in front of the very next sign-in --
  the toll gate again, one click cheaper. Being asked once introduces a
  feature; being asked after every sign-out is the thing that was being
  removed. The lock screen already fell back to the password
  when no PIN was set, so nothing else had to change.

Smaller, in the same round: a successful sign-in put the sign-in form back on
screen for as long as `pin_status` took to answer, because the gate below it
required a non-`null` answer and the fall-through rendered `AuthPage`. It now
renders the window frame and nothing in it.

---

### Calls, wave 1: the wire and nothing above it

Signalling only. Nothing rings yet and no sound moves — what exists is the path
an offer, an answer and a hangup travel, end to end, with a test on both sides
of it.

- **Signalling rides the conversation, not a route of its own.**
  `Payload::Call { call_id, signal }` is an ordinary encrypted payload, so the
  server moves it exactly as it moves a message: opaque, unread, rule 4 with no
  new work. The route table did not grow, `PROTOCOL_VERSION` did not move, and
  the fan-out that rings somebody is the per-conversation one that already
  existed. An SDP names codecs, ICE candidates and a DTLS fingerprint; on a
  plaintext signalling route the server would read all three.

- **An offer leaves no bubble. The hangup is the record.** The `Payload::Call`
  branch in `sync` hands every signal back through `SyncOutcome::calls` and
  `continue`s — except the hangup, which falls through to the ordinary insert
  and becomes the "Missed call" row. Storing all of it would put two blocks of
  SDP in a conversation each time somebody called; storing none of it would lose
  the only part anybody would look back at.

- **Candidates are bundled, never trickled** — and this one is about other
  people's installations. A build that predates this variant reads an unknown
  `kind` as `Unsupported`, which draws a bubble. Trickle ICE sends one envelope
  per candidate, so a single call would fill an older client's conversation with
  unreadable rows. Waiting for gathering to finish costs a fraction of a second
  against a relay and holds a whole call to two messages, so the worst an old
  build sees is an offer and a hangup.

- **Nothing is queued.** `send_call_signal` sends directly, like `rename` and
  `react`, and never through the outbox. An offer delivered ten minutes late
  would ring somebody about a call that ended before they sat down.

Three commands — `call_offer`, `call_answer`, `call_hangup` — bringing the IPC
surface to 115. `apps/desktop/src/lib/calls.ts` is the page's half; signals
arrive on `SyncResult.calls` and reach anything subscribed through the
`onSync` listener the sync agent already exported, so no dead scaffolding was
added for a UI that does not exist yet.

**What is deliberately still missing**, so nothing here reads as more than it
is: no ringing screen, no media, no TURN relay, and no permission handling. Also
worth knowing before the next wave — an incoming signal waits for the 4-second
sync poll, because `drain_stream` forwards typing and drops `ServerEvent::
Envelope`. Ringing needs that closed, and it is a wave-3 item rather than a
wave-1 one.

#### Checked in a real build before any of it was designed

The premise was measured rather than assumed, by attaching to a release build's
WebView2 over CDP:

- **The WebRTC stack is there and it works.** A loopback carried real media —
  Opus, and VP8/VP9/H.264/AV1 available. Microphone capture reports
  `echoCancellation`, `noiseSuppression` and `autoGainControl` all true at
  48 kHz, which is the entire argument for using the WebView's media stack
  instead of building one in Rust.
- **Calls need no CSP change.** Zero `securitypolicyviolation` events across ICE
  negotiation and a real `<video srcObject>`. Worth writing down given the CSP
  has failed silently three times before.
- **WebView2 shows its own permission prompt** — *"http://tauri.localhost wants
  to · Use your cameras"* — because wry registers a `PermissionRequested`
  handler only for clipboard-read and leaves every other kind at the default.
  A browser bubble naming an origin nobody recognises, inside a native
  messenger. Handling it properly needs `with_webview` and the WebView2 FFI,
  which would be the **second `unsafe` in the workspace**. Wave 3 decides.
- **A 2 fps camera reading was a closed privacy shutter**, not a pipeline
  problem: mean brightness 0, and the same encoder path did ~30 fps from a
  synthetic source.
