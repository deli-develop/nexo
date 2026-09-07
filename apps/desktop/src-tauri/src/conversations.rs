//! Conversation commands.
//!
//! Rule 2 again: what crosses this boundary is already-decrypted text and
//! identifiers. No ciphertext, no MLS state, no keys. The WebView never learns
//! that MLS exists.

use nexo_client::Transport;
use nexo_client::conversations;
use nexo_protocol::{CallSignal, ConversationId, HangupReason, Payload, VoiceMeta};
use serde::Serialize;
use tauri::State;

use crate::client::ClientState;

/// A conversation as the UI draws it.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationView {
    pub conversation_id: String,
    pub kind: String,
    /// What to call it. `None` for a conversation joined from a Welcome, which
    /// this device has no name for until M7's profile fetch — the UI says so
    /// rather than inventing one.
    pub title: Option<String>,
    /// Whoever else is in it, by handle. Empty until the profile fetch of M7.
    pub members: Vec<String>,
    /// The most recent message body, for the list preview.
    ///
    /// Decrypted locally — the server has no preview column and never will
    /// (brief 4.2).
    pub last_message: Option<String>,
    pub last_message_at_ms: Option<i64>,
    /// Whether this device sent the most recent message.
    ///
    /// The UI needs this to decide what deserves a toast and an unread mark: a
    /// conversation whose newest message is our own is by definition read.
    pub last_message_outgoing: Option<bool>,
    /// Whether a picture has been set, so the UI asks for one only when there
    /// is one to fetch and decrypt.
    pub has_avatar: bool,
    /// Whether every current key here was confirmed out of band.
    ///
    /// Read from the encrypted store, not from the WebView. It used to be a
    /// `localStorage` boolean, which meant it survived a key change it knew
    /// nothing about -- a mark that outlived the thing it was about.
    pub verified: bool,
    /// Whether somebody's key changed under a device already known here.
    ///
    /// Stays true until acknowledged, across restarts. That persistence is the
    /// point: a warning that vanishes when the window closes is one that can be
    /// missed by closing the window.
    pub key_changed: bool,
    /// When it changed, so the warning can say when rather than just that.
    pub key_changed_at_ms: Option<i64>,
}

/// One message, decrypted.
#[derive(Debug, Clone, Serialize)]
pub struct MessageView {
    pub envelope_id: i64,
    /// `None` for our own messages: MLS does not let a sender decrypt its own
    /// ciphertext, so ours are written locally with no sender attached, and
    /// that absence is how the UI knows which side to draw them on.
    pub sender_device_id: Option<String>,
    pub body: String,
    pub sent_at_ms: i64,
    /// True when this device sent it.
    pub outgoing: bool,
    /// Whether the server has it yet.
    ///
    /// A queued message is drawn differently and must be: telling someone
    /// their message is sent when it is sitting in an outbox is the one lie
    /// a messenger cannot afford (rule 7).
    pub pending: bool,
    /// Set when the message carries a file.
    ///
    /// Only what a bubble needs to draw: name, type, size. The S3 key, the AES
    /// key, and the nonce stay in Rust (rule 2) -- the WebView asks to save an
    /// attachment by envelope id and never sees what opens it.
    pub attachment: Option<AttachmentView>,
    /// The sender's own name for this message, when it has one.
    ///
    /// What a later reaction, edit or retraction refers to. `None` for a
    /// message sent before names existed and for one still in the outbox that
    /// somehow lost it -- the UI offers no action that needs a name on those.
    pub client_id: Option<String>,
    /// Set when this message is the record of a call.
    ///
    /// A call leaves exactly one row behind — the hangup — and it is drawn as
    /// a line rather than a bubble: nobody said anything, so there is nothing
    /// to quote, react to or edit.
    pub call: Option<CallRecordView>,
    /// The `kind` of a payload this build cannot read, when that is what
    /// arrived.
    ///
    /// Rule 7 in this layer: a message that did not open is shown as one. The
    /// bytes are still in the store, so a later build that knows the kind
    /// reads them from there -- but this build must not pretend the sender
    /// typed the JSON it could not parse.
    pub unsupported: Option<String>,
    /// Pinned **on this device**.
    ///
    /// Local, and the UI must say so. See the schema-12 migration in
    /// `crates/store`: a shared pin has no enforceable cap, because the server
    /// may not read the payload and so cannot count.
    pub pinned: bool,
    /// Set when the sender took the message back.
    ///
    /// The row survives, so this is how the bubble tells "taken back" from
    /// "never said anything".
    pub retracted_at_ms: Option<i64>,
    /// Set when the sender last changed it. Shown as a quiet mark, not judged.
    pub edited_at_ms: Option<i64>,
    /// Reactions on this message, most-used first.
    ///
    /// The same shape the feed already draws pills from, so the pill component
    /// is reused rather than reimplemented for conversations.
    pub reactions: Vec<ReactionView>,
    /// What this message answers, when it answers something.
    ///
    /// Resolved here rather than in the WebView, because the answer depends on
    /// what this device holds and the page cannot know that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<ReplyView>,
    /// Who a forwarded message says it came from, when it says anything.
    ///
    /// `None` while `forwarded` is true is the honest "passed on, author
    /// unknown" — the bubble then says only that it was forwarded.
    pub forwarded_from: Option<String>,
    /// Whether this arrived as a forward at all.
    pub forwarded: bool,
    /// Set when the message is a picture or clip meant to be opened once.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_once: Option<ViewOnceView>,
    /// Set when the message is a sticker.
    ///
    /// Names the art rather than carrying it: every client has the pack. A page
    /// that does not recognise the pair draws a placeholder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<StickerView>,
}

/// Which sticker a message is.
#[derive(Debug, Clone, Serialize)]
pub struct StickerView {
    pub pack: String,
    pub id: String,
}

/// What a bubble may know about a view-once message.
///
/// Everything here is safe to know after the fact. **No key crosses**, opened
/// or not (rule 2) -- the page asks to open by the message's name and is handed
/// bytes, exactly as it asks to save an attachment by envelope id.
#[derive(Debug, Clone, Serialize)]
pub struct ViewOnceView {
    /// Whether it can still be opened on this device.
    ///
    /// False means the key is gone, which is a fact about the disk rather than
    /// a decision this build made -- so a modified build cannot make it true.
    pub openable: bool,
    /// Whether we sent it. Ours are never openable: we kept the original.
    pub outgoing: bool,
    /// When it was opened, if it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at_ms: Option<i64>,
    /// `image` or `video`, so the bubble can name what is behind the cover
    /// before it is opened and after there is nothing left to show.
    pub kind: String,
}

/// The quoted message a reply points at, as far as this device can tell.
///
/// Three states, and the difference matters to a reader: the message is here
/// (`body` says what it said), it was taken back (`retracted`), or this device
/// never received it (`found` is false). The last is ordinary rather than an
/// error -- somebody joined the conversation after the message they are being
/// answered about -- and the bubble says so instead of drawing a blank quote.
#[derive(Debug, Clone, Serialize)]
pub struct ReplyView {
    /// The name of the message being answered, so the UI can scroll to it.
    pub target: String,
    /// Whether this device has that message at all.
    pub found: bool,
    /// Its envelope id, when it is here -- what a jump-to scrolls by.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope_id: Option<i64>,
    /// Whether this device sent the message being answered.
    pub outgoing: bool,
    /// Whether it was taken back. An empty `body` and this set are not the
    /// same thing as a message that never arrived.
    pub retracted: bool,
    /// What it said, already shortened -- a quote is a reminder, not a copy,
    /// and a paragraph quoted above every answer buries the answer.
    pub excerpt: String,
}

/// How much of a quoted message a bubble shows.
const QUOTE_CHARS: usize = 120;

/// The quoted line for one target, from what this device holds.
fn resolve_reply(target: &str, by_name: &std::collections::HashMap<&str, &StoredRef>) -> ReplyView {
    let Some(found) = by_name.get(target) else {
        return ReplyView {
            target: target.to_string(),
            found: false,
            envelope_id: None,
            outgoing: false,
            retracted: false,
            excerpt: String::new(),
        };
    };
    ReplyView {
        target: target.to_string(),
        found: true,
        envelope_id: Some(found.envelope_id),
        outgoing: found.outgoing,
        retracted: found.retracted,
        excerpt: if found.retracted {
            String::new()
        } else {
            shorten(&found.body, QUOTE_CHARS)
        },
    }
}

/// Enough of a stored message to quote it.
struct StoredRef {
    envelope_id: i64,
    outgoing: bool,
    retracted: bool,
    body: String,
}

/// Cuts a quote to length on a word boundary where there is one nearby.
///
/// Chopping mid-word reads as corruption rather than as brevity, so this backs
/// up to the last space in the final quarter of the budget and only falls back
/// to a hard cut when there is none -- which is what a long URL or a language
/// that does not space its words will do.
fn shorten(body: &str, limit: usize) -> String {
    let mut cut = body.char_indices().map(|(i, _)| i).nth(limit);
    if cut.is_none() {
        return body.to_string();
    }
    let end = cut.take().unwrap_or(body.len());
    let head = &body[..end];
    let floor = end.saturating_sub(limit / 4);
    let boundary = head[floor..].find(' ').map(|i| floor + i).unwrap_or(end);
    format!("{}…", head[..boundary].trim_end())
}

/// One emoji on a message, and how many used it.
#[derive(Debug, Clone, Serialize)]
pub struct ReactionView {
    pub emoji: String,
    pub count: i64,
    /// Whether this account is one of them.
    pub mine: bool,
}

