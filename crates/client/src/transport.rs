//! The seam between session logic and the network.
//!
//! Everything in this crate is deliberately blocking. Argon2id at 64 MiB,
//! SQLCipher, and DPAPI are all CPU- or syscall-bound work with no useful
//! concurrency inside them, so making the core `async` would add a colour to
//! every function and buy nothing. The Tauri command layer owns the
//! `spawn_blocking` that keeps the UI responsive; that is the right place for
//! it, because that is where the runtime lives.
//!
//! [`Transport`] exists so that [`crate::session`] can be tested without a
//! server. The HTTP implementation arrives with M4, when the client starts
//! talking to `api.dice.fit` for real.

use nexo_protocol::{MeetProfile, MeetProfileUpdate, MeetRequest};
use serde::{Deserialize, Serialize};

/// Argon2id parameters the server tells the client to use.
///
/// Sent rather than hardcoded so they can be raised without shipping a new
/// client. A client that hardcoded them would silently keep using the old cost
/// after a server-side change, and nobody would notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Argon2Params {
    /// Memory cost in KiB.
    pub memory_kib: u32,
    /// Time cost.
    pub iterations: u32,
    /// Lanes.
    pub parallelism: u32,
}

/// What `POST /v1/auth/salt` returns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaltResponse {
    /// Hex-encoded per-account salt.
    ///
    /// For a handle with no account this is a decoy the server derives
    /// deterministically, so that asking cannot reveal whether an account
    /// exists. The client cannot tell the difference, and does not need to.
    pub salt: String,
    /// The parameters to derive the verifier with.
    pub argon2: Argon2Params,
}

/// What the auth endpoints return on success.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTokens {
    /// Short-lived bearer token.
    pub access_token: String,
    /// Long-lived, single-use, rotating.
    pub refresh_token: String,
    /// Seconds until `access_token` expires.
    pub expires_in: u64,
    /// Server-assigned account id.
    pub user_id: i64,
    /// This device's id.
    pub device_id: String,
}

/// Errors a transport can report.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// The server said the credentials were wrong, or the handle is unknown.
    ///
    /// One variant for both on purpose: the server refuses to distinguish them
    /// (see its `salt` endpoint), and a client that split them apart would
    /// reintroduce the enumeration oracle in its own error messages.
    #[error("that handle and password do not match an account")]
    InvalidCredentials,
    /// The handle is already registered.
    #[error("that handle is already taken")]
    HandleTaken,
    /// The current password given to change-password was wrong.
    ///
    /// Separate from [`Self::InvalidCredentials`], which also means "your
    /// session expired": the caller here is authenticated, so there is no
    /// enumeration to protect and the two need different prose.
    #[error("that is not your current password")]
    WrongPassword,
    /// A commit cited an epoch that is no longer current.
    ///
    /// Not an error to show a user: it means resync and rebuild (PLAN.md risk
    /// 4(b)), and the server tells us where to resync to.
    #[error("stale epoch: the conversation is at {current}")]
    StaleEpoch {
        /// What the server considers current.
        current: i64,
    },
    /// The server has no such thing.
    ///
    /// Separate from [`Rejected`](Self::Rejected) because for some calls it is
    /// not a failure at all: "you are not on the map" is an ordinary answer,
    /// and a caller should be able to say so without reading an error message
    /// to find out.
    #[error("not found")]
    NotFound,
    /// The server rejected the request.
    #[error("the server rejected the request: {0}")]
    Rejected(String),
    /// The server could not be reached.
    #[error("could not reach the server: {0}")]
    Unreachable(String),
}

/// A conversation as the server sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    /// Which conversation.
    pub conversation_id: String,
    /// `dm` or `group`.
    pub kind: String,
    /// The epoch the server believes is current.
    pub epoch: i64,
    /// The newest envelope, for deciding whether a sync is worth making.
    pub latest_envelope_id: Option<i64>,
    /// Every member's handle, the caller included.
    ///
    /// The only way an invited device can name a conversation: it learns of
    /// one through this list, and MLS credentials name devices rather than
    /// accounts. Defaults to empty so an older server stays readable.
    #[serde(default)]
    pub members: Vec<String>,
}

/// One envelope, straight off the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    /// Cursor.
    pub envelope_id: i64,
    /// Which conversation.
    pub conversation_id: String,
    /// Which device sent it.
    pub sender_device_id: String,
    /// The epoch it was built against.
    pub epoch: i64,
    /// Hex-encoded, opaque.
    pub ciphertext: String,
    /// Whether it carries a commit.
    pub is_commit: bool,
    /// Server receive time.
    pub server_timestamp_ms: i64,
}

