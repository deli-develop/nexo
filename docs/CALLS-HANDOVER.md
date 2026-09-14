# Calls — where this stands, and what is left

**Written 2026-09-08. Delete this file when the list at the bottom is empty** —
a handover note that outlives its handover becomes another thing to disbelieve.
Everything durable here belongs in [`OPS.md`](OPS.md), [`STATUS.md`](STATUS.md)
or [`CONTEXT.md`](CONTEXT.md); this is only the part that is still in motion.

---

## What is built and committed

Six waves, all through `.\scripts\check.ps1` green:

| Wave | What | Commit |
|---|---|---|
| 1 | Signalling on the encrypted wire — `Payload::Call`, `send_call_signal`, three IPC commands | `eba587a` |
| 2 | TURN relay credentials — `GET /v1/calls/ice`, coturn REST scheme | `38c0d29` |
| 3 | Audio calls — state machine, ring/answer/decline, prompt ringing, auto-lock inhibit | `38c0d29` |
| 4 | Video — camera, H.264 preference, bitrate cap, device-loss handling | `5f84755` |
| 5 | Honesty pass — privacy table, the locked-socket fix, the block-stops-ringing test | `bcd8032` |
| 6 | WebView2 permission handler — the workspace's second `unsafe` | `bcd8032` / `6eb7464` |

The design decisions are recorded in `STATUS.md` under each wave, and the traps
in `CONTEXT.md`'s *Conventions*. Do not re-derive them.

---

## Uncommitted right now

Nothing. The startup log line that used to claim *"TURN relay configured; calls
are available"* — believed, and wrong, because the server reads two environment
variables and never contacts the relay — went in with `c7e0884`. It now says
only what it checked.

---

## The production relay, as configured

Facts worth not rediscovering:

| | |
|---|---|
| API + Caddy | `188.245.162.230` (`api.dice.fit`, `updates.dice.fit`) |
| coturn | `91.98.107.6` — a Hetzner **floating IP** (`turn.dice.fit`) |
| coturn ports | `443` TLS, `3478` plain, relay range `49152–65535/udp` |
| Certificate | certbot, **not** Caddy — `/etc/letsencrypt/live/turn.dice.fit/`, deployed to `/etc/coturn/tls/` by a renewal hook |
| Verified working | **TURN over TLS on 443**, from an Iranian ISP path, 2026-09-08 |
| Verified *not* working | plain UDP `3478` from that same network — the ISP drops UDP to a foreign VPS |

### Five things that blocked this, all silent

None is guessable, and only the first is in `OPS.md` today:

1. Hetzner firewall needs `3478/udp`, `3478/tcp` and **`49152-65535/udp`**. The
   last one is the one that produces a call which connects and carries no sound.
2. **Caddy binds `0.0.0.0:443`** and therefore squats the floating IP too. Every
   site block needs `bind 188.245.162.230`, and the `turn.dice.fit` block has to
   be removed from the Caddyfile entirely.
3. **`certbot --standalone` binds the wildcard**, so it collides with Caddy on
   port 80 even when Caddy is confined to the other address. It needs
   `--http-01-address 91.98.107.6`.
4. `external-ip` must be the **floating** IP. Left at the old one, media is
   advertised at an address coturn is not listening on.
5. **coturn runs as `turnserver` and cannot bind port 443** without
   `CAP_NET_BIND_SERVICE`. Debian's unit does not grant it, and the failure
   presents as a service stuck in `activating (start)` rather than an error.
   The override lives at
   `/etc/systemd/system/coturn.service.d/override.conf`.

---

## What is left, in order

### 1. Confirm the client is told to use TLS first

`/etc/nexo/nexo.env` must have `turns:` **before** `turn:`, so ICE tries the
path that works before the one the ISP drops. All three lines belong there
together — `NEXO_TURN_SECRET` included, even when only the URLs are being
edited:

```sh
NEXO_TURN_SECRET=the secret from /etc/turnserver.conf, byte-identical
NEXO_TURN_URLS=turns:turn.dice.fit:443?transport=tcp,turn:turn.dice.fit:3478?transport=udp
NEXO_STUN_URLS=stun:turn.dice.fit:3478
```

`NEXO_TURN_SECRET` and `NEXO_TURN_URLS` are all-or-nothing: with one of the two
set, `TurnConfig::from_env` bails and **the service does not start at all** —
not "calls are off", but every route gone and Caddy answering 502. That is
deliberate (`apps/server/src/calls.rs`), and it is worth knowing before editing
this file with the API live.

`sudo systemctl restart nexo-server` after, then `curl -fsS
https://api.dice.fit/v1/health` before walking away. This was not verified as
live.

### 2. Place a real call, end to end

**Nothing above proves a call works.** What is proven is that signalling
travels, that the relay answers STUN over TLS, and that the media pipeline
works in isolation. Two machines on the current build, one call, both
directions. Until that is done, calls are unverified.

Both ends need a build that knows `Payload::Call` — an older one draws the
offer as an unreadable bubble instead of ringing.

### 3. Rotate the TURN shared secret

The current value was pasted into a chat transcript on 2026-09-08. It only
authorises relay use — bandwidth, not messages — but it should not stand.

```sh
openssl rand -hex 32
```

Into **both** `static-auth-secret` (`/etc/turnserver.conf`) and
`NEXO_TURN_SECRET` (`/etc/nexo/nexo.env`), byte-identical, then restart coturn
and nexo-server.

### 4. Write `OPS.md` Pass 3 — TURN over TLS on 443

The five traps above, as a runbook section: floating IP and netplan, the Caddy
`bind`, certbot's `--http-01-address`, the certbot renewal hook, and the
systemd capability override. Phase 8b currently stops at plain TURN and Pass 2
assumes Caddy keeps the certificate — which is no longer how this is deployed.

### 5. Write the missing "getting the code onto the server" section

`OPS.md` documents the Hetzner SSH key in Phase 1 and then never says how the
source reaches the box. `deploy-server.sh` says *"run from a clone"* and there
is no clone step. What is deployed today: a **read-only deploy key**
(`nexo-hetzner-deploy`, key id `162545376`), `~/.ssh/config` pinning it with
`IdentitiesOnly yes`, and an SSH remote. Note that `deli-develop` had
`deploy_keys_enabled_for_repositories` disabled org-wide and it had to be
turned on.

---

## Deliberately not built

Named so nobody treats them as oversights:

- **Group calls.** Mesh stops scaling almost immediately, and an SFU cannot
  read the media without breaking rule 4.
- **Screen sharing.** `getDisplayMedia` is available; nothing uses it.
- **Call notifications while the window is unfocused.** A call rings in-app
  only.
- **Ringing while locked.** Locking drops the keys that would read the
  invitation, so a call arrives as a missed call. Said plainly in the Settings
  lock text.
- **ICE restart / renegotiation.** Candidates are bundled once per call, so the
  camera toggle disables a track rather than reopening the device.

## One known local wart

A microphone grant made by a build older than wave 6 survives in
`%LOCALAPPDATA%\fit.dice.nexo\EBWebView` and bypasses the new permission gate
on that machine until the profile is cleared. New installs are unaffected —
`SetSavesInProfile(false)` stops it recurring.
