# Relay: a user's device as a path past the block

A volunteer turns on *help others connect* in their Nexo app, and their
computer starts passing traffic between blocked users and the real server. It
is the same local proxy Nexo already carries, run in the other direction, in
the Rust shell. This document is the design: why it works, what it costs, and
what makes it work at all. It is a proposal, not a status line — nothing
described here is built yet. [`STATUS.md`](STATUS.md) does not list it.

The closest relatives are Tor's Snowflake and Psiphon's Conduit. Both do
exactly this: a fleet of ordinary home machines, each forwarding encrypted
bytes for strangers, so the path to a blocked service no longer ends at a
single address. What Nexo adds is that the forwarded traffic is already opaque
envelopes, so the relay never even sees a TLS record — only Nexo ciphertext.

---

## Why it works

The block is on a host. `api.delidev.net` and the two object-storage buckets
resolve to a handful of addresses, and those addresses live on a hosting
provider. That is what makes them blockable: few, stable, and recognisable as
datacentre IP space.

A home internet address is none of those things.

- **Many.** Every volunteer is a different address, and the set is large and
  open at both ends.
- **Changing.** Home IPs rotate on every reconnect, and the volunteer base
  turns over. There is no single address to keep on a blocklist, and a
  blocklist that grows with the volunteer base is the wrong shape for a
  network.
- **Not hosting-provider space.** It does not sit in the datacentre / ISP
  range that the throttling Nexo sees on Hetzner appears to target. Traffic
  through a residential connection is not the same traffic that gets shaped.

So the route to the real server stops ending at one blockable point. It ends
at *a* point, where *a* is a rotating set of home machines, and choosing which
one is a per-session decision the client makes.

That last point is the whole feature. The relay does not need to be fast or
reliable on average; it needs to exist, and to be discoverable, and to be
enough of a path for a blocked user to carry a conversation.

## What the relay sees

Nothing. The relay forwards Nexo envelopes — MLS-encrypted, opaque to
everything that is not an endpoint holding the group keys. It sees a byte
stream that starts at a blocked user's client and ends at the real server,
plus whatever the transport layer puts in the headers. It does not see
messages, tokens, group state, or which conversation is which. It is a pipe,
and a good one, because the payload has no structure it could leak.

This is also what makes it *safe for the person* running it. A volunteer does
not become a server that can be read, because there is nothing to read. The
risk that remains is not content exposure; it is the fact of being observed
forwarding Nexo traffic, and of being inside the jurisdiction that is doing
the blocking. The design below spends its effort on those two.

## How it is carried

Two jobs, and they are separate:

- **The byte pipe.** The desktop shell already speaks TLS and can open
  outbound connections on a port. Run the same local proxy in the other
  direction — listen, accept, forward — and the shell is the relay. No new
  transport, no new dependency; a listener where a dialer used to be.
- **Reaching an address behind a NAT.** This is the hard part, and it is why
  Snowflake and Psiphon both exist. A home router does not accept incoming
  connections. The relay cannot simply say *I am on port 41731*; the blocked
  user has no route to it. So the relay has to advertise a path the user can
  reach, using a technique that does not require the router to open a hole.

The pipe is cheap. The path is the engineering.

## The hard parts

These are the three that decide whether the thing works at all.

### 1. Finding a relay

A blocked user has to learn a relay's address, through a channel they can
still reach. There are two ways, and a working deployment will use both.

- **A lookup service the user can still reach.** A small list of current relay
  addresses, published somewhere that is not itself blocked. It can be a host
  the censors have not (yet) marked, a record on a domain they are unlikely to
  sink, or a feed the client polls. The list has to be cheap to update and
  tolerant of a relay dropping off, because the set is rotating by design.
- **Links shared through people.** A relay address, or a short-lived token
  that resolves to one, passed by hand: a friend, a Telegram channel, a
  sticker. It is the least centralised option and the one that survives a
  censored lookup service, at the cost of somebody having to say it.

The failure mode to avoid is a single well-known host that becomes the new
blockable point. The list is a convenience, not a dependency: it can go down
and the feature keeps working, because the addresses were already out there
being shared.

### 2. Home routers

Most home routers do not accept incoming connections. A relay behind one has
to make itself reachable without the router's cooperation, and without a
public IP the household can hand out.

The standard answers, all used by Snowflake-family tools:

- **Outbound-only forwarding.** The relay never needs an inbound hole if the
  user's connection is initiated by the relay, or if the relay holds the
  longer-lived leg. The blocked user connects *to* a relay that has already
  opened the pipe, so no inbound port is ever required on the user's side.
- **A reachable front.** Where an address the user can dial is needed, it is
  either a relay that happens to have one (a box not behind a symmetric
  NAT), or a small forwarding hop that exists to hand the user the relay's
  actual path. The front is deliberately thin and disposable, because it is
  the one point that *is* a fixed address and therefore the one that gets
  blocked first.

The honest constraint: a relay on a symmetric NAT with no inbound path is the
weakest volunteer, and the system has to work with mostly-them. Which means
the protocol has to prefer the outbound-only shape, and treat a dialable
address as a bonus, not a requirement.

### 3. Relay location

Volunteers should be **outside** the blocking jurisdiction. A relay run
inside the country doing the blocking puts the volunteer in legal risk — the
forwarding act is visible even if the content is not, and "I was running Nexo"
is a statement a hostile state reads as an accusation.

This is not a technical requirement; the relay does not need a foreign IP to
move bytes. It is a *people* requirement, and it shapes two things:

- **Who is asked to volunteer.** The UI should say it plainly — *this helps
  people who cannot reach Nexo; if you are in the blocking country, expect
  this to be noticeable* — so the decision is made with the risk visible.
- **Where the volunteer base is expected to be.** The design optimises for a
  diaspora and sympathetic non-residents, not for citizens of the blocking
  state. A relay inside the country is allowed, but it is a volunteer's
  explicit choice, and the documentation does not hide the cost.

---

## What it does not change

The relay is a route, not a new system. It does not touch MLS, the store, the
envelope format, or the invariants in [`CONTEXT.md`](CONTEXT.md#invariants):
the server still never reads message contents, and the relay is a better
version of the server's position, not a replacement. Rule 4 holds on the
volunteer's machine as it holds on the hosting box — the only bytes present
are ciphertext.

What it does change is the assumption that *the only path to the server is the
server's own address*. That assumption is what a block exploits, and a relay
fleet is the answer to it.

## Open questions

The ones that need a decision before this stops being a design:

- **The lookup host.** Where is the relay list published, and who rotates it?
  The choice determines the next thing that gets blocked.
- **The NAT shape of the volunteer base.** How many real home relays will
  actually be on outbound-only (weakest) addresses versus dialable ones? The
  protocol's default has to match the answer.
- **Relay lifetime and trust.** A relay is disposable by design, so a single
  long-lived one is an anomaly worth flagging. What does "enough" look like,
  and how does a blocked user know they are getting a working path rather
  than a dead one?
- **The volunteer's bandwidth and battery.** A desktop relay is fine; a laptop
  that is left on for a week is a different machine. The *help others
  connect* toggle needs a cost model before it is safe to default on.

The first three are design questions. The fourth is a product one, and it is
the one most likely to make a volunteer turn the feature off again.