/// What the server said about an accepted envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Accepted {
    /// The new envelope's id.
    pub envelope_id: i64,
    /// The epoch in force afterwards.
    pub epoch: i64,
}

/// A KeyPackage claimed for someone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimedKeyPackage {
    /// Hex-encoded.
    pub key_package: String,
    /// Whose device it belongs to.
    pub device_id: String,
}

/// The network calls session logic needs.
pub trait Transport {
    /// Fetch the salt and Argon2id parameters for a handle.
    fn salt(&self, handle: &str) -> Result<SaltResponse, TransportError>;

    /// Create an account.
    fn register(
        &self,
        handle: &str,
        display_name: &str,
        pw_salt_hex: &str,
        pw_verifier_hex: &str,
        identity_pubkey_hex: &str,
    ) -> Result<SessionTokens, TransportError>;

    /// Sign in to an existing account.
    fn login(
        &self,
        handle: &str,
        pw_verifier_hex: &str,
        identity_pubkey_hex: &str,
    ) -> Result<SessionTokens, TransportError>;

    /// Exchanges a refresh token for a new pair.
    ///
    /// Single-use: the token handed in is dead afterwards, and presenting it
    /// again is treated as theft (the server revokes the whole family).
    fn refresh(&self, refresh_token: &str) -> Result<SessionTokens, TransportError>;

    /// Invalidates a refresh token, ending the session server-side.
    fn logout(&self, refresh_token: &str) -> Result<(), TransportError>;

    /// Replaces the password verifier (§6.4).
    ///
    /// All three arguments are hex: the current password's verifier as proof
    /// of knowledge, then the fresh salt and the verifier derived against it.
    /// Requires an access token — the server checks possession of the session
    /// *and* knowledge of the old password, because either alone is not the
    /// account's owner.
    fn change_password(
        &self,
        old_verifier: &str,
        new_salt: &str,
        new_verifier: &str,
    ) -> Result<(), TransportError>;

    /// Deletes the account on the server, for good.
    ///
    /// Hex of the current password's verifier, for the reason
    /// [`Transport::change_password`] gives about itself and more so: a token
    /// is a session, and this is the one call whose mistake cannot be undone
    /// by anybody, here or on the server.
    ///
    /// Says nothing about the local half. That is
    /// [`crate::session::delete_account`]'s job, and it runs whatever this
    /// returns.
    fn delete_account(&self, pw_verifier: &str) -> Result<(), TransportError>;

    /// Remembers the access token that authenticates everything below.
    ///
    /// Held by the transport rather than passed to each call: a token that has
    /// to be threaded through every signature is a token that eventually gets
    /// logged by one of them.
    fn set_access_token(&self, token: &str);

    /// Hands over the refresh token, so an aged access token can be replaced
    /// without asking for a password.
    ///
    /// Defaulted rather than required: a transport that does not refresh is a
    /// legitimate one, and every fake in the tests would otherwise have to
    /// implement it to say "no".
    fn set_refresh_token(&self, _token: &str) {}

    /// Publishes KeyPackages so other people can invite this device.
    fn publish_key_packages(&self, key_packages: &[String]) -> Result<(), TransportError>;

    /// How many unconsumed KeyPackages are left, and the refill threshold.
    fn key_package_count(&self) -> Result<(i64, i64), TransportError>;

    /// Claims one KeyPackage for a handle. Single-use: this consumes it.
    fn claim_key_package(&self, handle: &str) -> Result<ClaimedKeyPackage, TransportError>;

    /// Registers a conversation and its members.
    /// Registers a conversation, and says which one the server settled on.
    ///
    /// The returned id is **not** always the one passed in. There is exactly
    /// one DM per pair of people, and the server enforces that: if one already
    /// exists it hands that one back rather than creating a second. Two people
    /// pressing "message" at the same moment is otherwise a race no client can
    /// win, because the check and the create are two round trips with a gap
    /// between them and only the server sees both.
    fn create_conversation(
        &self,
        conversation_id: &str,
        members: &[String],
    ) -> Result<String, TransportError>;

    /// Throws away a conversation that has never carried anything.
    ///
    /// For exactly one situation: [`create_conversation`] succeeded and the
    /// commit that follows it did not, leaving a conversation on the server
    /// that nobody holds the group for and nobody can ever send in. The server
    /// refuses the moment one envelope exists, so this cannot reach a real
    /// conversation — see `delivery::discard_conversation`.
    ///
    /// [`create_conversation`]: Transport::create_conversation
    fn discard_conversation(&self, conversation_id: &str) -> Result<(), TransportError>;

