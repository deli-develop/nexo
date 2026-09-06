//! Meet&Greet, across the IPC seam.
//!
//! Nothing new crosses here. A pin, a headline, a handle and a character
//! config are all plaintext already and all readable by the server; there is
//! no key material anywhere in this file, so invariant 2 is untouched.
//!
//! The one thing worth stating plainly: **the character config is opaque on
//! this side too.** It is carried as a JSON value from the server to the
//! WebView and back, and neither Rust nor the server parses it. The renderer
//! in the page is the only thing that reads it, which is what keeps a
//! character out of object storage and out of anything that would have to
//! moderate an image.

use serde::{Deserialize, Serialize};
use tauri::State;

use nexo_client::meet::{self, Context};
use nexo_protocol::MeetProfileUpdate;

use crate::client::ClientState;

/// Why a Meet&Greet call failed, as the page sees it.
#[derive(Debug, Serialize)]
pub struct MeetErrorView {
    pub kind: &'static str,
    pub message: String,
}

fn failure(kind: &'static str, message: impl Into<String>) -> MeetErrorView {
    MeetErrorView {
        kind,
        message: message.into(),
    }
}

impl From<meet::MeetError> for MeetErrorView {
    fn from(error: meet::MeetError) -> Self {
        use nexo_client::transport::TransportError;
        // The detail goes to the log; the page gets the summary.
        tracing::warn!(%error, "meet call failed");
        match &error {
            meet::MeetError::Transport(TransportError::Unreachable(_)) => failure(
                "unreachable",
                "Can't reach the server. This is the map as it was.",
            ),
            meet::MeetError::Transport(TransportError::InvalidCredentials) => {
                failure("signed_out", "Your session expired. Sign in again.")
            }
            meet::MeetError::Transport(TransportError::NotFound) => {
                failure("not_found", "That is not there.")
            }
            meet::MeetError::Transport(TransportError::Rejected(detail)) => {
                failure("rejected", detail.clone())
            }
            _ => failure("internal", "Something went wrong. Try again."),
        }
    }
}

/// Runs a blocking closure against the signed-in client.
///
/// One helper, so no command can forget the lock or the `spawn_blocking`.
async fn with_client<T, F>(state: &ClientState, work: F) -> Result<T, MeetErrorView>
where
    T: Send + 'static,
    F: FnOnce(&crate::client::LoggedIn) -> Result<T, MeetErrorView> + Send + 'static,
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
        // revokes every session for the account. The conversation, feed and
        // media paths have always done this; the map did not, so a rotation
        // that happened to land on a Meet call was the one that went missing.
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

/// One pin, as the page draws it.
///
/// Flattened out of the store's row rather than passed through, so the page
/// never sees a database shape and `char_config` arrives as JSON rather than
/// as a string the page would have to parse itself.
#[derive(Debug, Serialize)]
pub struct PinView {
    pub handle: String,
    pub display_name: String,
    pub lat: f64,
    pub lon: f64,
    pub headline: Option<String>,
    pub char_config: serde_json::Value,
    pub updated_at_ms: i64,
}

