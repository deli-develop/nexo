# Deploy — from a fresh server to a live API

A straight line. Seven steps, in order, with the exact command for each and the
exact thing you should see back.

**This file is the path. [`OPS.md`](OPS.md) is the map.** When a step works,
you never need OPS.md. When one does not, OPS.md is where the reasoning lives —
every step below names the phase it comes from.

**Before you start, you need three things:**

- the server's IPv4 address, from the Hetzner console;
- the private half of the SSH key you gave it at creation;
- the ability to edit DNS for `delidev.net`.

Roughly forty minutes, of which twenty-five is the machine compiling and you
doing nothing.

| Step | What it does | Time |
|---|---|---|
| 1 | Get in, and make it safe to stay | 5 min |
| 2 | Postgres 17 | 5 min |
| 3 | DNS — **before** step 4, not after | 5 min + propagation |
| 4 | Caddy, and a certificate | 3 min |
| 5 | Build and install the server | 20–30 min |
| 6 | Check it from your own machine | 1 min |
| 7 | Point the desktop client at it | 2 min |

---

## Step 1 — Get in, and make it safe to stay

From your machine. `<ip>` is the server's IPv4 address:

```bash
ssh root@<ip>
```

If that refuses you, the key Hetzner has is not the key you are offering — add
`-i ~/.ssh/id_ed25519` to name it explicitly.

**Update first, harden second.** The order matters and it is not obvious:
`apt upgrade` ships a new `sshd_config`, and if you have already edited that
file, apt stops and asks a full-screen question about whose version to keep.
Upgrading first means there is nothing to ask about.

```bash
apt update && apt upgrade -y && apt install -y unattended-upgrades
```

**fail2ban comes later, at the end of this step, and that is deliberate.** It
bans an address after a handful of failed SSH attempts, and a ban drops packets
silently — so it looks like the host went away rather than like a refusal.
Installing it *before* you have confirmed the new user can get in means the
exact fumbling this step exists to protect you from is what locks you out.

Now make a non-root user:

```bash
adduser --disabled-password --gecos "" deploy && usermod -aG sudo deploy && rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

**And give it a way to use `sudo`.** `--disabled-password` means the account has
no password, and Ubuntu's `sudo` asks for the user's *own* password — so
without this, `sudo` can never succeed and there is nothing you could type that
would help. Passwordless is the right shape here: SSH already requires your
key, and a password would only be a second secret to keep somewhere.

```bash
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy && chmod 440 /etc/sudoers.d/deploy && visudo -c
```

`visudo -c` must print `parsed OK`. **Do not close this root window until it
does** — a malformed file in `/etc/sudoers.d/` disables `sudo` completely, and
then neither user can fix it.

*(Prefer a password? `passwd deploy` instead, and `sudo` will prompt for it.)*

**Before you turn root login off, prove the new user works.** Open a **second**
terminal on your own machine, leave this one open, and run:

```bash
ssh deploy@<ip>
```

and then, in that new session:

```bash
sudo -v
```

Both have to work, and `sudo -v` should return **silently, with no prompt**. If
it asks for a password and refuses everything you type, the sudoers drop-in
above is missing — go back and add it from the root window.

If they do not work, fix it from the root window you still have open. Locking yourself out of a fresh box costs ten minutes; locking yourself
out of a running one costs the box.

Only once that passes, turn off the two ways in that do not need a key. Run it
from either window — **`sudo` on each part**, because `&&` starts a new process
each time and one `sudo` at the front only covers the first:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl restart ssh
```

Confirm it took:

```bash
sudo grep -E '^(PermitRootLogin|PasswordAuthentication)' /etc/ssh/sshd_config
```

Both must read `no`. Restarting sshd does not drop sessions that are already
open, so both windows survive it. New root connections stop working from here
on, which is the point.

> `sed: couldn't open temporary file /etc/ssh/sedXXXXXX: Permission denied`
> means you are the `deploy` user and left a `sudo` off. That is the good
> failure — it proves `deploy` works.

Now, and not before, the brute-force guard:

```bash
sudo apt install -y fail2ban
```

