# Tutorial — everything you personally have to supply

Every value Nexo needs that is *not* in the repository: what it is, where it
goes, and when it actually blocks you. This file is the list of things only you
can fill in; [`DEPLOY.md`](DEPLOY.md) is the step-by-step that uses them, and
[`OPS.md`](OPS.md) is the reasoning behind it.

Read the status column before you go shopping.

| Symbol | Meaning |
|---|---|
| ✅ | Read by code that exists today. Enter it and it works. |
| ○ | Not read by any code yet. The name is fixed here so that when the milestone lands, the value you already generated is the one it looks for. |

---

## 0. The short answer

**To run the desktop client as it stands today: nothing.** No account, no
domain, no key. `pnpm install && pnpm tauri dev` is the whole story.

**The API server needs one thing: a local Postgres.** `pnpm dev:server` connects
at startup and applies its migrations, so it will not start without a reachable
`DATABASE_URL`. §3.1 has both ways to get one, and neither takes more than a
minute. The client does not talk to the server yet — that is M4.

Everything below is a *lead time* list. The items with real clocks on them are
the code-signing certificate (weeks) and the domain nameserver change (hours to
a day). Start those early; the rest is an afternoon each.

---

## 1. Master list

### Free, or already yours

| # | Value | Where it goes | Needed by |
|---|---|---|---|
| 1 | SSH keypair (`ed25519`) | public half → Hetzner console; private half stays on your machine | M4 |
| 2 | Postgres role password | `.env` locally, `/etc/nexo/nexo.env` on the server | M2 (local), M4 (server) |
| 3 | JWT signing keypair (EdDSA) | `.env` locally, `/etc/nexo/nexo.env` on the server | **M2 — required today** |
| 4 | Tauri updater minisign keypair | private half → GitHub Actions secret; public half → `tauri.conf.json` | M9 |

### Costs money

| # | Value | Roughly | Needed by |
|---|---|---|---|
| 5 | Hetzner Cloud account + CAX21 server | €8–11/month | M4 |
| 6 | *(was: control of `dice.fit`)* — folded into row 10. One domain now, not two. | — | — |
| 7 | Hetzner Object Storage, 2 buckets + 2 credential pairs | from ~€5/month | M6 |
| 8 | Hetzner Storage Box (backups) | from ~€3.20/month | M4, in practice |
| 9 | Authenticode code-signing certificate, ideally **EV** | €200–600/year, days-to-weeks lead | M9 |
| 10 | Control of `delidev.net`: an `A`/`AAAA` for `api` at the server, and a CNAME for `nexo` at Netlify | domain price | M4, and the web client |
| 11 | A Netlify account with this repository connected | free tier is enough to start | the web client |

Nothing here is a third-party API key: no SMS provider, no push service, no
analytics, no mail provider. **One qualification since the web client exists:**
`nexo-web` is served by Netlify's CDN, because a website has no other shape.
That is a hosting account, not an API key, and no credential for it is ever
compiled into a client — but it does mean the web client's users trust that
CDN on every page load, which its own `docs/WEB-THREAT-MODEL.md` §3 states
plainly. The desktop app remains free of any CDN. That is deliberate — see
[`docs/PLAN.md`](PLAN.md) ("no phone, no SMS") and the README's Security
section. If a guide anywhere tells you to paste an API key into this project, it
is not describing Nexo.

---

## 2. Right now, on your machine

The client needs nothing entered:

```powershell
pnpm install
pnpm tauri dev
```

The server needs a database and a `.env` (§3.1 creates the database):

```powershell
docker compose up -d
Copy-Item .env.example .env
openssl genpkey -algorithm ed25519 -out jwt-ed25519.pem   # once
pnpm dev:server
# -> http://127.0.0.1:8080/v1/health  {"status":"ok","protocol_version":1}
```

The knobs that exist today:

