# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Tauri wraps the same page for Windows, and Android is planned — but the design
language is the web's, not any OS's, and one page serves all three. See
[`docs/REWORK.md`](docs/REWORK.md).

## Users

Three audiences, all confirmed, and the design has to hold all three at once:

- **Friends and small circles.** People who already know each other. A handful
  of contacts, group chats, everyday back-and-forth. Phone in hand most of the
  time, desktop while working.
- **Privacy-first users under real risk.** People who chose an encrypted
  messenger deliberately and would be harmed by a leak. For them the interface
  has to be legible about what is protected and must never reassure beyond what
  is true.
- **A community around shared interest.** People who find each other through
  the public feed and profiles, then talk privately.

The third is why the product has a public half at all, and the second is why
that half must never be mistaken for the private one.

## Product Purpose

An end-to-end encrypted messenger with a public feed and public profiles beside
private conversations. Private messages are E2EE with MLS (RFC 9420); the
server stores and forwards ciphertext it cannot read. Feed posts and profiles
are **not** encrypted and are public to any signed-in user.

Success is that somebody can tell, without reading documentation, which half of
the product they are in.

## Positioning

Two things a neighbouring product could not truthfully copy:

- **MLS rather than a bespoke scheme**, with the group state on the device and
  the server holding opaque envelopes it has no key for.
- **A public surface that says it is public**, in the place where you write
  rather than in a settings page. Most products with both halves blur them;
  this one is built to keep them apart.

## Operating Context

- **Windows desktop** through a Tauri shell, often a resized window rather than
  full screen, beside other work.
- **A phone browser**, one-handed, in short bursts.
- **A signed-in web app** at `nexo.delidev.net`; the API is `api.delidev.net`.
- Four destinations and no deep links: Home (the public feed), Messages,
  Profile, Settings.

## Capabilities and Constraints

Confirmed and shipping: registration and sign-in, 1:1 and group conversations,
attachments, voice messages, view-once media, reactions, replies, edits,
retraction, folders, drafts, conversation search, the public feed with posts,
comments, votes and reactions, public profiles with per-field visibility, the
follow graph, blocking in both directions, reporting, invitations past a
private account's gate, 24-hour stories, a live WebSocket, an offline outbox,
and an auto-lock with a PIN.

Deliberately absent: Meet&Greet (a map of strangers) and voice/video calls,
both built and then removed — see [`docs/REWORK.md`](docs/REWORK.md).

Technical constraints that bind the interface:

- **A strict CSP.** Nothing is fetched at runtime: no CDN, no remote fonts, no
  remote images beyond the app's own object storage. Every asset ships in the
  bundle.
- **Design values live in tokens**, authored in
  `packages/design-tokens/tokens.css`. A hex code in a component is a bug.
- **Both themes ship.** Settings offers System, Light and Dark.

## Brand Commitments

- The name is **Nexo**. The mark is drawn as paths, not set in type
  (`components/ui/BrandMark.tsx`).
- Icons are hand-drawn SVG in one stroke weight (`components/ui/Icon.tsx`).
  No icon font, no emoji standing in for an icon.
- **Binding visual references, given by the user:** reference 2 (the Messenger
  desktop) for the desktop shape and palette; references 3 and 4 (the iOS chat
  explorations) for the phone's proportions and forms — **rendered dark, not
  light**, which is the one place those references are explicitly overruled.

## Evidence on Hand

Real, in the repository: the working app, `docs/BRIEF.md` (the original
specification), `docs/THREAT-MODEL.md` (what is and is not protected),
`docs/STATUS.md` (what actually works, walked against the code).

**No fabrications.** There are no users yet beyond the two contributors, no
testimonials, no usage numbers, no press, no customers. Nothing in the
interface may imply otherwise.

## Product Principles

1. **The public half must look public.** Feed and profile surfaces say so
   where somebody writes, not in a footnote. A redesign that makes the feed
   feel as private as a chat breaks the product's central claim.
2. **Never overclaim the encryption.** No "military grade", no "unhackable",
   no padlock implying more than MLS gives. A message that cannot be decrypted
   says so rather than being hidden.
3. **Fail visibly, not silently.** Rule 7 of the brief: there is no plaintext
   fallback and no quiet skip.
4. **One product across three screens.** The same page serves phone, desktop
   and web. Proportions change; identity, vocabulary and information
   architecture do not.
5. **Quiet by default, colour where it means something.** The interface is one
   grey scale plus an accent; semantic colour appears where a status is being
   reported, and content keeps its own colour.

## Accessibility & Inclusion

Confirmed binding by the user:

- Every control reachable by keyboard, with a visible focus ring. Shortcuts
  live in one listener (`app/useShortcuts.ts`).
- Screen-reader labels on every control; `aria-current` on the active
  destination.
- Both themes must meet contrast on body and placeholder text.

Currently real but **unaudited** — no formal pass has been run, and that
absence is a fact rather than a claim.