> If SSH later times out rather than refusing you, fail2ban is the first
> suspect — `Connection timed out` where you expected `Permission denied` is
> what a ban looks like. It clears itself in about ten minutes. Hetzner's `>_`
> Console is VNC rather than SSH, so it still works while you are banned:
> `fail2ban-client status sshd` shows the list and
> `fail2ban-client unban --all` clears it.

Everything after this is done as `deploy`, not root.

> **If apt asks anyway** — a blue screen headed *Configuring openssh-server*,
> asking what to do about a modified `sshd_config` — choose **keep the local
> version currently installed**. "Locally modified" means you modified it, and
> the maintainer's version would put password authentication back on. Then do
> the `ssh deploy@<ip>` check above before closing anything.

*(OPS.md Phase 3.)*

---

## Step 2 — Postgres 17

Ubuntu 24.04 ships Postgres 16 and this project targets 17, so the PGDG
repository goes on first:

```bash
sudo apt install -y postgresql-common && sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
```

It asks one question. Answer yes. Then:

```bash
sudo apt install -y postgresql-17
```

Create the role and the database. **The password here is a placeholder and
stays one** — step 5 replaces it with a generated value and writes that into
the env file. You are not inventing a secret:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE nexo LOGIN PASSWORD 'replaced-in-step-5';
CREATE DATABASE nexo OWNER nexo;
\c nexo
CREATE EXTENSION IF NOT EXISTS citext;
SQL
```

Check that it is not reachable from outside:

```bash
sudo ss -lntp | grep 5432
```

**Read the third column, not the fourth.** You want this:

```
LISTEN 0 200   127.0.0.1:5432   0.0.0.0:*   users:(("postgres",...))
LISTEN 0 200       [::1]:5432      [::]:*   users:(("postgres",...))
               └─ listening on   └─ peer
```

- **Column 3** is the address Postgres is bound to. `127.0.0.1` and `[::1]` are
  loopback — only this machine can reach it. That is correct.
- **Column 4** is the peer address, and `0.0.0.0:*` means "nothing connected
  yet, anything could". *Every* listening socket shows this, it is not a
  setting, and it cannot be changed. Ignore it.

Only `0.0.0.0:5432` in the **third** column is wrong. If you see that, stop and
fix it: port 5432 is not in the Hetzner firewall and must never be.

*(OPS.md Phase 4.)*

---

## Step 3 — DNS, before Caddy and not after

Caddy asks Let's Encrypt for a certificate the first time it starts, and that
request fails if the name does not already resolve to this box. Doing this in
the wrong order is the most common way to spend an hour on nothing.

In the **Hetzner DNS Console** (<https://dns.hetzner.com>, free):

1. Add the zone `delidev.net`.
2. At whatever registrar holds `delidev.net`, change the nameservers to the
   ones Hetzner shows you.
3. Add one record pair, pointing at this server:

   ```
   api    A     <server IPv4>
   api    AAAA  <server IPv6>
   ```

Then wait, and check from **your own machine** rather than from the server:

```bash
nslookup api.delidev.net
```

It has to come back with the server's address before you continue. A
nameserver change can take anywhere from minutes to a few hours.

> `nexo.delidev.net` is **not** set up here. That name is a CNAME pointing at
> Netlify, and it belongs to the web client — wave 8 of
> [`REWORK.md`](REWORK.md). Nothing on this box serves it.

*(OPS.md Phase 5.)*

---

## Step 4 — Caddy, and a certificate

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
```

```bash
sudo apt update && sudo apt install -y caddy
```

Write the configuration. One site block, because one thing runs here:

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
api.delidev.net {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
		X-Content-Type-Options "nosniff"
		-Server
	}
	reverse_proxy 127.0.0.1:8080
}
CADDY
```

```bash
sudo systemctl reload caddy
```

Caddy now fetches a certificate. Watch it happen — you want to see
`certificate obtained successfully`:

```bash
sudo journalctl -u caddy -n 30 --no-pager
```

A 502 from `https://api.delidev.net` at this point is **correct**. Caddy is
working and there is nothing behind it yet. That is step 5.

*(OPS.md Phase 6.)*

