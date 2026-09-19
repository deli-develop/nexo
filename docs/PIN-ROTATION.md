# TLS key pinning — the decision, and the rotation plan if it ever ships

Plan risk 2 scheduled this document for M9. It records a **decision not to
pin in v0.1**, and the design that any future pinning must follow, so the
next person tempted to "just pin the cert" meets the failure mode before the
config option.

## The decision: v0.1 does not pin

The client validates `api.delidev.net` with normal WebPKI
plus TLS 1.3 — the platform trust store, no custom verifier.

Reasons, in order:

1. **The bricking failure mode is real and one-directional.** Let's Encrypt
   issues a fresh key on every renewal unless the ACME client is told to
   reuse one, and Caddy rotates by default. A pinned client meeting a rotated
   key fails closed and cannot be fixed remotely: the update channel it would
   need is behind the same pin. That is a fleet-wide brick with no recovery
   but reinstalling.
2. **The updater already has an application-layer pin.** Update manifests are
   minisign-signed and verified against the key in `tauri.conf.json`
   (`docs/RELEASING.md`). A network attacker who defeats TLS still cannot
   feed the app a build — which is the highest-value thing pinning would have
   protected.
3. **What TLS pinning would add** is protection of the *API* traffic against
   an attacker holding a mis-issued certificate for `delidev.net` — a CA-level
   compromise. Against that adversary, message content is already E2EE, and
   what is exposed is metadata and the public feed. Real, but not worth a
   self-bricking mechanism in a v0.1 with no staged rollout to catch it.

## If pinning ever ships, all of this is mandatory

Shipping any part without the rest recreates the brick:

- **Pin the SPKI, not the certificate**, and pin **two**: the live key and an
  offline backup generated at the same time and stored with the updater's
  private key. Rotation is then: deploy the backup, generate a new backup,
  ship the new pin set in the next release, and only afterwards retire the
  old key.
- **Caddy must be told to reuse the key** (`key_type`/reuse configuration for
  the ACME client) — the pin is on the keypair, so renewal must stop rotating
  it.
- **A hard expiry on the pin itself**: after a fixed date the client falls
  back to WebPKI validation and warns loudly. A degraded client beats a dead
  one, and the expiry bounds the damage of every mistake above.
- **Staged rollout with the updater proven first.** The update channel is the
  only remote fix for a bad pin; it must demonstrably work before any build
  that pins is shipped wide.

Revisit alongside the first release that has update telemetry — before that,
there is no way to know a pin rollout is going wrong until the support inbox
says so.