/// The visible facts about an attached file.
#[derive(Debug, Clone, Serialize)]
pub struct AttachmentView {
    /// Already run through `safe_file_name`: the sender chose this string, and
    /// it reaches a UI that will put it in a save dialog.
    pub name: String,
    pub mime: String,
    pub size: u64,
    /// Set when the sender recorded this, so the bubble draws a voice note
    /// rather than a file row. Absent for everything picked from disk, and for
    /// every message sent before recording existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceView>,
    /// Whether it can be played a segment at a time rather than fetched whole.
    ///
    /// What decides whether the bubble points a player at the streaming scheme
    /// or falls back to the old fetch-and-decrypt path. False for everything
    /// sent before segmenting existed.
    pub streamable: bool,
}

/// The drawable half of [`nexo_protocol::VoiceMeta`].
///
/// Separate from the protocol type for the reason `AttachmentView` is separate
/// from `Payload`: what crosses this boundary is chosen, not inherited. Here
/// that costs nothing today — both fields are drawn — but it means a field
/// added to the payload later does not reach the WebView by default.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceView {
    pub duration_ms: u32,
    /// Already capped by `VoiceMeta::drawable_peaks`, so the renderer cannot be
    /// handed ten thousand bars by a sender who felt like it.
    pub peaks: Vec<u8>,
}

/// What the *bubble* shows, which is not what a conversation-list row shows.
///
/// `Payload::preview` falls back to the file name when an attachment carries no
/// message, and that is right in a list where there is no picture. In the
/// thread the picture is right there, so repeating its name beside it is noise
/// -- the stored body is the preview, so it is unwrapped back to the real one
/// here rather than changing what is stored and breaking the list.
fn bubble_body(stored: &str, payload: Option<&str>) -> String {
    let Some(encoded) = payload else {
        return stored.to_string();
    };
    match Payload::decode(encoded.as_bytes()) {
        // The sender's own words, or nothing. A file with no message says
        // everything it has to say through the file row beneath it.
        Payload::Attachment { body, .. } => body.unwrap_or_default(),
        _ => stored.to_string(),
    }
}

/// The sticker a stored payload names, when it names one.
fn sticker_in(payload: Option<&str>) -> Option<StickerView> {
    match Payload::decode(payload?.as_bytes()) {
        Payload::Sticker { pack, id, .. } => Some(StickerView { pack, id }),
        _ => None,
    }
}

/// What a stored payload answers, when it answers something.
///
/// Only a queued reply needs this: once the message reaches the `messages`
/// table it has a `reply_to` column, and reading a column beats decoding JSON.
/// Who a forwarded message says it came from, when it says anything.
///
/// The sender's claim, like everything else inside an envelope: no one else
/// was there, and nothing can check it. The UI presents it as a claim.
fn forwarding(payload: Option<&str>) -> (bool, Option<String>) {
    let Some(payload) = payload else {
        return (false, None);
    };
    match Payload::decode(payload.as_bytes()) {
        Payload::Text {
            forwarded,
            forwarded_from,
            ..
        } => (forwarded, forwarded_from.filter(|who| !who.is_empty())),
        _ => (false, None),
    }
}

fn reply_target(payload: Option<&str>) -> Option<String> {
    match Payload::decode(payload?.as_bytes()) {
        Payload::Reply { target, .. } => Some(target.to_string()),
        _ => None,
    }
}

/// How a call ended, as the bubble draws it.
#[derive(Debug, Clone, Serialize)]
pub struct CallRecordView {
    /// `cancelled`, `declined`, `ended` or `failed`.
    pub reason: String,
    /// How long the two were connected. Zero for a call that never was.
    pub seconds: u32,
    /// Whether it was a video call. Audio-only today.
    pub video: bool,
}

impl CallRecordView {
    /// Reads a call record out of a stored payload, if that is what it is.
    ///
    /// Only a hangup is ever stored, so an offer or an answer reaching here
    /// would mean the receive branch let one through — and `None` is the right
    /// answer for that too: an unbroken UI beats a bubble full of SDP.
    fn from_payload(encoded: Option<&str>) -> Option<Self> {
        let Payload::Call { signal, .. } = Payload::decode(encoded?.as_bytes()) else {
            return None;
        };
        let CallSignal::Hangup { reason, seconds } = signal else {
            return None;
        };
        Some(CallRecordView {
            // Spelled the way the wire spells it, so the page switches on the
            // same word the protocol uses and neither side invents a synonym.
            reason: match reason {
                HangupReason::Cancelled => "cancelled",
                HangupReason::Declined => "declined",
                HangupReason::Ended => "ended",
                HangupReason::Failed => "failed",
                // `HangupReason` is non-exhaustive: a reason from a newer build
                // is shown as a plain ended call rather than dropping the row.
                _ => "ended",
            }
            .to_string(),
            seconds,
            video: false,
        })
    }
}

/// The `kind` of an unreadable payload, when that is what was stored.
///
/// `None` for everything this build understands, including a message with no
/// payload at all -- the overwhelmingly common case, and the cheap one.
fn unsupported_kind(payload: Option<&str>) -> Option<String> {
    match Payload::decode(payload?.as_bytes()) {
        Payload::Unsupported { kind } => Some(kind),
        _ => None,
    }
}

impl AttachmentView {
    /// Reads the visible parts out of a stored payload.
    ///
    /// Returns `None` for a text message or an unparseable payload -- a message
    /// that cannot be described as an attachment is simply not shown as one.
    fn from_payload(encoded: Option<&str>) -> Option<Self> {
        let Payload::Attachment {
            name,
            mime,
            size,
            voice,
            segmented,
            ..
        } = Payload::decode(encoded?.as_bytes())
        else {
            return None;
        };
        Some(AttachmentView {
            name: nexo_protocol::safe_file_name(&name),
            mime,
            size,
            voice: voice.map(|v| VoiceView {
                duration_ms: v.duration_ms,
                peaks: v.drawable_peaks().to_vec(),
            }),
            streamable: segmented,
        })
    }
}

/// What a sync did, for the UI to report honestly.
#[derive(Debug, Clone, Serialize)]
pub struct SyncView {
    pub messages: usize,
    pub commits: usize,
    /// Envelopes that could not be read. Rule 7: surfaced, never hidden.
    pub failed: usize,
    /// Which conversations received messages, and how many each.
    ///
    /// This is what drives the unread counts and the toast: the totals above
    /// say *whether* anything happened, these say *where*. Only conversations
    /// with at least one new message appear.
    pub arrivals: Vec<ArrivalView>,
    /// Conversations where somebody's key changed during this sync.
    ///
    /// Separate from `arrivals` because it is not about messages arriving. The
    /// UI raises a banner on these; the totals above decide nothing here.
    #[serde(default)]
    pub key_changed: Vec<String>,
    /// Call signalling that arrived during this sync, oldest first.
    ///
    /// Rides the sync result rather than a push, because sync is what decrypts
    /// an envelope and there is nowhere earlier the signal exists in the clear.
    /// The page acts on these immediately or not at all — see
    /// `nexo_client::conversations::SyncOutcome::calls`.
    #[serde(default)]
    pub calls: Vec<CallSignalView>,
}

/// One piece of call signalling, on its way to the page.
///
/// The signal itself is handed over as the protocol defines it, tag and all,
/// rather than flattened into a bag of optional fields: the page has to switch
/// on which signal this is anyway, and a shape that mirrors the wire is one
/// fewer translation to get wrong.
///
/// Rule 2 holds here. An SDP carries codec lists, ICE candidates and a DTLS
/// *fingerprint* — a hash of a certificate, not a key — and the page is where
/// it was generated in the first place.
#[derive(Debug, Clone, Serialize)]
pub struct CallSignalView {
    pub conversation_id: String,
    /// The device that sent it, when MLS could name one.
    pub sender_device_id: Option<String>,
    pub call_id: String,
    pub signal: CallSignal,
}

impl From<conversations::IncomingCall> for CallSignalView {
    fn from(call: conversations::IncomingCall) -> Self {
        Self {
            conversation_id: call.conversation_id.to_string(),
            sender_device_id: call.sender_device_id,
            call_id: call.call_id.to_string(),
            signal: call.signal,
        }
    }
}

/// New messages in one conversation, from one sync pass.
#[derive(Debug, Clone, Serialize)]
pub struct ArrivalView {
    pub conversation_id: String,
    /// Newly decrypted incoming messages. Our own sends never count — they
    /// are written locally at send time and are not an "arrival".
    pub messages: usize,
}

/// An error the UI can act on.
#[derive(Debug, Serialize)]
pub struct ConversationErrorView {
    pub kind: &'static str,
    pub message: String,
}

fn failure(kind: &'static str, message: impl Into<String>) -> ConversationErrorView {
    ConversationErrorView {
        kind,
        message: message.into(),
    }
}

impl From<conversations::ConversationError> for ConversationErrorView {
    fn from(error: conversations::ConversationError) -> Self {
        use nexo_client::transport::TransportError;
        // The detail goes to the log; the user gets the summary. These errors
        // can carry query text and file paths.
        tracing::warn!(%error, "conversation call failed");
        match &error {
            conversations::ConversationError::Transport(TransportError::Unreachable(_)) => failure(
                "unreachable",
                "Can't reach the server. Your message will send when you're back online.",
            ),
            conversations::ConversationError::Transport(TransportError::InvalidCredentials) => {
                failure("signed_out", "Your session expired. Sign in again.")
            }
            conversations::ConversationError::Transport(TransportError::StaleEpoch { .. }) => {
                failure(
                    "stale_epoch",
                    "This conversation moved on. Syncing and trying again.",
                )
            }
            conversations::ConversationError::Transport(TransportError::Rejected(detail)) => {
                failure("rejected", detail.clone())
            }
            conversations::ConversationError::NotAMember => {
                failure("not_a_member", "You are not in that conversation.")
            }
            _ => failure("internal", "Something went wrong. Try again."),
        }
    }
}

