# What Telegram does that Nexo could

A filtered study, not a wish list. Telegram has hundreds of features and most
of them are wrong for this app — some because they need a server that can read
messages, some because they need remote code, some because they are built for
groups of two hundred thousand people. What is left after that filter is short,
and that shortness is the point of the document.

**How it was made.** Telegram's own blog and FAQ for what each feature actually
does, review and comparison writing for what people say they like, and the
desktop keyboard-shortcut references for the things daily users lean on without
naming them. Sources at the foot. Everything about *Nexo* below was checked
against the code, not remembered.

**What is already built** is not repeated here. Replies and quotes, reactions,
edit and take back, pinning, local delete, archive, drafts, folders, stories,
voice messages, view-once media, stickers, typing indicators, mute, blocks, the
follow graph, themes and accent — all of these exist. [`STATUS.md`](STATUS.md)
is the inventory.

---

## The filter

A Telegram feature is out if it needs any of these, and the reason is an
invariant rather than a preference:

| Needs | Why it cannot happen here |
|---|---|
| The server to read messages | Rule 4. Nexo's server moves opaque envelopes. |
| Remote code or a third-party fetch | Rule 3 and the CSP. Nothing in the page may reach a stranger's host. |
| Message history in the cloud | There is no readable cloud copy: the server keeps sealed envelopes (`THREAT-MODEL.md` §2.2) but no key that opens them, and a device that has moved past an epoch no longer has the keys either. The store is the only readable copy. |
| A second device on one account | One device, one account today. Changing that is a design, not a feature. |
| Claiming more protection than exists | Rule 5. |

Two more, which are about this app rather than about cryptography:

- **Group scale.** Nexo groups are small. Topics, slow mode and anti-spam
  tooling solve problems it does not have — and the public feed already covers
  broadcasting.

  **One exception, taken on purpose: roles, for Teams.** A team is a private
  board of posts for up to 200 people, and somebody has to be able to decide
  who is in it. So a team has exactly three roles — owner, admin, member — and
  the server enforces who may add and remove. That is the whole of it. No
  custom roles or per-permission toggles, no topics or sub-groups inside a
  team, no slow mode, no channels at 200k, no anti-spam tooling; a team is
  capped at 200 members because commit size and fan-out grow with the group,
  and broadcasting is still the feed's job. Ordinary groups keep no roles at
  all.
- **Payload weight.** Everything ships in the binary; there is no CDN. A
  feature that wants forty megabytes of animation assets pays for itself on
  every install and every update.

---

## Worth building

Ordered by what they cost, not by how much they are loved. Effort is rough and
relative.

### 1. A conversation with yourself

**Telegram calls it Saved Messages**, and it is the feature that shows up first
in every "underrated Telegram features" piece — a place to throw links, files
and notes to yourself, which people then use as their scratchpad and bookmark
store. Telegram later gave it tags and its own search.

**Fits because** it needs nothing new on the wire. It is a conversation whose
only member is you, and everything that already works in a conversation —
attachments, voice notes, search, pinning — works in it for free.

**The honest limit:** Telegram's version is a cloud drive, reachable from any
device. Nexo's would be on this machine only, and the empty state has to say so
rather than let someone assume otherwise. That is the same honesty the feed
banner already practices.

**Effort:** small. **Risk:** low.

### 2. Search inside a conversation

`Ctrl+F` in a chat is on every Telegram desktop shortcut list, and it is the
one shortcut people who use no other shortcuts still learn.

**Fits because it is already built.** `search_messages` exists in the store
over an FTS index, it is exposed as an IPC command, and the conversation list
already calls it. What is missing is only the in-conversation UI — a field, a
result count, and next/previous jumps. The header button that would open it now
focuses the list's search box, which is a stopgap.

**Effort:** small, and almost all of it is UI. **Risk:** very low.

### 3. Forwarding

Sending a message on to another conversation is the ordinary, unglamorous thing
everybody does. Telegram's desktop app even lets you drag a message onto a chat
in the list to forward it.

**Fits because** forwarding in an E2EE app is a re-encrypt: read the plaintext
this device already holds, encrypt it into the target group, send. No new
server behaviour.

