//! Tauri commands — the entire surface the WebView can reach.
//!
//! Every command here is a deliberate hole in an otherwise closed wall. Adding
//! one means adding a permission to capabilities/default.json, so the two
//! files should always be read together.

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt as _;

use crate::client::ClientState;
use crate::windows::{NotificationDetail, WindowPrefs, toast_text, tray_tooltip};

/// The running app version, for the About panel and the M0 IPC smoke test.
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Shows a Windows toast for an incoming message (§8).
///
/// The WebView asks for it, but it does not get to choose what the toast says:
/// `detail` is applied here, in Rust, by `toast_text`. That matters because
/// this text is drawn on a lock screen and over screen shares, and "the
/// notification respects the privacy setting" has to be true of the process
/// that builds the string, not of the one that requests it.
#[tauri::command]
pub fn notify_message(
    app: AppHandle,
    sender: String,
    body: String,
    detail: NotificationDetail,
) -> Result<(), String> {
    let (title, text) = toast_text(detail, &sender, &body);
    app.notification()
        .builder()
        .title(title)
        .body(text)
        .show()
        // A toast that will not display is not worth failing a sync over, but
        // it is worth reporting -- silently dropping notifications is the kind
        // of thing that gets diagnosed as "the app stopped working".
        .map_err(|e| format!("The notification could not be shown: {e}"))
}

/// Updates the tray tooltip with the unread count (§8).
#[tauri::command]
pub fn set_unread(app: AppHandle, unread: usize) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("nexo") {
        tray.set_tooltip(Some(tray_tooltip(unread)))
            .map_err(|e| format!("The tray could not be updated: {e}"))?;
    }
    Ok(())
}

/// Locks the app: closes the encrypted store and drops the MLS state (§8).
///
/// # What locking does, and does not, guarantee
///
/// It drops `LoggedIn` — the SQLCipher connection, the MLS provider, the
/// signer. What it cannot do is guarantee those bytes are gone from RAM: the
/// allocator may reuse the pages, the OS may have paged them out, and Rust
/// does not promise to zero a freed heap allocation. So this defends against
/// the realistic case — an unattended, unlocked machine, someone who sits
/// down at it — and not against an attacker who can already read this
/// process's memory; someone with that access has the key whether or not the
/// store is "locked". `docs/THREAT-MODEL.md` §3 says the same; it is repeated
/// here because a feature called "lock" invites a stronger reading than it
/// earns.
///
/// The idle *timer* lives in the WebView, because idleness means "no keyboard
/// or pointer input" and the window is the only place that is observable.
/// Rust is only ever told that the time has come — the WebView cannot lock or
/// unlock anything itself.
///
/// Deliberately infallible from the caller's side. If locking could fail and
/// the UI treated that as "stay unlocked", the failure mode would be an app
/// that looks locked and is not.
#[tauri::command]
pub fn lock(
    client_state: tauri::State<'_, ClientState>,
    stream_state: tauri::State<'_, crate::stream::StreamState>,
) {
    match client_state.0.lock() {
        Ok(mut guard) => {
            // Dropping `LoggedIn` closes the SQLCipher connection and releases
            // the provider that holds the MLS secrets.
            *guard = None;
        }
        Err(poisoned) => {
            // A poisoned lock means a previous holder panicked. Clearing it
            // anyway is right: the whole point is to end up with no session,
            // and refusing here would leave one in place.
            *poisoned.into_inner() = None;
        }
    }

    // And the socket, explicitly.
    //
    // `stream.rs` has always said that locking closes it — "a socket still
    // delivering into a locked app is a session that did not really end" — but
    // the mechanism it relied on does not fire here. `follow_session` closes
    // the socket when there is no *session*, and locking deliberately keeps
    // `SessionState`: the tokens are what let `unlock_with_pin` rebuild
    // everything from disk with no server round trip. So the session outlives
    // the lock, `follow_session` sees it and holds the connection open, and
    // nothing was ever going to call it anyway — `drain_stream` is driven by
    // the sync agent, which unmounts with the app shell.
    //
    // The result was an authenticated WebSocket left open by a locked app,
    // quietly accumulating events nobody could decrypt. Closed here instead,
    // where the intent lives.
    match stream_state.0.lock() {
        // Dropping the `Stream` asks its thread to stop.
        Ok(mut guard) => *guard = None,
        Err(poisoned) => *poisoned.into_inner() = None,
    }

    // And the camera and microphone gate. A locked app must not be able to
    // open a device, and the flag would otherwise outlive the lock exactly as
    // the socket used to.
    crate::permissions::allow_call_media(false);
}

/// Whether the app is currently unlocked.
#[tauri::command]
pub fn is_unlocked(client_state: tauri::State<'_, ClientState>) -> bool {
    client_state
        .0
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

/// Brings the window to the front, from the tray or a notification.
#[tauri::command]
pub fn focus_window(app: AppHandle) {
    crate::windows::show_main_window(&app);
}

/// Asks Windows for a desktop backdrop, and reports what happened.
///
/// Paired with the chooser in Settings rather than decided here. The report is
/// shown next to it, because on Windows 11 the API does not say whether the
/// backdrop became visible -- and the person looking at the window can tell in
/// a second what this process cannot tell at all. See `windows::set_backdrop`.
#[tauri::command]
pub fn set_window_backdrop(
    app: AppHandle,
    kind: crate::windows::BackdropKind,
) -> crate::windows::BackdropReport {
    crate::windows::set_backdrop(&app, kind)
}

/// Turns close-to-tray on or off (§8).
///
/// The preference lives in the WebView's settings store, but the close handler
/// runs in Rust, so the WebView pushes the value across whenever it changes —
/// and once at startup, because the handler's default is off.
#[tauri::command]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) {
    app.state::<WindowPrefs>().set_close_to_tray(enabled);
}