    /// Every conversation this account is in.
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, TransportError>;

    /// Hands an envelope to the delivery service.
    /// `client_msg_id` names the message so a retry is idempotent.
    ///
    /// Not optional. A client with an offline queue cannot tell "the request
    /// never arrived" from "the reply was lost", so it must retry -- and a
    /// retry without this id is a duplicate in everyone's conversation.
    fn send(
        &self,
        conversation_id: &str,
        ciphertext_hex: &str,
        epoch: i64,
        is_commit: bool,
        client_msg_id: &str,
    ) -> Result<Accepted, TransportError>;

    /// Adds someone to a conversation's membership (routing only).
    fn add_member(&self, conversation_id: &str, handle: &str) -> Result<(), TransportError>;

    /// Removes someone from a conversation's membership (routing only).
    fn remove_member(&self, conversation_id: &str, handle: &str) -> Result<(), TransportError>;

    /// Asks for a time-limited URL to PUT an encrypted attachment to.
    ///
    /// The bytes never pass through the server: it holds the bucket
    /// credentials, the client holds the file, and this is the permission that
    /// joins them for ten minutes.
    fn upload_url(
        &self,
        conversation_id: &str,
        size: u64,
    ) -> Result<(String, String), TransportError>;

    /// Asks for a time-limited URL to GET an encrypted attachment from.
    fn download_url(&self, key: &str) -> Result<String, TransportError>;

    /// PUTs bytes to a presigned URL.
    ///
    /// Part of the transport because it is the one call that goes somewhere
    /// other than the API, and a caller should not have to own an HTTP client
    /// to send a file.
    fn put_object(&self, url: &str, bytes: Vec<u8>) -> Result<(), TransportError>;

    /// GETs bytes from a presigned URL.
    fn get_object(&self, url: &str) -> Result<Vec<u8>, TransportError>;

    /// GETs one byte range from a presigned URL.
    ///
    /// `from` and `to` are inclusive, as HTTP means them. What comes back may
    /// legitimately be *shorter* than asked for — the last range of a file
    /// usually is — but never longer, and a caller that needs an exact length
    /// must check.
    ///
    /// The default implementation fetches the whole object and slices it, so
    /// every existing transport keeps working unchanged and correctness never
    /// depends on the server honouring `Range`. It is overridden in `http.rs`
    /// with a real ranged request, which is where the saving actually is:
    /// opening one segment of a 200 MB video should not move 200 MB.
    fn get_object_range(&self, url: &str, from: u64, to: u64) -> Result<Vec<u8>, TransportError> {
        let all = self.get_object(url)?;
        let start = (from as usize).min(all.len());
        let end = (to as usize).saturating_add(1).min(all.len());
        Ok(all.get(start..end).unwrap_or_default().to_vec())
    }

    /// Everything after `since_id`.
    fn sync(&self, conversation_id: &str, since_id: i64) -> Result<Vec<Envelope>, TransportError>;

    // ------------------------------------------------------------ Meet&Greet ---
    //
    // Unlike everything above, none of this carries ciphertext. A pin, a
    // headline and a character are readable by the server by design, and the
    // agreement screen says so — see `apps/server/src/meet.rs`.

    /// Every active pin, minus blocks. `after` continues a page.
    fn meet_pins(&self, after: Option<&str>) -> Result<Vec<MeetProfile>, TransportError>;

    /// My own pin. `None` when I am not on the map.
    fn meet_me(&self) -> Result<Option<MeetProfile>, TransportError>;

    /// Place or move my pin, or change what goes with it.
    ///
    /// What comes back from the server is not what was sent: the pin is
    /// coarsened on write. A caller that wants to draw its own pin has to read
    /// it back rather than assume.
    fn meet_set_me(&self, update: &MeetProfileUpdate) -> Result<(), TransportError>;

    /// Come off the map, keeping the character.
    fn meet_leave(&self) -> Result<(), TransportError>;

    /// Accept the agreement at a given version.
    fn meet_consent(&self, version: i32) -> Result<(), TransportError>;

    /// Intros waiting for me.
    fn meet_requests(&self) -> Result<Vec<MeetRequest>, TransportError>;

    /// Mark an already-opened conversation as an intro.
    fn meet_open_request(
        &self,
        handle: &str,
        conversation_id: &str,
    ) -> Result<MeetRequest, TransportError>;