**Two things it must get right.** It has to say a message was forwarded and
from whom, because a forwarded message that looks original is a lie the UI
would be telling. And an attachment should be re-sent by reference where it can
be, rather than downloaded and re-uploaded whole.

**Effort:** medium. **Risk:** low, provided provenance is shown.

### 4. Selecting several messages

Telegram lets you select a run of messages and then copy, delete or forward
them together. It pairs with forwarding and makes clearing up a conversation
bearable.

**Fits because** the hard part is already written and tested: `selection.ts`
holds the Ctrl/Shift selection rules as a pure function with its own tests, for
the conversation list. The same rules apply to messages.

**Effort:** small-to-medium. **Risk:** low. The destructive entries must keep
the ordering rule the message menu already follows.

### 5. Keyboard shortcuts

`Ctrl+Tab` between chats, `Ctrl+F` to search, `Esc` to back out, `Ctrl+0` for
the self-conversation, double-click a message to reply. Desktop users lean on
these without ever calling them a feature.

**Fits because** it is keyboard handling in the shell. It costs nothing at
runtime and nothing in payload, and it is the cheapest thing on this list that
regular people feel immediately.

**Effort:** small. **Risk:** very low. Needs a written-down list so two
surfaces do not claim the same chord.

### 6. Paste an image, drop a file

On Telegram Desktop you paste a screenshot straight into the composer and get a
send preview with a caption box. It is the single most-used desktop convenience
there is, and its absence is felt every time.

**Fits because** the attachment path already exists; this is a different way of
reaching it. Both go through the same sniffing and the same encryption.

**Watch:** the bytes must still be sniffed in Rust rather than trusted from the
clipboard's declared type — the convention about MIME being a layout hint and
not evidence applies exactly here.

**Effort:** small-to-medium. **Risk:** low.

### 7. The unread line

A divider that says where you stopped reading, and a way to jump to it. Quiet,
universal, and the thing that makes returning to a busy conversation possible.

**Fits because** unread counts are already tracked per conversation in the
store. This is drawing what is already known.

**Effort:** small. **Risk:** low.

### 8. Scheduled send

Telegram lets you hold Send and pick a time, and in Saved Messages the same
mechanism becomes a reminder. People use it for timezones and for not writing
to someone at 3am.

**Fits because** the outbox already exists and already holds messages that have
not gone yet. A scheduled message is an outbox entry with a time on it.

**The honest limit:** with no server-side scheduling — and there cannot be one,
because the server cannot read the message — it sends when the app is running.
Nexo runs in the tray and can start with Windows, so this is usually fine, but
the UI has to say "sends when Nexo is open" rather than promise more.

**Effort:** medium. **Risk:** low, if the promise is worded correctly.

### 9. Auto-delete timers

Telegram's is per chat, 24 hours or 7 days, counted **from sending rather than
from reading**, applying only to messages sent after it is switched on, with
the countdown visible on the message.

**Fits well** — better than most things on this list, because the machinery is
familiar: stories already expire at 24 hours and view-once media already burns
on open. And unlike Telegram's cloud chats, deletion here is genuine where it
counts: the server holds only ciphertext it cannot open (and, today, keeps it —
`THREAT-MODEL.md` §2.2), so the readable copies are the local ones.

**Must be said plainly:** like "delete for everyone", this is a request other
Nexo clients honour, not a guarantee against a modified client. The existing
retract dialog already words this correctly and the same wording should be
reused.

**Effort:** medium. **Risk:** low.

### 10. Quoting part of a message

Telegram's Replies 2.0 lets you drag-select inside a message and quote only
that, and tapping the quote jumps back to where it came from.

**Fits because** replies and quotes already exist; the increment is a text
range on the reply rather than the whole message. Entirely client-side.

**Effort:** medium. **Risk:** low. The stored range has to survive the original
being edited — falling back to the whole message is the honest answer.

### 11. Text formatting

Bold, italic, strikethrough, monospace, code blocks, blockquote, and spoilers
(hidden text you tap to reveal). Telegram added quote formatting and spoilers
and both are widely used.

**Fits because** it is text. No fetching, no remote fonts — the bundled faces
already include a monospace.

