# Nexo

A private messenger for Windows, with a public side to it.

Nexo keeps two things apart that most apps blur together. Your conversations are
private — encrypted on your machine, and unreadable to the server that carries
them. Your feed, your profile and your pin on the map are public — meant to be
seen, and clearly labelled as such. Nothing is described as more protected than
it is.

## Who it is for

- **People who want a real conversation to stay private** without adopting a
  security ritual to get it. Encryption is on for every message; there is no
  switch to forget and no "secret chat" mode to remember to start.
- **People who dislike handing over a phone number to be reachable.** An account
  is a handle and a password. No SMS, no address book upload, no contact list
  scraped off the device.
- **People who want somewhere public as well.** A feed, a profile, stories and a
  map — the sociable half of a messenger — without those living in a different
  app that watches you differently.
- **People who care where the line is.** What the operator can see is written
  down plainly below and in the threat model, rather than being left for you to
  infer.

## What you get

**Private conversations.** One-to-one and group, encrypted end to end. Photos,
video, sound and files go the same way, and play inside the conversation.
Reactions, replies, pinned messages, editing, and taking a message back on both
sides. Search runs across your whole history and never leaves your machine.

**A public side, honestly labelled.** A feed of posts, a profile people can
visit, and stories that disappear after 24 hours. These are visible to other
signed-in people — and the app says so where you write them, not in a footnote.

**Control over who reaches you.** An account can be private — absent from
search, and reachable only by somebody you already share a conversation with or
who holds an invitation you issued. Both halves are enforced on the server, so
neither is a promise the app merely makes. Blocking works in both directions and
takes the stories with it. Reporting exists.

**A lock that actually locks.** Leave the app idle and the session ends, not just
the view. A short PIN gets you back in, tied to your Windows sign-in, with the
password always available as the way back.

**An app you can set to your taste.** Light, dark, or whatever Windows is doing
at sunset. An accent hue that stays legible whichever you pick, adjustable
contrast and blur, and a genuinely translucent window when you want one.

**Nothing phoning home.** No analytics, no ads, no tracking, and no content
loaded from anyone else's server at runtime. Link previews, which would mean
fetching from a stranger's site, are off unless you turn them on.

## What it does not protect

Being clear about this is part of the design.

- **Feed posts, profiles and their media are not end-to-end encrypted.** They are
  readable by the server and visible to any signed-in person. Something written
  to be read by strangers cannot also be sealed to a closed group.
- **Conversation metadata is visible to the server** — who talks to whom, when,
  and roughly how much. The contents are not, but the pattern is.
- **A device someone else controls is not covered.** Encryption protects messages
  in transit and at rest; it cannot help once somebody is inside your Windows
  session with the app unlocked.

[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) is the long version: who this is
meant to withstand, who it is not, and where each limit comes from.

## Security

- The encryption is **MLS** ([RFC 9420](https://www.rfc-editor.org/rfc/rfc9420.html)),
  the IETF's standard for group messaging, through the audited OpenMLS
  implementation. No cryptography is invented here.
- The server stores and forwards ciphertext it cannot read.
- Your local history is stored encrypted on your own disk.
- A message that cannot be decrypted is shown as exactly that. There is no
  fallback that quietly displays something readable instead.
- Nothing is downloaded and run at startup: no plugins, no remote code, no CDN.

## Where it stands

Nexo is early and openly so. [`docs/STATUS.md`](docs/STATUS.md) is written by
walking the code rather than the commit messages, and lists both what works and
what is known to be broken. It runs on Windows 10 (1809+) and Windows 11; an
Android version is planned, and the app is built so that it does not require
starting over.

## Building it yourself

Nexo is open source. [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) has the
prerequisites and the commands, and [`docs/CONTEXT.md`](docs/CONTEXT.md) is the
map of the repository for anyone intending to change something.

## Licence

MIT — the text in [`LICENSE`](LICENSE), unedited on purpose so that licence
scanners recognise it. Copyright is held under `delidev`, jointly by the two
people who write here; [`docs/LICENSING.md`](docs/LICENSING.md) is the precise
version, and [`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md) covers
what ships alongside the installer.