| Variable | Status | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | ✅ | none — **required** | Postgres connection string — `apps/server/src/db.rs`. No default on purpose: a server that boots without its database reports healthy while being unable to do its job. |
| `NEXO_BIND` | ✅ | `127.0.0.1:8080` | Address the API listens on. |
| `RUST_LOG` | ✅ | `nexo_server=info,tower_http=info` | Log filter. Never `debug` on a box holding real users; `debug` is compiled out of release builds anyway. |
| `NEXO_JWT_PRIVATE_KEY_PEM` | ✅ | none — **required** | Path to the Ed25519 PKCS#8 PEM that signs access tokens. `openssl genpkey -algorithm ed25519 -out jwt-ed25519.pem`. The server refuses to start without it: an auth system that invents a key per boot signs everyone out on every restart. |
| `NEXO_S3_*` | ✅ | unset | Object storage. Seven required, all or none — §7. |

The server reads a `.env` at the repo root, so these live in a file rather than
in your shell. `.env` is gitignored and must stay that way. There is no `.env`
on the server — systemd's `EnvironmentFile` supplies the real values (§5), so
the loader is a no-op there.

Also install **Strawberry Perl** —
`winget install StrawberryPerl.StrawberryPerl`, then open a fresh shell. It is
not a value you enter, but it is the item that stops an M2 build dead when
SQLCipher starts building a vendored OpenSSL (PLAN.md risk 3). It also ships a
`cmake`, which the AWS S3 SDK's `aws-lc-sys` needs.

---

## 3. Database

### 3.1 Locally

M2 and M3 run entirely against a local Postgres; provisioning Hetzner early buys
familiarity, not progress. Either route below gives you one.

**Docker, if you have it.** Nothing to install, nothing to remember, and it
cannot collide with a native install because it takes a different port:

```powershell
docker compose up -d
```

The role, the database and the ownership all come from `docker-compose.yml`, so
there is nothing further to run. `docker compose stop` / `start` between
sessions; the named volume keeps the data.

**Or a native install.** Postgres 17 for Windows, then:

```powershell
psql -U postgres -c "CREATE ROLE nexo LOGIN PASSWORD 'a-local-dev-password';"
psql -U postgres -c "CREATE DATABASE nexo OWNER nexo;"
```

`nexo` must *own* the database, not merely have access to it: `citext` is a
trusted extension, so the owner can create it without superuser, which is what
lets the first migration apply it instead of you.

The installer does not put `psql` on `PATH`. It is at
`C:\Program Files\PostgreSQL\17\bin\psql.exe`.

> **Port 5433, not 5432.** `docker-compose.yml` publishes there deliberately. A
> native Windows Postgres holds `127.0.0.1:5432` and `::1:5432`, and Docker
> publishing the same port binds only the IPv6 wildcard — so `localhost` still
> reaches the native server and you get an authentication failure against a
> database you did not mean to contact. Worse, if that server runs a non-English
> locale, sqlx cannot even decode the error text and reports *"Postgres returned
> a non-UTF-8 string for its error message"*, which points nowhere near the
> cause.

The value you enter:

| Variable | Status | Example |
|---|---|---|
| `DATABASE_URL` | ✅ | `postgres://nexo:nexo_dev@127.0.0.1:5433/nexo` — **127.0.0.1, not `localhost`**; see `docker-compose.yml` |

A throwaway password is fine here and only here. This one never leaves your
machine, and it is not the one you put on the server.

**Compiling does not need a database; running does.** `sqlx` checks its queries
at compile time against the committed `.sqlx/` cache, not a live server, because
`.cargo/config.toml` sets `SQLX_OFFLINE=true` for every build. So `cargo build`,
`cargo test` and CI all work with no database anywhere. The connection is made
at startup instead, and that is where a missing or wrong `DATABASE_URL` shows
up.

After changing or adding a `sqlx::query!`, regenerate the cache:

```powershell
$env:SQLX_OFFLINE = "false"
cargo sqlx prepare --workspace -- --all-targets
Remove-Item Env:\SQLX_OFFLINE
```

