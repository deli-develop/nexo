//! The live socket, from the shell's side.
//!
//! `nexo_client::stream` owns the connection; this module owns *when* there is
//! one, and turns what arrives into Tauri events the page can listen to.
//!
//! # Why the shell holds it and not the page
//!
//! The access token lives in Rust and does not cross the IPC boundary (rule 2).
//! A socket opened from the WebView would need that token in the page — or in
//! the URL, where every proxy on the way logs it. So the socket is opened here
//! and the page is handed only the events.
//!
//! # It adds promptness, never correctness
//!
//! The 4-second sync poll continues underneath and is still what makes the app
//! right. Everything here is allowed to fail: a socket that never connects
//! leaves the app behaving exactly as it did before this existed, which is why
//! nothing in it reports an error to the user.

use std::sync::Mutex;

use nexo_client::stream::Stream;
use nexo_protocol::{ClientEvent, ServerEvent};
use serde::Serialize;
use tauri::{Emitter, State};

/// The socket, for as long as somebody is signed in.
#[derive(Default)]
pub struct StreamState(pub Mutex<Option<Stream>>);

/// A typing notice, as the page receives it.
#[derive(Debug, Clone, Serialize)]
pub struct TypingEvent {
    pub conversation_id: String,
    /// The account that is typing. Not a handle: the socket carries ids, and
    /// resolving one to a name is the page's business, not this module's.
    pub user_id: i64,
}

/// The Tauri event a typing notice arrives as.
pub const TYPING_EVENT: &str = "nexo://typing";

/// Something arrived for a conversation, as the page receives it.
#[derive(Debug, Clone, Serialize)]
pub struct EnvelopeEvent {
    pub conversation_id: String,
}

/// The Tauri event an arrival arrives as.
///
/// It carries no content and cannot: an envelope is ciphertext until `sync`
/// decrypts it, and this module has no client to decrypt it with. What it says
/// is "there is something to fetch", and the page answers by syncing.
pub const ENVELOPE_EVENT: &str = "nexo://envelope";

/// Where the socket points, matching `HttpTransport::new`.
///
/// Read the same way so a development build talking to a local server gets a
/// local socket rather than reaching for production.
fn base_url() -> String {
    if cfg!(debug_assertions) {
        std::env::var("NEXO_API_BASE")
            .unwrap_or_else(|_| nexo_client::http::DEFAULT_BASE_URL.to_string())
    } else {
        nexo_client::http::DEFAULT_BASE_URL.to_string()
    }
}

/// Opens the socket if somebody is signed in, closes it if not.
///
/// Driven from `drain_stream` rather than from login, so nothing in `auth.rs`
/// has to learn about sockets and there is no state to keep in step: the
/// session either exists or it does not, and this follows it.
///
/// **Signing out closes the socket here; locking does not, and cannot.**
/// Locking deliberately keeps `SessionState` — the tokens are what let
/// `unlock_with_pin` rebuild the client from disk with no server round trip —
/// so a locked app still has a session and this function would hold the
/// connection open. It is `commands.rs::lock` that closes it, explicitly, and
/// close it must: a socket still delivering into a locked app is a session
/// that did not really end.
fn follow_session(session: &Mutex<Option<nexo_client::Session>>, slot: &mut Option<Stream>) {
    let token = match session.lock() {
        Ok(guard) => guard.as_ref().map(|s| s.access_token.clone()),
        Err(_) => None,
    };
    match token {
        Some(token) => {
            if slot.is_none() {
                *slot = Some(Stream::connect(&base_url(), &token));
            }
        }
        // Dropping the `Stream` asks its thread to stop.
        None => *slot = None,
    }
}

/// Hands the page whatever has arrived since the last call.
///
/// Polled by the sync agent rather than pushed from the socket thread, because
/// emitting a Tauri event needs an `AppHandle` and the thread that owns the
/// socket has no reason to. The poll is already running; this rides on it.
#[tauri::command]
pub async fn drain_stream<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, StreamState>,
    session: State<'_, crate::auth::SessionState>,
) -> Result<(), ()> {
    let events = {
        let Ok(mut slot) = state.0.lock() else {
            return Ok(());
        };
        follow_session(&session.0, &mut slot);
        match slot.as_ref() {
            Some(stream) => stream.drain(),
            None => return Ok(()),
        }
    };

    for event in events {
        // Presence and receipts are still deliberately ignored rather than
        // half-implemented: each needs a UI decision that has not been made,
        // and an event the page silently drops is better than a badge that
        // means nothing.
        match event {
            ServerEvent::Typing {
                conversation_id,
                user_id,
            } => {
                let _ = app.emit(
                    TYPING_EVENT,
                    TypingEvent {
                        conversation_id: conversation_id.to_string(),
                        user_id,
                    },
                );
            }
            // Forwarded so the page can sync *now* rather than on its next
            // four-second tick.
            //
            // This is what makes a call ring like a call. Signalling arrives as
            // an ordinary envelope, so before this the gap between somebody
            // pressing "call" and the other phone ringing was however much of
            // the poll interval was left -- up to four seconds, on top of the
            // round trip. Messages get the same promptness as a side effect,
            // which they have always been entitled to.
            //
            // It stays an optimisation, exactly like the rest of this module:
            // the poll underneath is what makes the app correct, and a socket
            // that never connects leaves everything working as it did.
            ServerEvent::Envelope {
                conversation_id, ..
            } => {
                let _ = app.emit(
                    ENVELOPE_EVENT,
                    EnvelopeEvent {
                        conversation_id: conversation_id.to_string(),
                    },
                );
            }
            _ => {}
        }
    }
    Ok(())
}

/// Tells the conversation that this device is typing.
///
/// Fire and forget. A notice that did not go is invisible rather than wrong,
/// which is why this returns nothing and never fails: reporting "your typing
/// indicator failed" would be noise about something nobody asked for.
#[tauri::command]
pub async fn typing(state: State<'_, StreamState>, conversation_id: String) -> Result<(), ()> {
    let Ok(id) = conversation_id.parse() else {
        return Ok(());
    };
    if let Ok(slot) = state.0.lock()
        && let Some(stream) = slot.as_ref()
    {
        stream.send(ClientEvent::Typing {
            conversation_id: id,
        });
    }
    Ok(())
}