/// Whether the app starts with Windows.
///
/// Asked of the registry, not of a stored preference: the `Run` key is the
/// truth, and a preference that disagreed with it — say, after another tool
/// cleaned "startup programs" — would show a toggle that lies.
#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("The startup entry could not be read: {e}"))
}

/// Turns start-with-Windows on or off (§8).
///
/// HKCU, never HKLM: the plugin writes the per-user `Run` key, which needs no
/// admin and touches nobody else's account.
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| format!("The startup entry could not be changed: {e}"))
}

/// What Settings → Storage reports.
///
/// Two numbers, kept apart because they are not the same kind of thing and
/// only one of them is safe to delete. `store_bytes` is the encrypted database
/// — the messages themselves, and the only copy: the server deletes ciphertext
/// on acknowledgement. `cache_bytes` is downloaded media the WebView is
/// holding, re-fetchable from object storage.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StorageView {
    /// The absolute path of the store, for the fact row.
    pub store_path: String,
    /// The store file plus its WAL sidecars.
    pub store_bytes: u64,
    /// The WebView's cache directory, or 0 when there is nothing cached yet.
    pub cache_bytes: u64,
}

/// Measures what Nexo is keeping on this machine (§6.4).
///
/// Reported rather than estimated: an invented number in a Storage panel is
/// the kind of small dishonesty that makes someone doubt the rest of the app.
/// A path that cannot be read counts as zero rather than failing the whole
/// panel — a missing cache directory just means nothing has been cached.
#[tauri::command]
pub fn storage_info(app: AppHandle) -> Result<StorageView, String> {
    let store_path =
        nexo_store::default_path().ok_or("Could not locate the application data folder.")?;

    // The WAL and shared-memory sidecars are part of the store: after a busy
    // session the -wal file can be a large fraction of the total, and omitting
    // it would understate what deleting the account would actually reclaim.
    let store_bytes: u64 = ["", "-wal", "-shm"]
        .iter()
        .map(|suffix| {
            let mut path = store_path.clone().into_os_string();
            path.push(suffix);
            std::fs::metadata(std::path::PathBuf::from(path))
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum();

    let cache_bytes = app
        .path()
        .app_cache_dir()
        .map(|dir| directory_size(&dir))
        .unwrap_or(0);

    Ok(StorageView {
        store_path: store_path.display().to_string(),
        store_bytes,
        cache_bytes,
    })
}

/// Bytes under a directory, following it down.
///
/// Unreadable entries are skipped rather than propagated: this feeds a number
/// on a settings panel, and a locked file somewhere in a cache tree is not a
/// reason to show an error instead of a size.
fn directory_size(dir: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => directory_size(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            // Symlinks are not followed: a link out of the cache directory
            // would make this measure something else entirely, and on Windows
            // a directory junction could make it loop.
            _ => 0,
        })
        .sum()
}

/// Clears downloaded media from the WebView's cache (§6.4).
///
/// Only the cache. The encrypted store is untouched, and the button that calls
/// this says so — messages are the store, not the cache, and there is no
/// server-side copy to restore them from.
#[tauri::command]
pub fn clear_media_cache(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("The main window is not open.")?;
    window
        .clear_all_browsing_data()
        .map_err(|e| format!("The cache could not be cleared: {e}"))
}

/// Fetches a link preview for one URL (§4.5).
///
/// Only ever called when the preference is on — the WebView checks that before
/// asking — but the refusals in `preview.rs` are the real control: they run
/// here regardless of who asked or why. See that module for what the fetch
/// will and will not do with a URL that arrived from a stranger.
#[tauri::command]
pub async fn preview_link(url: String) -> Result<crate::preview::PreviewView, String> {
    // A blocking HTTP call with a six-second ceiling: off the async runtime,
    // like every other blocking call in this process.
    tauri::async_runtime::spawn_blocking(move || crate::preview::fetch(&url))
        .await
        .map_err(|e| {
            tracing::error!(%e, "the preview task panicked");
            "Something went wrong. Try again.".to_string()
        })?
        .map_err(|e| e.to_string())
}

/// What an update check found, for the About panel.
#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateView {
    /// The version waiting on the update server.
    pub version: String,
}

/// Asks the update server whether a newer build exists (§8, M9).
///
/// Check only — nothing is downloaded or installed from here. The manifest's
/// minisign signature is verified by the updater plugin against the public key
/// pinned in `tauri.conf.json`, so a compromised update server cannot hand out
/// a build this function would report as real.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateView>, String> {
    let updater = app.updater().map_err(|e| {
        // A dev build has no signing key configured; say so rather than
        // pretending to have checked.
        format!("Updates are not configured in this build: {e}")
    })?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("The update check failed: {e}"))?;
    Ok(update.map(|u| UpdateView { version: u.version }))
}

/// Downloads and installs a waiting update, then restarts the app.
///
/// The download's signature is checked against the pinned public key before a
/// byte of it is run; a manifest the key does not sign is an error, not an
/// install.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Updates are not configured in this build: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("The update check failed: {e}"))?
        .ok_or_else(|| "There is no update waiting.".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("The update could not be installed: {e}"))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_version_matches_the_crate() {
        assert_eq!(super::app_version(), env!("CARGO_PKG_VERSION"));
    }
}
