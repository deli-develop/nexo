//! Wire types shared by the Nexo client and server.
//!
//! Deliberate constraints on this crate:
//! - no I/O, no crypto, no platform calls, so it compiles unchanged for Android;
//! - nothing here may carry message plaintext. The server handles these types,
//!   and the server must never be able to read message contents (brief rule 4).

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod window;

// Re-exported so the shell can parse a message name without taking its own
// dependency on `uuid`. The type is already this crate's vocabulary: every id
// on the wire is one.
pub use uuid::Uuid as MessageId;
/// The same type under the name the call code means by it.
///
/// An alias, not a new type: it buys documentation rather than safety, which is
/// the same trade [`MessageId`] already makes. What it prevents is a signature
/// reading `MessageId` for something that names a call and not a message.
pub use uuid::Uuid as CallId;

/// Wire protocol version. Bump on any breaking change to the types below.
///
/// 2 adds the Meet&Greet types at the end of this file. 3 gives a message a
/// name of its own, so a later reaction, edit or retraction can refer to it.
pub const PROTOCOL_VERSION: u16 = 3;

/// A conversation identifier. One MLS group per conversation; a 1:1 chat is a
/// two-member group with no special-casing (§4.2).
pub type ConversationId = Uuid;

/// A device identifier. In v0.1 an account has exactly one device, but the MLS
/// group member is the *device*, not the user, so multi-device is an added
/// member later rather than a schema change.
pub type DeviceId = Uuid;

/// The complete set of fields that travel with a message on the wire.
///
/// §4.2 fixes this shape: nothing else is permitted. No plaintext subject, no
/// preview, no attachment filename, no MIME type. Attachment metadata lives
/// *inside* `ciphertext`, never beside it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Envelope {
    /// Which conversation this belongs to.
    pub conversation_id: ConversationId,
    /// Which device sent it.
    pub sender_device_id: DeviceId,
    /// The MLS epoch the ciphertext was produced in.
    pub epoch: u64,
    /// The opaque MLS message. The server never decrypts this.
    #[serde(with = "serde_bytes_vec")]
    pub ciphertext: Vec<u8>,
    /// Server receive time, in milliseconds since the Unix epoch. Set by the
    /// server; a client-supplied value is ignored.
    pub server_timestamp_ms: i64,
}

/// What a recorded message carries besides its bytes.
///
/// Two things the receiver cannot cheaply work out for itself. Duration is in
/// the container, but reading it means decoding enough of the file to find it,
/// and the bubble has to be the right width before that finishes. The peaks are
/// not in the file at all at any price short of decoding the whole of it.
///
/// Both are drawn, and neither is trusted for anything else. A sender who lies
/// about the duration gets a bubble whose label disagrees with its own player,
/// which is the entire consequence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VoiceMeta {
    /// How long the recording runs, in milliseconds, as the recorder measured
    /// it. Shown before the file has been decoded, and replaced by the player's
    /// own figure once it has one.
    pub duration_ms: u32,
    /// A coarse amplitude envelope, one byte per bucket, `0`–`255`.
    ///
    /// The waveform is what makes a four-second note look different from a
    /// forty-second one before anybody presses play. It is deliberately crude:
    /// [`VoiceMeta::MAX_PEAKS`] buckets is enough to draw and far too few to
    /// carry speech. Bytes rather than floats because this sits inside every
    /// copy of the ciphertext, and a `Vec<f32>` would be four times the size to
    /// no visible effect.
    pub peaks: Vec<u8>,
}

impl VoiceMeta {
    /// The most buckets a recorder may send.
    ///
    /// A cap rather than a fixed count, because a two-second note has no use
    /// for sixty-four bars and should not pay for them. Enforced on arrival:
    /// a longer list is truncated rather than refused, since a waveform is
    /// decoration and losing the tail of one is not worth dropping a message
    /// somebody recorded.
    pub const MAX_PEAKS: usize = 64;

    /// The peaks, capped, for drawing.
    ///
    /// Every reader goes through this rather than the field, so a payload built
    /// by something other than this app cannot make the renderer draw ten
    /// thousand bars.
    #[must_use]
    pub fn drawable_peaks(&self) -> &[u8] {
        let end = self.peaks.len().min(Self::MAX_PEAKS);
        &self.peaks[..end]
    }
}

/// `skip_serializing_if` needs a function, not a comparison.
fn is_false(value: &bool) -> bool {
    !*value
}

