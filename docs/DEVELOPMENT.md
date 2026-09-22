# Development

Everything needed to build and run Nexo on a Windows machine: the repository
layout, the prerequisites, the commands, and the two things on a stock Windows
box that stop a first build.

[`CONTEXT.md`](CONTEXT.md) is the map of the code itself — which file answers
which question, and which two or three a given task actually needs. Read that
before changing anything; this file only gets the toolchain working.

## Layout

```
apps/desktop        Tauri 2 + React 19 client (Windows)
apps/server         axum API and MLS Delivery Service (Linux, aarch64)
crates/protocol     Wire types shared by both. No I/O, no crypto.
crates/crypto       MLS, the identity keypair, and safety numbers.
crates/crypto-wasm  The same, through wasm-bindgen, for a browser engine.
crates/platform     The OS seam: SecureStore, and the Windows DPAPI backing.
crates/store        The client's SQLCipher database.
crates/client       Session logic. No platform calls, no HTTP client.
```

`crates/client` is what the build prompt called `packages/api-client`: the
client-side logic that is identical on Windows and Android, so the port reuses
it instead of reimplementing it. It reaches the OS through `SecureStore` and
the network through a `Transport` trait, both supplied by the shell around it.

Inside the client:

```
src/components/ui       Buttons, avatars, panes, controls, the icon set
src/components/chrome   Titlebar and the icon rail
src/features/{home,messages,profile,settings}
src/mock                Historical. The M1 fixtures; nothing outside it imports it.
```

Colour, type, radius, motion and the glass utilities are not in the client at
all: they are authored in `packages/design-tokens/tokens.css` and imported by
`src/main.tsx`, so a second platform can consume the same values as
`tokens.json` rather than a copy.

`crates/protocol`, `crates/crypto` and `crates/platform` must compile unchanged
for Android; keep every platform call behind `nexo-platform`.

Inside the server:

```
src/db.rs           The Postgres pool.
src/state.rs        AppState: the pool and, from M6, object storage.
src/storage.rs      Hetzner object storage. Two buckets the types keep apart.
migrations/         Applied with sqlx-cli; checked into .sqlx for offline builds.
tests/s3_smoke.rs   Ignored by default. Needs real credentials.
```

## Getting started

Windows 10 1809+ or Windows 11, on x86_64.

### 1. Prerequisites