/// Take back one of our own messages, or change what it says.
///
/// `body` absent is a retraction; present is an edit. One command, because
/// they are the same act with different content and the checks are identical.
///
/// What goes out is a **request**. A well-behaved Nexo applies it; a modified
/// one need not, and the UI must say so rather than claiming the message is
/// gone.
#[tauri::command]
pub async fn revise_message(
    state: State<'_, ClientState>,
    conversation_id: String,
    target: String,
    body: Option<String>,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let target = target
            .parse::<nexo_protocol::MessageId>()
            .map_err(|_| failure("invalid_request", "That message cannot be changed."))?;
        conversations::revise(&client.context(), id, target, body.as_deref(), now_ms())?;
        Ok(())
    })
    .await
}

/// React to a message, or take the reaction back.
///
/// Goes out as an encrypted payload like any message. There is no reaction
/// endpoint on the server and there must not be one: an emoji is content.
#[tauri::command]
pub async fn react_to_message(
    state: State<'_, ClientState>,
    conversation_id: String,
    target: String,
    emoji: String,
    on: bool,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let target = target
            .parse::<nexo_protocol::MessageId>()
            .map_err(|_| failure("invalid_request", "That message cannot be reacted to."))?;
        conversations::react(&client.context(), id, target, &emoji, on)?;
        Ok(())
    })
    .await
}

/// Pin or unpin a message, on this device only.
///
/// Nothing is sent and nobody else sees it. The name of the command says
/// "this device" because the UI has to as well.
#[tauri::command]
pub async fn set_message_pinned(
    state: State<'_, ClientState>,
    conversation_id: String,
    envelope_id: i64,
    pinned: bool,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        client
            .store
            .set_pinned(&conversation_id, envelope_id, pinned, now_ms())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Remove a message from this device.
///
/// Everyone else keeps their copy, and the UI must say exactly that. Taking a
/// message back from other people is a different act with a different name and
/// a much weaker promise.
#[tauri::command]
pub async fn delete_message_for_me(
    state: State<'_, ClientState>,
    conversation_id: String,
    envelope_id: i64,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        client
            .store
            .delete_message(&conversation_id, envelope_id)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Runs a blocking closure against the signed-in client.
///
/// One helper, so no command can forget the lock or the `spawn_blocking`.
async fn with_client<T, F>(state: &ClientState, work: F) -> Result<T, ConversationErrorView>
where
    T: Send + 'static,
    F: FnOnce(&crate::client::LoggedIn) -> Result<T, ConversationErrorView> + Send + 'static,
{
    let handle = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = handle.lock().map_err(|_| {
            failure(
                "internal",
                "The client state was poisoned by an earlier failure. Restart the app.",
            )
        })?;
        let client = guard
            .as_ref()
            .ok_or_else(|| failure("signed_out", "You are not signed in."))?;
        let outcome = work(client);

        // An access token ages on the clock, so the transport may have traded
        // the refresh token for a new pair mid-call. Writing the new one down
        // is not optional: the next launch replays whatever is stored, and a
        // spent refresh token is what the server reads as theft -- it revokes
        // every session for the account.
        if let Some(rotated) = client.transport.take_rotated_refresh_token()
            && let Err(error) = client.store.set_refresh_token(&rotated)
        {
            tracing::error!(%error, "could not persist a rotated refresh token");
        }

        outcome
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "a conversation task panicked");
        failure("internal", "Something went wrong. Try again.")
    })?
}

fn parse_id(id: &str) -> Result<ConversationId, ConversationErrorView> {
    id.parse()
        .map_err(|_| failure("invalid_request", "That is not a conversation id."))
}

/// Every conversation this device knows about, newest activity first.
#[tauri::command]
pub async fn list_conversations(
    state: State<'_, ClientState>,
) -> Result<Vec<ConversationView>, ConversationErrorView> {
    with_client(&state, |client| {
        let stored = client
            .store
            .conversations()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;

        let mut out = Vec::with_capacity(stored.len());
        for conversation in stored {
            let messages = client.store.messages(&conversation.id).map_err(|e| {
                ConversationErrorView::from(conversations::ConversationError::Store(e))
            })?;
            let last = messages.last();
            // The peers, for the verification state below. Only the derived
            // booleans cross the IPC boundary -- the keys themselves stay in
            // Rust, like every other key in this process (rule 2).
            let peers = client.store.peers(&conversation.id).map_err(|e| {
                ConversationErrorView::from(conversations::ConversationError::Store(e))
            })?;
            out.push(ConversationView {
                conversation_id: conversation.id,
                // What the server said, once `discover` has asked. Everything
                // was reported as a DM before that, which made the UI look up
                // a group's title as if it were somebody's handle.
                kind: conversation.kind.unwrap_or_else(|| "dm".to_string()),
                title: conversation.title,
                members: conversation.members,
                last_message: last.map(|m| m.body.clone()),
                last_message_at_ms: last.map(|m| m.sent_at_ms),
                last_message_outgoing: last.map(|m| m.sender_device_id.is_none()),
                has_avatar: conversation.has_avatar,
                // Verified means every peer's current key is one that was
                // confirmed. A conversation with no peers yet is not verified:
                // there is nothing to have compared.
                verified: !peers.is_empty()
                    && peers
                        .iter()
                        .all(|p| p.verified_key.as_deref() == Some(p.identity_key.as_slice())),
                key_changed: peers.iter().any(|p| p.changed_at_ms.is_some()),
                key_changed_at_ms: peers.iter().filter_map(|p| p.changed_at_ms).max(),
            });
        }

        // Most recent first, and conversations with nothing in them last —
        // a new conversation should not sit above an active one.
        out.sort_by_key(|c| std::cmp::Reverse(c.last_message_at_ms));
        Ok(out)
    })
    .await
}

/// Removes a conversation from **this device**.
///
/// The name is the whole design. Nothing is deleted for anyone else and
/// nothing can be: the other members hold their own copies, and the server
/// holds ciphertext it drops on acknowledgement rather than on request. A
/// command called `delete_conversation` that quietly meant "hide it here"
/// would be the kind of promise rule 7 exists to forbid, so the button says
/// "Remove from this device" and this is what it does.
///
/// The MLS group state stays. Server-side we are still a member, so the next
/// message from that conversation arrives, is decrypted, and the conversation
/// comes back with the new message in it -- which is the honest outcome and
/// the one the confirmation warns about. Dropping the group state instead
/// would leave a member who can no longer read anything sent to them.
#[tauri::command]
pub async fn delete_conversation(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        client
            .store
            .delete_conversation(&conversation_id)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Starts a 1:1 conversation with a handle.
#[tauri::command]
pub async fn start_conversation(
    state: State<'_, ClientState>,
    handle: String,
) -> Result<String, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = conversations::open_with(&client.context(), &handle)?;
        tracing::info!(%id, "opened a conversation");
        Ok(id.to_string())
    })
    .await
}

/// Starts a group conversation with several handles.
#[tauri::command]
pub async fn start_group(
    state: State<'_, ClientState>,
    handles: Vec<String>,
    title: String,
) -> Result<String, ConversationErrorView> {
    with_client(&state, move |client| {
        let title = if title.trim().is_empty() {
            "New group".to_string()
        } else {
            title.trim().to_string()
        };
        let id = conversations::start_group_with(&client.context(), &handles, &title)?;
        tracing::info!(%id, members = handles.len(), "started a group");
        Ok(id.to_string())
    })
    .await
}

/// Adds someone to a conversation that already exists.
#[tauri::command]
pub async fn add_to_conversation(
    state: State<'_, ClientState>,
    conversation_id: String,
    handle: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        conversations::add_to(&client.context(), id, &handle)?;
        tracing::info!(%id, "added a member");
        Ok(())
    })
    .await
}

/// Renames a conversation for everyone in it.
#[tauri::command]
pub async fn rename_conversation(
    state: State<'_, ClientState>,
    conversation_id: String,
    title: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        if title.trim().is_empty() {
            return Err(failure("invalid_request", "Give it a name first."));
        }
        if title.trim().chars().count() > 80 {
            return Err(failure("invalid_request", "A name is up to 80 characters."));
        }
        conversations::rename(&client.context(), id, &title)?;
        tracing::info!(%id, "renamed a conversation");
        Ok(())
    })
    .await
}

/// Sets the conversation's picture from a file the user picked.
///
/// The bytes are read here and encrypted before they leave: the WebView passes
/// a path and never sees the image, the bucket never sees the plaintext, and
/// the key that opens it travels inside an MLS message.
#[tauri::command]
pub async fn set_conversation_avatar(
    state: State<'_, ClientState>,
    conversation_id: String,
    path: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let contents = std::fs::read(&path).map_err(|e| {
            failure(
                "unreadable_file",
                format!("That file could not be read: {e}"),
            )
        })?;

        if contents.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(failure("too_large", "That image is too large."));
        }
        // Sniffed, never taken from the name: this is what every member's
        // browser will be told the bytes are.
        let mime = crate::feed::sniff_mime(&contents);
        if !crate::feed::is_renderable(mime) {
            return Err(failure("not_an_image", "That file is not an image."));
        }

        conversations::set_group_avatar(&client.context(), id, &contents, mime)?;
        tracing::info!(%id, "set a conversation picture");
        Ok(())
    })
    .await
}