---

## Step 5 — Build and install the server

**The repository is private**, so the box needs its own read access before it
can clone. Use a *deploy key* — read-only and scoped to this one repository —
rather than a personal access token, which would put your whole GitHub
account's permissions on a server.

On the box:

```bash
ssh-keygen -t ed25519 -C "nexo-server" -f ~/.ssh/github_deploy -N ""
```

```bash
cat ~/.ssh/github_deploy.pub
```

On GitHub, at `https://github.com/deli-develop/nexo/settings/keys` →
**Add deploy key**. Title it `nexo-server`, paste that line, and **leave "Allow
write access" unticked** — the server only reads, and a read-only key cannot be
used to push if the box is ever compromised.

Back on the box, point git at that key and clone over SSH:

```bash
printf 'Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
' >> ~/.ssh/config && chmod 600 ~/.ssh/config
```

```bash
git clone git@github.com:deli-develop/nexo.git && cd nexo
```

The first connection asks whether to trust `github.com`'s host key — type
`yes`.

> A `Username for 'https://github.com':` prompt means you used the HTTPS URL.
> GitHub removed password authentication for git years ago, so there is nothing
> to type there. Use the `git@github.com:` form above.

Then run the deploy, telling it which browser origin to allow:

```bash
NEXO_CORS_ORIGINS=https://nexo.delidev.net bash scripts/deploy-server.sh
```

**What it does, so you can tell a hang from a slow step.** It installs the
build dependencies, installs Rust if there is none, generates the database
password and sets it on the role, generates the token signing key, writes
`/etc/nexo/nexo.env`, compiles `nexo-server`, runs the migrations, installs the
binary and a systemd unit, and starts it.

**The compile is the long part.** Twenty minutes or more on a CAX21, with no
output for most of it. It has not hung. `aws-lc-sys` and the vendored OpenSSL
are the slow ones.

It is safe to run again. The database password and the signing key are
generated **once** and a re-run keeps them — rotating either signs every
account out, which is why the script refuses to do it by accident.

Two things you pass rather than it inventing them, and both are remembered in
the env file so you pass each only once:

| Variable | What happens without it |
|---|---|
| `NEXO_CORS_ORIGINS` | No CORS layer, so neither the website nor the packaged desktop app can call this server. |
| The eight `NEXO_S3_*` values | Attachments and feed images are unavailable. Everything else works. All eight or none — a partly filled block is a startup error, on purpose. The buckets also need their own CORS rule, which this script cannot set — `OPS.md` Phase 8, *Bucket CORS*. |

*(OPS.md Phase 7. Object storage is Phase 8, and you do not need it today.)*

---

## Step 6 — Check it, from your own machine

On the server first:

```bash
sudo systemctl status nexo-server --no-pager
```

Then from **your own machine**, which is the check that actually counts — it
goes through DNS, through Caddy's certificate, and into the service:

```bash
curl -i https://api.delidev.net/v1/health
```

You want:

```
HTTP/2 200
{"status":"ok","protocol_version":5}
```

`protocol_version` is **5**. If it says 3, the box is running a build from
before Meet&Greet and calls were removed, and the desktop client will not talk
to it.

### When it does not say that

| What you see | What it means | What to do |
|---|---|---|
| `curl: (6) Could not resolve host` | DNS has not propagated, or the record is wrong | Back to step 3. Check from your machine, not the server. |
| `502 Bad Gateway` | Caddy is fine; `nexo-server` is not running | `sudo journalctl -u nexo-server -n 60 --no-pager` |
| The service restart-loops | It refuses a half-finished configuration at startup, by design | The log names the variable. The S3 block and `NEXO_CORS_ORIGINS` are each all-or-nothing. |
| A panic naming `NEXO_CORS_ORIGINS` | A wildcard, a non-`https://` origin, or a value with a path or a trailing slash | Exact origins only: `https://nexo.delidev.net`, no slash at the end. |
| `NEXO_JWT_PRIVATE_KEY_PEM is not set` | The env file is missing it, or the file it names is not readable by the `nexo` user | `sudo ls -l /etc/nexo/` — the key is `nexo:nexo`, mode 600. |
| Certificate errors | Caddy could not complete the ACME challenge | Port 80 must be open in the Hetzner firewall, not only 443. |