**Watch:** rendering must build elements, never inject markup. A formatter that
takes a shortcut to `innerHTML` is a hole in an app whose whole point is that
message content is hostile until proven otherwise.

**Effort:** medium. **Risk:** low if rendered structurally, high if not.

### 12. Small conveniences worth grouping

- **Per-conversation notification detail.** Mute exists; Telegram also lets a
  chat differ from the global rule. The global toast-privacy setting already
  models the idea.
- **Send without sound.** One checkbox, and the notification path already
  distinguishes what a toast may say.
- **Recent and frequently-used emoji** in the picker, which currently opens on
  the full set every time.
- **Per-conversation accent.** Telegram's chat wallpapers, but in Nexo's terms:
  the accent hue is already a token, so a per-conversation override is a token
  swap rather than an image.

**Effort:** each small. **Risk:** low.

---

## Deliberately not

Written down so nobody has to re-derive it.

| Feature | Why not |
|---|---|
| Bots and mini-apps | Remote code in the client. Rule 3. |
| GIF search, third-party sticker packs | A request to a stranger's server. `THREAT-MODEL.md` §2.3 settled this once; stickers are drawn in the repo for this reason. |
| Message translation, voice-to-text | Sends message content to a third party. Rule 4 in spirit and rule 3 in fact. |
| Cloud chat history, multi-device sync | The server cannot read messages, and there is one device per account. Both would be designs, not features. |
| Channels at 200k, topics, slow mode, anti-spam | The public feed already covers broadcasting, and Nexo's groups are small. Teams take one thing from this family — owner, admin and member — and nothing else; see *Group scale* above. |
| Link-preview images | `img-src` names no remote host on purpose, and previews are opt-in already. |
| Premium cosmetics — name colours, custom emoji packs | No monetisation, and the payload ships in the binary. |
| Phone-number contact discovery | Nexo collects no phone numbers and says so. |
| Last seen / online presence | A standing broadcast of when somebody is at their machine. Typing is already behind the `presence` preference; this would be a threat-model decision before a product one. |

---

## Where I would start

Items 2, 5 and 7 — in-conversation search, keyboard shortcuts, the unread line
— are small, entirely local, and each removes a daily annoyance. Item 2 in
particular is mostly already written. Item 1 and item 3, the self-conversation
and forwarding, are the two that people would actually name if asked what was
missing.

Nothing here needs a change to the protocol, the server, or the crypto.

---

## Sources

Telegram's own writing, for what the features do:

- [Saved Messages 2.0, One-Time Voice Messages and 8 More Features](https://telegram.org/blog/new-saved-messages-and-9-more)
- [Scheduled Messages, Reminders, Custom Cloud Themes and More Privacy](https://telegram.org/blog/scheduled-reminders-themes)
- [Auto-Delete, Widgets and Expiring Invite Links](https://telegram.org/blog/autodelete-inv2)
- [No-SIM Signup, Auto-Delete All Chats, Topics 2.0 and More](https://telegram.org/blog/ultimate-privacy-topics-2-0)
- [Replies 2.0, Adjustable Link Previews, Name Colors and More](https://telegram.org/blog/reply-revolution)

For what people say they value:

- [5 overlooked Telegram features you should be using](https://www.androidpolice.com/2020/07/17/5-overlooked-telegram-features-you-should-be-using/)
- [Telegram Messenger reviews](https://www.producthunt.com/products/telegram-messenger/reviews)
- [Telegram reviews on Capterra](https://www.capterra.com/p/180347/Telegram/reviews/)
- [Telegram vs WhatsApp: Why Millions Are Switching](https://blog.invitemember.com/telegram-vs-whatsapp-why-millions-are-switching/)
- [Signal vs. Telegram: Which Chat App Is Better?](https://www.expressvpn.com/blog/signal-vs-telegram-which-messaging-app-is-better/)

For the desktop habits:

- [Telegram Desktop Keyboard Shortcuts](https://winaero.com/telegram-desktop-keyboard-shortcuts/)
- [Keyboard shortcuts for Telegram Desktop](https://usethekeyboard.com/telegram/)
