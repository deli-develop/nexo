//! The auth commands, and the IPC boundary they sit on.
//!
//! Rule 2: no key material in the WebView. What crosses this boundary is a
//! handle, a display name, and — inbound only, once, never stored and never
//! echoed — a password. What comes back is an account and nothing else.
//!
//! In particular the WebView never sees:
//!
//! - the identity private key, which is generated and stored on this side;
//! - the SQLCipher key, which never leaves the OS keystore unwrapped;
//! - the access or refresh token, which live in [`SessionState`] in this
//!   process. A token in the WebView is a token in reach of any script that
//!   ever gets to run there.

use std::sync::Mutex;

use nexo_client::transport::Transport as _;
use nexo_client::transport::TransportError;
use nexo_client::{HttpTransport, Session, SessionError, conversations, pin, session};
use nexo_platform::dpapi::DpapiStore;
use serde::Serialize;
use tauri::State;

use crate::client::{self, ClientState};

/// Tokens for the current session, held on the Rust side only.
#[derive(Default)]
pub struct SessionState(pub Mutex<Option<Session>>);

/// What the UI is told about the signed-in account.
///
/// The shape is chosen by subtraction: everything the UI genuinely needs to
/// render, and nothing else. No tokens, no key material, no salt.
#[derive(Debug, Clone, Serialize)]
pub struct AccountView {
    pub user_id: i64,
    pub handle: String,
    pub display_name: String,
    pub device_id: String,
}

impl From<nexo_store::Account> for AccountView {
    fn from(a: nexo_store::Account) -> Self {
        Self {
            user_id: a.user_id,
            handle: a.handle,
            display_name: a.display_name,
            device_id: a.device_id,
        }
    }
}

/// An error the UI can act on.
///
/// `kind` is for branching, `message` is for showing. Splitting them keeps the
/// UI from matching on prose, which is how a copy edit becomes a behaviour
/// change.
#[derive(Debug, Serialize)]
pub struct AuthErrorView {
    pub kind: &'static str,
    pub message: String,
}

impl From<SessionError> for AuthErrorView {
    fn from(error: SessionError) -> Self {
        // Log the detail, hand the user the summary. Errors from this path can
        // carry a file path or a database message; neither belongs on screen.
        tracing::warn!(%error, "auth failed");
        let (kind, message) = match &error {
            SessionError::Transport(TransportError::InvalidCredentials) => (
                "invalid_credentials",
                "That handle and password do not match an account.".to_string(),
            ),
            SessionError::Transport(TransportError::HandleTaken) => {
                ("handle_taken", "That handle is already taken.".to_string())
            }
            SessionError::Transport(TransportError::WrongPassword) => (
                "wrong_password",
                "That is not your current password.".to_string(),
            ),
            SessionError::Transport(TransportError::Unreachable(_)) => (
                "unreachable",
                "Can't reach the server. Check your connection and try again.".to_string(),
            ),
            SessionError::Transport(TransportError::Rejected(detail)) => {
                ("rejected", detail.clone())
            }
            SessionError::DifferentAccount(handle) => (
                "different_account",
                format!(
                    "This device is still signed in as @{handle}. Sign in as @{handle} and                      sign out to clear its messages from this machine first — they are the                      only copy, and the server keeps none."
                ),
            ),
            SessionError::Store(nexo_store::StoreError::WrongKey { .. }) => (
                "store_unreadable",
                "This machine's local data can't be opened. Signing in again will start a \
                 fresh local store."
                    .to_string(),
            ),
            _ => ("internal", "Something went wrong. Try again.".to_string()),
        };
        Self { kind, message }
    }
}

