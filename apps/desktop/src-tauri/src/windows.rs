//! Windows integration (§8): tray, notifications, single instance, autostart.
//!
//! The through-line here is that every one of these features is a way for the
//! app to say something *outside* its own window — on the taskbar, in a toast,
//! in the registry — and each is therefore a small leak of what is happening
//! inside an end-to-end encrypted messenger. So each is either configurable or
//! deliberately minimal:
//!
//! - A toast respects the notification-detail setting, and the default is
//!   sender-only. A preview on a lock screen is the most common way an
//!   encrypted message gets read by someone else.
//! - The tray badge counts unread; it does not name anyone.
//! - Autostart is written to `HKCU`, never `HKLM`. A per-machine key needs
//!   admin, affects other people's accounts, and is not the app's to write.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

/// Window behaviour the user can change while the app runs.
///
/// Managed state rather than a captured bool: the close handler is installed
/// once at startup, but the preference it consults belongs to the person using
/// the app, and they change it in Settings long after setup ran.
#[derive(Debug, Default)]
pub struct WindowPrefs {
    /// Whether closing the window hides to the tray instead of quitting.
    /// Defaults off — see `install_close_to_tray` in `lib.rs`.
    pub close_to_tray: AtomicBool,
}

impl WindowPrefs {
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_close_to_tray(&self, enabled: bool) {
        self.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}

/// How much a Windows toast is allowed to say (§8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationDetail {
    /// Sender and the message text.
    Full,
    /// Sender only. The default.
    ///
    /// A toast is drawn on the lock screen and over screen shares, which is the
    /// most common way a message that was end-to-end encrypted in transit gets
    /// read by the wrong person. Knowing *who* wrote is enough to decide
    /// whether to go and look.
    #[default]
    Sender,
    /// Neither. Just that something arrived.
    None,
}

/// Builds the title and body of a toast, honouring the privacy setting.
///
/// Pure, and separated from the plugin call so the rule can be tested. This is
/// the function that decides what ends up on a lock screen, which makes it
/// worth more than a glance.
pub fn toast_text(detail: NotificationDetail, sender: &str, body: &str) -> (String, String) {
    match detail {
        NotificationDetail::Full => (sender.to_string(), body.to_string()),
        NotificationDetail::Sender => (sender.to_string(), "Sent you a message".to_string()),
        // Not even the sender: a name on a lock screen is enough to reveal a
        // relationship, and for some people that is the thing worth hiding.
        NotificationDetail::None => ("Nexo".to_string(), "New message".to_string()),
    }
}

/// The tray tooltip for a given unread count.
///
/// A count and nothing else. The tray is visible to anyone glancing at the
/// taskbar, so it says how much rather than from whom.
pub fn tray_tooltip(unread: usize) -> String {
    match unread {
        0 => "Nexo".to_string(),
        1 => "Nexo — 1 unread".to_string(),
        n => format!("Nexo — {n} unread"),
    }
}

/// Installs the tray icon and its menu (§8).
pub fn install_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Nexo", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    TrayIconBuilder::with_id("nexo")
        .icon(
            app.default_window_icon().cloned().ok_or_else(|| {
                tauri::Error::AssetNotFound("the window icon is missing".to_string())
            })?,
        )
        .tooltip(tray_tooltip(0))
        .menu(&menu)
        // False, because on Windows the left click is how people expect to get
        // the window back; the menu is the right-click gesture.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Builds the main window from its entry in `tauri.conf.json`.
///
/// That entry says `"create": false` so the window is made here instead, where
/// it can be given the one thing config cannot know: a relay to connect
/// through, chosen at runtime (`via_relay.rs`).
pub fn create_main_window<R: Runtime>(
    app: &AppHandle<R>,
    proxy: Option<tauri::Url>,
) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;
    let mut builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    if let Some(proxy) = proxy {
        builder = builder.proxy_url(proxy);
    }
    builder.build()?;
    Ok(())
}

/// Brings the window back, from the tray or from a second launch.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // Unminimize before show: a window that was minimised to the taskbar
        // stays minimised through `show()` alone, and the click appears to do
        // nothing.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Which desktop backdrop to ask Windows for.