*(OPS.md has a longer version of this table, under "When `api.delidev.net`
answers 502".)*

---

## Step 7 — Point the desktop client at it

Nothing to configure. `DEFAULT_BASE_URL` in `crates/client/src/http.rs` is
already `https://api.delidev.net`, compiled in — a Tauri app ships whatever you
put in it, so an "environment variable" in a desktop binary is just a string
the user can read, and this one is not one.

For a **development** build only, `NEXO_API_BASE` overrides it, so you can aim
a debug build at your own machine:

```bash
NEXO_API_BASE=http://127.0.0.1:8080 pnpm tauri dev
```

A `--release` build ignores that variable deliberately. The consequence when
testing: a release build driven against a local server is not talking to it,
and a route that only exists locally comes back 404 — which looks like a bug in
the feature rather than a binary aimed at the wrong host.

---

## Step 8 — The website, at `nexo.delidev.net`

The same app the Windows client runs, served as a page. Nothing new is built:
`apps/desktop` is the app and always was, and the web build is that bundle
without the Tauri shell around it.

### How it is built

Netlify builds it from the repository, on every push, and the only unusual
part is that the build has to produce WebAssembly first: the page cannot start
without `packages/crypto-wasm`, which is what does MLS.

`scripts/netlify-build.sh` handles it — Rust toolchain, the `wasm32` target,
then the **prebuilt** `wasm-bindgen` binary downloaded from its release, which
takes about ten seconds rather than the several minutes compiling it would.
The version is read out of `crates/crypto-wasm/Cargo.toml` rather than written
in the Netlify config, because a pin in two files is a pin that will eventually
disagree with itself — and that disagreement produces a module which loads and
then throws on its first call.

There is a second path, off by default: the `web` job in
`.github/workflows/ci.yml` will deploy with the Netlify CLI if
`NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` are set as GitHub secrets. It skips
itself silently when they are not, so having both paths configured does not
race — but if you do set those secrets, turn off Netlify's own build first, or
two builds will publish over each other.

### What to set up, once

1. **Connect the repository** in Netlify. *Add new site → Import an existing
   project*, and pick this repo. The build command and the publish directory
   come from `netlify.toml`; there is nothing to type.
2. **Point the DNS — in the Hetzner DNS Console, not at the registrar.**

   Dynadot holds the registration for `delidev.net` and nothing else: its
   nameservers are delegated to Hetzner (`hydrogen.ns.hetzner.com` and its
   two siblings), so every record lives at <https://dns.hetzner.com>. Step 3
   is where that was set up, and `api.delidev.net` is already an `A` record
   in that zone. Editing DNS at Dynadot does nothing at all — the records
   are simply never consulted, which looks exactly like propagation being
   slow.

   > **Do not accept Netlify's offer to host your DNS.** The screen is headed
   > *Set up domain with Netlify DNS* and lists four nameservers
   > (`dns1.p08.nsone.net` and siblings) under "Update your subdomain's name
   > servers" — but the instruction underneath says to change them *at your
   > registrar*, which moves the **whole zone**, not the subdomain. Every
   > record Hetzner currently serves, `api.delidev.net` above all, stops
   > resolving as soon as that takes effect: the API goes down, the desktop
   > app goes with it, and Caddy stops being able to renew its certificate.
   >
   > The offer is tempting because it promises automatic SSL. A CNAME gets
   > the same certificate, so there is nothing to buy with that risk.
   >
   > Delegating *only* `nexo.delidev.net` is possible and safe — four `NS`
   > records for host `nexo` in the Hetzner zone, never a nameserver change
   > at Dynadot — but it means two DNS providers for one domain, which is
   > one more thing to remember during an incident. Use the CNAME.

   Netlify asks for two records, in this order.

   **First, proof that the domain is yours.** Netlify shows this when the
   apex is registered outside your account:

   | Type | Name | Value |
   |---|---|---|
   | TXT | `subdomain-owner-verification` | the hex string Netlify shows you |

   Add it at Hetzner, wait a minute, then press *Add subdomain*. The value is
   per-site and regenerates, so use the one on screen rather than one written
   down here.

   **Then the subdomain itself:**

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `nexo` | `<your-site>.netlify.app` |

   Netlify issues the certificate once that resolves. Minutes usually, an
   hour sometimes; it is DNS. The TXT record can be deleted afterwards, and
   there is no harm in leaving it.

3. **Let the API accept it.** The browser will refuse every request until the
   server says the origin is allowed. On the server, in `/etc/nexo/nexo.env`:

   ```
   NEXO_CORS_ORIGINS=https://nexo.delidev.net,http://tauri.localhost
   ```

   then `sudo systemctl restart nexo-server`. Without this the site loads, looks
   perfect, and cannot sign anybody in — the failure shows up only in the
   browser's console, as CORS.

4. **Let the buckets accept it too.** Pictures and attachments do not go
   through the API: the page uploads and downloads them itself, with a URL the
   API signed, straight to object storage — a different host with its own CORS
   rules. Both buckets need one naming the same origins as step 3; the rule and
   the commands are in `OPS.md` Phase 8, *Bucket CORS*. Without it everything
   else works — sign-in, messages, posts — and every picture fails with
   "Can't reach the server: Failed to fetch".

### If the build fails

| In the log | What it means |
|---|---|
| `This site is built by CI` then `exit 1` | An old `netlify.toml`. That guard is gone; pull `main`. |
| `ERR_PNPM_NO_LOCKFILE` or `workspace:` errors | Netlify ran npm. The script runs `pnpm install` itself; check that `NODE_VERSION` is 24 and that no UI override sets a build command. |
| `wasm-bindgen: permission denied` | The downloaded binary lost its exec bit. The script chmods it; if this appears, the extraction path changed. |
| `the CLI is X, the crate is pinned to Y` | Exactly what that check is for. The pin moved in `Cargo.toml` and the release for the new version has not been fetched — clear the Netlify cache and rebuild. |

### What the page is allowed to talk to

`netlify.toml` sets a Content-Security-Policy that permits exactly three
destinations: the site itself, `api.delidev.net` over HTTPS and the WebSocket,
and the object store. If you move either, that file is the second place to
change — and until you do, the symptom is a blocked request rather than an
error anybody would connect to the move.

`wasm-unsafe-eval` is in the policy and has to be: it is what allows
`WebAssembly.instantiate`. It does **not** enable `eval`, which is exactly why
the narrower keyword exists.

### What a browser cannot promise

Worth knowing before telling anybody the site is the same as the app:

- **Nothing is encrypted at rest.** The Windows client keeps its store in
  SQLCipher with a key from the OS keystore. A browser has no such place, so
  IndexedDB holds the session and the message history in the clear. Anybody
  with the machine, and anything that runs script in the page, can read them.
- **There is no updater and no tray**, no toasts outside the tab, and no
  autostart. The settings screen says so rather than offering buttons that
  do nothing.
- **A long video waits.** The desktop app streams attachments range by range
  through a custom scheme; a page fetches the whole file, decrypts it, and
  plays it from memory.

The part that does *not* change is the part that matters to somebody who is
not holding the device: the server still never holds a key, and a message is
still opaque to it.

---

## What you have now, and what you do not

**Working:** accounts, sign-in, conversations, the feed, profiles, follows,
blocking, reporting, invitations, stories, and the live WebSocket. Everything
the protocol does that does not need a bucket.

**Not set up, and each is a deliberate later step:**

| Missing | Effect | Where |
|---|---|---|
| Object storage | No attachments, no feed images, no story media | OPS.md Phase 8 |
| Backups | A dead disk is a dead service, with everything in it | OPS.md Phase 9 |
| The website | Needs the two Netlify secrets and a CNAME | Step 8 above |

**Do the backups before you invite anybody.** The server holds accounts, the
follow graph, and every envelope not yet synced. It does not hold message
plaintext — that is the point of the design — but an account nobody can sign
into again is still gone.

An untested backup is a belief, not a backup. Restore one before you need one.