`-- --all-targets` is not optional. Without it, queries inside `#[cfg(test)]`
modules are never compiled, `prepare` reports "no queries found", and writes an
empty cache that fails on the next real build.

### 3.2 On the server (M4)

Generate a real password — do not invent one:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

or, on the box: `openssl rand -base64 32`

Then follow [`docs/OPS.md`](OPS.md) Phase 4. Two rules that are not negotiable:

- Postgres listens on **localhost only**. Port 5432 never appears in the Hetzner
  firewall. Verify with `sudo ss -lntp | grep 5432` — loopback addresses only.
- The password lives in `/etc/nexo/nexo.env`, `chmod 600`, root-owned, and
  nowhere else. Not in the repo, not in a shell history you keep, not in CI.

---

## 4. Hetzner

Work through [`docs/OPS.md`](OPS.md) in order. The decisions and values it asks
*you* for, extracted:

**Phase 0 — decide before clicking anything**

- Do you control `delidev.net`? You do not need to transfer it to Hetzner:
  point its nameservers at Hetzner DNS and leave the registration where it is.
  `dice.fit` is no longer used by anything — see `OPS.md` Phase 0.1 for what
  happened to the two hosts that lived on it.
- Disk encryption: option **A** (none, boots unattended) or **B** (LUKS +
  dropbear, where every reboot waits for you at an SSH prompt). Record the
  choice in [`docs/THREAT-MODEL.md`](THREAT-MODEL.md) either way — it currently
  says the decision is open. Do not pick C casually.

**Phase 1 — account**

- Email and a payment method.
- Two-factor authentication, the same minute you create the account. This login
  will shortly control the server, the object storage and the backups.
- Project name: `nexo`. Note the **project id** from the console URL
  (`https://console.hetzner.com/projects/<id>/servers`) — §7 needs it.
- **SSH public key**, pasted into Security → SSH keys:

```powershell
ssh-keygen -t ed25519 -C "nexo-deploy"
type $env:USERPROFILE\.ssh\id_ed25519.pub   # paste this half only
```

**Phase 2 — the server.** Falkenstein · Ubuntu 24.04 · Arm64 **CAX21** · IPv4 +
IPv6 · name `nexo-api`. Firewall inbound: 22 (source-limited to your IP if it is
static), 80, 443 — plus 2222 if you chose LUKS option B. Keep the IPv4 address;
clients on arbitrary home and mobile networks cannot rely on IPv6-only
reachability.

**Phase 5 — DNS.** In Hetzner DNS: zone `delidev.net`, then at your registrar
change the nameservers to the ones Hetzner shows. One record pair — `A` to the
server's IPv4, `AAAA` to its IPv6:

```
api       A / AAAA    the API and the WebSocket
```

And one that does not point at this box at all:

```
nexo      CNAME       the Netlify site serving the app
```

Wait for propagation before you touch Caddy. Caddy asks Let's Encrypt for a
certificate on first start, and that request fails if the name does not yet
resolve to the box.

**Phase 6 — Caddy.** Nothing secret to enter: the hostnames in the Caddyfile are
the entire configuration, and certificates are obtained and renewed
automatically. Leave client-side certificate **pinning off** until M9 — PLAN.md
risk 2 spells out why a pinned client meeting a rotated key is a bricked install
with no remote fix.

---

## 5. The API server's environment file

`/etc/nexo/nexo.env`, `chmod 600`, owned by root, referenced by
`EnvironmentFile=` in the systemd unit ([`docs/OPS.md`](OPS.md) Phase 7).