///
/// A choice rather than a fixed order, because the right answer depends on a
/// machine none of us can see. See [`set_backdrop`] for why it cannot simply be
/// decided here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackdropKind {
    /// No backdrop. The app paints its own opaque field.
    Off,
    /// Acrylic: blurs whatever is behind the window, live. What most people
    /// mean by "translucent". Windows 10 v1809+ and Windows 11.
    #[default]
    Acrylic,
    /// Mica: a tint sampled from the *wallpaper*, not from the windows behind.
    /// Cheap, and it does not change when something moves behind the app --
    /// which is worth knowing before calling it broken. Windows 11 only.
    Mica,
    /// Tabbed: Mica's more opaque sibling. Windows 11 only.
    Tabbed,
    /// The old DWM blur-behind. Windows 7 and Windows 10.
    Blur,
}

/// What happened when the backdrop was asked for.
///
/// `applied` is deliberately **not** a promise that the desktop is now visible
/// through the window -- see [`set_backdrop`]. It says the call was made and
/// not refused, which on Windows 11 is all that can honestly be said.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BackdropReport {
    /// The effect that was asked for, as the WebView named it.
    pub requested: BackdropKind,
    /// Whether the call went through without being refused.
    pub applied: bool,
    /// Plain words for the Settings panel. Empty when there is nothing to add.
    pub note: String,
}

/// Asks Windows for a desktop backdrop behind the window.
///
/// # Why this is not CSS
///
/// `backdrop-filter` blurs what is painted *behind an element in the same
/// document*. It cannot reach the desktop: the wallpaper and the other windows
/// are not in the WebView's compositing tree, so no amount of CSS makes them
/// show through. The only thing that can is the desktop window manager.
///
/// # Why this reports rather than decides
///
/// The first version of this picked acrylic, fell back to blur, and returned a
/// `bool`. That bool was a guess wearing a fact's clothes, and the app spent it
/// as one: on `true` it made its own field translucent, so a failed backdrop
/// produced a window that *looked* like glass with nothing behind it.
///
/// The reason the guess cannot be improved is in `window-vibrancy`: from
/// Windows 11 build 22523 on, `apply_acrylic` sets `DWMWA_SYSTEMBACKDROP_TYPE`
/// and returns `Ok(())` **without reading DWM's answer**. There is no result to
/// check. Whether the backdrop is actually visible also depends on how the
/// window was created -- the modern backdrop and the legacy one want opposite
/// things from `transparent` in `tauri.conf.json` -- and that is decided before
/// this function is ever called.
///
/// So this stops pretending. It applies what it was asked for, says so, and
/// Settings shows the answer next to a chooser. The person in front of the
/// machine can see in one second what no amount of guessing from here could
/// establish, and pick the one that works on their Windows.
///
/// # The user's own setting outranks the app's
///
/// Windows has a "Transparency effects" switch, and with it off DWM stops
/// blurring while still accepting the request. It is read first, and a no there
/// is a no here.
#[cfg(windows)]
pub fn set_backdrop<R: Runtime>(app: &AppHandle<R>, kind: BackdropKind) -> BackdropReport {
    let Some(window) = app.get_webview_window("main") else {
        return BackdropReport {
            requested: kind,
            applied: false,
            note: "There is no window to put a backdrop behind.".into(),
        };
    };

    if kind != BackdropKind::Off && !transparency_allowed() {
        let _ = window.run_on_main_thread({
            let window = window.clone();
            move || clear_all(&window)
        });
        return BackdropReport {
            requested: kind,
            applied: false,
            note: "Windows' own transparency effects are switched off, so this \
                   is off too. Settings > Personalisation > Colours."
                .into(),
        };
    }

    // Onto the main thread and back with the answer. Tauri runs a command on a
    // worker thread, and window appearance belongs to the thread that owns the
    // window; Tauri's own `set_effects` hops the same way.
    let (answer, wait) = std::sync::mpsc::channel();
    let target = window.clone();
    if window
        .run_on_main_thread(move || {
            let _ = answer.send(composite(&target, kind));
        })
        .is_err()
    {
        return BackdropReport {
            requested: kind,
            applied: false,
            note: "The window did not answer.".into(),
        };
    }

    // Bounded: the work is one DWM call, and a Settings toggle that waits
    // forever on an event loop that is not answering is worse than one that
    // reports nothing happened.
    match wait.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(Ok(())) => BackdropReport {
            requested: kind,
            applied: kind != BackdropKind::Off,
            note: String::new(),
        },
        Ok(Err(message)) => BackdropReport {
            requested: kind,
            applied: false,
            note: message,
        },
        Err(_) => BackdropReport {
            requested: kind,
            applied: false,
            note: "The window did not answer in time.".into(),
        },
    }
}