/// What is actually inside an MLS ciphertext.
///
/// §4.2 fixes the *envelope* shape and forbids a plaintext subject, preview,
/// filename or MIME type beside a message. This is the other half of that rule:
/// everything those would have carried lives **inside** the ciphertext instead,
/// where the server cannot reach it.
///
/// Tagged and versioned, because this is the one structure both ends must agree
/// on forever. A client meeting a `kind` it does not know shows "this message
/// needs a newer version of Nexo" rather than guessing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum Payload {
    /// An ordinary message.
    Text {
        /// The message.
        body: String,
        /// This sender's name for this message.
        ///
        /// Not the envelope id: that is the server's number, and a message
        /// still sitting in the outbox does not have one — which is exactly
        /// the window in which somebody wants to take a message back. Not the
        /// `client_msg_id` either: that one is the server's idempotency key,
        /// and a value that was both would sit in the server's tables in
        /// cleartext *and* inside everyone's ciphertext.
        ///
        /// `None` for anything sent before this existed. Such a message cannot
        /// be named, so it cannot be edited or retracted, and the menu does
        /// not offer it — absence has to be representable for that to work,
        /// which is why this is an `Option` rather than a defaulted `Uuid`
        /// that would give every old message the same nil name.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<Uuid>,
        /// Who wrote it first, when this message is a forward of another.
        ///
        /// The sender's word, not the server's: nobody but the forwarder knows
        /// where it came from, and nobody else can check it. So the UI says
        /// "forwarded" as a claim by the person who forwarded it, which is the
        /// only thing it truthfully can.
        ///
        /// `None` covers both "not a forward" and "forwarded, but this device
        /// could not name the original author" — a group message whose sender
        /// it cannot resolve. Absence has to be representable for the second
        /// case, which is why it is not a defaulted empty string.
        ///
        /// Defaulted and skipped when absent, like `id` above, so every
        /// message sent before this existed stays byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        forwarded_from: Option<String>,
        /// Whether this is a forward at all.
        ///
        /// Separate from the name above because `Option<String>` cannot tell
        /// "not a forward" from "a forward whose author could not be named",
        /// and the reader is owed the difference: the first is an ordinary
        /// message, the second says plainly that it came from somewhere else
        /// without claiming to know where. Skipped when false, so a message
        /// that is not a forward is byte-identical to one sent before this
        /// field existed.
        #[serde(default, skip_serializing_if = "is_not_forwarded")]
        forwarded: bool,
    },
    /// A file. The bytes live in object storage; the key to them is here.
    ///
    /// This is why an attachment is end-to-end encrypted rather than merely
    /// encrypted-at-rest: the object in the bucket is AES-256-GCM ciphertext,
    /// and the only copy of the key that opens it is inside an MLS message the
    /// server cannot read.
    Attachment {
        /// Where the ciphertext sits in the bucket.
        s3_key: String,
        /// The AES-256-GCM key, hex. **Never leaves an MLS message.**
        key: String,
        /// The nonce, hex. Fresh per file.
        nonce: String,
        /// SHA-256 of the *plaintext*, hex, so a recipient can tell a corrupted
        /// download from a tampered one.
        sha256: String,
        /// The original file name. Inside the ciphertext, never beside it.
        name: String,
        /// MIME type, likewise inside.
        mime: String,
        /// Plaintext size in bytes.
        size: u64,
        /// An optional message sent with the file.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        /// Present when the sender recorded this rather than picked it.
        ///
        /// The receiver draws a voice note instead of a file row, and it is the
        /// *sender* who says so. Guessing from the MIME type is what the client
        /// does for everything that predates this field, and it is only ever a
        /// reading: a `.wav` is more often speech than music, which is not the
        /// same as knowing. A recorder knows.
        ///
        /// `Option`, and absent on the wire when there is none, so that every
        /// message already sent stays byte-identical and the extension list
        /// keeps answering for them.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        voice: Option<VoiceMeta>,
        /// Whether the object is sealed in segments rather than as one piece.
        ///
        /// The two encodings are **not distinguishable from the ciphertext**,
        /// so this has to be carried: a reader that guessed would either fail
        /// every whole-object file or read segment headers out of a file that
        /// has none.
        ///
        /// `false` by default and omitted when false, so every message sent
        /// before segmenting existed stays byte-identical on the wire. The
        /// segment count is *not* carried -- it is derived from `size`, and a
        /// sender who lies about `size` then fails the per-segment
        /// authentication rather than being believed.
        #[serde(default, skip_serializing_if = "is_false")]
        segmented: bool,
        /// This sender's name for this message. See [`Payload::Text`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<Uuid>,
    },
    /// A change to what the conversation is called.
    ///
    /// Sent as an ordinary message so every member converges on the same name,
    /// and so the **server never learns it**. A title column on the server
    /// would have been simpler and would have handed it whatever people call
    /// their group — which is content, not the routing metadata the threat
    /// model already concedes.
    ///
    /// Renaming is last-writer-wins by envelope order. Two people renaming at
    /// once is not worth a merge: the later one is what everybody sees, and
    /// they can see each other do it.
    Rename {
        /// What the conversation is now called.
        title: String,
    },
    /// A new picture for the conversation.
    ///
    /// Encrypted exactly like an [`Payload::Attachment`], and for the same
    /// reason: the object in the bucket is AES-256-GCM ciphertext and the only
    /// copy of the key is inside an MLS message. A group's picture is
    /// something its members chose to show each other, not something the
    /// server is entitled to look at.
    GroupAvatar {
        /// Where the ciphertext sits in the bucket.
        s3_key: String,
        /// The AES-256-GCM key, hex. **Never leaves an MLS message.**
        key: String,
        /// The nonce, hex. Fresh per image.
        nonce: String,
        /// SHA-256 of the *plaintext*, hex.
        sha256: String,
        /// MIME type, sniffed from the bytes rather than the file name.
        mime: String,
        /// Plaintext size in bytes.
        size: u64,
    },
    /// A reaction to a message, added or taken away.
    ///
    /// Inside the ciphertext, and it has to be: an emoji is content, and a
    /// server-side reaction endpoint would hand the server exactly what rule 4
    /// says it may never have. `Rename` is the shape this follows — a payload
    /// that changes shared state, draws no bubble of its own, and ends the
    /// receive branch with `continue`.
    ///
    /// One variant with a toggle rather than two, for the reason `posts.rs`
    /// gives for having a single endpoint: adding and removing are the same
    /// act with opposite sign, and splitting them doubles what a receiver has
    /// to keep in step.
    Reaction {
        /// The message being reacted to, by the name inside its ciphertext.
        ///
        /// Not the envelope id: that is the server's number, and a reaction
        /// can be sent to a message that is still in an outbox.
        target: Uuid,
        /// The emoji. Checked with [`is_reaction_emoji`] on both sides.
        emoji: String,
        /// True to add, false to take it back.
        ///
        /// Defaulted so that an older sender that only ever adds is read
        /// correctly rather than as a removal.
        #[serde(default = "yes")]
        on: bool,
    },
    /// Take a message back.
    ///
    /// A **request**, not a deletion. It asks every Nexo installation that has
    /// the message to empty it, and a well-behaved one does. A modified client
    /// keeps its copy, and the UI must never say otherwise — see
    /// `docs/THREAT-MODEL.md`.
    Retract {
        /// The message being taken back, by the name inside its ciphertext.
        target: Uuid,
    },
    /// Change what a message says.
    ///
    /// The same request, with a replacement. Only the sender's own device may
    /// do either; that is checked on arrival against the envelope's
    /// authenticated sender, not asserted here.
    Edit {
        /// The message being changed.
        target: Uuid,
        /// What it says now.
        body: String,
        /// The sender's clock when they changed it.
        ///
        /// Advisory. It is shown beside the message, and it is *not* what the
        /// window is judged against — the receiver uses the server's timestamps
        /// on both envelopes, so a wrong clock on one device cannot buy time
        /// or lose it.
        edited_at_ms: i64,
    },
    /// A message answering another one.
    ///
    /// Carries its own words rather than wrapping a `Text`, because a reply is
    /// one message and not two: a build that flattened it into a quote plus a
    /// body would have to decide what the search index and the conversation
    /// preview see, and the answer for both is "the reply itself".
    ///
    /// **The quoted text is not carried.** Only the name of the message being
    /// answered. Copying the original in would put a second, unrevocable copy
    /// of somebody's words inside a message they did not send — so retracting
    /// the original would leave it quoted forever, and quoting would become a
    /// way to defeat taking a message back. The reader resolves the target
    /// against what it already has, and says so plainly when it has nothing.
    Reply {
        /// The message being answered, by the name inside its ciphertext.
        ///
        /// The same kind of reference `Edit` and `Retract` use, and it fails
        /// the same way: a message sent before names existed cannot be
        /// referred to, so the UI does not offer to reply to one.
        target: Uuid,
        /// What the reply says.
        body: String,
        /// This sender's name for *this* message. See [`Payload::Text`].
        ///
        /// A reply can itself be replied to, edited and taken back, so it needs
        /// a name of its own like any other message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<Uuid>,
    },
    /// A sticker, by name.
    ///
    /// **A name, not a picture.** The art is bundled in every client, so what
    /// travels is a few bytes inside the ciphertext rather than an upload, an
    /// object in the bucket, a key and a download. A sticker therefore costs
    /// what a short message costs, which is the only reason sending one feels
    /// free.
    ///
    /// It also means the server learns nothing from a sticker that it does not
    /// learn from any other message — no object appears in storage, and no
    /// third party is asked for anything, so nobody outside the conversation
    /// knows a sticker was sent at all, let alone which.
    ///
    /// A client that does not have the pack draws a placeholder saying so. That
    /// is the one cost of naming rather than sending: an old build cannot
    /// render a sticker added after it shipped, and must say so rather than
    /// guess.
    Sticker {
        /// Which pack. Carried so a second pack can exist later without its
        /// ids having to avoid this one's.
        pack: String,
        /// Which sticker in it. Stable for the life of the pack — renaming one
        /// would silently change what old messages show.
        id: String,
        /// This sender's name for this message. See [`Payload::Text`].
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<Uuid>,
    },
    /// A picture or a clip meant to be opened once.
    ///
    /// The same shape as an [`Payload::Attachment`], and encrypted the same way
    /// — what differs is entirely on the receiving side, and it is worth being
    /// exact about what it does and does not buy.
    ///
    /// **What it does.** The key that opens the ciphertext is stored apart from
    /// the message, and destroyed when the file is opened. After that this
    /// device cannot read the object again: not "declines to", cannot. The
    /// ciphertext in the bucket is meaningless without the key, and the copy in
    /// the message is gone with it. That is a stronger promise than a client
    /// refusing to show something it could still decrypt, because a client can
    /// be modified and a missing key cannot be argued with.
    ///
    /// **What it does not.** Anything the viewer does while it is open. A
    /// screenshot, a photograph of the screen, a modified build that keeps the
    /// bytes. There is no notification for those, deliberately: sending one
    /// would imply a guarantee `docs/THREAT-MODEL.md` §4 explicitly disclaims,
    /// since the viewer's own device is out of scope. The UI says the true
    /// thing instead of the reassuring one (rule 5).
    ViewOnce {
        /// Where the ciphertext sits in the bucket.
        s3_key: String,
        /// The AES-256-GCM key, hex. Kept apart from the message on arrival and
        /// destroyed on opening -- that destruction *is* the feature.
        key: String,
        /// The nonce, hex.
        nonce: String,
        /// SHA-256 of the plaintext, hex.
        sha256: String,
        /// MIME type. No file name: this is never saved anywhere, so there is
        /// nothing for a name to name.
        mime: String,
        /// Plaintext size in bytes.
        size: u64,
        /// This sender's name for this message. See [`Payload::Text`].
        ///
        /// Not optional here. Everything about this message is keyed by it --
        /// the key row that opens it, and the record that it was opened -- and
        /// unlike the older variants there is no history of unnamed ones to
        /// stay compatible with.
        id: Uuid,
    },
    /// A story, and the key that opens it.
    ///
    /// The object is encrypted exactly once, like an attachment, and this
    /// payload is sent down every conversation the author already has. That is
    /// the whole design, and the reason for it is blocking: the delivery
    /// service checks `blocked_between` only for two-member conversations, so a
    /// story *group* would keep reaching somebody who blocked its author until
    /// an explicit removal commit landed. Sending down existing conversations
    /// inherits the check that already works — a blocked person has no
    /// deliverable conversation left.
    ///
    /// It draws no bubble. Like `Rename`, it changes state elsewhere and ends
    /// the receive branch with `continue`.
    Story {
        /// The server's id for this story.
        ///
        /// Carried because the reader needs it and cannot derive it: fetching
        /// the bytes is `POST /v1/stories/{id}/url`, and an envelope names a
        /// device rather than anything the stories table knows about. The
        /// receiver used to hash `s3_key` into a stand-in id, which no server
        /// route has ever recognised — a contact's story could be listed and
        /// never opened.
        ///
        /// It is not a capability and grants nothing. The download route still
        /// checks contact, block and expiry for the *caller*, so a sender who
        /// named somebody else's story would only point a reader at bytes they
        /// were already allowed to fetch — and hand them the wrong key for it.
        ///
        /// `default` rather than a version bump: a story from a build that
        /// predates this field arrives as `0`, which the receiver reads as
        /// "unknown" and falls back on exactly as it behaved before.
        #[serde(default)]
        story_id: i64,
        /// Where the ciphertext is, in the **encrypted** bucket.
        s3_key: String,
        /// The AES-256-GCM key, hex. Fresh for this story and nothing else.
        key: String,
        /// The nonce, hex.
        nonce: String,
        /// SHA-256 of the *plaintext*, hex.
        sha256: String,
        /// MIME type, sniffed from the bytes rather than a file name.
        mime: String,
        /// Plaintext size in bytes.
        size: u64,
        /// When it stops being available, by the server's clock.
        ///
        /// Carried so a reader can drop it without asking anybody. The server
        /// refuses the bytes after this too — the two are independent, and
        /// both are needed: the reader's copy of the key is what actually has
        /// to go, and only the reader can remove that.
        expires_at_ms: i64,
    },
    /// One step of setting up, accepting or ending a call.
    ///
    /// Signalling rides the conversation rather than a route of its own, and
    /// that is what makes it end-to-end encrypted without any new machinery:
    /// an offer's SDP names codecs and, once gathering has finished, the
    /// network candidates that reach this device. On a plaintext route the
    /// server would read both. Here it moves the same opaque envelope it
    /// already moves — rule 4, at no cost.
    ///
    /// **Candidates are bundled into the offer and the answer, never
    /// trickled.** Trickle ICE sends a message per candidate, and a build that
    /// predates this variant draws every one of them as an `Unsupported`
    /// bubble — one call would fill an older installation's conversation with
    /// punctuation. Waiting for gathering to finish costs a fraction of a
    /// second against a relay and holds the whole exchange to two messages, so
    /// what an old client sees is at most an offer and a hangup.
    ///
    /// Only [`CallSignal::Hangup`] leaves a bubble behind. An offer and an
    /// answer are machinery: they end the receive branch with `continue`, the
    /// way [`Payload::Rename`] does.
    Call {
        /// Which call this is about.
        ///
        /// Minted by the caller and echoed by every later signal. Without it a
        /// hangup that crosses a second invitation on the wire would end the
        /// wrong call — two people ringing each other at once is the ordinary
        /// way that happens, not a rare one.
        call_id: CallId,
        /// What this message does.
        signal: CallSignal,
    },
    /// A payload this build cannot read.
    ///
    /// Produced only by [`Payload::decode`] and never sent — it is what a
    /// client does *instead of* guessing. The alternative is what this used to
    /// do: render the raw JSON as though someone had typed it, which turns
    /// every future variant into a bubble full of punctuation on every
    /// installation that has not updated yet.
    ///
    /// The `kind` is carried so the UI can say which thing is missing rather
    /// than only that something is. The undecoded bytes are kept beside the
    /// message by the client, because MLS will not decrypt that envelope a
    /// second time: a build that learns the variant later can still read what
    /// arrived today.
    #[serde(skip)]
    Unsupported {
        /// The `kind` the sender used.
        kind: String,
    },
}