/// Records a new session in both pieces of state.
///
/// The tokens go in `SessionState`; the assembled client — provider, store,
/// signer, credential — goes in `ClientState`. Both are set together, so there
/// is never a window where one says signed in and the other does not.
async fn install(
    state: &State<'_, SessionState>,
    client_state: &State<'_, ClientState>,
    session: Session,
) -> Result<(), AuthErrorView> {
    let transport = HttpTransport::new();
    transport.set_access_token(&session.access_token);
    // An access token lives fifteen minutes and ages on the clock, not on
    // idleness. Handing the refresh token over is what lets the transport
    // replace it in place instead of every request failing until a restart.
    transport.set_refresh_token(&session.refresh_token);

    let for_state = Session {
        account: session.account.clone(),
        access_token: session.access_token.clone(),
        refresh_token: session.refresh_token.clone(),
    };

    let slot = client_state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let logged_in = client::build(session, transport).map_err(|e| {
            tracing::error!(%e, "assembling the signed-in client failed");
            AuthErrorView {
                kind: "internal",
                message: "Something went wrong. Try again.".to_string(),
            }
        })?;
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(logged_in);
        }
        Ok::<(), AuthErrorView>(())
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "install task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })??;

    *state.0.lock().expect("session lock") = Some(for_state);
    Ok(())
}

/// Publishes KeyPackages for the device that just signed in.
///
/// **Both** register and login need this, and for a long time only register did
/// it. That was invisible while a replaced device's packages stayed claimable:
/// a reinstalled account was reachable through the *old* device's supply, which
/// meant the Welcome went somewhere the new device could not read. Retiring
/// those packages fixed the silent half and exposed this one -- a freshly
/// signed-in device published nothing, so nobody could start a conversation
/// with it at all.
///
/// Not fatal. The account exists and the user is signed in; the periodic refill
/// retries. But it is warned about, because the failure is otherwise invisible:
/// the other person is simply told there is no key package for that handle,
/// with no way to learn why.
async fn publish_key_packages_for(client_state: &State<'_, ClientState>, when: &str) {
    let handle = client_state.0.clone();
    let problem = tauri::async_runtime::spawn_blocking(move || {
        let guard = handle.lock().ok()?;
        let logged_in = guard.as_ref()?;
        conversations::publish_key_packages(&logged_in.context(), nexo_crypto::KEY_PACKAGE_TARGET)
            .err()
            .map(|e| e.to_string())
    })
    .await
    .ok()
    .flatten();

    if let Some(error) = problem {
        tracing::warn!(%error, %when, "publishing key packages failed");
    }
}

/// Where the encrypted store lives, or an error the UI can show.
fn store_path() -> Result<std::path::PathBuf, AuthErrorView> {
    nexo_store::default_path().ok_or(AuthErrorView {
        kind: "internal",
        message: "Could not locate the application data folder.".to_string(),
    })
}

fn keystore() -> Result<DpapiStore, AuthErrorView> {
    DpapiStore::new().map_err(|e| {
        tracing::error!(%e, "keystore unavailable");
        AuthErrorView {
            kind: "internal",
            message: "The Windows credential store is unavailable.".to_string(),
        }
    })
}