/// The DWM call itself, on the main thread.
#[cfg(windows)]
fn composite<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    kind: BackdropKind,
) -> Result<(), String> {
    clear_all(window);
    // `None` for the tint: window-vibrancy then asks DWM for blur and no
    // colour, which leaves every pixel of the app's own colour to the
    // stylesheet. The palette stays in one place (rule 1) instead of being
    // half in CSS and half in an RGBA literal over here.
    let result = match kind {
        BackdropKind::Off => return Ok(()),
        BackdropKind::Acrylic => window_vibrancy::apply_acrylic(window, None),
        BackdropKind::Mica => window_vibrancy::apply_mica(window, None),
        BackdropKind::Tabbed => window_vibrancy::apply_tabbed(window, None),
        BackdropKind::Blur => window_vibrancy::apply_blur(window, None),
    };
    match result {
        Ok(()) => {
            tracing::debug!(?kind, "window backdrop requested");
            Ok(())
        }
        Err(error) => {
            tracing::debug!(?kind, %error, "the window backdrop was refused");
            Err(error.to_string())
        }
    }
}

/// Takes off whatever is currently on, before putting the next one on.
///
/// All four, because the app cannot know which one a previous run left behind
/// and two backdrops on one window is not a defined state.
#[cfg(windows)]
fn clear_all<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window_vibrancy::clear_acrylic(window);
    let _ = window_vibrancy::clear_mica(window);
    let _ = window_vibrancy::clear_tabbed(window);
    let _ = window_vibrancy::clear_blur(window);
}

/// Whether Windows' own "Transparency effects" switch is on.
///
/// Settings > Personalisation > Colours, stored as a DWORD in HKCU. People turn
/// it off for a reason -- a slower machine, a preference for flat surfaces, or
/// motion and transparency being uncomfortable to look at -- and an app that
/// composites anyway is overriding an accessibility choice with a decoration.
///
/// Read at each call rather than cached: the switch can be flipped while the
/// app is running.
///
/// A missing key means yes. The value is absent on a fresh profile that has
/// never opened that page, and defaulting to off there would mean the feature
/// never appeared for most people.
#[cfg(windows)]
fn transparency_allowed() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_value::<u32, _>("EnableTransparency"))
        .map(|value| value != 0)
        .unwrap_or(true)
}

/// The same call away from Windows: there is nothing to composite.
///
/// `pnpm dev` in a browser and the Linux CI build both land here.
#[cfg(not(windows))]
pub fn set_backdrop<R: Runtime>(_app: &AppHandle<R>, kind: BackdropKind) -> BackdropReport {
    BackdropReport {
        requested: kind,
        applied: false,
        note: "Desktop backdrops are a Windows feature.".into(),
    }
}

/// Undoes everything this app put outside its own window for one account.
///
/// Called on sign-out. Two things, and each was a real leftover:
///
/// - The **tray tooltip**, which the sync agent writes with the unread count.
///   The agent stops when the shell unmounts, so without this the taskbar goes
///   on reporting "Nexo — 4 unread" for a mailbox that no longer exists on this
///   machine, to whoever sits down next.
/// - The **startup entry** in `HKCU`. Someone who signs out on a machine they
///   are handing over should not have left it launching a messenger every time
///   the next person logs in. Turning it back on is one switch in Settings, and
///   it is the new account's decision to make, not the old one's.
///
/// Neither failure is worth refusing the sign-out over -- the store and the
/// keys are already gone by the time this runs, which is the part that
/// mattered -- so both are logged and stepped over.
pub fn forget_account<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tray) = app.tray_by_id("nexo")
        && let Err(error) = tray.set_tooltip(Some(tray_tooltip(0)))
    {
        tracing::debug!(%error, "the tray tooltip could not be reset");
    }

    // Desktop only: Android has no startup entry to remove, because it has
    // no such thing to create.
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt as _;
        if let Err(error) = app.autolaunch().disable() {
            tracing::debug!(%error, "the startup entry could not be removed");
        }
    }
}