/// A step in one call's life, inside [`Payload::Call`].
///
/// Tagged like [`Payload`] itself and for the same reason: a build that meets a
/// signal it does not know must be able to say so rather than guess. An
/// unreadable signal fails the call closed (rule 7) — it never falls back to
/// "probably an answer".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "signal", rename_all = "snake_case")]
#[non_exhaustive]
pub enum CallSignal {
    /// Somebody is calling. Ring.
    Offer {
        /// Whether the caller is offering video as well as sound.
        ///
        /// The SDP says this too, but only to something that parses SDP. The
        /// callee has to draw a ringing screen — "video call from …" — before
        /// anything has parsed anything, so the answer is carried plainly.
        video: bool,
        /// The offer, with ICE candidates already gathered into it.
        sdp: String,
    },
    /// Accepted, with the other half of the negotiation.
    Answer {
        /// Whether the answerer is sending video back. A video call answered
        /// with the camera off is an ordinary thing to do, and it is not the
        /// caller's decision.
        video: bool,
        /// The answer, candidates included.
        sdp: String,
    },
    /// The call is over — before it started, or after.
    ///
    /// The only signal that leaves a message behind, because it is the only one
    /// a person would ever want to look back at. It is written by whichever
    /// side ends the call, and both sides store the record from it, so a
    /// conversation reads the same on both machines.
    Hangup {
        /// Why it ended. The receiving UI says "Missed call" or "Declined"
        /// from this rather than inferring it from who sent what.
        reason: HangupReason,
        /// How long the two were connected, in whole seconds.
        ///
        /// Zero for a call that never connected, which is not the same
        /// statement as `reason` makes: a call can be `Ended` after two seconds
        /// or after an hour, and the record shows the difference.
        ///
        /// Defaulted so a signal written before this field existed still reads.
        #[serde(default)]
        seconds: u32,
    },
}

/// Why a call ended, for the record it leaves in the conversation.
///
/// Separate from "who sent the hangup", because the two do not line up: a
/// caller who gives up sends `Cancelled` and the callee shows a *missed* call,
/// while a callee who refuses sends `Declined` and the caller shows exactly
/// that. Deriving either from the sender would get one of them wrong.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum HangupReason {
    /// The caller gave up before it was answered. The callee missed it.
    Cancelled,
    /// The callee refused it.
    Declined,
    /// It connected, and then somebody hung up. The ordinary ending.
    Ended,
    /// The media path never came up. Not anybody's decision — a failure, and
    /// the UI is allowed to say so rather than pretending somebody hung up.
    Failed,
}

/// Where to reach the relay, and the short-lived credential that opens it.
///
/// Fetched per call rather than compiled into the client, for two reasons that
/// both matter. The credential **expires**, so a copy that leaked from a device
/// stops working on its own rather than handing somebody free bandwidth for
/// ever. And the relay's address can move — a second host, a different port —
/// without shipping a release to every installation.
///
/// The shape deliberately mirrors WebRTC's `RTCIceServer`, so the page hands
/// this to `RTCPeerConnection` almost unchanged. Inventing a different shape
/// here would buy a translation step and nothing else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IceServers {
    /// The servers to try, in order.
    pub servers: Vec<IceServer>,
    /// When the credential stops working, ms since the epoch.
    ///
    /// Carried so a client can tell "my credential expired mid-call" from "the
    /// relay is down", which need different answers: the first is refetched,
    /// the second is reported.
    pub expires_at_ms: i64,
    /// Whether every call must go through the relay rather than peer to peer.
    ///
    /// The server decides this, not the client, so the policy can change
    /// without a release. It is `true` today and the reason is not bandwidth:
    /// a direct connection hands the other side your home IP address in the
    /// ICE candidates, and "who you called" plus "where you live" is not a
    /// trade a messenger should make silently. Relaying costs a hop and hides
    /// both ends from each other.
    pub relay_only: bool,
}

