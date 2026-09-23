//! Tauri commands — the entire surface the WebView can reach.
//!
//! Every command here is a deliberate hole in an otherwise closed wall. Adding
//! one means adding a permission to capabilities/default.json, so the two
//! files should always be read together.

use tauri::{AppHandle, Manager, State};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt;
#[cfg(desktop)]
use tauri_plugin_updater::UpdaterExt as _;

use crate::relay::{Relay, RelayInfo};
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
#[cfg(desktop)]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("The startup entry could not be read: {e}"))
}

/// There is no such thing on a phone, and saying so is the honest answer.
///
/// `false` rather than an error: the settings screen hides the toggle when
/// this is false, and an error there would be a red line about a feature the
/// platform does not have.
#[tauri::command]
#[cfg(mobile)]
pub fn get_autostart(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}

/// Turns start-with-Windows on or off (§8).
///
/// HKCU, never HKLM: the plugin writes the per-user `Run` key, which needs no
/// admin and touches nobody else's account.
#[tauri::command]
#[cfg(desktop)]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| format!("The startup entry could not be changed: {e}"))
}

#[tauri::command]
#[cfg(mobile)]
pub fn set_autostart(_app: AppHandle, _enabled: bool) -> Result<(), String> {
    Err("Android decides when apps start.".to_string())
}

/// Forgets what the shell knows about the account that just signed out.
///
/// Two things, and neither is in the page's gift: the tray tooltip still says
/// how many unread messages the last account had, and the startup entry still
/// launches the app for whoever logs in next. Somebody handing over a machine
/// should not leave it opening a messenger for the next person.
///
/// Infallible from the caller's side. The store and the keys are already gone
/// by the time this runs -- which is the part that mattered -- so a tray that
/// will not update is logged and stepped over rather than turned into a
/// sign-out that appears to have failed.
#[tauri::command]
pub fn forget_account(app: AppHandle) {
    crate::windows::forget_account(&app);
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
#[cfg(desktop)]
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
#[cfg(desktop)]
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

// ------------------------------------------------------------------ relay

/// Starts relaying for other people, or answers the relay already running.
/// `0` picks a free port. What it forwards, and what it refuses, is in
/// `relay.rs`.
#[tauri::command]
pub async fn start_relay(relay: State<'_, Relay>, port: u16) -> Result<RelayInfo, String> {
    relay.start(port).await
}

/// Closes the relay and every tunnel through it. `false` when none was
/// running.
#[tauri::command]
pub fn stop_relay(relay: State<'_, Relay>) -> bool {
    relay.stop()
}

/// The running relay's port, or `None`.
#[tauri::command]
pub fn relay_status(relay: State<'_, Relay>) -> Option<RelayInfo> {
    relay.status()
}

/// The store updates the app on a phone, and it is not this app's business.
///
/// `None` rather than an error, for the same reason `get_autostart` answers
/// `false`: the About panel hides the Check button when there is nothing to
/// check, and an error there would report a fault where there is none.
#[tauri::command]
#[cfg(mobile)]
pub async fn check_update(_app: AppHandle) -> Result<Option<UpdateView>, String> {
    Ok(None)
}

#[tauri::command]
#[cfg(mobile)]
pub async fn install_update(_app: AppHandle) -> Result<(), String> {
    Err("Updates come from the store on this platform.".to_string())
}