/// The conversation's picture, decrypted, as a `data:` URL.
///
/// `None` when it has none — which is most conversations, so this is an
/// ordinary answer rather than an error.
#[tauri::command]
pub async fn conversation_avatar(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<Option<String>, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let Some((contents, _)) = conversations::group_avatar(&client.context(), id)? else {
            return Ok(None);
        };
        // The sender's declared type is not evidence. Sniffing again here is
        // what stops a member handing everyone else an HTML "image".
        let mime = crate::feed::sniff_mime(&contents);
        if !crate::feed::is_renderable(mime) {
            return Ok(None);
        }
        Ok(Some(crate::feed::data_url(mime, &contents)))
    })
    .await
}

/// Every image and file in a conversation, oldest first.
///
/// N2's media strip needs the whole conversation's attachments, not one
/// message's. Nothing new is fetched: `sync` already wrote each payload beside
/// its message when it arrived, so this reads what is on disk and filters --
/// which is also why it works offline and why it costs nothing to open.
///
/// Payloads are **not** returned. They hold decryption keys; only the envelope
/// id crosses, and the bytes come back one at a time through
/// `attachment_data_url` or `save_attachment`.
#[tauri::command]
pub async fn conversation_attachments(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<Vec<AttachmentEntry>, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let messages = client
            .store
            .messages(&id.to_string())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;

        Ok(messages
            .into_iter()
            .filter_map(|m| {
                let view = AttachmentView::from_payload(m.payload.as_deref())?;
                Some(AttachmentEntry {
                    envelope_id: m.envelope_id,
                    kind: if view.mime.starts_with("image/") {
                        "image"
                    } else if view.mime.starts_with("video/") {
                        "video"
                    } else if view.mime.starts_with("audio/") {
                        "audio"
                    } else {
                        "file"
                    }
                    .to_string(),
                    name: view.name,
                    mime: view.mime,
                    size: view.size,
                    sent_at_ms: m.sent_at_ms,
                    outgoing: m.sender_device_id.is_none(),
                })
            })
            .collect())
    })
    .await
}

/// One attachment in the conversation-wide list.
#[derive(Debug, Clone, Serialize)]
pub struct AttachmentEntry {
    /// All the WebView needs to ask for the bytes.
    pub envelope_id: i64,
    /// `image`, `video`, `audio` or `file`, from the type inside the ciphertext.
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sent_at_ms: i64,
    pub outgoing: bool,
}

/// Marks every current key in a conversation as verified.
///
/// Called after two people have compared safety numbers out of band. It records
/// *which* keys were confirmed rather than a flag, so the mark cannot survive
/// one of them changing -- which is the whole failure this replaced.
#[tauri::command]
pub async fn mark_verified(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        client
            .store
            .mark_verified(&id.to_string())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;
        tracing::info!(%id, "safety numbers marked verified");
        Ok(())
    })
    .await
}

/// Dismisses a key-change warning.
///
/// Deliberately not the same as verifying. Being told a key changed and
/// choosing to carry on is not the same as having compared the new one, and
/// one button doing both would manufacture a verification nobody performed.
#[tauri::command]
pub async fn acknowledge_key_change(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        client
            .store
            .acknowledge_key_change(&id.to_string())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;
        tracing::info!(%id, "key change acknowledged without verifying");
        Ok(())
    })
    .await
}

/// Messages matching a search term, newest first.
///
/// Runs against the FTS5 index inside the encrypted store, so the term never
/// leaves the machine. A server-side search would need the plaintext, and the
/// server has none to search.
///
/// `conversation_id` scopes it to one conversation — what the in-chat find bar
/// asks for, as against the list's search across everything. The filter goes
/// into the query rather than onto its result because `LIMIT` runs last:
/// filtering afterwards would search the newest messages anywhere and then
/// keep whichever happened to be in this chat.
#[tauri::command]
pub async fn search_messages(
    state: State<'_, ClientState>,
    term: String,
    conversation_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SearchHitView>, ConversationErrorView> {
    with_client(&state, move |client| {
        // Enough to fill a list without turning a one-letter term into a scan
        // of every message ever received.
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let hits = client
            .store
            .search_messages(&term, conversation_id.as_deref(), limit)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;

        Ok(hits
            .into_iter()
            .map(|h| SearchHitView {
                envelope_id: h.envelope_id,
                conversation_id: h.conversation_id,
                body: h.body,
                sent_at_ms: h.sent_at_ms,
                outgoing: h.outgoing,
            })
            .collect())
    })
    .await
}

/// One search result.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHitView {
    pub envelope_id: i64,
    pub conversation_id: String,
    /// The matching text. Plaintext, and only ever inside this process and the
    /// WebView that asked for it.
    pub body: String,
    pub sent_at_ms: i64,
    pub outgoing: bool,
}

/// Sends a message.
/// Opens the conversation you have with yourself, making it if there is none.
///
/// Idempotent on both sides: the store is checked first, and the server hands
/// back the existing one rather than making a second.
#[tauri::command]
pub async fn open_self_conversation(
    state: State<'_, ClientState>,
) -> Result<String, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = conversations::start_self_conversation(&client.context())?;
        Ok(id.to_string())
    })
    .await
}

/// Passes a message on to another conversation.
///
/// `forwarded_from` is what this device believes the original author to be,
/// and it is the page's answer rather than the core's: the shell knows what it
/// drew on the bubble, and for a group message that is often nothing. `None`
/// means "forwarded, author unknown", which the reader is shown as such.
///
/// Text only — see `conversations::forward_message` for why an attachment is
/// not simply the same thing with a bigger payload.
#[tauri::command]
pub async fn forward_message(
    state: State<'_, ClientState>,
    conversation_id: String,
    envelope_id: i64,
    to_conversation_id: String,
    forwarded_from: Option<String>,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let from = parse_id(&conversation_id)?;
        let to = parse_id(&to_conversation_id)?;
        conversations::forward_message(&client.context(), from, envelope_id, to, forwarded_from)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, ClientState>,
    conversation_id: String,
    body: String,
) -> Result<MessageView, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err(failure("invalid_request", "Nothing to send."));
        }
        let sent = conversations::send_message(&client.context(), id, trimmed)?;
        Ok(MessageView {
            // A queued message has no envelope id -- the server assigns it, and
            // the server has not seen this yet. Negative ids are used as the
            // local key so they cannot collide with a real one, and so a UI
            // sorting by id keeps them at the end where they belong.
            envelope_id: sent.envelope_id().unwrap_or(-now_ms()),
            sender_device_id: None,
            body: trimmed.to_string(),
            sent_at_ms: now_ms(),
            outgoing: true,
            pending: sent.envelope_id().is_none(),
            attachment: None,
            client_id: sent.client_id().map(str::to_string),
            // We wrote it, so this build understands it by construction.
            call: None,
            unsupported: None,
            // Nothing is pinned, reacted to, edited or taken back the moment
            // it is sent.
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: None,
        })
    })
    .await
}

/// Sends a message answering another one.
///
/// `target` is the sender's name for the message being answered -- the same
/// kind of reference editing and taking back already use. A message sent before
/// names existed has none, and the UI does not offer to reply to one.
///
/// Nothing here checks that the target exists. It may have been sent to a
/// conversation this device joined later, and refusing the reply would be
/// refusing a message that is perfectly readable; the reader draws an
/// unresolved quote instead (see `ReplyView`).
#[tauri::command]
pub async fn send_reply(
    state: State<'_, ClientState>,
    conversation_id: String,
    body: String,
    target: String,
) -> Result<MessageView, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err(failure("invalid_request", "Nothing to send."));
        }
        let target = nexo_protocol::MessageId::parse_str(&target)
            .map_err(|_| failure("invalid_request", "That message cannot be replied to."))?;

        let sent = conversations::send_reply(&client.context(), id, trimmed, target)?;
        Ok(MessageView {
            envelope_id: sent.envelope_id().unwrap_or(-now_ms()),
            sender_device_id: None,
            body: trimmed.to_string(),
            sent_at_ms: now_ms(),
            outgoing: true,
            pending: sent.envelope_id().is_none(),
            attachment: None,
            client_id: sent.client_id().map(str::to_string),
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            // Left for the reload to fill. Resolving the quote needs the whole
            // conversation, and this call has one message -- the page already
            // refreshes after a send, and a half-resolved quote drawn for one
            // frame is worse than one that appears complete.
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: None,
        })
    })
    .await
}

/// Sends a picture or clip the recipient can open once.
///
/// The path crosses, not the bytes -- same as `send_attachment`, and for the
/// same reason. What differs is entirely on the far side: see
/// `Payload::ViewOnce`.
#[tauri::command]
pub async fn send_view_once(
    state: State<'_, ClientState>,
    conversation_id: String,
    path: String,
) -> Result<MessageView, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let path = std::path::PathBuf::from(&path);

        let contents = std::fs::read(&path).map_err(|e| {
            failure(
                "unreadable_file",
                format!("That file could not be read: {e}"),
            )
        })?;
        if contents.is_empty() {
            return Err(failure("invalid_request", "That file is empty."));
        }
        if contents.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(failure(
                "too_large",
                format!(
                    "Attachments are limited to {} MB.",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                ),
            ));
        }

        // From the bytes, not the extension: this decides what the recipient's
        // bubble will offer to play, and a sender-chosen name is not evidence.
        let mime = crate::feed::sniff_mime(&contents);
        if !crate::feed::is_playable(mime) {
            return Err(failure(
                "invalid_request",
                "Only a picture or a video can be sent this way.",
            ));
        }

        let sent = conversations::send_view_once(&client.context(), id, mime, &contents)?;
        Ok(MessageView {
            envelope_id: sent.envelope_id().unwrap_or(0),
            sender_device_id: None,
            body: String::new(),
            sent_at_ms: now_ms(),
            outgoing: true,
            pending: false,
            attachment: None,
            client_id: sent.client_id().map(str::to_string),
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            sticker: None,
            view_once: Some(ViewOnceView {
                // Ours never was. We kept the file we picked; a key that let us
                // reopen what the recipient cannot would make the bubble lie.
                openable: false,
                outgoing: true,
                opened_at_ms: Some(now_ms()),
                kind: if mime.starts_with("video/") {
                    "video".to_string()
                } else {
                    "image".to_string()
                },
            }),
        })
    })
    .await
}