/// One relay or STUN server, in WebRTC's own vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IceServer {
    /// One server reachable several ways — UDP, TCP, TLS.
    pub urls: Vec<String>,
    /// Absent for a plain STUN server, which needs no credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// The credential that goes with `username`. Short-lived, and useless once
    /// `expires_at_ms` has passed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

/// `serde` needs a function, not a literal, for a default of `true`.
fn yes() -> bool {
    true
}

/// So `forwarded: false` is left out of the wire entirely.
fn is_not_forwarded(forwarded: &bool) -> bool {
    !*forwarded
}

impl Payload {
    /// A plain text message, with a fresh name.
    ///
    /// Minted here rather than by the caller so that every message made this
    /// way has one. The sender reads it back with [`Payload::id`] before
    /// encrypting: MLS ratchets on encryption and those bytes *are* the
    /// message, so there is no second chance to look inside and learn what it
    /// was called.
    pub fn text(body: impl Into<String>) -> Self {
        Self::Text {
            body: body.into(),
            id: Some(Uuid::new_v4()),
            forwarded_from: None,
            forwarded: false,
        }
    }

    /// A message passed on from somewhere else.
    ///
    /// `from` is what the forwarding device believes the original author to be
    /// — `None` when it cannot tell, which is the honest answer for a group
    /// message whose sender it could not resolve.
    pub fn forwarded(body: impl Into<String>, from: Option<String>) -> Self {
        Self::Text {
            body: body.into(),
            id: Some(Uuid::new_v4()),
            forwarded_from: from,
            forwarded: true,
        }
    }

    /// The sender's name for this message, when it has one.
    ///
    /// `None` for a payload that carries no name at all — a rename, a group
    /// picture, something this build cannot read, or a message from before
    /// names existed. Nothing can refer to those, and the UI offers no action
    /// that would try.
    pub fn id(&self) -> Option<Uuid> {
        match self {
            Payload::Text { id, .. }
            | Payload::Attachment { id, .. }
            | Payload::Reply { id, .. } => *id,
            // Always named -- see the variant.
            Payload::ViewOnce { id, .. } => Some(*id),
            // Named `message_id` rather than `id`, because `id` on this variant
            // already means the sticker.
            Payload::Sticker { message_id, .. } => *message_id,
            _ => None,
        }
    }

    /// What to show in a conversation list, and in the bubble.
    ///
    /// An attachment with no message shows its file name, because "" is not a
    /// useful thing to render and the name is already inside the ciphertext.
    pub fn preview(&self) -> &str {
        match self {
            // A reply is something somebody said, so it previews like one.
            // The quote is not part of it: a list row showing "> yes ..." for
            // every answer in a busy conversation says less than the answer.
            Payload::Text { body, .. } | Payload::Reply { body, .. } => body,
            Payload::Attachment { body, name, .. } => match body {
                Some(body) if !body.is_empty() => body,
                _ => name,
            },
            // None of these is something anyone said, so none is a preview of
            // the conversation. The row keeps whatever came before it. A
            // reaction especially: a conversation whose list entry changed to
            // an emoji every time somebody tapped one would be unreadable.
            // A sticker has no words either. The list draws it from `sticker`
            // on the view, the way it draws an attachment from `attachment` --
            // putting "Sticker" here would bake English into a crate that has
            // none, and the wrong English for anybody not reading it.
            Payload::Sticker { .. }
            // A view-once has no words and no file name, so there is nothing
            // to preview either. The list says "Photo" or "Video" from the
            // kind, which the bubble decides.
            | Payload::ViewOnce { .. }
            | Payload::Rename { .. }
            | Payload::GroupAvatar { .. }
            | Payload::Reaction { .. }
            | Payload::Retract { .. }
            | Payload::Edit { .. }
            | Payload::Story { .. }
            // A call has no words. The record a finished call leaves is drawn
            // from its `reason` and `seconds` by the bubble, the way a sticker
            // is drawn from the payload -- putting "Missed call" here would
            // bake English into a crate that has none, and the wrong English
            // for anybody not reading it.
            | Payload::Call { .. } => "",
            // Nor is this. Whatever it says, this build cannot read it, and
            // guessing at a preview would be the same mistake in a smaller
            // place.
            Payload::Unsupported { .. } => "",
        }
    }

    /// Encodes for putting inside an MLS message.
    pub fn encode(&self) -> Vec<u8> {
        // JSON rather than a compact codec: this is inside a padded, encrypted
        // message, so a few bytes buy nothing, and being able to read it in a
        // debugger without a decoder is worth real money when something is
        // wrong.
        serde_json::to_vec(self).unwrap_or_else(|_| b"{}".to_vec())
    }

    /// Encodes as a string, for storing beside the message.
    pub fn encode_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Decodes what came out of an MLS message.
    ///
    /// Three outcomes, and the distinction between the last two is the point:
    ///
    /// - a payload this build knows;
    /// - a JSON object naming a `kind` it cannot read — [`Payload::Unsupported`],
    ///   which draws no bubble and says so;
    /// - anything else — text, because the very first messages this project
    ///   ever sent were bare UTF-8 with no envelope, and refusing to read them
    ///   would be self-inflicted data loss.
    ///
    /// The middle case used to fall through to the last one. That made every
    /// new variant a display bug on older installations, and it read the
    /// sender's structure as if it were their prose — the opposite of failing
    /// closed (rule 7).
    pub fn decode(bytes: &[u8]) -> Self {
        match serde_json::from_slice::<Payload>(bytes) {
            Ok(payload) => payload,
            Err(_) => match tagged_kind(bytes) {
                Some(kind) => Payload::Unsupported { kind },
                // No name, and there cannot be one: these bytes predate the
                // idea. The actions that need a name are not offered on them.
                None => Payload::Text {
                    body: String::from_utf8_lossy(bytes).into_owned(),
                    id: None,
                    forwarded_from: None,
                    forwarded: false,
                },
            },
        }
    }
}

/// The `kind` of a JSON object, when the bytes are one.
///
/// Deliberately not a second attempt at the whole payload: all this decides is
/// whether somebody sent a *tagged* thing, and pulling one string out of an
/// untyped value cannot fail on fields this build has never heard of — which
/// is exactly the case it exists to catch.
fn tagged_kind(bytes: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    Some(value.get("kind")?.as_str()?.to_string())
}

/// Reduces a sender-supplied file name to something safe to write to disk.
///
/// The name inside an attachment payload is chosen by whoever sent it. It is
/// end-to-end authenticated -- so it is genuinely *their* name -- but that is a
/// statement about who wrote it, not about whether it is safe. A contact whose
/// device has been taken over can send `..\..\Startup\evil.exe`, and
/// authentication does not make that harmless.
///
/// So: the last path segment only, with separators, drive colons, wildcards,
/// control characters, and leading dots removed, truncated, and never empty.
/// The result is a suggestion for a save dialog, which is the only place it is
/// ever used -- nothing writes to it without the user choosing a location.
pub fn safe_file_name(name: &str) -> String {
    // Both separators, because a Windows client can receive a name composed on
    // any platform and `/` is a separator here too.
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);

    let cleaned: String = last
        .chars()
        .map(|c| match c {
            // Reserved on Windows, plus control characters.
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();

    // A leading dot hides the file; a trailing dot or space is silently
    // stripped by Windows, which turns "evil.exe " into "evil.exe".
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());

    // Device names are still reserved even with an extension: `CON.txt` is
    // `CON`. Prefixing is enough to make them ordinary.
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = trimmed.split('.').next().unwrap_or("");
    let reserved = RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r));

    let mut out = if trimmed.is_empty() {
        "attachment".to_string()
    } else if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    };

    // Well under any filesystem limit, and on a character boundary.
    const MAX: usize = 120;
    if out.len() > MAX {
        let cut = (0..=MAX)
            .rev()
            .find(|i| out.is_char_boundary(*i))
            .unwrap_or(0);
        out.truncate(cut);
    }
    if out.is_empty() {
        out = "attachment".to_string();
    }
    out
}