/// Decides what a window close should do.
///
/// Extracted so the rule is testable without a window. It is small, but
/// getting it wrong in either direction is bad: an app that quits when someone
/// meant to tuck it away stops delivering messages, and one that hides when
/// they meant to quit looks like it ignored them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide to the tray and keep running.
    HideToTray,
    /// Actually exit.
    Quit,
}

pub fn close_action(close_to_tray: bool, quitting: bool) -> CloseAction {
    // `quitting` wins. Once Quit has been chosen from the tray menu, a close
    // event must not put the window back into hiding -- that is how an app
    // becomes impossible to shut down.
    if quitting || !close_to_tray {
        CloseAction::Quit
    } else {
        CloseAction::HideToTray
    }
}

/// Wires close-to-tray onto the main window.
///
/// The preference is read from [`WindowPrefs`] at the moment of each close,
/// not captured at install time: Settings changes it while the app runs, and a
/// captured bool would honour the value from launch until quit.
pub fn install_close_to_tray<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            // `is_quitting` is not tracked here yet -- the tray's Quit calls
            // `app.exit`, which does not raise CloseRequested -- so the only
            // decision left is the preference.
            let close_to_tray = handle.state::<WindowPrefs>().close_to_tray();
            if close_action(close_to_tray, false) == CloseAction::HideToTray {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sender_only_toast_does_not_carry_the_message() {
        // The default, and the reason it is the default: this text is drawn on
        // a lock screen.
        let (title, body) = toast_text(
            NotificationDetail::Sender,
            "Skylar",
            "the password is hunter2",
        );
        assert_eq!(title, "Skylar");
        assert!(!body.contains("hunter2"), "the message leaked: {body}");
    }

    #[test]
    fn the_quietest_setting_names_nobody() {
        // A name alone reveals a relationship, which for some people is the
        // thing worth hiding.
        let (title, body) = toast_text(NotificationDetail::None, "Skylar", "anything");
        assert!(!title.contains("Skylar"));
        assert!(!body.contains("Skylar"));
        assert!(!body.contains("anything"));
    }

    #[test]
    fn the_fullest_setting_says_everything_it_promises() {
        let (title, body) = toast_text(NotificationDetail::Full, "Skylar", "on my way");
        assert_eq!(title, "Skylar");
        assert_eq!(body, "on my way");
    }

    #[test]
    fn sender_only_is_the_default() {
        assert_eq!(NotificationDetail::default(), NotificationDetail::Sender);
    }

    #[test]
    fn the_tray_says_how_many_not_from_whom() {
        assert_eq!(tray_tooltip(0), "Nexo");
        assert_eq!(tray_tooltip(1), "Nexo — 1 unread");
        assert_eq!(tray_tooltip(12), "Nexo — 12 unread");
    }

    #[test]
    fn quitting_always_beats_close_to_tray() {
        // Otherwise Quit from the tray menu would hide the window instead, and
        // the app could not be shut down.
        assert_eq!(close_action(true, true), CloseAction::Quit);
        assert_eq!(close_action(false, true), CloseAction::Quit);
    }

    #[test]
    fn close_to_tray_hides_only_when_it_is_on() {
        assert_eq!(close_action(true, false), CloseAction::HideToTray);
        assert_eq!(close_action(false, false), CloseAction::Quit);
    }

    #[test]
    fn close_to_tray_starts_off_and_can_be_changed() {
        // Off by default: someone who closes a window and finds the app still
        // running has been surprised by their own computer.
        let prefs = WindowPrefs::default();
        assert!(!prefs.close_to_tray());
        prefs.set_close_to_tray(true);
        assert!(prefs.close_to_tray());
        prefs.set_close_to_tray(false);
        assert!(!prefs.close_to_tray());
    }
}