/// Opens a view-once message once, and destroys its key on the way out.
///
/// Returns a data URL, like `attachment_data_url` -- but this is the only time
/// it can ever be produced for this message. A second call fails because the
/// key is gone, not because a check said no.
///
/// The WebView is handed bytes and never the key (rule 2), which is the same
/// boundary every other attachment keeps; what is different here is that on
/// this side of it there is nothing left afterwards.
#[tauri::command]
pub async fn open_view_once(
    state: State<'_, ClientState>,
    client_id: String,
) -> Result<String, ConversationErrorView> {
    with_client(&state, move |client| {
        let (contents, _declared) = conversations::open_view_once(&client.context(), &client_id)?;

        // Sniffed again here rather than trusted from the payload: this string
        // decides what the page will render, and the sender chose the other one.
        let mime = crate::feed::sniff_mime(&contents);
        if !crate::feed::is_playable(mime) {
            return Err(failure(
                "not_renderable",
                "That was not a picture or a video.",
            ));
        }
        Ok(crate::feed::data_url(mime, &contents))
    })
    .await
}

/// What a player needs before it asks for any bytes.
///
/// `None` when the attachment is not segmented, which is every file sent before
/// segmenting existed. The page then uses `attachment_data_url` exactly as it
/// did before -- a fallback that is always correct, only slower.
#[tauri::command]
pub async fn attachment_stream_info(
    state: State<'_, ClientState>,
    envelope_id: i64,
) -> Result<Option<StreamInfoView>, ConversationErrorView> {
    with_client(&state, move |client| {
        let info = conversations::stream_info(&client.context(), envelope_id)?;
        Ok(info.map(|i| StreamInfoView {
            size: i.size,
            segments: i.segments,
            mime: i.mime,
        }))
    })
    .await
}

/// What `attachment_stream_info` tells the page. No key, as ever.
#[derive(Debug, Clone, Serialize)]
pub struct StreamInfoView {
    pub size: u64,
    pub segments: u64,
    pub mime: String,
}

/// Sends a sticker.
///
/// The pack and the sticker's name, nothing else — the art is already in every
/// client. Nothing is uploaded and no third party is asked for anything, which
/// is why a sticker costs what a short message costs.
///
/// The pair is not validated here. A page can only offer what it has, and a
/// receiver that does not know the pair draws a placeholder saying so; refusing
/// the send instead would mean this build deciding what a *newer* build is
/// allowed to name.
#[tauri::command]
pub async fn send_sticker(
    state: State<'_, ClientState>,
    conversation_id: String,
    pack: String,
    sticker_id: String,
) -> Result<MessageView, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        if pack.is_empty() || sticker_id.is_empty() {
            return Err(failure("invalid_request", "That is not a sticker."));
        }
        let sent = conversations::send_sticker(&client.context(), id, &pack, &sticker_id)?;
        Ok(MessageView {
            envelope_id: sent.envelope_id().unwrap_or(-now_ms()),
            sender_device_id: None,
            // A sticker says nothing in words, and the bubble draws the art.
            body: String::new(),
            sent_at_ms: now_ms(),
            outgoing: true,
            pending: sent.envelope_id().is_none(),
            attachment: None,
            client_id: sent.client_id().map(str::to_string),
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: Some(StickerView {
                pack,
                id: sticker_id,
            }),
        })
    })
    .await
}

/// What somebody typed into a conversation and has not sent.
///
/// Read and written through Rust rather than kept in the page, because it is
/// message content: the same words the message would have carried, so it gets
/// the same protection the sent ones get. See the schema-19 migration.
#[tauri::command]
pub async fn draft(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<Option<String>, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        client
            .store
            .draft(&id.to_string())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Saves an unsent message. An empty body clears it.
#[tauri::command]
pub async fn set_draft(
    state: State<'_, ClientState>,
    conversation_id: String,
    body: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        client
            .store
            .set_draft(&id.to_string(), &body, now_ms())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Which conversations have an unsent message waiting, for the list to mark.
#[tauri::command]
pub async fn conversations_with_drafts(
    state: State<'_, ClientState>,
) -> Result<Vec<String>, ConversationErrorView> {
    with_client(&state, move |client| {
        client
            .store
            .conversations_with_drafts()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// A folder as the rail draws it.
#[derive(Debug, Clone, Serialize)]
pub struct FolderView {
    pub id: i64,
    pub name: String,
    /// Which conversations are filed here.
    pub conversations: Vec<String>,
}

/// Every folder on this device.
///
/// Local, always — folders never reach the server. How somebody files their own
/// conversations is a reading of who matters to them, and the server has no use
/// for it and no business holding it.
#[tauri::command]
pub async fn list_folders(
    state: State<'_, ClientState>,
) -> Result<Vec<FolderView>, ConversationErrorView> {
    with_client(&state, move |client| {
        let folders = client
            .store
            .folders()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;
        Ok(folders
            .into_iter()
            .map(|f| FolderView {
                id: f.id,
                name: f.name,
                conversations: f.conversations,
            })
            .collect())
    })
    .await
}

/// Makes a folder.
#[tauri::command]
pub async fn create_folder(
    state: State<'_, ClientState>,
    name: String,
) -> Result<i64, ConversationErrorView> {
    with_client(&state, move |client| {
        let name = name.trim();
        if name.is_empty() {
            return Err(failure("invalid_request", "A folder needs a name."));
        }
        // Long enough for anything anyone means, short enough that the rail
        // stays a rail. Truncated rather than refused: somebody who pasted a
        // sentence meant the beginning of it.
        let name: String = name.chars().take(40).collect();
        client
            .store
            .create_folder(&name, now_ms())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Renames a folder.
#[tauri::command]
pub async fn rename_folder(
    state: State<'_, ClientState>,
    folder_id: i64,
    name: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let name = name.trim();
        if name.is_empty() {
            return Err(failure("invalid_request", "A folder needs a name."));
        }
        let name: String = name.chars().take(40).collect();
        client
            .store
            .rename_folder(folder_id, &name)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Removes a folder. The conversations in it are untouched.
#[tauri::command]
pub async fn delete_folder(
    state: State<'_, ClientState>,
    folder_id: i64,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        client
            .store
            .delete_folder(folder_id)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Files a conversation in a folder, or takes it out.
#[tauri::command]
pub async fn set_folder_member(
    state: State<'_, ClientState>,
    folder_id: i64,
    conversation_id: String,
    member: bool,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        // Parsed to reject nonsense, then stored as the string the rest of the
        // schema uses for a conversation id.
        let id = parse_id(&conversation_id)?;
        client
            .store
            .set_folder_member(folder_id, &id.to_string(), member)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// Pulls anything new for one conversation.
#[tauri::command]
pub async fn sync_conversation(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<SyncView, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let outcome = conversations::sync(&client.context(), id)?;
        let arrivals = if outcome.messages > 0 {
            vec![ArrivalView {
                conversation_id: id.to_string(),
                messages: outcome.messages,
            }]
        } else {
            Vec::new()
        };
        let calls = outcome
            .calls
            .into_iter()
            .map(CallSignalView::from)
            .collect::<Vec<_>>();
        Ok(SyncView {
            messages: outcome.messages,
            commits: outcome.commits,
            failed: outcome.failed,
            arrivals,
            key_changed: if outcome.key_changes.is_empty() {
                Vec::new()
            } else {
                vec![id.to_string()]
            },
            calls,
        })
    })
    .await
}

/// Pulls anything new for every conversation.
///
/// What the app calls on a timer and after reconnecting. Returns the totals so
/// the UI can decide whether anything changed without re-reading every
/// conversation.
#[tauri::command]
pub async fn sync_all(state: State<'_, ClientState>) -> Result<SyncView, ConversationErrorView> {
    with_client(&state, |client| {
        // Before syncing what we know about, find out what we have been invited
        // to. An invitation lands as a server-side membership row and nothing
        // else; without this the Welcome sits unread in a conversation this
        // device never thinks to ask about.
        //
        // Offline is not fatal here: the conversations already known still sync
        // from the local list below.
        if let Err(error) = conversations::discover(&client.context()) {
            tracing::warn!(%error, "could not list conversations from the server");
        }

        let ids = client
            .store
            .conversation_ids()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;

        let mut total = SyncView {
            messages: 0,
            commits: 0,
            failed: 0,
            arrivals: Vec::new(),
            key_changed: Vec::new(),
            calls: Vec::new(),
        };
        for id in ids {
            let Ok(parsed) = id.parse::<ConversationId>() else {
                continue;
            };
            // One conversation failing must not stop the others: an unreachable
            // server would otherwise mean no conversation ever syncs.
            match conversations::sync(&client.context(), parsed) {
                Ok(outcome) => {
                    total.messages += outcome.messages;
                    total.commits += outcome.commits;
                    total.failed += outcome.failed;
                    total
                        .calls
                        .extend(outcome.calls.into_iter().map(CallSignalView::from));
                    if !outcome.key_changes.is_empty() {
                        // Named, not counted. The UI raises a banner on the
                        // conversation, and a total would say nothing about
                        // which one to look at.
                        total.key_changed.push(id.clone());
                    }
                    if outcome.messages > 0 {
                        total.arrivals.push(ArrivalView {
                            conversation_id: id,
                            messages: outcome.messages,
                        });
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, %id, "syncing one conversation failed");
                }
            }
        }
        Ok(total)
    })
    .await
}

/// Parses a call id the page handed back.
fn parse_call_id(id: &str) -> Result<nexo_protocol::CallId, ConversationErrorView> {
    id.parse()
        .map_err(|_| failure("invalid_request", "That is not a call id."))
}

/// Where to send a call's media, and the credential that opens the relay.
///
/// Asked once per call, immediately before offering or answering. Not cached:
/// the credential expires, and a stale one fails inside ICE where there is
/// nothing useful to report. A server with no relay configured refuses this,
/// which is how the page learns that calls are unavailable here.
#[tauri::command]
pub async fn call_ice_servers(
    state: State<'_, ClientState>,
) -> Result<nexo_protocol::IceServers, ConversationErrorView> {
    with_client(&state, |client| {
        client
            .transport
            .ice_servers()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::from(e)))
    })
    .await
}

/// Rings somebody: names a new call and sends the offer.
///
/// The id is minted here rather than in the page because it is the one thing
/// about a call that both sides must agree on, and a value invented in the
/// WebView would be a value Rust could only take somebody's word for. Handing
/// it back afterwards is what lets the page address the call it just started.
///
/// The SDP arrives already gathered — see [`nexo_protocol::Payload::Call`] for
/// why candidates are bundled rather than trickled.
#[tauri::command]
pub async fn call_offer(
    state: State<'_, ClientState>,
    conversation_id: String,
    video: bool,
    sdp: String,
) -> Result<String, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let call_id = nexo_protocol::CallId::new_v4();
        conversations::send_call_signal(
            &client.context(),
            id,
            call_id,
            CallSignal::Offer { video, sdp },
        )?;
        Ok(call_id.to_string())
    })
    .await
}

/// Accepts a call that is ringing.
#[tauri::command]
pub async fn call_answer(
    state: State<'_, ClientState>,
    conversation_id: String,
    call_id: String,
    video: bool,
    sdp: String,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let call_id = parse_call_id(&call_id)?;
        conversations::send_call_signal(
            &client.context(),
            id,
            call_id,
            CallSignal::Answer { video, sdp },
        )
        .map_err(ConversationErrorView::from)
    })
    .await
}

/// Ends a call — declined, cancelled, or finished.
///
/// One command for all three because they are one thing on the wire, and the
/// difference between them is the `reason` the record keeps. `seconds` is zero
/// for a call that never connected; the reason says which kind of nothing that
/// was.
#[tauri::command]
pub async fn call_hangup(
    state: State<'_, ClientState>,
    conversation_id: String,
    call_id: String,
    reason: HangupReason,
    seconds: u32,
) -> Result<(), ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let call_id = parse_call_id(&call_id)?;
        conversations::send_call_signal(
            &client.context(),
            id,
            call_id,
            CallSignal::Hangup { reason, seconds },
        )
        .map_err(ConversationErrorView::from)
    })
    .await
}