/// What the server pushes down the WebSocket (§5.2).
///
/// Tagged by `type` so a client can match on one field, and so adding a variant
/// later does not change how the existing ones deserialise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// A message, or a commit, for a conversation this device is in.
    Envelope {
        /// Cursor: also what the client acknowledges.
        envelope_id: i64,
        /// Which conversation.
        conversation_id: ConversationId,
        /// Which device sent it.
        sender_device_id: DeviceId,
        /// The epoch it was built against.
        epoch: u64,
        /// The opaque MLS message, hex-encoded.
        ciphertext: String,
        /// Whether it carries a commit.
        is_commit: bool,
        /// Server receive time.
        server_timestamp_ms: i64,
    },
    /// Someone is typing. Opt-out-able in Settings (§6.1).
    Typing {
        /// Where.
        conversation_id: ConversationId,
        /// Who.
        user_id: i64,
    },
    /// Someone came online or went away.
    Presence {
        /// Who.
        user_id: i64,
        /// Whether they are connected now.
        online: bool,
    },
    /// A delivery or read receipt.
    Receipt {
        /// Which conversation.
        conversation_id: ConversationId,
        /// How far the sender has read.
        envelope_id: i64,
        /// Who read it.
        user_id: i64,
    },
    /// The server is closing this connection, and why.
    ///
    /// Sent before the close frame so the client can tell "your token expired"
    /// from "the network dropped" — the first needs a refresh, the second a
    /// retry.
    Closing {
        /// A machine-readable reason.
        reason: String,
    },
}

/// What a client sends up the WebSocket (§5.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    /// Confirms an envelope was received, so the server can stop holding it.
    ///
    /// Delivered ciphertext is deleted on acknowledgement (§4.3); this is what
    /// triggers that.
    Ack {
        /// Which conversation.
        conversation_id: ConversationId,
        /// Everything up to and including this id has arrived.
        envelope_id: i64,
    },
    /// This device is typing.
    Typing {
        /// Where.
        conversation_id: ConversationId,
    },
    /// Keeps the connection alive through an idle NAT.
    Ping,
}

/// Errors that can be reported across the wire.
#[derive(Debug, thiserror::Error, Serialize, Deserialize, PartialEq, Eq)]
pub enum ProtocolError {
    /// The commit referenced an epoch that is no longer current. The client
    /// must resync and rebuild it. See docs/PLAN.md risk 4(b).
    #[error("stale epoch: server is at {current}, commit cited {cited}")]
    StaleEpoch {
        /// The epoch the server considers current.
        current: u64,
        /// The epoch the rejected commit cited.
        cited: u64,
    },
    /// The wire protocol versions do not match.
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u16),
}

mod serde_bytes_vec {
    //! Serialize `Vec<u8>` compactly under CBOR while staying readable in JSON.
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        Vec::<u8>::deserialize(d)
    }
}

/// Whether a string is acceptable as a reaction.
///
/// Here rather than in `posts.rs`, where it started, because both sides now
/// need the same answer and two copies of a validation rule are one of them
/// being wrong later. The feed calls it on the server; a conversation has to
/// call it on the **receiver**, because the server never sees a message
/// payload and so cannot refuse anything about it (rule 4). A rule the server
/// cannot enforce has to be enforced where the bytes are read.
///
/// The limits are the feed's, unchanged: a length in characters *and* in
/// bytes, and nothing with whitespace or control characters. The string is
/// rendered as-is in a pill, so it has to be a thing you can render.
pub fn is_reaction_emoji(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 4
        && value.len() <= 16
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

// ------------------------------------------------------------- Meet&Greet ---
//
// These are the exception to this file's usual rule, and it is worth being
// exact about why. Everything above carries ciphertext the server cannot read.
// A Meet&Greet presence is the opposite: a pin, a headline and a character are
// *meant* to be readable by the server and by every signed-in person, exactly
// as a profile is. Rule 4 is not weakened by that, because none of this is
// message content -- and rule 5 is what makes it honest, so the agreement
// screen says all three are public in those words.
//
// What is deliberately absent: any field a device could fill in by itself. No
// accuracy, no heading, no speed, no "seen at". A pin is a claim somebody
// typed, and a schema that cannot express a measurement cannot later be made
// to carry one by a well-meaning change.

/// Somebody's presence on the Meet&Greet map.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetProfile {
    /// Who this is.
    pub handle: String,
    /// What to call them.
    pub display_name: String,
    /// Latitude, **as the server stored it** — snapped to a grid and jittered.
    ///
    /// Never the value a client submitted. The coarsening happens on write, so
    /// the precise figure is not kept anywhere and cannot leak from here later.
    pub lat: f64,
    /// Longitude, under the same rule as `lat`.
    pub lon: f64,
    /// One line about themselves. The only free text in P0.
    pub headline: Option<String>,
    /// The NexoChar, as its generator config.
    ///
    /// `Value` on purpose: the server does not know what a hairstyle is and
    /// must not learn. It enforces a size ceiling and nothing else, and the
    /// character is rendered on whichever client draws it. Storing the config
    /// rather than an image is also what keeps this out of object storage —
    /// there is no picture to host, and none to moderate.
    pub char_config: serde_json::Value,
    /// When the pin last moved, in milliseconds since the Unix epoch.
    pub updated_at_ms: i64,
}

/// A change to one's own presence. Every field is optional: this is a patch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MeetProfileUpdate {
    /// Where the pin was dropped. Coarsened by the server before it is stored.
    pub lat: Option<f64>,
    /// The other half of the pin.
    pub lon: Option<f64>,
    /// One line, at most 80 characters.
    pub headline: Option<String>,
    /// The NexoChar config.
    pub char_config: Option<serde_json::Value>,
    /// Whether to appear on the map at all.
    ///
    /// Leaving is a flag rather than a delete: a character somebody spent ten
    /// minutes on survives being off the map, and coming back is one tap.
    pub active: Option<bool>,
}

/// How far an intro has got.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MeetRequestState {
    /// Sent, not yet answered. The sender may not send again while this holds.
    Pending,
    /// The conversation is now an ordinary one.
    Accepted,
    /// Refused. Nothing is sent back beyond the state itself.
    Declined,
}