```ini
# --- read by code today ---
NEXO_BIND=127.0.0.1:8080
RUST_LOG=nexo_server=info
DATABASE_URL=postgres://nexo:THE-GENERATED-PASSWORD@localhost/nexo

# --- M4: fill in when the milestone lands ---
REDIS_URL=redis://127.0.0.1:6379
NEXO_JWT_PRIVATE_KEY_PEM=/etc/nexo/jwt-ed25519.pem

# --- M6: one credential pair per bucket, never one shared pair ---
NEXO_S3_ENDPOINT=https://fsn1.your-objectstorage.com
NEXO_S3_REGION=fsn1
NEXO_S3_MEDIA_BUCKET=nexo-media
NEXO_S3_MEDIA_ACCESS_KEY=
NEXO_S3_MEDIA_SECRET_KEY=
NEXO_S3_ENC_BUCKET=nexo-enc
NEXO_S3_ENC_ACCESS_KEY=
NEXO_S3_ENC_SECRET_KEY=
```

`NEXO_BIND` stays on **loopback**. Caddy terminates TLS and proxies to
`127.0.0.1:8080`; the Rust process holds no certificate and must never be
reachable from outside the box.

The JWT keypair — access tokens are EdDSA, deliberately not HS256, so this is a
keypair and not a shared secret:

```bash
openssl genpkey -algorithm ed25519 -out /etc/nexo/jwt-ed25519.pem
chmod 600 /etc/nexo/jwt-ed25519.pem
chown nexo:nexo /etc/nexo/jwt-ed25519.pem
```

Rotating it signs everyone out. That is the correct emergency response to a
suspected server compromise, and it is also why you do not rotate it idly.

---

## 6. The client side

There is **no `.env` in the desktop app**, and there should not be one. A Tauri
client ships whatever you put in it, so an "environment variable" in a desktop
binary is just a string the user can read. Two things get entered instead:

**The base URL** lives in Rust, not in the WebView: `https://api.delidev.net`
and `wss://api.delidev.net/v1/stream`, compiled in, with a debug-only override
for pointing a dev build at your own machine.

**The CSP stays as narrow as it is.** Today
`apps/desktop/src-tauri/tauri.conf.json` says:

```
connect-src 'self' ipc: https://ipc.localhost
```

A `fetch` to `api.delidev.net` from the WebView is blocked by that, quietly. The
alternative the brief already chose is the better one: **all network I/O happens
in Rust**, the WebView only speaks IPC, and the CSP never widens. That also
removes CORS from the attachment path entirely (BRIEF §5.3) and keeps encryption
on the Rust side of the seam, where it belongs.

---

## 7. Object storage (M6)

Console → Object Storage, region FSN1, **two private buckets**: `nexo-media` and
`nexo-enc`. Values to enter: endpoint, both bucket names, two access-key/secret
pairs — into `.env` locally, `nexo.env` on the server. The block is commented
out in `.env.example`; uncomment it when you have the keys.

**All seven or none.** A partly filled block is a startup error rather than a
silent fallback to "not configured", because the silent version is discovered in
production. `NEXO_S3_REGION` is the exception: optional, defaults to `fsn1`, and
only feeds the signature.

Three settings that are not values, all handled in
`apps/server/src/storage.rs`, but each of which would otherwise cost you an
afternoon:

- **Path-style addressing.** On Hetzner the bucket name is not part of the
  hostname; every bucket in a region shares one domain.
- **SigV4, pinned explicitly** — which here means credentials passed in directly
  with *no* provider chain. The server never asks a cloud metadata service who
  it is, so an SSRF cannot become someone else's credentials.
- **Rust-side only.** Never presign into the WebView.

### Separate credentials are not enough

This is the part that surprises people, and it has already caught this project
once. **Hetzner S3 keys are project-wide by default**: every key can read and
write every bucket in the project. Generating one pair per bucket achieves
nothing on its own.

Restricting a key needs a **bucket policy**, applied over the S3 API — Hetzner
Console has no policy editor. [`docs/OPS.md`](OPS.md) Phase 8 has the exact
JSON, the ARN format (`arn:aws:iam:::user/p<project_id>:<access_key_id>` — note
the literal `p`, and the plain AWS form silently matches nobody), and the
commands.