/// The decrypted history of one conversation, oldest first.
#[tauri::command]
pub async fn conversation_messages(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<Vec<MessageView>, ConversationErrorView> {
    with_client(&state, move |client| {
        parse_id(&conversation_id)?;
        let stored = client
            .store
            .messages(&conversation_id)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;

        // One lookup for the whole conversation rather than one per message.
        // "Mine" is decided against this device's id, not against a NULL --
        // see the schema-13 migration in `crates/store`.
        let me = client
            .store
            .account()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?
            .map(|a| a.device_id);
        let reactions = client
            .store
            .reactions(&conversation_id, me.as_deref())
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;

        // The conversation's view-once rows, by name, read in one go for the
        // same reason the quote lookup is: once per bubble would be once per
        // bubble too many.
        let burnt = client
            .store
            .view_once_in(&conversation_id)
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?;
        let view_once: std::collections::HashMap<&str, &nexo_store::StoredViewOnce> = burnt
            .iter()
            .map(|item| (item.client_id.as_str(), item))
            .collect();

        // Every message this device holds, by the sender's name for it, so a
        // quote is resolved from what is already loaded rather than by asking
        // the store once per reply. The thread is one conversation, and the
        // message being answered is nearly always in it.
        //
        // Owned in `refs` and borrowed in the map because `stored` is consumed
        // below to build the views: the names cannot be borrowed from rows that
        // are about to move.
        let refs: Vec<(String, StoredRef)> = stored
            .iter()
            .filter_map(|m| {
                m.client_id.as_ref().map(|name| {
                    (
                        name.clone(),
                        StoredRef {
                            envelope_id: m.envelope_id,
                            outgoing: m.sender_device_id.is_none(),
                            retracted: m.retracted_at_ms.is_some(),
                            body: m.body.clone(),
                        },
                    )
                })
            })
            .collect();
        let by_name: std::collections::HashMap<&str, &StoredRef> = refs
            .iter()
            .map(|(name, value)| (name.as_str(), value))
            .collect();

        // Queued messages, appended after the delivered ones. They belong in
        // the conversation -- someone wrote them and expects to see them --
        // and they are marked so the UI can draw them as not-yet-sent.
        let queued: Vec<MessageView> = client
            .store
            .outbox()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))?
            .into_iter()
            .filter(|item| item.conversation_id == conversation_id && !item.is_commit)
            .map(|item| MessageView {
                envelope_id: -item.queued_at_ms,
                sender_device_id: None,
                body: bubble_body(&item.body, item.payload.as_deref()),
                sent_at_ms: item.queued_at_ms,
                outgoing: true,
                pending: true,
                attachment: AttachmentView::from_payload(item.payload.as_deref()),
                client_id: item.client_id.clone(),
                call: None,
                unsupported: None,
                // A queued message has no envelope id yet, and that is what a
                // pin is keyed by. Nothing to pin until the server has it.
                pinned: false,
                retracted_at_ms: None,
                edited_at_ms: None,
                // It has a name, so it *could* carry reactions -- but nobody
                // has seen it to react to.
                reactions: Vec::new(),
                // A queued reply keeps its target in the payload until the
                // message lands in `messages` and gets its own column.
                reply: reply_target(item.payload.as_deref())
                    .map(|target| resolve_reply(&target, &by_name)),
                forwarded_from: forwarding(item.payload.as_deref()).1,
                forwarded: forwarding(item.payload.as_deref()).0,
                // A view-once never queues: it uploads first, so by the time
                // there is a message there is a server that has it.
                view_once: None,
                // A sticker can queue, and its payload is in the outbox for
                // exactly this reason -- the body is empty.
                sticker: sticker_in(item.payload.as_deref()),
            })
            .collect();

        Ok(stored
            .into_iter()
            .map(|m| {
                // Read before the row is consumed: the name is both the view's
                // own field and the key its reactions are filed under.
                let reactions = m
                    .client_id
                    .as_deref()
                    .and_then(|name| reactions.get(name))
                    .map(|list| {
                        list.iter()
                            .map(|r| ReactionView {
                                emoji: r.emoji.clone(),
                                count: r.count,
                                mine: r.mine,
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let outgoing = m.sender_device_id.is_none();
                let client_id_for_view_once = m.client_id.clone();
                let payload_for_sticker = m.payload.clone();
                let (forwarded, forwarded_from) = forwarding(m.payload.as_deref());
                MessageView {
                    forwarded,
                    forwarded_from,
                    envelope_id: m.envelope_id,
                    outgoing,
                    sender_device_id: m.sender_device_id,
                    attachment: AttachmentView::from_payload(m.payload.as_deref()),
                    call: CallRecordView::from_payload(m.payload.as_deref()),
                    unsupported: unsupported_kind(m.payload.as_deref()),
                    pinned: m.pinned,
                    retracted_at_ms: m.retracted_at_ms,
                    edited_at_ms: m.edited_at_ms,
                    reactions,
                    body: bubble_body(&m.body, m.payload.as_deref()),
                    sent_at_ms: m.sent_at_ms,
                    client_id: m.client_id,
                    // Everything in `messages` was accepted by the server
                    // before it was written there. What is still waiting lives
                    // in the outbox, and is appended below.
                    pending: false,
                    reply: m
                        .reply_to
                        .as_deref()
                        .map(|target| resolve_reply(target, &by_name)),
                    sticker: sticker_in(payload_for_sticker.as_deref()),
                    view_once: client_id_for_view_once
                        .as_deref()
                        .and_then(|name| view_once.get(name))
                        .map(|item| ViewOnceView {
                            openable: item.openable(),
                            outgoing,
                            opened_at_ms: item.opened_at_ms,
                            kind: if item.mime.starts_with("video/") {
                                "video".to_string()
                            } else {
                                "image".to_string()
                            },
                        }),
                }
            })
            .chain(queued)
            .collect())
    })
    .await
}

/// Sends everything waiting in the outbox.
///
/// Called on a timer and after the network returns. Being offline is not an
/// error: it is the state the queue exists for, and it leaves everything
/// exactly where it was.
#[tauri::command]
pub async fn flush_outbox(
    state: State<'_, ClientState>,
) -> Result<FlushView, ConversationErrorView> {
    with_client(&state, |client| {
        let outcome = nexo_client::outbox::flush(&client.context())?;
        Ok(FlushView {
            sent: outcome.sent,
            already_sent: outcome.already_sent,
            still_queued: outcome.still_queued,
            failed: outcome.failed,
        })
    })
    .await
}

/// How many messages are waiting to be sent.
#[tauri::command]
pub async fn outbox_count(state: State<'_, ClientState>) -> Result<i64, ConversationErrorView> {
    with_client(&state, |client| {
        client
            .store
            .outbox_len()
            .map_err(|e| ConversationErrorView::from(conversations::ConversationError::Store(e)))
    })
    .await
}

/// What a flush did.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct FlushView {
    pub sent: usize,
    /// Messages the server already had, matched by their client id.
    ///
    /// Reported separately from `sent` because they are the duplicates that
    /// idempotency prevented, and calling them "sent" would overstate what
    /// just happened.
    pub already_sent: usize,
    pub still_queued: usize,
    pub failed: usize,
}

/// Sends a file, given a path the user picked.
///
/// The **path** crosses the bridge, not the bytes. A 20 MB file base64-encoded
/// through IPC would be slow and pointless, and it would put the whole
/// plaintext in the WebView's heap for no reason (rule 2). Rust reads it,
/// encrypts it, and uploads it; the WebView learns only that it worked.
#[tauri::command]
pub async fn send_attachment(
    state: State<'_, ClientState>,
    conversation_id: String,
    path: String,
    body: Option<String>,
) -> Result<MessageView, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        let path = std::path::PathBuf::from(&path);

        // A directory, a missing file, or something unreadable: say which,
        // because "sending failed" is useless when the fix is picking a
        // different file.
        let contents = std::fs::read(&path).map_err(|e| {
            failure(
                "unreadable_file",
                format!("That file could not be read: {e}"),
            )
        })?;
        if contents.is_empty() {
            return Err(failure("invalid_request", "That file is empty."));
        }
        if contents.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(failure(
                "too_large",
                format!(
                    "Attachments are limited to {} MB.",
                    MAX_ATTACHMENT_BYTES / (1024 * 1024)
                ),
            ));
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "attachment".to_string());
        let mime = mime_for(&path);
        let body = body.as_deref().map(str::trim).filter(|b| !b.is_empty());
        let size = contents.len() as u64;

        let sent = conversations::send_attachment(
            &client.context(),
            id,
            &name,
            mime,
            &contents,
            body,
            None,
        )?;

        Ok(MessageView {
            // An attachment always goes straight to the server -- it has no
            // outbox path -- so there is an envelope id here. `unwrap_or(0)`
            // is the shape of the type, not an expected case.
            envelope_id: sent.envelope_id().unwrap_or(0),
            sender_device_id: None,
            body: body.unwrap_or(&name).to_string(),
            sent_at_ms: now_ms(),
            outgoing: true,
            pending: false,
            attachment: Some(AttachmentView {
                name: nexo_protocol::safe_file_name(&name),
                mime: mime.to_string(),
                size,
                // A picked file is never a voice note, whatever its extension.
                // That is the whole point of carrying the flag: this path had
                // no recorder behind it.
                voice: None,
                // Video is sealed in segments, so our own bubble streams it
                // back the same way the recipient's will.
                streamable: mime.starts_with("video/"),
            }),
            // The name the payload was given, so the bubble can be reacted to
            // and taken back without waiting for a reload.
            client_id: sent.client_id().map(str::to_string),
            // It parsed: this build wrote it.
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: None,
        })
    })
    .await
}