/// One intro, from a stranger on the map.
///
/// The conversation is a real MLS group opened through the ordinary delivery
/// path — there is no second, lesser kind of message here. What the request
/// adds is the one-message rule while it is `Pending`, enforced by the server
/// because a cap the client applies is not a cap.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MeetRequest {
    /// The server's id for this request.
    pub id: i64,
    /// Who sent it.
    pub from_handle: String,
    /// The conversation their one message is in.
    pub conversation_id: ConversationId,
    /// Where it has got to.
    pub state: MeetRequestState,
    /// When it was sent, in milliseconds since the Unix epoch.
    pub created_at_ms: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A forward carries both facts, and an ordinary message carries neither.
    ///
    /// The second half is the compatibility claim: adding these fields must
    /// not change a byte of what a non-forward puts on the wire, or every
    /// message this build sends becomes something older builds have to
    /// tolerate for no reason.
    #[test]
    fn forwarding_is_carried_without_changing_ordinary_messages() {
        let plain = Payload::text("hello");
        let json = String::from_utf8(plain.encode()).expect("payloads are utf-8");
        assert!(
            !json.contains("forwarded"),
            "a message that is not a forward must not mention forwarding: {json}"
        );

        let named = Payload::forwarded("hello", Some("ada".into()));
        assert_eq!(Payload::decode(&named.encode()), named);
        match Payload::decode(&named.encode()) {
            Payload::Text {
                forwarded,
                forwarded_from,
                ..
            } => {
                assert!(forwarded);
                assert_eq!(forwarded_from.as_deref(), Some("ada"));
            }
            other => panic!("expected text, got {other:?}"),
        }

        // The case `Option<String>` alone could not express: passed on, but
        // this device could not say by whom.
        let anonymous = Payload::forwarded("hello", None);
        match Payload::decode(&anonymous.encode()) {
            Payload::Text {
                forwarded,
                forwarded_from,
                ..
            } => {
                assert!(forwarded, "still a forward with no name on it");
                assert_eq!(forwarded_from, None);
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn a_text_payload_round_trips() {
        let payload = Payload::text("hello");
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    #[test]
    fn an_attachment_payload_round_trips() {
        let payload = Payload::Attachment {
            s3_key: "enc/abc/def".into(),
            key: "aa".repeat(32),
            nonce: "bb".repeat(12),
            sha256: "cc".repeat(32),
            name: "report.pdf".into(),
            mime: "application/pdf".into(),
            size: 1234,
            body: Some("as promised".into()),
            voice: None,
            segmented: false,
            id: Some(Uuid::new_v4()),
        };
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    #[test]
    fn a_sticker_round_trips() {
        let payload = Payload::Sticker {
            pack: "nexo".into(),
            id: "thumbs-up".into(),
            message_id: Some(Uuid::new_v4()),
        };
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    #[test]
    fn a_sticker_carries_a_name_not_a_picture() {
        // The reason it costs what a short message costs. If art ever ended up
        // in here it would be an upload wearing a message's clothes.
        let payload = Payload::Sticker {
            pack: "nexo".into(),
            id: "heart".into(),
            message_id: None,
        };
        let json = String::from_utf8(payload.encode()).expect("payloads are utf-8");
        assert!(json.len() < 120, "a sticker must stay tiny: {json}");
        for forbidden in ["svg", "base64", "data:", "path", "http"] {
            assert!(
                !json.contains(forbidden),
                "`{forbidden}` suggests art is being carried: {json}"
            );
        }
    }

    #[test]
    fn a_sticker_previews_as_nothing_rather_than_as_english() {
        // The conversation list draws it from the sticker itself. A word here
        // would be the wrong word for anybody not reading English.
        let payload = Payload::Sticker {
            pack: "nexo".into(),
            id: "fire".into(),
            message_id: None,
        };
        assert_eq!(payload.preview(), "");
    }

    #[test]
    fn a_reply_round_trips() {
        let payload = Payload::Reply {
            target: Uuid::new_v4(),
            body: "yes, that one".into(),
            id: Some(Uuid::new_v4()),
        };
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    #[test]
    fn a_reply_carries_no_copy_of_what_it_answers() {
        // The design claim in the `Reply` doc comment, tested. If the quoted
        // text were carried, retracting the original would leave it readable
        // inside every answer -- so quoting would defeat taking a message back.
        let payload = Payload::Reply {
            target: Uuid::new_v4(),
            body: "yes".into(),
            id: None,
        };
        let json = String::from_utf8(payload.encode()).expect("payloads are utf-8");
        assert!(
            json.contains("target"),
            "it must name what it answers: {json}"
        );
        assert!(
            !json.contains("quote") && !json.contains("excerpt"),
            "a reply must not carry the words it answers: {json}"
        );
    }

    #[test]
    fn a_reply_is_a_message_somebody_said() {
        // It previews and can be named like any other message -- a reply that
        // could not be edited, taken back or replied to in turn would be a
        // second-class message for no reason.
        let id = Uuid::new_v4();
        let payload = Payload::Reply {
            target: Uuid::new_v4(),
            body: "the second one".into(),
            id: Some(id),
        };
        assert_eq!(payload.preview(), "the second one");
        assert_eq!(payload.id(), Some(id));
    }

    #[test]
    fn a_voice_note_round_trips_with_its_waveform() {
        let payload = Payload::Attachment {
            s3_key: "enc/abc/def".into(),
            key: "aa".repeat(32),
            nonce: "bb".repeat(12),
            sha256: "cc".repeat(32),
            name: "voice-1725400000000.webm".into(),
            mime: "audio/webm".into(),
            size: 9001,
            body: None,
            voice: Some(VoiceMeta {
                duration_ms: 4_200,
                peaks: vec![0, 17, 200, 255, 3],
            }),
            segmented: false,
            id: Some(Uuid::new_v4()),
        };
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    #[test]
    fn an_attachment_without_a_recorder_stays_byte_identical() {
        // The compatibility claim in the `voice` doc comment, tested rather
        // than asserted: adding the field must not change what a picked file
        // looks like on the wire, or every old client sees a new shape.
        let payload = Payload::Attachment {
            s3_key: "k".into(),
            key: String::new(),
            nonce: String::new(),
            sha256: String::new(),
            name: "holiday.jpg".into(),
            mime: "image/jpeg".into(),
            size: 1,
            body: None,
            voice: None,
            segmented: false,
            id: None,
        };
        let json = String::from_utf8(payload.encode()).expect("payloads are utf-8");
        assert!(
            !json.contains("voice"),
            "an attachment with no recording must not mention one: {json}"
        );
    }

    #[test]
    fn a_payload_predating_voice_notes_still_decodes() {
        // Exactly what a v0.1.20 client puts on the wire.
        let older = br#"{"kind":"attachment","s3_key":"enc/a/b","key":"aa","nonce":"bb","sha256":"cc","name":"x.pdf","mime":"application/pdf","size":7}"#;
        let Payload::Attachment { voice, name, .. } = Payload::decode(older) else {
            panic!("an attachment from an older build must still read as one");
        };
        assert_eq!(name, "x.pdf");
        assert!(voice.is_none(), "no recorder made that message");
    }

    #[test]
    fn a_waveform_is_capped_before_it_is_drawn() {
        // A sender chooses this list, so the renderer must not be sized by it.
        let voice = VoiceMeta {
            duration_ms: 1_000,
            peaks: vec![42; 10_000],
        };
        assert_eq!(voice.drawable_peaks().len(), VoiceMeta::MAX_PEAKS);
        assert!(voice.drawable_peaks().iter().all(|&p| p == 42));
    }

    #[test]
    fn a_short_waveform_is_left_alone() {
        let voice = VoiceMeta {
            duration_ms: 900,
            peaks: vec![1, 2, 3],
        };
        assert_eq!(voice.drawable_peaks(), &[1, 2, 3]);
    }

    #[test]
    fn bare_bytes_are_read_as_text() {
        // The first messages this project sent had no envelope. Refusing to
        // read them would be self-inflicted data loss.
        // Spelled out rather than compared against `Payload::text`, which mints
        // a name. These bytes predate the idea of one, and `None` is the part
        // being asserted: a message nothing can refer to.
        assert_eq!(
            Payload::decode(b"just a message"),
            Payload::Text {
                body: "just a message".into(),
                id: None,
                forwarded_from: None,
                forwarded: false,
            }
        );
    }

    #[test]
    fn a_payload_without_an_id_still_reads() {
        // Every message sent before version 3 looks like this. Refusing them,
        // or reading them as something else, would break every history that
        // already exists — which is the whole reason the field is optional.
        let before = br#"{"kind":"text","body":"from before names"}"#;
        assert_eq!(
            Payload::decode(before),
            Payload::Text {
                body: "from before names".into(),
                id: None,
                forwarded_from: None,
                forwarded: false,
            }
        );
        assert_eq!(Payload::decode(before).id(), None);
    }

    #[test]
    fn an_id_survives_the_round_trip() {
        let payload = Payload::text("hello");
        let id = payload.id().expect("text() mints one");
        assert_eq!(Payload::decode(&payload.encode()).id(), Some(id));
    }

    #[test]
    fn payloads_that_are_not_messages_have_no_id() {
        // A rename changes shared state and is not a thing anyone can react
        // to, edit or take back. Answering `None` is what stops the UI from
        // offering those on it.
        assert_eq!(
            Payload::Rename {
                title: "Trip".into()
            }
            .id(),
            None
        );
        assert_eq!(
            Payload::Unsupported {
                kind: "reaction".into()
            }
            .id(),
            None
        );
    }

    #[test]
    fn an_unknown_kind_is_not_rendered_as_text() {
        // What a newer build's payload looks like to this one. Reading it as
        // prose would put raw JSON in a chat bubble on every installation that
        // has not updated, which is what this used to do.
        let from_the_future = br#"{"kind":"reaction","target":42,"emoji":"x"}"#;
        assert_eq!(
            Payload::decode(from_the_future),
            Payload::Unsupported {
                kind: "reaction".into()
            }
        );
    }

    #[test]
    fn a_malformed_known_kind_also_fails_closed() {
        // A `text` payload with no body is not a message someone typed; it is
        // a payload that did not survive the trip. Same answer, because the
        // honest thing to say about both is "this did not open".
        assert_eq!(
            Payload::decode(br#"{"kind":"text"}"#),
            Payload::Unsupported {
                kind: "text".into()
            }
        );
    }

    #[test]
    fn json_that_is_not_a_tagged_payload_is_still_text() {
        // Somebody typing JSON into the composer is sending prose that happens
        // to have braces in it. Only a `kind` makes it a payload.
        let typed = br#"{"hello": "world"}"#;
        assert_eq!(
            Payload::decode(typed),
            Payload::Text {
                body: r#"{"hello": "world"}"#.into(),
                id: None,
                forwarded_from: None,
                forwarded: false,
            }
        );
    }

    #[test]
    fn a_call_signal_round_trips() {
        let call_id = Uuid::new_v4();
        for signal in [
            CallSignal::Offer {
                video: true,
                sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n".into(),
            },
            CallSignal::Answer {
                video: false,
                sdp: "v=0\r\na=recvonly\r\n".into(),
            },
            CallSignal::Hangup {
                reason: HangupReason::Declined,
                seconds: 0,
            },
            CallSignal::Hangup {
                reason: HangupReason::Ended,
                seconds: 272,
            },
        ] {
            let payload = Payload::Call {
                call_id,
                signal: signal.clone(),
            };
            assert_eq!(Payload::decode(&payload.encode()), payload);
        }
    }

    #[test]
    fn a_call_is_tagged_so_an_older_build_names_it_instead_of_reading_it() {
        // An installation that predates calls must land in `Unsupported`
        // rather than render the SDP as though somebody had typed it (rule 7).
        // That hinges on one thing only: the encoding carries a `kind` that
        // `tagged_kind` can pull out without understanding it. This build knows
        // `call`, so it cannot demonstrate the fallback by decoding -- what it
        // can check is the property the fallback depends on.
        let encoded = Payload::Call {
            call_id: Uuid::new_v4(),
            signal: CallSignal::Offer {
                video: false,
                sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n".into(),
            },
        }
        .encode();

        assert_eq!(tagged_kind(&encoded).as_deref(), Some("call"));
        assert_eq!(
            Payload::Unsupported {
                kind: "call".into()
            }
            .preview(),
            ""
        );
    }

    #[test]
    fn a_call_signals_shape_on_the_wire() {
        // Pinned because both ends and every future build depend on it, and
        // because the signal enum is tagged *inside* the payload rather than
        // flattened into it -- a difference that is invisible until something
        // hand-writes this JSON and finds it does not parse.
        let json = serde_json::to_value(Payload::Call {
            call_id: "00000000-0000-0000-0000-000000000001"
                .parse()
                .expect("a literal uuid"),
            signal: CallSignal::Hangup {
                reason: HangupReason::Ended,
                seconds: 272,
            },
        })
        .expect("a payload serialises");

        assert_eq!(
            json,
            serde_json::json!({
                "kind": "call",
                "call_id": "00000000-0000-0000-0000-000000000001",
                "signal": { "signal": "hangup", "reason": "ended", "seconds": 272 },
            })
        );
    }

    #[test]
    fn a_hangup_from_before_the_duration_existed_still_reads() {
        // Same rule as every other defaulted field: a signal written by an
        // earlier build must not become unreadable, and zero is the honest
        // answer for a call whose length nobody recorded.
        let before = br#"{"kind":"call","call_id":"00000000-0000-0000-0000-000000000001","signal":{"signal":"hangup","reason":"cancelled"}}"#;
        assert_eq!(
            Payload::decode(before),
            Payload::Call {
                call_id: "00000000-0000-0000-0000-000000000001"
                    .parse()
                    .expect("a literal uuid"),
                signal: CallSignal::Hangup {
                    reason: HangupReason::Cancelled,
                    seconds: 0,
                },
            }
        );
    }

    #[test]
    fn a_call_is_not_a_preview() {
        // Like a sticker and a reaction: it has no words, and the conversation
        // list must not invent any.
        assert_eq!(
            Payload::Call {
                call_id: Uuid::new_v4(),
                signal: CallSignal::Hangup {
                    reason: HangupReason::Ended,
                    seconds: 61,
                },
            }
            .preview(),
            ""
        );
    }

    #[test]
    fn an_unsupported_payload_previews_as_nothing() {
        // It must not reach the conversation list. A row that shows the kind
        // of a thing it cannot read is leaking structure into prose again.
        let payload = Payload::Unsupported {
            kind: "reaction".into(),
        };
        assert_eq!(payload.preview(), "");
    }

    #[test]
    fn an_attachment_with_no_message_previews_its_name() {
        let payload = Payload::Attachment {
            s3_key: "k".into(),
            key: String::new(),
            nonce: String::new(),
            sha256: String::new(),
            name: "holiday.jpg".into(),
            mime: "image/jpeg".into(),
            size: 1,
            body: None,
            voice: None,
            segmented: false,
            id: None,
        };
        assert_eq!(payload.preview(), "holiday.jpg");
    }

    #[test]
    fn a_message_sent_with_an_attachment_wins_the_preview() {
        let payload = Payload::Attachment {
            s3_key: "k".into(),
            key: String::new(),
            nonce: String::new(),
            sha256: String::new(),
            name: "holiday.jpg".into(),
            mime: "image/jpeg".into(),
            size: 1,
            body: Some("from the trip".into()),
            voice: None,
            segmented: false,
            id: None,
        };
        assert_eq!(payload.preview(), "from the trip");
    }

    #[test]
    fn the_filename_is_inside_the_payload_not_beside_it() {
        // §4.2: no plaintext filename may sit next to a message. The only place
        // it exists is here, inside what gets encrypted.
        let payload = Payload::Attachment {
            s3_key: "enc/x/y".into(),
            key: "0".repeat(64),
            nonce: "0".repeat(24),
            sha256: "0".repeat(64),
            name: "payslip.pdf".into(),
            mime: "application/pdf".into(),
            size: 10,
            body: None,
            voice: None,
            segmented: false,
            id: None,
        };
        let encoded = payload.encode();
        assert!(
            encoded.windows(11).any(|w| w == b"payslip.pdf"),
            "the name must be in the payload, which is what gets encrypted"
        );
        // And an Envelope has nowhere to put it.
        let envelope = Envelope {
            conversation_id: Uuid::nil(),
            sender_device_id: Uuid::nil(),
            epoch: 1,
            ciphertext: encoded,
            server_timestamp_ms: 0,
        };
        let json = serde_json::to_value(&envelope).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        assert!(!keys.contains(&"name"));
        assert!(!keys.contains(&"mime"));
    }

    #[test]
    fn envelope_roundtrips_and_carries_nothing_extra() {
        let e = Envelope {
            conversation_id: Uuid::nil(),
            sender_device_id: Uuid::nil(),
            epoch: 7,
            ciphertext: vec![1, 2, 3],
            server_timestamp_ms: 1_700_000_000_000,
        };
        let json = serde_json::to_value(&e).unwrap();
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        keys.sort_unstable();
        // Field *order* is not meaningful here (serde_json sorts); the point is
        // that the set is exactly these five and nothing has crept in.
        assert_eq!(
            keys,
            [
                "ciphertext",
                "conversation_id",
                "epoch",
                "sender_device_id",
                "server_timestamp_ms"
            ],
            "§4.2 fixes the envelope shape; adding a field is a protocol change"
        );

        let back: Envelope = serde_json::from_value(json).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn a_traversing_file_name_loses_its_path() {
        // The attack this function exists for: an authenticated contact whose
        // device was taken over choosing where the file lands.
        assert_eq!(safe_file_name(r"..\..\Startup\evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(
            safe_file_name(r"C:\Windows\System32\drivers\etc\hosts"),
            "hosts"
        );
    }

    #[test]
    fn separators_and_wildcards_do_not_survive() {
        assert!(!safe_file_name("a/b").contains('/'));
        assert!(!safe_file_name(r"a\b").contains('\\'));
        assert_eq!(safe_file_name("re*port?.txt"), "re_port_.txt");
        assert_eq!(safe_file_name("a:b.txt"), "a_b.txt");
    }

    #[test]
    fn control_characters_are_removed() {
        // A newline in a name is either a mistake or an attempt to make a log
        // line or a dialog say something it does not.
        assert_eq!(safe_file_name("re\nport\t.txt"), "re_port_.txt");
        assert_eq!(safe_file_name("null\0byte"), "null_byte");
    }

    #[test]
    fn trailing_dots_and_spaces_are_stripped() {
        // Windows strips them silently, so "evil.exe " and "evil.exe" name the
        // same file -- better to make that visible here than to be surprised.
        assert_eq!(safe_file_name("evil.exe "), "evil.exe");
        assert_eq!(safe_file_name("evil.exe."), "evil.exe");
        assert_eq!(safe_file_name(".hidden"), "hidden");
    }

    #[test]
    fn reserved_device_names_are_defused() {
        // CON, CON.txt, and con.TXT all name the console device.
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("con.txt"), "_con.txt");
        assert_eq!(safe_file_name("LPT1.pdf"), "_LPT1.pdf");
        // But a name that merely starts with those letters is fine.
        assert_eq!(safe_file_name("contract.pdf"), "contract.pdf");
    }

    #[test]
    fn a_name_that_reduces_to_nothing_gets_one() {
        // Every branch has to end with something writable; "" is not a file
        // name, and neither is "...".
        assert_eq!(safe_file_name(""), "attachment");
        assert_eq!(safe_file_name("..."), "attachment");
        assert_eq!(safe_file_name("   "), "attachment");
        assert_eq!(safe_file_name("/"), "attachment");
    }

    #[test]
    fn a_very_long_name_is_truncated_on_a_character_boundary() {
        let long = format!("{}.txt", "\u{00e4}".repeat(400));
        let safe = safe_file_name(&long);
        assert!(safe.len() <= 120);
        // The point of the boundary search: this would panic on a bad cut.
        assert!(std::str::from_utf8(safe.as_bytes()).is_ok());
        assert!(!safe.is_empty());
    }

    #[test]
    fn an_ordinary_name_is_left_alone() {
        // A sanitiser that mangles normal input is a bug users will actually
        // notice.
        assert_eq!(
            safe_file_name("Quarterly Report (final) v2.pdf"),
            "Quarterly Report (final) v2.pdf"
        );
        assert_eq!(
            safe_file_name("\u{4f1a}\u{8b70}\u{8a18}\u{9332}.docx"),
            "\u{4f1a}\u{8b70}\u{8a18}\u{9332}.docx"
        );
    }

    /// The same cases `posts.rs` checked before the rule moved here — the
    /// point of moving it was that both ends give the same answer.
    #[test]
    fn a_reaction_emoji_is_short_visible_and_unbroken() {
        for good in ["\u{1F44D}", "\u{2764}\u{FE0F}", "!"] {
            assert!(is_reaction_emoji(good), "{good:?} should be allowed");
        }
        for bad in [
            "",                                                             // nothing to render
            "abcde",       // more than four characters
            "a b",         // whitespace
            "\u{1F44D}\n", // a control character
            "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", // over the byte ceiling
        ] {
            assert!(!is_reaction_emoji(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_reaction_round_trips() {
        let payload = Payload::Reaction {
            target: Uuid::from_u128(7),
            emoji: "\u{1F44D}".into(),
            on: false,
        };
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    /// An older sender only ever added, and said so by omitting the field.
    /// Reading that as a removal would take reactions off as they arrived.
    #[test]
    fn a_reaction_without_the_toggle_is_an_addition() {
        let wire =
            br#"{"kind":"reaction","target":"00000000-0000-0000-0000-000000000007","emoji":"x"}"#;
        match Payload::decode(wire) {
            Payload::Reaction { on, emoji, .. } => {
                assert!(on, "an absent toggle means added, not removed");
                assert_eq!(emoji, "x");
            }
            other => panic!("expected a reaction, got {other:?}"),
        }
    }

    /// A reaction changes shared state and draws no bubble, so it must not
    /// become the conversation list's preview.
    #[test]
    fn a_reaction_is_not_a_preview() {
        let payload = Payload::Reaction {
            target: Uuid::from_u128(1),
            emoji: "\u{1F44D}".into(),
            on: true,
        };
        assert_eq!(payload.preview(), "");
    }

    #[test]
    fn a_meet_profile_round_trips() {
        let profile = MeetProfile {
            handle: "dice".into(),
            display_name: "Dice".into(),
            lat: 47.25,
            lon: 8.5,
            headline: Some("here for the mountains".into()),
            char_config: serde_json::json!({ "topVariant": "hoodie", "eyesVariant": "happy" }),
            updated_at_ms: 1_760_000_000_000,
        };
        let wire = serde_json::to_string(&profile).unwrap();
        assert_eq!(serde_json::from_str::<MeetProfile>(&wire).unwrap(), profile);
    }

    /// A headline is optional, and absent is not the same as empty.
    #[test]
    fn a_meet_profile_without_a_headline_round_trips() {
        let profile = MeetProfile {
            handle: "bananaaboy".into(),
            display_name: "bananaaboy".into(),
            lat: -33.75,
            lon: 151.0,
            headline: None,
            char_config: serde_json::json!({}),
            updated_at_ms: 1,
        };
        let wire = serde_json::to_string(&profile).unwrap();
        let back: MeetProfile = serde_json::from_str(&wire).unwrap();
        assert_eq!(back, profile);
        assert!(back.headline.is_none());
    }

    /// The update is a patch: an omitted field means "leave it alone", which is
    /// a different instruction from "set it to nothing".
    #[test]
    fn a_meet_update_round_trips_and_defaults_to_changing_nothing() {
        let empty = MeetProfileUpdate::default();
        assert!(empty.lat.is_none() && empty.char_config.is_none() && empty.active.is_none());

        let leaving = MeetProfileUpdate {
            active: Some(false),
            ..Default::default()
        };
        let wire = serde_json::to_string(&leaving).unwrap();
        assert_eq!(
            serde_json::from_str::<MeetProfileUpdate>(&wire).unwrap(),
            leaving
        );
    }

    #[test]
    fn a_meet_request_round_trips_in_every_state() {
        for state in [
            MeetRequestState::Pending,
            MeetRequestState::Accepted,
            MeetRequestState::Declined,
        ] {
            let request = MeetRequest {
                id: 7,
                from_handle: "dice".into(),
                conversation_id: ConversationId::nil(),
                state,
                created_at_ms: 1_760_000_000_000,
            };
            let wire = serde_json::to_string(&request).unwrap();
            assert_eq!(serde_json::from_str::<MeetRequest>(&wire).unwrap(), request);
        }
    }

    /// The states are written into the database's CHECK constraint, so their
    /// wire spelling is not free to drift.
    /// The field was added after stories shipped, so a story from a build
    /// that predates it must still decode -- as a story, with the id unknown,
    /// rather than as `Unsupported`.
    #[test]
    fn a_story_from_before_the_id_existed_still_decodes() {
        let old = br#"{"kind":"story","s3_key":"story/abc","key":"00","nonce":"01",
            "sha256":"02","mime":"image/png","size":9,"expires_at_ms":7}"#;
        match Payload::decode(old) {
            Payload::Story {
                story_id, s3_key, ..
            } => {
                assert_eq!(story_id, 0, "unknown, and the reader says so");
                assert_eq!(s3_key, "story/abc");
            }
            other => panic!("a story decoded as {other:?}"),
        }
    }

    #[test]
    fn a_story_carries_the_server_id_it_was_given() {
        let payload = Payload::Story {
            story_id: 4242,
            s3_key: "story/abc".into(),
            key: "00".into(),
            nonce: "01".into(),
            sha256: "02".into(),
            mime: "image/png".into(),
            size: 9,
            expires_at_ms: 7,
        };
        assert_eq!(Payload::decode(&payload.encode()), payload);
    }

    #[test]
    fn meet_request_states_are_snake_case_on_the_wire() {
        assert_eq!(
            serde_json::to_string(&MeetRequestState::Pending).unwrap(),
            "\"pending\""
        );
        assert_eq!(
            serde_json::to_string(&MeetRequestState::Declined).unwrap(),
            "\"declined\""
        );
    }
}
