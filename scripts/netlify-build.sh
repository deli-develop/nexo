#!/usr/bin/env bash
#
# Builds the website on Netlify.
#
# The page cannot start without WebAssembly — `packages/crypto-wasm` is what
# does MLS — so this has to produce the wasm before it can build the bundle.
# That needs three things Netlify's image does not necessarily have: a Rust
# toolchain, the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` at
# exactly the version pinned in `crates/crypto-wasm/Cargo.toml`.
#
# All three are cheap. The CLI in particular is **downloaded, not compiled**:
# the release carries a prebuilt musl binary, so it is a ten-second fetch
# rather than the several-minute `cargo install` that an earlier version of
# this repository used as the reason not to build here at all.
#
# # The version is read, never written
#
# Rule 8 says every dependency is pinned, and a pin repeated in two files is a
# pin that will disagree with itself. The version below is read out of the
# crate manifest, and `packages/crypto-wasm/scripts/build.mjs` checks the
# installed CLI against the same manifest afterwards — so a mismatch fails the
# build rather than producing a module that loads and then throws on its first
# call.

set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"

echo "--- toolchain"
if ! command -v cargo > /dev/null 2>&1; then
  echo "installing rustup"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
fi
# Netlify runs each command in a fresh shell, so rustup's own PATH edit to
# ~/.profile is not enough — it has to be on PATH for the rest of this script.
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version
rustup target add wasm32-unknown-unknown

echo "--- wasm-bindgen"
wanted="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)"/\1/p' crates/crypto-wasm/Cargo.toml)"
if [ -z "$wanted" ]; then
  echo "could not read the pinned wasm-bindgen version from crates/crypto-wasm/Cargo.toml" >&2
  exit 1
fi
echo "pinned to $wanted"

if [ "$(wasm-bindgen --version 2> /dev/null | awk '{print $2}')" != "$wanted" ]; then
  asset="wasm-bindgen-${wanted}-x86_64-unknown-linux-musl"
  url="https://github.com/rustwasm/wasm-bindgen/releases/download/${wanted}/${asset}.tar.gz"
  echo "downloading $url"
  mkdir -p "$root/.netlify-bin"
  curl -sSfL "$url" | tar -xz -C "$root/.netlify-bin" --strip-components=1 "${asset}/wasm-bindgen"
  # The archive does not always carry the exec bit through, and a binary that
  # is merely readable fails later with "permission denied" from inside the
  # wasm build, which points at the wrong thing entirely.
  chmod +x "$root/.netlify-bin/wasm-bindgen"
  export PATH="$root/.netlify-bin:$PATH"
fi
wasm-bindgen --version

echo "--- install"
# Corepack first, because the version then comes from `packageManager` in
# package.json like every other pin. Netlify may already have pnpm on PATH, in
# which case this is a no-op; if corepack is unavailable or refuses, the
# existing pnpm is used rather than failing the build over a shim.
corepack enable 2> /dev/null || echo "corepack unavailable; using the pnpm already on PATH"
pnpm --version
pnpm install --frozen-lockfile

echo "--- wasm"
pnpm --filter @nexo/crypto-wasm build

echo "--- page"
pnpm --filter nexo-desktop build

echo "--- done"
ls -la apps/desktop/dist