Verify, always:

```powershell
cargo test -p nexo-server --test s3_smoke -- --ignored --nocapture
```

Four checks: both buckets reachable, a small object round-trips, a 20 MB object
round-trips, and **the media credentials are refused by the encrypted bucket**.
That last one is the only evidence the separation is real. Re-run it after any
key rotation — a new key is unrestricted, and the policy names the old one.

The test prints bucket names and byte counts. It never prints a key.

---

## 8. Release secrets (M9)

**Tauri updater keypair.** `pnpm tauri signer generate`. The private half goes
into a GitHub Actions secret and nowhere else — never in the repo, never echoed
into a workflow log. The public half goes into `tauri.conf.json` and ships. Lose
the private half and you cannot ship an update that installed clients accept.

**Authenticode certificate.** Buy this first, not last. Since June 2023 the key
must sit on FIPS 140-2 L2 hardware — a token or a cloud HSM — and EV needs a
validated legal entity, which takes days to weeks. An OV certificate still has
to accumulate SmartScreen reputation, so an OV-signed installer can warn on day
one. PLAN.md risk 1 says plainly that "installs without a SmartScreen block" may
not be achievable as written; if EV is not viable, rewrite the definition of
done rather than shipping something that quietly fails its own check.

---

## 9. What counts as a secret

Never commit, never paste into a chat, never let into a CI log:

- the SSH **private** key
- the Postgres password, and `nexo.env` / `.env` themselves
- `jwt-ed25519.pem`
- both S3 **secret** keys
- the Tauri minisign private key
- the code-signing certificate and its PIN

Safe to write down anywhere: hostnames, bucket names, the S3 endpoint, the
Hetzner project id, S3 access key **ids** (they appear in bucket policies by
design), the server's IP, `NEXO_BIND`, the Tauri **public** key.

`.gitignore` already covers `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`,
`keyring.bin` and `store.db*`. Keep new secrets inside those shapes rather than
inventing a filename the ignore list has never heard of.

---

## 10. Checklist

Today:

- [ ] `pnpm install`, and `pnpm tauri dev` opens the window
- [ ] `docker compose up -d`, `.env` present, `pnpm dev:server`, `/v1/ready`
      answers `{"status":"ready"}`
- [ ] Strawberry Perl installed (M2 blocker — do it now)
- [ ] Code-signing certificate purchase started (weeks of lead time)

Before M4:

- [ ] SSH keypair generated, public half in Hetzner
- [ ] Hetzner account with 2FA, project `nexo`, project id noted
- [ ] CAX21 in fsn1; firewall 22 / 80 / 443 only
- [ ] Disk-encryption decision recorded in `docs/THREAT-MODEL.md` — **before
      the server is built**, not after: there is no in-place path to an
      encrypted root. `OPS.md` Phase 0.2 lists what is on that disk
- [ ] `deploy` user; root login off; password auth off — verified in a second
      terminal before closing the first
- [ ] Postgres 17 with a generated password, loopback only
- [ ] `delidev.net` nameservers at Hetzner; `api` resolving to the box and `nexo` to Netlify
- [ ] Caddy issuing certificates; pinning **off**
- [ ] `/etc/nexo/nexo.env` at `chmod 600`; JWT keypair generated
- [ ] `curl https://api.delidev.net/v1/health` answers from your machine
- [ ] Nightly `pg_dump` into Borg on a Storage Box — **and one restore actually
      tested**, because an untested backup is a belief, not a backup

Before M6:

- [ ] Two private buckets, two credential pairs
- [ ] **A bucket policy on `nexo-enc`**, and `s3_smoke` passing all four checks

Before M9:

- [ ] Tauri minisign keypair; private half in GitHub Actions secrets
- [ ] Code-signing certificate in hand, on its hardware token
- [ ] One backup copy kept **off** Hetzner — server, storage and backups in one
      account means one compromised login takes all three
