---
version: 1
slug: "apps-desktop-src"
primary_target: "apps/desktop/src"
related_targets: []
---

Scope: the whole signed-in app — Home, Messages, Profile, Settings — on phone
and desktop. Visitor mode: **Operate**.

Audience: friends and small circles, privacy-first users under real risk, and a
community around shared interest. Job: read and answer messages quickly, and
tell at a glance which half of the product they are in.

Constraints: the public half must look public; never overclaim the encryption;
both themes ship; keyboard and screen-reader support. Design values live in
`packages/design-tokens/tokens.css` — a hex code in a component is a bug.

## Direction contract

THESIS: A messenger whose two halves are visibly different materials — private
conversation is a lit surface, the public feed is a flat one. Refuses the
category default of one uniform card grid where a DM and a public post look
identical.

OWN-WORLD: Deep navy-black ground (not neutral graphite — the blue is in the
ground itself), panels divided by 1px hairline seams and never by shadow. One
blue accent, reserved for state: active destination, own bubble, unread. Rows
are one type size — rank carried by weight, case and colour, never by a size
ladder. Avatars are large and fully round; controls are pill-shaped.

STORY: Somebody opens the app, sees who has written, answers, and never once
wonders whether what they are typing is public.

FIRST VIEWPORT: Phone — search pill at top, story row of labelled circles
under it, then conversation rows at one size; bottom tab bar. Desktop — 64px
rail, then a 300px list whose head is that same search pill, then the
conversation filling the rest; primary action is the composer, bottom right.

FORM: Reference 2's world (Messenger desktop) at candidate 6 of the grounded
list; user-pinned, so the pin overrides the roll's assignment. Seed key
8341d9bd.

RAISED, from declined challengers:
- From the dark-first developer console: hairline seams rather than shadow,
  accent for state only, and destructive actions given deliberate isolation.
- From the pocket airline timetable: one type size per row, rank carried by
  weight, case and reversal instead of size.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