/// Creates an account.
///
/// `password` arrives from the WebView, is turned into an Argon2id verifier
/// here, and is dropped when this function returns. It is never stored, never
/// logged, and never sent — only the verifier leaves the machine.
#[tauri::command]
pub async fn register(
    state: State<'_, SessionState>,
    client_state: State<'_, ClientState>,
    handle: String,
    display_name: String,
    password: String,
) -> Result<AccountView, AuthErrorView> {
    let path = store_path()?;
    let keystore = keystore()?;

    // Argon2id at 64 MiB, SQLCipher and DPAPI are all blocking. Doing them on
    // the async runtime would stall every other task in the process; this is
    // the boundary the client crate's blocking design expects.
    let session = tauri::async_runtime::spawn_blocking(move || {
        let transport = HttpTransport::new();
        session::register(
            &transport,
            &keystore,
            &path,
            &handle,
            &display_name,
            &password,
        )
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "register task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })??;

    let account = AccountView::from(session.account.clone());
    let user_id = account.user_id;
    install(&state, &client_state, session).await?;

    publish_key_packages_for(&client_state, "registration").await;

    tracing::info!(user_id, "registered");
    Ok(account)
}

/// Signs in to an existing account.
#[tauri::command]
pub async fn login(
    state: State<'_, SessionState>,
    client_state: State<'_, ClientState>,
    handle: String,
    password: String,
) -> Result<AccountView, AuthErrorView> {
    let path = store_path()?;
    let keystore = keystore()?;

    let session = tauri::async_runtime::spawn_blocking(move || {
        let transport = HttpTransport::new();
        session::login(&transport, &keystore, &path, &handle, &password)
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "login task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })??;

    let account = AccountView::from(session.account.clone());
    let user_id = account.user_id;
    install(&state, &client_state, session).await?;

    // Signing in on a machine with no local store generates a fresh identity
    // keypair, which is a new device with an empty supply. Without this it is
    // an account nobody can start a conversation with.
    publish_key_packages_for(&client_state, "sign-in").await;

    tracing::info!(user_id, "signed in");
    Ok(account)
}

/// The three answers [`restore_session`] can give, kept apart so the offline
/// case is not confused with the signed-out one.
enum Outcome {
    Active(AccountView),
    SignedOut,
    Offline,
}

/// The account this installation is signed in as, if any.
///
/// Called once at startup. Two steps, and the order matters:
///
/// 1. **Resume.** Trade the stored refresh token for a fresh access token, so
///    the account is reachable, and assemble the full client.
/// 2. **Fall back to restore, but only when offline.** A server that cannot be
///    reached is no reason to throw the user out: read the account from disk
///    and let the app open to its own history. A token the server *rejected*
///    is the opposite case and answers `None`, because reporting an account
///    whose commands all fail with "You are not signed in" tells the user two
///    contradictory things at once.
#[tauri::command]
pub async fn restore_session(
    client_state: State<'_, ClientState>,
) -> Result<Option<AccountView>, AuthErrorView> {
    let slot = client_state.0.clone();

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let resumed = client::resume().map_err(|e| {
            tracing::error!(%e, "resuming failed");
            AuthErrorView {
                kind: "internal",
                message: "Something went wrong. Try again.".to_string(),
            }
        })?;
        Ok::<Outcome, AuthErrorView>(match resumed {
            client::Resumed::Active(logged_in) => {
                let account = AccountView::from(logged_in.session.account.clone());
                // A client that cannot be stored is not a session. Saying so
                // beats reporting an account the commands behind it will refuse.
                let Ok(mut guard) = slot.lock() else {
                    tracing::error!("the client state lock was poisoned");
                    return Ok(Outcome::SignedOut);
                };
                *guard = Some(*logged_in);
                Outcome::Active(account)
            }
            client::Resumed::SignedOut => Outcome::SignedOut,
            client::Resumed::Offline => Outcome::Offline,
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "restore task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })??;

    match outcome {
        Outcome::Active(account) => return Ok(Some(account)),
        // The stored token was rejected, so there is no session to report. The
        // sign-in screen is the honest answer, and the only one the user can
        // act on.
        Outcome::SignedOut => return Ok(None),
        Outcome::Offline => {}
    }

    // Offline only. Answer from disk alone: the account is still ours, and the
    // app opens to its own history rather than to a prompt it cannot satisfy.
    let path = store_path()?;
    let keystore = keystore()?;
    let account = tauri::async_runtime::spawn_blocking(move || session::restore(&keystore, &path))
        .await
        .map_err(|e| {
            tracing::error!(%e, "restore task panicked");
            AuthErrorView {
                kind: "internal",
                message: "Something went wrong. Try again.".to_string(),
            }
        })??;

    Ok(account.map(AccountView::from))
}

/// Changes the account password (§6.4).
///
/// Both passwords arrive from the WebView, are turned into Argon2id verifiers
/// here, and are dropped when this function returns. Neither is stored, logged
/// or sent — only the verifiers leave the machine, and the current one has to
/// be among them because a bearer token proves possession of a session, not
/// knowledge of the password. Without that, an unattended unlocked machine
/// would be enough to lock its owner out of their own account.
///
/// Nothing local changes. The SQLCipher key comes from the OS keystore rather
/// than from the password, so no history is re-encrypted and none can be lost.
#[tauri::command]
pub async fn change_password(
    client_state: State<'_, ClientState>,
    current_password: String,
    new_password: String,
) -> Result<(), AuthErrorView> {
    let handle = {
        let guard = client_state.0.lock().map_err(|_| AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        })?;
        let logged_in = guard.as_ref().ok_or(AuthErrorView {
            kind: "signed_out",
            message: "You are not signed in.".to_string(),
        })?;
        logged_in.session.account.handle.clone()
    };

    // Two Argon2id derivations at 64 MiB, and a network round trip. Both
    // belong off the async runtime; the transport is built here rather than
    // borrowed from the guard because the guard cannot be held across an await.
    tauri::async_runtime::spawn_blocking(move || {
        let transport = HttpTransport::new();
        session::change_password(&transport, &handle, &current_password, &new_password)
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "change-password task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })??;

    tracing::info!("password changed");
    Ok(())
}

/// This device's identity fingerprint, for the Security screen (brief 4.1).
///
/// Read from the identity keypair in the encrypted store, so the digits on
/// screen are the real key or there are none. `None` means no identity key has
/// been written yet; the screen says so rather than showing placeholder digits,
/// because the whole instruction on that screen is to compare them in person.
///
/// Only the *public* half is touched. Nothing derived here can reconstruct the
/// secret, which is why this may cross the IPC boundary at all.
#[tauri::command]
pub async fn device_fingerprint(
    client_state: State<'_, ClientState>,
) -> Result<Option<String>, AuthErrorView> {
    // A single indexed read and two SHA-256s: short enough to do under the
    // lock, and there is no await here for the guard to be held across.
    let guard = client_state.0.lock().map_err(|_| AuthErrorView {
        kind: "internal",
        message: "Something went wrong. Try again.".to_string(),
    })?;
    let logged_in = guard.as_ref().ok_or(AuthErrorView {
        kind: "signed_out",
        message: "You are not signed in.".to_string(),
    })?;
    Ok(session::device_fingerprint(&logged_in.store)?)
}

/// Whether an unlock PIN is set, and how many tries remain.
#[tauri::command]
pub async fn pin_status() -> Result<PinStatusView, AuthErrorView> {
    let keystore = keystore()?;
    let status = pin::status(&keystore).map_err(pin_failed)?;
    Ok(PinStatusView {
        set: status.set,
        attempts_left: status.attempts_left,
    })
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct PinStatusView {
    pub set: bool,
    pub attempts_left: u8,
}

/// Sets or replaces the unlock PIN.
///
/// The digits are turned into a verifier here and dropped when this returns.
/// What is written down is salted Argon2id output, wrapped by the OS keystore
/// — so it is bound to this Windows account as well as to the PIN.
#[tauri::command]
pub async fn set_pin(pin: String) -> Result<(), AuthErrorView> {
    let keystore = keystore()?;
    pin::set(&keystore, pin.trim()).map_err(pin_failed)
}

/// Forgets the PIN. The password becomes the only way past the lock screen.
#[tauri::command]
pub async fn clear_pin() -> Result<(), AuthErrorView> {
    let keystore = keystore()?;
    pin::clear(&keystore).map_err(pin_failed)
}

/// Unlocks with the PIN.
///
/// Only ever a *re*-open: locking dropped the client, and this rebuilds it from
/// what is already on this machine. It never creates a session — a wrong PIN,
/// or one guessed too many times, leaves the lock screen exactly where it was
/// and the password is still the way through.
#[tauri::command]
pub async fn unlock_with_pin(
    client_state: State<'_, ClientState>,
    pin: String,
) -> Result<Option<AccountView>, AuthErrorView> {
    let keystore = keystore()?;
    let pin = pin.trim().to_string();

    let ok = tauri::async_runtime::spawn_blocking(move || pin::verify(&keystore, &pin))
        .await
        .map_err(|e| {
            tracing::error!(%e, "pin check panicked");
            AuthErrorView {
                kind: "internal",
                message: "Something went wrong. Try again.".to_string(),
            }
        })?
        .map_err(pin_failed)?;

    if !ok {
        return Ok(None);
    }

    // The same path a restart takes. The PIN proved who is at the keyboard; it
    // is not a credential the server has ever heard of, and nothing here
    // pretends otherwise.
    let slot = client_state.0.clone();
    let account = tauri::async_runtime::spawn_blocking(move || {
        let resumed = client::resume().map_err(|e| {
            tracing::error!(%e, "resuming after a PIN unlock failed");
            AuthErrorView {
                kind: "internal",
                message: "Something went wrong. Try again.".to_string(),
            }
        })?;
        let client::Resumed::Active(logged_in) = resumed else {
            return Ok::<Option<AccountView>, AuthErrorView>(None);
        };
        let account = AccountView::from(logged_in.session.account.clone());
        let Ok(mut guard) = slot.lock() else {
            return Ok(None);
        };
        *guard = Some(*logged_in);
        Ok(Some(account))
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "unlock task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })??;

    Ok(account)
}

fn pin_failed(error: pin::PinError) -> AuthErrorView {
    tracing::warn!(%error, "pin");
    match error {
        pin::PinError::Locked => AuthErrorView {
            kind: "pin_locked",
            message: "Too many attempts. Sign in with your password.".to_string(),
        },
        pin::PinError::Invalid(message) => AuthErrorView {
            kind: "invalid_request",
            message,
        },
        _ => AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        },
    }
}

/// Signs out and destroys the local store and its key.
///
/// The local wipe happens even if the server call fails: someone signing out on
/// a machine they are handing over cares about the disk, not about whether a
/// token somewhere expires in fifteen minutes.
#[tauri::command]
pub async fn logout(
    app: tauri::AppHandle,
    state: State<'_, SessionState>,
    client_state: State<'_, ClientState>,
) -> Result<(), AuthErrorView> {
    let path = store_path()?;
    let keystore = keystore()?;

    let refresh_token = state
        .0
        .lock()
        .expect("session lock")
        .as_ref()
        .map(|s| s.refresh_token.clone())
        .unwrap_or_default();

    // Everything in memory goes *before* the wipe, not after, and the order is
    // the whole point on Windows.
    //
    // `LoggedIn` owns the `EncryptedStore`, which owns an open handle to
    // `store.db`. Windows refuses to unlink a file that is still open, so
    // deleting the store while this state was alive failed with `os error 32`
    // -- and because the wipe is written as `delete(...)?`, that failure also
    // skipped erasing the store key and the unlock PIN below it. Sign-out then
    // reported success while the database, the DPAPI-wrapped key that opens it
    // and the PIN were all still on disk: exactly the outcome the dialog
    // promises does not happen.
    //
    // Dropping the client first closes the connection, so the unlink succeeds.
    // Doing it before the server call as well costs nothing: the tokens are
    // dead either way, and `session::logout` wipes whatever the server says.
    *state.0.lock().expect("session lock") = None;
    if let Ok(mut guard) = client_state.0.lock() {
        *guard = None;
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let transport = HttpTransport::new();
        session::logout(&transport, &keystore, &path, &refresh_token)
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "logout task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })?;

    // And everything this app put *outside* its own window.
    //
    // Signing out used to leave two traces on the machine, and both outlived
    // the account they belonged to: a tray icon still counting somebody's
    // unread messages, and a registry entry launching Nexo at every login for
    // a person who had just left. Neither is dangerous on its own; together
    // they are the difference between "signed out" and "signed out except for
    // the parts you can see from the desktop".
    crate::windows::forget_account(&app);

    tracing::info!("signed out");
    result.map_err(AuthErrorView::from)
}

/// Deletes the account on the server, then wipes this machine.
///
/// The order is the opposite of [`logout`]'s and the reasoning is spelled out
/// in `session::delete_account`: wiping first and then failing would leave an
/// account that still exists, that nothing here can reach, and that has no
/// recovery.
///
/// The password crosses the IPC boundary and nothing else does. It is turned
/// into a verifier inside the core and never sent, stored or logged — the same
/// path `change_password` takes, for the same reason.
#[tauri::command]
pub async fn delete_account(
    app: tauri::AppHandle,
    state: State<'_, SessionState>,
    client_state: State<'_, ClientState>,
    handle: String,
    password: String,
) -> Result<(), AuthErrorView> {
    let path = store_path()?;
    let keystore = keystore()?;

    // Two halves, with the store closed in between, and the order is forced
    // from both ends. The server has to answer first -- wiping locally and
    // then being refused would leave an account that still exists and that
    // nothing here can reach. But the database cannot be unlinked on Windows
    // while `LoggedIn` still holds it open, so the handles have to go before
    // the wipe. The only moment that satisfies both is between the two.
    tauri::async_runtime::spawn_blocking(move || {
        let transport = HttpTransport::new();
        session::delete_account_on_server(&transport, &handle, &password)
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "delete-account task panicked");
        AuthErrorView {
            kind: "internal",
            message: "Something went wrong. Try again.".to_string(),
        }
    })?
    .map_err(AuthErrorView::from)?;

    // The account is gone on the server. Close everything this process holds
    // before asking the filesystem to remove it.
    *state.0.lock().expect("session lock") = None;
    if let Ok(mut guard) = client_state.0.lock() {
        *guard = None;
    }

    tauri::async_runtime::spawn_blocking(move || session::wipe_local(&keystore, &path))
        .await
        .map_err(|e| {
            tracing::error!(%e, "wipe task panicked");
            AuthErrorView {
                kind: "internal",
                message: "Something went wrong. Try again.".to_string(),
            }
        })?
        .map_err(AuthErrorView::from)?;

    crate::windows::forget_account(&app);

    tracing::info!("account deleted");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_view_carries_no_secrets() {
        let account = nexo_store::Account {
            user_id: 1,
            handle: "alice".into(),
            display_name: "Alice".into(),
            device_id: "device".into(),
        };
        let json = serde_json::to_string(&AccountView::from(account)).unwrap();
        for forbidden in ["token", "secret", "key\"", "salt", "verifier"] {
            assert!(
                !json.contains(forbidden),
                "`{forbidden}` must not cross the IPC boundary: {json}"
            );
        }
    }

    #[test]
    fn errors_carry_a_machine_readable_kind() {
        // The UI branches on `kind`, so a copy edit to `message` must not be
        // able to change behaviour.
        let view = AuthErrorView::from(SessionError::Transport(TransportError::InvalidCredentials));
        assert_eq!(view.kind, "invalid_credentials");

        let view = AuthErrorView::from(SessionError::Transport(TransportError::HandleTaken));
        assert_eq!(view.kind, "handle_taken");

        let view = AuthErrorView::from(SessionError::Transport(TransportError::Unreachable(
            "connection refused to 10.0.0.1".into(),
        )));
        assert_eq!(view.kind, "unreachable");
        // And the network detail is not repeated at the user.
        assert!(!view.message.contains("10.0.0.1"));
    }

    #[test]
    fn an_unreachable_server_does_not_read_as_a_wrong_password() {
        let view = AuthErrorView::from(SessionError::Transport(TransportError::Unreachable(
            "timed out".into(),
        )));
        assert_ne!(view.kind, "invalid_credentials");
        assert!(view.message.to_lowercase().contains("server"));
    }
}