/// The map, and how old it is.
#[derive(Debug, Serialize)]
pub struct MapView {
    pub pins: Vec<PinView>,
    pub fetched_at_ms: i64,
    /// True when the server could not be reached and this is the cached copy.
    /// The page says so rather than presenting old pins as current.
    pub stale: bool,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Everyone on the map, from the server when it can be reached and from the
/// cache when it cannot.
#[tauri::command]
pub async fn meet_pins(state: State<'_, ClientState>) -> Result<MapView, MeetErrorView> {
    with_client(&state, |client| {
        let map = meet::map(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            now_ms(),
        )?;
        Ok(MapView {
            pins: map
                .pins
                .into_iter()
                .map(|p| PinView {
                    handle: p.handle,
                    display_name: p.display_name,
                    lat: p.lat,
                    lon: p.lon,
                    headline: p.headline,
                    // Stored as text; handed over as JSON. A parse failure
                    // means a config this build cannot read, and `null` is a
                    // fallback the renderer already has to handle.
                    char_config: serde_json::from_str(&p.char_config)
                        .unwrap_or(serde_json::Value::Null),
                    updated_at_ms: p.updated_at_ms,
                })
                .collect(),
            fetched_at_ms: map.fetched_at_ms,
            stale: map.stale,
        })
    })
    .await
}

/// My own pin, or `null` when I am not on the map.
#[tauri::command]
pub async fn meet_me(state: State<'_, ClientState>) -> Result<Option<PinView>, MeetErrorView> {
    with_client(&state, |client| {
        let mine = meet::me(&Context {
            transport: &*client.transport,
            store: &client.store,
        })?;
        Ok(mine.map(|p| PinView {
            handle: p.handle,
            display_name: p.display_name,
            lat: p.lat,
            lon: p.lon,
            headline: p.headline,
            char_config: p.char_config,
            updated_at_ms: p.updated_at_ms,
        }))
    })
    .await
}

/// What the studio sends when a pin is placed or a character saved.
#[derive(Debug, Deserialize)]
pub struct SetMeRequest {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub headline: Option<String>,
    pub char_config: Option<serde_json::Value>,
    pub active: Option<bool>,
}

/// Place or move my pin.
///
/// Answers with what the server stored, which is deliberately not what was
/// sent: the pin is coarsened on write, and the page draws the answer rather
/// than the request or it would show a precision that does not exist.
#[tauri::command]
pub async fn meet_set_me(
    state: State<'_, ClientState>,
    request: SetMeRequest,
) -> Result<Option<PinView>, MeetErrorView> {
    with_client(&state, move |client| {
        let update = MeetProfileUpdate {
            lat: request.lat,
            lon: request.lon,
            headline: request.headline,
            char_config: request.char_config,
            active: request.active,
        };
        let stored = meet::set_me(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            &update,
        )?;
        Ok(stored.map(|p| PinView {
            handle: p.handle,
            display_name: p.display_name,
            lat: p.lat,
            lon: p.lon,
            headline: p.headline,
            char_config: p.char_config,
            updated_at_ms: p.updated_at_ms,
        }))
    })
    .await
}

/// Come off the map. The character survives.
#[tauri::command]
pub async fn meet_leave(state: State<'_, ClientState>) -> Result<(), MeetErrorView> {
    with_client(&state, |client| {
        meet::leave(&Context {
            transport: &*client.transport,
            store: &client.store,
        })?;
        Ok(())
    })
    .await
}

/// Accept the agreement at a version.
#[tauri::command]
pub async fn meet_consent(
    state: State<'_, ClientState>,
    version: i32,
) -> Result<(), MeetErrorView> {
    with_client(&state, move |client| {
        meet::accept_agreement(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            version,
        )?;
        Ok(())
    })
    .await
}

/// One intro waiting for an answer.
#[derive(Debug, Serialize)]
pub struct RequestView {
    pub id: i64,
    pub from_handle: String,
    pub conversation_id: String,
    pub created_at_ms: i64,
}

/// The intro inbox.
#[tauri::command]
pub async fn meet_requests(
    state: State<'_, ClientState>,
) -> Result<Vec<RequestView>, MeetErrorView> {
    with_client(&state, |client| {
        let requests = meet::requests(&Context {
            transport: &*client.transport,
            store: &client.store,
        })?;
        Ok(requests
            .into_iter()
            .map(|r| RequestView {
                id: r.id,
                from_handle: r.from_handle,
                conversation_id: r.conversation_id.to_string(),
                created_at_ms: r.created_at_ms,
            })
            .collect())
    })
    .await
}

/// Mark a conversation as an intro, after its one message has been sent.
///
/// The ordering is the caller's and it matters: the page opens the
/// conversation with the existing `start_conversation`, sends one message
/// through the existing path, and only then calls this. Doing it the other way
/// would leave a request pointing at a conversation that does not exist.
///
/// Reusing the ordinary conversation path is the whole point — MLS group
/// creation, KeyPackage consumption and Welcome delivery already work, and a
/// second copy of them for this feature would be a second thing to get wrong.
#[tauri::command]
pub async fn meet_send_request(
    state: State<'_, ClientState>,
    handle: String,
    conversation_id: String,
) -> Result<RequestView, MeetErrorView> {
    with_client(&state, move |client| {
        let request = meet::open_request(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            &handle,
            &conversation_id,
        )?;
        Ok(RequestView {
            id: request.id,
            from_handle: request.from_handle,
            conversation_id: request.conversation_id.to_string(),
            created_at_ms: request.created_at_ms,
        })
    })
    .await
}

/// Accept an intro, which lifts the one-message cap.
#[tauri::command]
pub async fn meet_accept_request(
    state: State<'_, ClientState>,
    id: i64,
) -> Result<(), MeetErrorView> {
    with_client(&state, move |client| {
        meet::answer(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            id,
            true,
        )?;
        Ok(())
    })
    .await
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
pub async fn meet_search(
    state: State<'_, ClientState>,
    term: String,
) -> Result<Vec<SearchResultView>, MeetErrorView> {
    with_client(&state, move |client| {
        let found = meet::search(
            &Context {
                transport: &*client.transport,
                store: &client.store,
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
pub async fn meet_create_invite(
    state: State<'_, ClientState>,
    label: Option<String>,
    days: i64,
) -> Result<MintedInviteView, MeetErrorView> {
    with_client(&state, move |client| {
        let minted = meet::create_invite(
            &Context {
                transport: &*client.transport,
                store: &client.store,
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
pub async fn meet_invites(state: State<'_, ClientState>) -> Result<Vec<InviteView>, MeetErrorView> {
    with_client(&state, |client| {
        let list = meet::invites(&Context {
            transport: &*client.transport,
            store: &client.store,
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
pub async fn meet_revoke_invite(
    state: State<'_, ClientState>,
    id: i64,
) -> Result<(), MeetErrorView> {
    with_client(&state, move |client| {
        meet::revoke_invite(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            id,
        )?;
        Ok(())
    })
    .await
}

/// One story this device holds.
///
/// The key is **not** here. It stays in Rust, exactly as an attachment's does
/// (rule 2): the page asks for a story by id and gets bytes, never what opens
/// them.
#[derive(Debug, Serialize)]
pub struct StoryView {
    pub id: i64,
    /// Who posted it, when the account is known. Empty for one that arrived
    /// over the wire — an envelope names a device, not an account.
    pub author_handle: String,
    /// The device that sent it. The UI resolves this to a person the same way
    /// it resolves an incoming message's author.
    pub author_device_id: String,
    pub mime: String,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
}

/// Post a story from a file on disk.
#[tauri::command]
pub async fn story_post(state: State<'_, ClientState>, path: String) -> Result<i64, MeetErrorView> {
    with_client(&state, move |client| {
        let contents = std::fs::read(&path).map_err(|e| {
            failure(
                "unreadable_file",
                format!("That file could not be read: {e}"),
            )
        })?;
        // A story is a picture or a video. The sniffer knows about sound now
        // too, so this says which of the three it wants rather than trusting
        // that the sniffer only recognises two things.
        let mime = crate::feed::sniff_mime(&contents);
        if !crate::feed::is_renderable(mime) {
            return Err(failure(
                "not_an_image",
                "That file is not a picture or a video.",
            ));
        }
        // Refused here rather than at the viewer.
        //
        // The upload route allows 25 MB and `story_open` renders at most 12,
        // so without this a larger video would encrypt, upload, fan out to
        // every contact, and then be unwatchable by all of them — including
        // the person who posted it. Better to say no once than to say "too
        // large to display" to everybody afterwards.
        if contents.len() > crate::feed::MAX_INLINE_IMAGE_BYTES {
            return Err(failure(
                "too_large",
                format!(
                    "A story is up to {} MB.",
                    crate::feed::MAX_INLINE_IMAGE_BYTES / (1024 * 1024)
                ),
            ));
        }
        let id = nexo_client::stories::post(&client.context(), &contents, mime, now_ms())
            .map_err(|e| MeetErrorView::from(nexo_client::meet::MeetError::from(e)))?;
        Ok(id)
    })
    .await
}

/// Stories this device holds. Reading them ends the expired ones.
#[tauri::command]
pub async fn story_list(state: State<'_, ClientState>) -> Result<Vec<StoryView>, MeetErrorView> {
    with_client(&state, |client| {
        let live = nexo_client::stories::live(&client.context(), now_ms())
            .map_err(|e| MeetErrorView::from(nexo_client::meet::MeetError::from(e)))?;
        Ok(live
            .into_iter()
            .map(|s| StoryView {
                id: s.id,
                author_handle: s.author_handle,
                author_device_id: s.author_device_id,
                mime: s.mime,
                created_at_ms: s.created_at_ms,
                expires_at_ms: s.expires_at_ms,
            })
            .collect())
    })
    .await
}

/// A story's bytes, as a `data:` URL the page can render.
///
/// The key stays in Rust, exactly as an attachment's does (rule 2): the page
/// asks by id and gets pixels, never what opened them.
#[tauri::command]
pub async fn story_open(state: State<'_, ClientState>, id: i64) -> Result<String, MeetErrorView> {
    with_client(&state, move |client| {
        let (bytes, _declared) = nexo_client::stories::open(&client.context(), id, now_ms())
            .map_err(|e| MeetErrorView::from(nexo_client::meet::MeetError::from(e)))?;

        if bytes.len() > crate::feed::MAX_INLINE_IMAGE_BYTES {
            return Err(failure("too_large", "That story is too large to display."));
        }
        // Sniffed from the bytes, never taken from what the sender declared:
        // this string decides how the WebView renders it.
        let mime = crate::feed::sniff_mime(&bytes);
        if !crate::feed::is_renderable(mime) {
            return Err(failure(
                "not_renderable",
                "That story is not a picture or a video.",
            ));
        }
        Ok(crate::feed::data_url(mime, &bytes))
    })
    .await
}

/// Report somebody.
///
/// `subject_kind` and `subject_id` rather than a handle, because the server's
/// reports table covers posts and comments too and this is the first caller of
/// an endpoint that predates the map. The card resolves a handle to an id
/// through the profile it is already showing.
#[tauri::command]
pub async fn meet_report(
    state: State<'_, ClientState>,
    subject_kind: String,
    subject_id: i64,
    reason: String,
    note: Option<String>,
) -> Result<(), MeetErrorView> {
    with_client(&state, move |client| {
        meet::report(
            &Context {
                transport: &*client.transport,
                store: &client.store,
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

/// Decline an intro.
#[tauri::command]
pub async fn meet_decline_request(
    state: State<'_, ClientState>,
    id: i64,
) -> Result<(), MeetErrorView> {
    with_client(&state, move |client| {
        meet::answer(
            &Context {
                transport: &*client.transport,
                store: &client.store,
            },
            id,
            false,
        )?;
        Ok(())
    })
    .await
}
