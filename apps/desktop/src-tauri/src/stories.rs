//! Stories, across the IPC seam.
//!
//! These lived in `meet.rs` until the map was removed, which was never where
//! they belonged: a story is encrypted media sent through the conversation
//! layer, exactly as an attachment is, and it has nothing to do with a map of
//! strangers.
//!
//! **Rule 2 holds here.** A story's key stays in Rust. The page asks for a
//! story by id and gets pixels back, never what opened them — the same seam
//! `conversations::attachment_data_url` keeps.
//!
//! The error view, the `with_client` helper and `now_ms` come from
//! [`crate::conversations`] rather than being copied: `nexo_client::stories`
//! already answers in `ConversationError`, so a second error type here would
//! be a translation with nothing to translate. Reusing the helper also keeps
//! the rotated-refresh-token drain in one place, which is the thing this
//! shell has already got wrong once — see the note in its header.

use serde::Serialize;
use tauri::State;

use crate::client::ClientState;
use crate::conversations::{ConversationErrorView, failure, now_ms, with_client};

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
pub async fn story_post(
    state: State<'_, ClientState>,
    path: String,
) -> Result<i64, ConversationErrorView> {
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
        Ok(nexo_client::stories::post(
            &client.context(),
            &contents,
            mime,
            now_ms(),
        )?)
    })
    .await
}

/// Stories this device holds. Reading them ends the expired ones.
#[tauri::command]
pub async fn story_list(
    state: State<'_, ClientState>,
) -> Result<Vec<StoryView>, ConversationErrorView> {
    with_client(&state, |client| {
        let live = nexo_client::stories::live(&client.context(), now_ms())?;
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
pub async fn story_open(
    state: State<'_, ClientState>,
    id: i64,
) -> Result<String, ConversationErrorView> {
    with_client(&state, move |client| {
        let (bytes, _declared) = nexo_client::stories::open(&client.context(), id, now_ms())?;

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
