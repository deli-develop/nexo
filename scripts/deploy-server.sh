#!/usr/bin/env bash
#
# Phase 7 of docs/OPS.md, in one run: build nexo-server, install it, give it a
# database, a signing key and a systemd unit, and start it.
#
# Safe to run again. Every step checks for what it would create and leaves an
# existing one alone -- the database password and the JWT key in particular are
# generated once and never rotated by a re-run, because rotating either one
# signs every account out.
#
#   bash deploy-server.sh
#
# Run it from a clone of the repo, as a user with sudo.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/nexo/nexo.env
KEY_FILE=/etc/nexo/jwt-ed25519.pem
UNIT=/etc/systemd/system/nexo-server.service
BIN=/usr/local/bin/nexo-server

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$REPO/Cargo.toml" ] || die "no Cargo.toml at $REPO -- run this from the repo clone"

say "Build dependencies"
sudo apt-get update -qq
# cc: the linker rustc shells out to. cmake: aws-lc-sys builds its own C crypto
# for the AWS SDK's TLS. libssl-dev/pkg-config: openssl-sys.
sudo apt-get install -y -qq build-essential cmake pkg-config libssl-dev curl
command -v cc >/dev/null || die "cc still missing after build-essential"
command -v cmake >/dev/null || die "cmake still missing"

say "Rust toolchain"
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
command -v cargo >/dev/null || die "cargo not on PATH"

say "Postgres role and database"
command -v psql >/dev/null || die "postgres is not installed -- do OPS.md Phase 4 first"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='nexo'" | grep -q 1 \
  || die "role 'nexo' does not exist -- do OPS.md Phase 4 first"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='nexo'" | grep -q 1 \
  || die "database 'nexo' does not exist -- do OPS.md Phase 4 first"

say "Service user"
id -u nexo >/dev/null 2>&1 \
  || sudo useradd --system --no-create-home --shell /usr/sbin/nologin nexo
sudo mkdir -p /etc/nexo

say "Database password"
# Reuse whatever the env file already holds. Generating a new one on every run
# would leave the service unable to reach a database it provisioned itself.
if sudo test -f "$ENV_FILE" && sudo grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  DB_URL="$(sudo sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -1)"
  echo "reusing the password already in $ENV_FILE"
else
  # hex only: a connection string is a URL, and a password containing @ : / #
  # would have to be percent-encoded to survive it.
  DB_PW="$(openssl rand -hex 16)"
  sudo -u postgres psql -qc "ALTER ROLE nexo PASSWORD '$DB_PW';" >/dev/null
  DB_URL="postgres://nexo:$DB_PW@localhost/nexo"
  echo "generated a new password and set it on the role"
fi

say "Token signing key"
# The server refuses to start without this. Generated once: rotating it signs
# every account out, so a re-run must never replace an existing key.
if sudo test -f "$KEY_FILE"; then
  echo "keeping the existing key at $KEY_FILE"
else
  sudo openssl genpkey -algorithm ed25519 -out "$KEY_FILE" 2>/dev/null
  echo "generated $KEY_FILE"
fi
sudo chown nexo:nexo "$KEY_FILE"
sudo chmod 600 "$KEY_FILE"

say "Object storage"
# All seven or none: a partly filled block is a startup error, not a silent
# fallback to "not configured". Supply them in the environment to turn
# attachments and feed images on:
#
#   NEXO_S3_ENDPOINT=... NEXO_S3_REGION=... ... bash deploy-server.sh
#
# Reused from the existing env file on a re-run, so this only has to be passed
# once. Nothing is echoed: these are live credentials.
S3_BLOCK=""
S3_VARS="NEXO_S3_ENDPOINT NEXO_S3_REGION NEXO_S3_MEDIA_BUCKET NEXO_S3_MEDIA_ACCESS_KEY NEXO_S3_MEDIA_SECRET_KEY NEXO_S3_ENC_BUCKET NEXO_S3_ENC_ACCESS_KEY NEXO_S3_ENC_SECRET_KEY"
have=0; want=0
for v in $S3_VARS; do
  want=$((want + 1))
  value="${!v:-}"
  # Fall back to what the env file already holds.
  if [ -z "$value" ] && sudo test -f "$ENV_FILE"; then
    value="$(sudo sed -n "s/^$v=//p" "$ENV_FILE" | head -1)"
  fi
  if [ -n "$value" ]; then
    have=$((have + 1))
    S3_BLOCK="$S3_BLOCK$v=$value"$'
'
  fi
done

if [ "$have" -eq 0 ]; then
  S3_BLOCK=""
  echo "not configured -- attachments and feed images stay unavailable"
elif [ "$have" -ne "$want" ]; then
  die "object storage is $have/$want configured. All seven or none: a partly filled block is a startup error. Pass the missing ones in the environment."
else
  echo "all $want values present"
fi

say "Environment file"
sudo tee "$ENV_FILE" >/dev/null <<ENV
NEXO_BIND=127.0.0.1:8080
DATABASE_URL=$DB_URL
RUST_LOG=nexo_server=info,tower_http=info
NEXO_JWT_PRIVATE_KEY_PEM=$KEY_FILE
$S3_BLOCK
ENV
sudo chown root:nexo "$ENV_FILE"
sudo chmod 640 "$ENV_FILE"

say "Build (this is the long step)"
cd "$REPO"
# SQLX_OFFLINE=true comes from .cargo/config.toml, so this needs no database.
cargo build --release -p nexo-server

say "Migrations"
if ! command -v sqlx >/dev/null; then
  cargo install sqlx-cli --no-default-features --features postgres
fi
DATABASE_URL="$DB_URL" sqlx migrate run --source apps/server/migrations
DATABASE_URL="$DB_URL" sqlx migrate info --source apps/server/migrations

say "Install the binary"
sudo systemctl stop nexo-server 2>/dev/null || true
sudo install -m755 "$REPO/target/release/nexo-server" "$BIN"

say "systemd unit"
sudo tee "$UNIT" >/dev/null <<'UNITFILE'
[Unit]
Description=Nexo API and delivery service
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=nexo
Group=nexo
ExecStart=/usr/local/bin/nexo-server
Restart=on-failure
RestartSec=5
EnvironmentFile=/etc/nexo/nexo.env

# The service needs the network and its own state, and nothing else.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryDenyWriteExecute=yes

[Install]
WantedBy=multi-user.target
UNITFILE

sudo systemctl daemon-reload
sudo systemctl enable --now nexo-server
sleep 3

say "Health"
if ! sudo systemctl is-active --quiet nexo-server; then
  sudo journalctl -u nexo-server -n 40 --no-pager
  die "the service is not running -- the log above says why"
fi
LOCAL="$(curl -fsS --max-time 5 http://127.0.0.1:8080/v1/health || true)"
[ -n "$LOCAL" ] || { sudo journalctl -u nexo-server -n 40 --no-pager; die "no answer on 127.0.0.1:8080"; }
echo "local:  $LOCAL"
PUBLIC="$(curl -fsS --max-time 10 https://api.delidev.net/v1/health || true)"
if [ -n "$PUBLIC" ]; then
  echo "public: $PUBLIC"
  printf '\n\033[1;32mDone. api.delidev.net is live.\033[0m\n'
else
  printf '\n\033[1;33mThe service is up locally but api.delidev.net did not answer.\033[0m\n'
  echo "That is Caddy, not this service. Check: sudo systemctl status caddy"
fi