/// The longest recording this app will send.
///
/// Opus at the recorder's bitrate runs well under 20 kB per second, so this is
/// a few megabytes and a generous five minutes. It exists because the bytes
/// arrive over IPC rather than from a file on disk: `send_attachment` can weigh
/// a path before reading it, and this cannot -- by the time the argument is
/// here, whatever was sent has already been allocated.
const MAX_VOICE_BYTES: usize = 6 * 1024 * 1024;

/// Sends something the user recorded in the app.
///
/// **The bytes cross the bridge here, and that is deliberate**, against the
/// rule `send_attachment` follows two hundred lines above. The difference is
/// where the plaintext starts. A picked file is on disk, so passing its path
/// keeps it out of the WebView entirely; a recording is *made* in the WebView
/// -- `MediaRecorder` is the only capture this app has without a native audio
/// dependency -- so it is already in that heap before Rust hears about it.
/// Sending it down is moving plaintext out, not letting it in, and rule 2 is
/// unmoved: no key ever comes back the other way, and the encryption still
/// happens here.
///
/// `peaks` and `duration_ms` come from the recorder because only the recorder
/// has them; see [`nexo_protocol::VoiceMeta`].
#[tauri::command]
pub async fn send_voice_message(
    state: State<'_, ClientState>,
    conversation_id: String,
    audio_base64: String,
    mime: String,
    duration_ms: u32,
    peaks: Vec<u8>,
) -> Result<MessageView, ConversationErrorView> {
    with_client(&state, move |client| {
        use base64::Engine as _;

        let id = parse_id(&conversation_id)?;
        let contents = base64::engine::general_purpose::STANDARD
            .decode(audio_base64.as_bytes())
            .map_err(|_| failure("invalid_request", "That recording could not be read."))?;

        if contents.is_empty() {
            return Err(failure("invalid_request", "That recording is empty."));
        }
        if contents.len() > MAX_VOICE_BYTES {
            return Err(failure(
                "too_large",
                "That recording is too long. Five minutes is the limit.",
            ));
        }

        // Always `audio/`, whatever the recorder called it.
        //
        // `MediaRecorder` reports WebM/Opus as `video/webm` on some builds, and
        // that string is no longer cosmetic: `send_attachment` seals anything
        // `video/` in segments so it can be streamed, while a voice note is
        // fetched whole. A recording that claimed to be video would be sealed
        // one way and read the other, and would simply fail to open.
        let mime = if mime.starts_with("audio/") {
            mime
        } else {
            "audio/webm".to_string()
        };
        let name = format!("voice-{}.webm", now_ms());

        let voice = VoiceMeta {
            duration_ms,
            // Capped on the way in as well as on the way out. The renderer is
            // protected by `drawable_peaks`; this stops an oversized list being
            // encrypted into every recipient's copy in the first place.
            peaks: peaks.into_iter().take(VoiceMeta::MAX_PEAKS).collect(),
        };
        let drawable = voice.drawable_peaks().to_vec();
        let size = contents.len() as u64;

        let sent = conversations::send_attachment(
            &client.context(),
            id,
            &name,
            &mime,
            &contents,
            None,
            Some(voice),
        )?;

        Ok(MessageView {
            envelope_id: sent.envelope_id().unwrap_or(0),
            sender_device_id: None,
            // A recording has no words in it. The list shows what
            // `Payload::preview` makes of an attachment with no message.
            body: String::new(),
            sent_at_ms: now_ms(),
            outgoing: true,
            pending: false,
            attachment: Some(AttachmentView {
                name: nexo_protocol::safe_file_name(&name),
                mime,
                size,
                voice: Some(VoiceView {
                    duration_ms,
                    peaks: drawable,
                }),
                // A recording is small enough to fetch whole.
                streamable: false,
            }),
            client_id: sent.client_id().map(str::to_string),
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: None,
        })
    })
    .await
}

/// Downloads, decrypts, and writes an attachment to a path the user picked.
///
/// The destination comes from the native Save dialog, so the user chose it --
/// the sender's file name is only ever a suggestion, and a sanitised one.
#[tauri::command]
pub async fn save_attachment(
    state: State<'_, ClientState>,
    envelope_id: i64,
    path: String,
) -> Result<u64, ConversationErrorView> {
    with_client(&state, move |client| {
        let attachment = conversations::fetch_attachment_by_id(&client.context(), envelope_id)?;
        // Only reached if both the GCM tag and the SHA-256 matched, so nothing
        // partial or unverified is ever written to disk (rule 7).
        let size = attachment.contents.len() as u64;
        std::fs::write(&path, &attachment.contents).map_err(|e| {
            failure(
                "unwritable_file",
                format!("That file could not be saved: {e}"),
            )
        })?;
        Ok(size)
    })
    .await
}

/// An attachment, decrypted, as a `data:` URL the page can play or render.
///
/// The bytes never touch disk and the S3 key never leaves Rust. Only reached
/// when the GCM tag and the SHA-256 both matched, so nothing unverified is
/// ever rendered.
///
/// Refuses anything that is not actually a picture, a video or a sound,
/// whatever the sender called it: this value goes straight into the page, and
/// a sender-supplied MIME type is not evidence of anything.
#[tauri::command]
pub async fn attachment_data_url(
    state: State<'_, ClientState>,
    envelope_id: i64,
) -> Result<String, ConversationErrorView> {
    // Read under the lock, download outside it.
    //
    // The client lock covers the store, the MLS provider and the transport
    // together, and every command used to hold it for its whole duration. A
    // photo is a download and a decryption -- measured at about a second and a
    // half -- and while it ran, every other IPC call queued behind it: the
    // draft save from the message being typed at the time took 1.2 seconds for
    // no reason of its own. The store read is the only part that needs the
    // lock, so it is the only part that keeps it.
    let (transport, payload) = with_client(&state, move |client| {
        let payload = conversations::attachment_payload(&client.store, envelope_id)?;
        Ok((client.transport.clone(), payload))
    })
    .await?;

    let contents = tauri::async_runtime::spawn_blocking(move || {
        conversations::fetch_attachment_with(&*transport, &payload)
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "an attachment task panicked");
        failure("internal", "Something went wrong. Try again.")
    })?
    .map_err(ConversationErrorView::from)?;

    // Back under the lock, briefly: a rotated refresh token has to reach the
    // store, and `with_client` is what drains it.
    with_client(&state, |_| Ok(())).await?;

    if contents.len() > crate::feed::MAX_INLINE_IMAGE_BYTES {
        return Err(failure(
            "too_large",
            "That file is too large to open here. Save it instead.",
        ));
    }
    let mime = crate::feed::sniff_mime(&contents);
    if !crate::feed::is_playable(mime) {
        return Err(failure(
            "not_renderable",
            "That attachment is not a picture, a video or a sound.",
        ));
    }
    Ok(crate::feed::data_url(mime, &contents))
}

