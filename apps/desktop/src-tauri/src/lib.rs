//! The Nexo desktop shell.
//!
//! **What this is not, any more.** Until wave 7 it was the application: MLS,
//! the identity keypair, the SQLCipher key and every message plaintext lived
//! on this side of the IPC boundary, and the WebView received already-
//! decrypted strings and nothing else. That arrangement could not be carried
//! to a browser, which has no other side, so all of it moved into
//! `packages/core` and the page — see `docs/REWORK.md`.
//!
//! What is left is a shell, and it is what the name always said: a window, a
//! tray icon, toasts, autostart, a link preview and the updater. Twelve
//! commands, each a deliberate hole in an otherwise closed wall, each needing
//! a matching entry in `capabilities/default.json`.
//!
//! The things that used to justify this crate's existence are gone with the
//! code that did them. That is the trade `REWORK.md` records: one app that
//! runs in three places, at the cost of a session that is as reachable as the
//! page it lives in.

// `forbid`, not `deny`, and it is worth saying why it is back.
//
// This crate holds the MLS state, the identity keypair, the SQLCipher key and
// every message plaintext. It carried `forbid(unsafe_code)` until calls needed
// `permissions.rs` -- WebView2 decides camera and microphone access through a
// COM callback, and COM is FFI -- and `forbid` cannot be relaxed for a single
// module, which is the whole point of it. Calls are gone, that module with
// them, and the stronger word fits again. `crates/platform` is now the only
// place in the workspace that reaches for `unsafe`, for DPAPI.
#![forbid(unsafe_code)]

mod commands;
mod preview;
mod windows;

/// Start the app.
pub fn run() {
    init_tracing();

    let builder = tauri::Builder::default()
        .manage(windows::WindowPrefs::default())
        .plugin(tauri_plugin_dialog::init())
        // Writing one file, where the Save dialog just put it. Opening is an
        // ordinary <input type="file"> and needs no plugin at all -- which is
        // what lets the picker be the same code on every host.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // Everything a phone does not have.
    //
    // A tray, a startup entry, a second-instance guard and a sideloaded
    // updater are all desktop ideas, and on Android they are worse than
    // absent: the platform owns app lifecycle, launching and updates, and a
    // plugin that tried to take any of them either fails to build or fights
    // the OS. `cfg(desktop)` is Tauri's own switch for exactly this, set by
    // the build script.
    #[cfg(desktop)]
    let builder = builder
        // Before anything else can take the lock: a second launch hands its
        // arguments to the running instance and exits (§8). Two instances
        // would mean two WebViews over one IndexedDB and two MLS providers
        // ratcheting the same group forward independently -- the second is
        // the one that corrupts state.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            windows::show_main_window(app);
        }))
        // HKCU, never HKLM (§8). A per-machine Run key needs admin, affects
        // every account on the computer, and is not this app's to write.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // §8: manifests signed with the minisign key whose public half is
        // pinned in tauri.conf.json. The plugin refuses anything the key did
        // not sign, so the update server is not trusted, only the key.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            windows::install_tray(app.handle())?;
            // Close-to-tray defaults off (see `WindowPrefs`). Someone who
            // closes a window and finds the app still running has been
            // surprised by their own computer; they can turn it on in
            // Settings once they know it exists, and the WebView pushes the
            // stored preference across at startup.
            windows::install_close_to_tray(app.handle());
            Ok(())
        });

    builder
        // Commands are added one at a time, and each one needs a matching
        // entry in capabilities/default.json. The capability set starts empty
        // and only ever grows deliberately (§4.5).
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::notify_message,
            commands::set_unread,
            commands::focus_window,
            commands::set_close_to_tray,
            commands::set_window_backdrop,
            commands::forget_account,
            commands::preview_link,
            commands::get_autostart,
            commands::set_autostart,
            commands::check_update,
            commands::install_update,
            commands::start_relay,
            commands::stop_relay,
            commands::relay_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running nexo");
}

fn init_tracing() {
    // §4.5: nothing above `debug` may contain user content, and `debug` is
    // compiled out of release builds. `debug_assertions` is the switch, and
    // the release profile in the workspace manifest turns it off.
    //
    // Only this crate now. `nexo_client` used to be named here as well,
    // because conversations, joins and refused sends all happened in it; they
    // happen in the page now, and the browser console is where they go.
    let default = if cfg!(debug_assertions) {
        "nexo_desktop_lib=debug"
    } else {
        "nexo_desktop_lib=info"
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| default.into()),
        )
        .init();
}
