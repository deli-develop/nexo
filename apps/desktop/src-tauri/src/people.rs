//! Finding people, letting them in, and reporting them — across the IPC seam.
//!
//! What is left of `meet.rs` after the map was removed. Nothing new crosses
//! here: a handle, a display name and an invitation's label are plaintext
//! already, and the invitation secret is minted by the server rather than
//! derived from anything this side holds. There is no key material in this
//! file, so invariant 2 is untouched.

use serde::Serialize;
use tauri::State;

use nexo_client::people::{self, Context};

use crate::client::ClientState;

/// Why a people call failed, as the page sees it.
#[derive(Debug, Serialize)]
pub struct PeopleErrorView {
    pub kind: &'static str,
    pub message: String,
}

fn failure(kind: &'static str, message: impl Into<String>) -> PeopleErrorView {
    PeopleErrorView {
        kind,
        message: message.into(),
    }
}

impl From<people::PeopleError> for PeopleErrorView {
    fn from(error: people::PeopleError) -> Self {
        use nexo_client::transport::TransportError;
        // The detail goes to the log; the page gets the summary.
        tracing::warn!(%error, "people call failed");
        match &error {
            people::PeopleError::Transport(TransportError::Unreachable(_)) => {
                failure("unreachable", "Can't reach the server.")
            }
            people::PeopleError::Transport(TransportError::InvalidCredentials) => {
                failure("signed_out", "Your session expired. Sign in again.")
            }
            people::PeopleError::Transport(TransportError::NotFound) => {
                failure("not_found", "That is not there.")
            }
            people::PeopleError::Transport(TransportError::Rejected(detail)) => {
                failure("rejected", detail.clone())
            }
            _ => failure("internal", "Something went wrong. Try again."),
        }
    }
}

/// Runs a blocking closure against the signed-in client.
///
/// One helper, so no command can forget the lock or the `spawn_blocking`.
async fn with_client<T, F>(state: &ClientState, work: F) -> Result<T, PeopleErrorView>
where
    T: Send + 'static,
    F: FnOnce(&crate::client::LoggedIn) -> Result<T, PeopleErrorView> + Send + 'static,
{
    let handle = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = handle
            .lock()
            .map_err(|_| failure("internal", "The client is unavailable."))?;
        let client = guard
            .as_ref()
            .ok_or_else(|| failure("signed_out", "You are not signed in."))?;
        let outcome = work(client);

        // An access token ages on the clock, so the transport may have traded
        // the refresh token for a new pair mid-call. Writing the new one down
        // is not optional: whatever is stored is what the next resume replays,
        // and a spent refresh token is what the server reads as theft -- it
        // revokes every session for the account. Every path that talks to the
        // server does this; the one that forgot was the map, and a rotation
        // that happened to land on one of its calls was the one that went
        // missing.
        if let Some(rotated) = client.transport.take_rotated_refresh_token()
            && let Err(error) = client.store.set_refresh_token(&rotated)
        {
            tracing::error!(%error, "could not persist a rotated refresh token");
        }

        outcome
    })
    .await
    .map_err(|_| failure("internal", "That did not finish."))?
}

/// Somebody a search turned up.
#[derive(Debug, Serialize)]
pub struct SearchResultView {
    pub handle: String,
    pub display_name: String,
    pub avatar_key: Option<String>,
}

/// Find people. Public accounts only — the server decides that, not this.
#[tauri::command]
pub async fn search_users(
    state: State<'_, ClientState>,
    term: String,
) -> Result<Vec<SearchResultView>, PeopleErrorView> {
    with_client(&state, move |client| {
        let found = people::search(
            &Context {
                transport: &*client.transport,
            },
            &term,
        )?;
        Ok(found
            .into_iter()
            .map(|r| SearchResultView {
                handle: r.handle,
                display_name: r.display_name,
                avatar_key: r.avatar_key,
            })
            .collect())
    })
    .await
}

/// A freshly minted invitation. The secret is readable exactly once.
#[derive(Debug, Serialize)]
pub struct MintedInviteView {
    pub id: i64,
    pub secret: String,
    pub expires_at_ms: i64,
}

/// One invitation afterwards.
#[derive(Debug, Serialize)]
pub struct InviteView {
    pub id: i64,
    pub label: Option<String>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub revoked: bool,
    pub live: bool,
    pub used: i64,
}

/// Mint an invitation, at most seven days.
#[tauri::command]
pub async fn create_invite(
    state: State<'_, ClientState>,
    label: Option<String>,
    days: i64,
) -> Result<MintedInviteView, PeopleErrorView> {
    with_client(&state, move |client| {
        let minted = people::create_invite(
            &Context {
                transport: &*client.transport,
            },
            label.as_deref(),
            days,
        )?;
        Ok(MintedInviteView {
            id: minted.id,
            secret: minted.secret,
            expires_at_ms: minted.expires_at_ms,
        })
    })
    .await
}

/// My invitations.
#[tauri::command]
pub async fn invites(state: State<'_, ClientState>) -> Result<Vec<InviteView>, PeopleErrorView> {
    with_client(&state, |client| {
        let list = people::invites(&Context {
            transport: &*client.transport,
        })?;
        Ok(list
            .into_iter()
            .map(|i| InviteView {
                id: i.id,
                label: i.label,
                created_at_ms: i.created_at_ms,
                expires_at_ms: i.expires_at_ms,
                revoked: i.revoked,
                live: i.live,
                used: i.used,
            })
            .collect())
    })
    .await
}

/// Withdraw an invitation.
#[tauri::command]
pub async fn revoke_invite(state: State<'_, ClientState>, id: i64) -> Result<(), PeopleErrorView> {
    with_client(&state, move |client| {
        people::revoke_invite(
            &Context {
                transport: &*client.transport,
            },
            id,
        )?;
        Ok(())
    })
    .await
}

/// Report somebody.
///
/// `subject_kind` and `subject_id` rather than a handle, because the server's
/// reports table covers posts and comments too. The caller resolves a handle
/// to an id through the profile it is already showing.
#[tauri::command]
pub async fn report(
    state: State<'_, ClientState>,
    subject_kind: String,
    subject_id: i64,
    reason: String,
    note: Option<String>,
) -> Result<(), PeopleErrorView> {
    with_client(&state, move |client| {
        people::report(
            &Context {
                transport: &*client.transport,
            },
            &subject_kind,
            subject_id,
            &reason,
            note.as_deref(),
        )?;
        Ok(())
    })
    .await
}