/// The largest file this app will send.
///
/// The server enforces its own ceiling; this one exists so the user is told
/// before a 40 MB read and encryption, not after.
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

/// A content type guessed from the extension.
///
/// Only a hint for the recipient's UI. Nothing is executed or rendered based on
/// it, and the recipient re-derives its own from the name it saves under, so a
/// wrong guess is cosmetic.
fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("txt" | "md" | "log") => "text/plain",
        Some("zip") => "application/zip",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        // Named separately from the rest of the audio below because the UI
        // treats these two as voice messages: they are what a recorder writes
        // when nothing has compressed it yet.
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        _ => "application/octet-stream",
    }
}

/// The safety number for a 1:1 conversation, for the Verify screen (brief 4.1).
///
/// `None` for a group: a safety number is a fingerprint over *both* parties and
/// there is no meaningful one to show for five.
#[tauri::command]
pub async fn safety_number(
    state: State<'_, ClientState>,
    conversation_id: String,
) -> Result<Option<String>, ConversationErrorView> {
    with_client(&state, move |client| {
        let id = parse_id(&conversation_id)?;
        Ok(conversations::safety_number(&client.provider, id)?)
    })
    .await
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_view_carries_no_ciphertext_or_keys() {
        let view = MessageView {
            envelope_id: 1,
            sender_device_id: Some("device".into()),
            body: "hello".into(),
            sent_at_ms: 0,
            outgoing: false,
            pending: false,
            attachment: None,
            client_id: Some("11111111-1111-1111-1111-111111111111".into()),
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: None,
        };
        let json = serde_json::to_string(&view).unwrap();
        for forbidden in ["ciphertext", "epoch", "key", "secret", "token"] {
            assert!(
                !json.contains(forbidden),
                "`{forbidden}` must not cross the IPC boundary: {json}"
            );
        }
    }

    #[test]
    fn an_attachment_view_carries_no_key_and_no_object_key() {
        // The whole reason `AttachmentView` exists rather than passing the
        // payload through: the payload holds the AES key that opens the file.
        // If it ever crossed this boundary, the file would be as good as
        // plaintext to anything running in the WebView (rule 2).
        let payload = Payload::Attachment {
            s3_key: "enc/11111111-1111-1111-1111-111111111111/deadbeef".into(),
            key: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff".into(),
            nonce: "000102030405060708090a0b".into(),
            sha256: "ff".repeat(32),
            name: "report.pdf".into(),
            mime: "application/pdf".into(),
            size: 1234,
            body: Some("here".into()),
            voice: None,
            segmented: false,
            // Deliberately unnamed: this is the shape a message sent before
            // names existed still has, and it must still produce a view.
            id: None,
        };
        let view = AttachmentView::from_payload(Some(&payload.encode_string()))
            .expect("an attachment payload should produce a view");

        let json = serde_json::to_string(&view).unwrap();
        for forbidden in [
            "00112233445566778899aabbccddeeff",
            "000102030405060708090a0b",
            "enc/",
            "deadbeef",
        ] {
            assert!(
                !json.contains(forbidden),
                "`{forbidden}` must not cross the IPC boundary: {json}"
            );
        }
        assert_eq!(view.name, "report.pdf");
        assert_eq!(view.size, 1234);
    }

    #[test]
    fn an_attachment_name_is_sanitised_before_the_webview_sees_it() {
        // The sender chose this string and the UI puts it in a save dialog.
        let payload = Payload::Attachment {
            s3_key: "enc/x/y".into(),
            key: "aa".repeat(32),
            nonce: "bb".repeat(12),
            sha256: "cc".repeat(32),
            name: r"..\..\Startup\evil.exe".into(),
            mime: "application/octet-stream".into(),
            size: 1,
            body: None,
            voice: None,
            segmented: false,
            id: None,
        };
        let view = AttachmentView::from_payload(Some(&payload.encode_string())).unwrap();
        assert_eq!(view.name, "evil.exe");
    }

    #[test]
    fn a_text_message_has_no_attachment_view() {
        assert!(AttachmentView::from_payload(None).is_none());
        assert!(AttachmentView::from_payload(Some(&Payload::text("hi").encode_string())).is_none());
        // And nonsense in the column is treated as "no attachment", not as a
        // reason to fail the whole message list.
        assert!(AttachmentView::from_payload(Some("not json at all")).is_none());
    }

    #[test]
    fn a_guessed_mime_is_only_ever_a_hint() {
        use std::path::Path;
        assert_eq!(mime_for(Path::new("a/b/photo.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("notes.md")), "text/plain");
        // Unknown and extensionless both fall back rather than guessing.
        assert_eq!(
            mime_for(Path::new("archive.xyz")),
            "application/octet-stream"
        );
        assert_eq!(mime_for(Path::new("Makefile")), "application/octet-stream");
    }

    #[test]
    fn a_view_once_view_carries_no_key_of_any_kind() {
        // The point of a separate view type. Whether the message is openable
        // is a boolean here; what would open it never leaves Rust (rule 2).
        let view = ViewOnceView {
            openable: true,
            outgoing: false,
            opened_at_ms: None,
            kind: "image".into(),
        };
        let json = serde_json::to_string(&view).unwrap();
        for forbidden in ["key", "nonce", "sha256", "s3", "enc"] {
            assert!(
                !json.contains(forbidden),
                "`{forbidden}` must not cross the IPC boundary: {json}"
            );
        }
    }

    #[test]
    fn a_quote_is_shortened_on_a_word_boundary() {
        let long = "the quick brown fox jumps over the lazy dog ".repeat(6);
        let cut = shorten(&long, QUOTE_CHARS);
        assert!(cut.ends_with('…'), "a cut quote says it was cut: {cut}");
        assert!(cut.len() <= QUOTE_CHARS + 8, "roughly the budget: {cut}");
        assert!(
            !cut.trim_end_matches('…').ends_with(' '),
            "no trailing space before the ellipsis: {cut}"
        );
    }

    #[test]
    fn a_short_quote_is_left_whole() {
        assert_eq!(shorten("yes", QUOTE_CHARS), "yes");
    }

    #[test]
    fn a_quote_with_no_spaces_is_cut_anyway() {
        // A long URL, or a language that does not space its words. Backing up
        // to a boundary that is not there must not return the whole string.
        let wall = "x".repeat(400);
        let cut = shorten(&wall, QUOTE_CHARS);
        assert!(
            cut.len() < wall.len(),
            "it still has to be cut: {}",
            cut.len()
        );
    }

    #[test]
    fn an_unresolved_quote_says_so_rather_than_drawing_a_blank() {
        // Replying to a message this device never received is ordinary, not an
        // error: somebody joined the conversation after it was sent.
        let empty = std::collections::HashMap::new();
        let view = resolve_reply("11111111-1111-1111-1111-111111111111", &empty);
        assert!(!view.found);
        assert!(view.excerpt.is_empty());
        assert_eq!(view.envelope_id, None);
    }

    #[test]
    fn a_quote_of_a_retracted_message_carries_no_words() {
        // The row survives a retraction, so the body may still be readable
        // here. Quoting it would put back exactly what was taken away.
        let target = StoredRef {
            envelope_id: 7,
            outgoing: false,
            retracted: true,
            body: "something regretted".into(),
        };
        let mut by_name = std::collections::HashMap::new();
        by_name.insert("abc", &target);

        let view = resolve_reply("abc", &by_name);
        assert!(view.found);
        assert!(view.retracted);
        assert!(
            view.excerpt.is_empty(),
            "a retracted message must not be quoted back: {}",
            view.excerpt
        );
    }

    #[test]
    fn our_own_messages_are_marked_outgoing_by_the_absent_sender() {
        // MLS does not let a sender decrypt its own ciphertext, so ours are
        // stored with no sender. That absence is the signal, and it needs to
        // stay one.
        let mine = MessageView {
            envelope_id: 1,
            sender_device_id: None,
            body: "mine".into(),
            sent_at_ms: 0,
            outgoing: true,
            pending: false,
            attachment: None,
            client_id: None,
            call: None,
            unsupported: None,
            pinned: false,
            retracted_at_ms: None,
            edited_at_ms: None,
            reactions: Vec::new(),
            reply: None,
            forwarded_from: None,
            forwarded: false,
            view_once: None,
            sticker: None,
        };
        assert!(mine.outgoing);
        assert!(mine.sender_device_id.is_none());
    }

    #[test]
    fn an_unreachable_server_is_not_reported_as_being_signed_out() {
        use nexo_client::transport::TransportError;
        let view = ConversationErrorView::from(conversations::ConversationError::Transport(
            TransportError::Unreachable("connection refused".into()),
        ));
        assert_eq!(view.kind, "unreachable");
        assert_ne!(view.kind, "signed_out");
        // And the network detail is not repeated at the user.
        assert!(!view.message.contains("connection refused"));
    }

    #[test]
    fn a_stale_epoch_is_its_own_kind() {
        // The UI resyncs on this rather than showing an error, so it must be
        // distinguishable from a generic refusal.
        use nexo_client::transport::TransportError;
        let view = ConversationErrorView::from(conversations::ConversationError::Transport(
            TransportError::StaleEpoch { current: 4 },
        ));
        assert_eq!(view.kind, "stale_epoch");
    }
}