| | Version | Notes |
|---|---|---|
| [Rust](https://rustup.rs/) | 1.97.1 | Pinned by `rust-toolchain.toml`; rustup installs it for you on the first build. |
| [Node.js](https://nodejs.org/) | 24.x | |
| pnpm | 10.20.0 | `npm install -g pnpm@10.20.0` |
| Visual Studio Build Tools | 2022 or newer | Workload **Desktop development with C++**, which must include *MSVC v14.x — VS 2022+ C++ x64/x86 build tools* and the *Windows 11 SDK*. Without the x64 CRT nothing links. |
| WebView2 Runtime | Evergreen | Already present on Windows 11 and on updated Windows 10. The installer ships a bootstrapper for machines that lack it. |
| [Strawberry Perl](https://strawberryperl.com/) | any | **Not needed yet.** Required from M2 onward, when SQLCipher starts building a vendored OpenSSL. `winget install StrawberryPerl.StrawberryPerl` |
| CMake | any | Needed by `aws-lc-sys`, which the AWS S3 SDK builds for its TLS. Strawberry Perl ships one, so installing that usually covers it. On the aarch64 server: `apt install cmake`. |
| `wasm-bindgen-cli` | **exactly** 0.2.127 | Only for `pnpm test:wasm`. `cargo install wasm-bindgen-cli --version 0.2.127 --locked`. The version must equal the `wasm-bindgen` crate in `crates/crypto-wasm/Cargo.toml`; the build script refuses to run when they disagree, because a mismatch produces a module that loads and then fails on the first call. |

The `wasm32-unknown-unknown` target is listed in `rust-toolchain.toml`, so
rustup installs it with the toolchain and no `rustup target add` is needed.

### 2. Install

```powershell
git clone https://github.com/deli-develop/nexo.git
cd nexo
pnpm install
```

Re-run `pnpm install` after any pull that changes `pnpm-lock.yaml`. A stale
`node_modules` shows up as `Can't resolve '@fontsource/...'` during a build.

### 3. Run

The desktop app, with hot reload on the React side:

```powershell
pnpm tauri dev
```

The first run compiles the Rust core and takes a couple of minutes; later runs
start in seconds. Editing anything under `apps/desktop/src` reloads instantly;
editing Rust rebuilds and relaunches the window.

The API server, separately, in its own terminal. It now needs a local Postgres.
Start it once with Docker, then copy the env template:

```powershell
docker compose up -d
Copy-Item .env.example .env    # only needed once
```

Compose publishes Postgres on **5433**, not 5432, so a native Windows
PostgreSQL install cannot be contacted by mistake. Then:

```powershell
pnpm dev:server
# -> http://127.0.0.1:8080/v1/health  {"status":"ok","protocol_version":1}
```

Nothing in the client talks to it yet — that is M4. Set `NEXO_BIND` to listen
somewhere other than `127.0.0.1:8080`.

Both of these prepare their own build environment, so they work in any shell.

### 3b. The three builds

One page, three hosts. They share every line of `apps/desktop/src` and
`packages/core`; what differs is the shell around them.

| Build | Command | Notes |
|---|---|---|
| Windows | `pnpm tauri dev` / `pnpm tauri build` | The twelve-command shell |
| Web | `pnpm build` | `apps/desktop/dist`, deployed by CI |
| Android | `pnpm tauri android dev` | Needs the SDK/NDK below |

All three need `packages/crypto-wasm` built first, because the page imports it
and cannot start without it:

```powershell
pnpm --filter @nexo/crypto-wasm build
```

That produces **two** layouts from one `.wasm`: `pkg/` for Node's test runner,
`web/` for anything that runs in a browser engine. Neither substitutes for the
other — the glue differs and the module does not.

### 3c. Android

The shell is ready for it: wave 9 removed everything that made it
Windows-shaped, and the plugins a phone has no use for — tray, autostart,
single-instance, the sideloaded updater — are now behind
`cfg(not(target_os = "android"))` in `src-tauri/Cargo.toml`, with `cfg(mobile)`
commands that answer honestly instead of failing.

What is **not** done, and cannot be done from a machine without the toolchain:

1. **The Android SDK and NDK.** Install Android Studio, then set:

   ```powershell
   $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
   $env:NDK_HOME = "$env:ANDROID_HOME\ndk\<version>"
   ```

2. **The Rust targets:**

   ```powershell
   rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
   ```

3. **Initialise the project.** This writes `src-tauri/gen/android`, which is
   git-ignored and regenerated:

   ```powershell
   pnpm tauri android init
   ```

4. **A signing key**, which is yours and must not be in this repository:

   ```powershell
   keytool -genkey -v -keystore nexo.jks -keyalg RSA -keysize 2048 -validity 10000 -alias nexo
   ```

   Keep it somewhere you will still have it in five years. **An Android app
   cannot change its signing key**: lose it and the only way to ship an update
   is a new listing that nobody who installed the old one will be offered.

5. **Build:**

   ```powershell
   pnpm tauri android build --apk
   ```

Push notifications are the open question and are deliberately out of scope.
With MLS a push can carry nothing but "something arrived" — the server has no
key and never will — so the notification a phone shows before the app syncs
cannot name a sender or quote a message. That is a design decision to make
with its consequences in view, not a setting.

### 4. Using cargo directly

Raw `cargo` commands — `cargo test`, `cargo clippy`, `cargo build` — need the
environment set up first, once per terminal:

```powershell
. .\scripts\dev-env.ps1
cargo test --workspace
```

Dot-source it (the leading `. `). It edits the current session rather than a
child process, so running it without the dot does nothing useful. It finds a
usable MSVC toolchain, puts Strawberry Perl on `PATH` when it is installed, and
says what is missing. [Why it is needed](#why-dev-envps1-exists).

You can also serve the UI alone in a browser at `http://localhost:1420`:

```powershell
pnpm dev
```

That is useful for pure layout work, but anything that calls into Rust — the
titlebar buttons, Settings — will not work, because there is no Tauri process
behind it. Prefer `pnpm tauri dev`.

### 5. Before you push

```powershell
. .\scripts\dev-env.ps1     # if this shell has not had it yet
.\scripts\check.ps1
```

Runs exactly what CI runs: `cargo fmt`, `cargo clippy -D warnings`, the Rust
tests, both `cargo deny` passes, `cargo audit`, `pnpm typecheck` and
`pnpm build`.

### Building a release binary

```powershell
. .\scripts\dev-env.ps1
pnpm build          # must come first: the Rust client embeds apps/desktop/dist
cargo build --release
```

The binary lands at `target\release\nexo-desktop.exe`. `pnpm tauri build`
produces the NSIS installer, though signing and the updater are M9 work.

### Why `dev-env.ps1` exists

Two things on a stock Windows box stop this repo from building, and neither is
a code problem:

1. **Multiple Visual Studio installs.** Rust picks the newest MSVC it finds,
   which is not always the complete one. An install carrying only `lib\onecore`
   fails to link with `LNK1104: cannot open file 'msvcrt.lib'`. The script picks
   the newest install that actually has the desktop x64 CRT.
2. **Perl.** From M2 onward, SQLCipher's vendored OpenSSL needs a full Perl to
   run `Configure`. The Perl inside Git for Windows is not complete enough — it
   fails on a missing `Locale::Maketext::Simple`. Install Strawberry Perl:
   `winget install StrawberryPerl.StrawberryPerl`.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `C1083: Cannot open include file: 'excpt.h'`, or `LNK1104: cannot open file 'msvcrt.lib'` | A raw `cargo` command in a shell that has not had `.\scripts\dev-env.ps1` dot-sourced, so cc-rs auto-detected an incomplete Visual Studio. Dot-source it, or use `pnpm tauri dev` / `pnpm dev:server`, which do it themselves. If the script reports no usable install, add the **Desktop development with C++** workload in the Visual Studio Installer. |
| `Can't resolve '@fontsource/...'` | `node_modules` is behind the lockfile. Run `pnpm install`. |
| `Command 'perl' not found` or `Locale::Maketext::Simple` | Install Strawberry Perl and open a fresh shell (M2 onward only). |
| `pnpm: command not found` after `corepack enable` | `corepack enable` needs administrator rights. Use `npm install -g pnpm@10.20.0` instead. |
| `pnpm server` prints nothing and exits | `server` is one of pnpm's own commands (its store daemon), so the shorthand never reaches the script. The script is named `dev:server` for this reason. |
| `Port 1420 is already in use` | A previous `pnpm tauri dev` is still running; the port is fixed on purpose so Tauri and Vite cannot disagree about it. Free it with `Get-NetTCPConnection -LocalPort 1420 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`. |