    /// Asks for a URL to PUT a story's ciphertext to.
    ///
    /// Separate from [`upload_url`](Self::upload_url) because a story belongs
    /// to no conversation, and the attachment route rightly refuses a key
    /// whose conversation the caller is not a member of. It also lands under
    /// its own `story/` prefix, which is what lets the object store expire
    /// stories without touching attachments.
    fn story_upload_url(&self, size: u64) -> Result<(String, String), TransportError>;

    /// Record a story that has already been uploaded to the encrypted bucket.
    fn create_story(&self, s3_key: &str, size: i64) -> Result<StorySummary, TransportError>;

    /// A time-limited URL for a story's ciphertext.
    fn story_url(&self, id: i64) -> Result<String, TransportError>;

    /// Every live story a contact of this account has posted, and this
    /// account's own, as the *server* sees it right now.
    ///
    /// This is the reconciliation `stories::live` needs and did not do: an
    /// incoming story arrives over MLS carrying a device id, not a handle --
    /// MLS names devices -- so a received story sat forever with an empty
    /// `author_handle` until something matched it back to a person. The
    /// server already knows the answer, because `GET /v1/stories` joins
    /// against `users` to serve exactly this list, filtered to contacts and
    /// the unblocked (`stories.rs`, server side) -- the same boundary the
    /// fan-out already respects, so asking for it again here tightens
    /// nothing and leaks nothing.
    fn list_stories(&self) -> Result<Vec<StorySummary>, TransportError>;

    /// Where to send a call's media, and the credential that opens the relay.
    ///
    /// Asked once per call rather than cached across them: the credential
    /// expires, and a stale one fails at the relay where it is hardest to
    /// diagnose. `TransportError::Rejected` here is the honest answer for a
    /// server with no relay configured — calls are simply unavailable, which
    /// the UI is expected to say rather than dress up as a failure.
    fn ice_servers(&self) -> Result<nexo_protocol::IceServers, TransportError>;

    /// Find people by handle or display name. Public accounts only.
    fn search_users(&self, term: &str) -> Result<Vec<SearchResult>, TransportError>;

    /// Mint an invitation. The secret comes back once and is never stored.
    fn create_invite(&self, label: Option<&str>, days: i64)
    -> Result<MintedInvite, TransportError>;

    /// My invitations, live and spent.
    fn list_invites(&self) -> Result<Vec<InviteSummary>, TransportError>;

    /// Withdraw one.
    fn revoke_invite(&self, id: i64) -> Result<(), TransportError>;

    /// File a report about a post, a comment or a person.
    ///
    /// Here rather than beside the map because reporting is not a Meet&Greet
    /// feature — the server has had the endpoint since BRIEF 13 and the feed
    /// wants it too. This is simply the first caller.
    fn report(
        &self,
        subject_kind: &str,
        subject_id: i64,
        reason: &str,
        note: Option<&str>,
    ) -> Result<(), TransportError>;

    /// Answer an intro. Accepting lifts the one-message cap.
    fn meet_accept(&self, id: i64) -> Result<(), TransportError>;

    /// Refuse an intro. Also lifts the cap — see the server's `resolve`.
    fn meet_decline(&self, id: i64) -> Result<(), TransportError>;
}

/// Somebody a search turned up.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchResult {
    /// Their handle.
    pub handle: String,
    /// What to call them.
    pub display_name: String,
    /// Their picture, if they have one.
    pub avatar_key: Option<String>,
}

/// A freshly minted invitation.
///
/// The one and only time the secret is readable: the server keeps a hash, so a
/// lost secret cannot be looked up — it is revoked and replaced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MintedInvite {
    /// The server's id for it, for revoking later.
    pub id: i64,
    /// The secret itself. Show it once; it cannot be recovered.
    pub secret: String,
    /// When it stops working.
    pub expires_at_ms: i64,
}

/// One invitation, as its owner sees it afterwards.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InviteSummary {
    /// The server's id.
    pub id: i64,
    /// What the owner called it.
    pub label: Option<String>,
    /// When it was made.
    pub created_at_ms: i64,
    /// When it stops working.
    pub expires_at_ms: i64,
    /// Whether it was withdrawn.
    pub revoked: bool,
    /// Whether it works right now — expiry is by the clock, not by a job.
    pub live: bool,
    /// How many people reached the owner through it.
    pub used: i64,
}

/// A story the server has recorded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StorySummary {
    /// The server's id.
    pub id: i64,
    /// Who posted it.
    pub author_handle: String,
    /// When.
    pub created_at_ms: i64,
    /// When it stops being served. At most 24 hours out.
    pub expires_at_ms: i64,
}
