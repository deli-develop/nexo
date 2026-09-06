//! The MLS Delivery Service.
//!
//! Its whole job, from brief 4.2: store KeyPackages, fan out ciphertext, and
//! **order commits**. It holds no group secrets and cannot derive any.
//!
//! Rule 4 shapes every function here. If any of these ever needs to look inside
//! `ciphertext`, that is a design failure, not a feature to add. The one thing
//! the server knows about a message beyond its routing is whether the sender
//! *declared* it a commit — and that declaration is trusted only enough to
//! order commits, never enough to infer anything about the contents.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::get, routing::post};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::bearer::Caller;
use crate::state::AppState;

pub mod epoch;

/// Every delivery-service route. All of them require a [`Caller`].
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/keypackages", post(publish_key_packages))
        .route("/v1/keypackages/count", get(key_package_count))
        .route("/v1/keypackages/{handle}", get(claim_key_package))
        .route(
            "/v1/conversations",
            post(create_conversation).get(list_conversations),
        )
        .route(
            "/v1/conversations/{id}",
            axum::routing::delete(discard_conversation),
        )
        .route("/v1/conversations/{id}/members", post(add_member))
        // POST rather than DELETE: this carries a body naming who to remove,
        // and a DELETE with a body is awkward for clients and proxies alike.
        .route("/v1/conversations/{id}/members/remove", post(remove_member))
        .route("/v1/conversations/{id}/send", post(send))
        .route("/v1/conversations/{id}/sync", get(sync))
}

// ---------------------------------------------------------------- errors ---

/// What a delivery-service call can refuse with.
#[derive(Debug)]
pub enum DeliveryError {
    /// The caller is not a member of that conversation.
    NotAMember,
    /// No such conversation, handle, or key package.
    NotFound(&'static str),
    /// A commit cited an epoch that is no longer current (risk 4(b)).
    StaleEpoch {
        /// The epoch the server considers current.
        current: i64,
        /// The epoch the rejected commit cited.
        cited: i64,
    },
    /// The request was malformed.
    Invalid(String),
    /// Refused for a reason the caller is not told.
    ///
    /// Today that means a block. The message is deliberately the same one any
    /// other delivery failure would produce: someone who has been blocked
    /// should not be able to tell that from a message that simply did not go
    /// through. See `blocks.rs` for why that asymmetry is the point.
    Refused,
    /// Over a rate limit (BRIEF 4.5).
    ///
    /// No detail and no retry-after: how much budget is left, and which limit
    /// was met, are both things an attacker would use to pace themselves.
    TooManyRequests,
    /// Something failed that the caller cannot do anything about.
    Internal(anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: String,
    /// Present only on a stale epoch, so the client can resync to the right
    /// place without a second round trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    current_epoch: Option<i64>,
}

impl IntoResponse for DeliveryError {
    fn into_response(self) -> Response {
        let (status, error, message, current_epoch) = match self {
            // Membership is not confirmed to a non-member: "you are not in it"
            // and "it does not exist" are the same answer, or conversation ids
            // become guessable state.
            DeliveryError::NotAMember => (
                StatusCode::NOT_FOUND,
                "not_found",
                "No such conversation.".to_string(),
                None,
            ),
            DeliveryError::NotFound(what) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("No such {what}."),
                None,
            ),
            DeliveryError::StaleEpoch { current, cited } => (
                StatusCode::CONFLICT,
                "stale_epoch",
                format!(
                    "This commit cites epoch {cited}, but the conversation is at \
                     {current}. Resync and build it again."
                ),
                Some(current),
            ),
            DeliveryError::Invalid(message) => {
                (StatusCode::BAD_REQUEST, "invalid_request", message, None)
            }
            DeliveryError::Refused => (
                StatusCode::FORBIDDEN,
                "refused",
                "That could not be delivered.".to_string(),
                None,
            ),
            DeliveryError::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many requests. Slow down.".to_string(),
                None,
            ),
            DeliveryError::Internal(error) => {
                tracing::error!(%error, "delivery request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Something went wrong. Try again.".to_string(),
                    None,
                )
            }
        };
        (
            status,
            Json(ErrorBody {
                error,
                message,
                current_epoch,
            }),
        )
            .into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for DeliveryError {
    fn from(error: E) -> Self {
        DeliveryError::Internal(error.into())
    }
}

// ----------------------------------------------------------- keypackages ---

#[derive(Deserialize)]
pub struct PublishRequest {
    /// Hex-encoded KeyPackages.
    pub key_packages: Vec<String>,
}

#[derive(Serialize)]
pub struct CountResponse {
    /// Unconsumed packages left for this device.
    pub remaining: i64,
    /// Below this, top up (brief 4.2).
    pub refill_below: i64,
}

/// How many packages a client publishes at once, capped so one call cannot fill
/// the table. Brief 4.2 asks for 50 at registration.
const MAX_KEY_PACKAGES_PER_CALL: usize = 100;

async fn publish_key_packages(
    State(state): State<AppState>,
    caller: Caller,
    Json(request): Json<PublishRequest>,
) -> Result<StatusCode, DeliveryError> {
    if request.key_packages.is_empty() {
        return Err(DeliveryError::Invalid("No key packages supplied.".into()));
    }
    if request.key_packages.len() > MAX_KEY_PACKAGES_PER_CALL {
        return Err(DeliveryError::Invalid(format!(
            "At most {MAX_KEY_PACKAGES_PER_CALL} key packages per call."
        )));
    }

    let decoded: Vec<Vec<u8>> = request
        .key_packages
        .iter()
        .map(|hex| unhex(hex, "key_packages"))
        .collect::<Result<_, _>>()?;

    for data in decoded {
        sqlx::query!(
            "INSERT INTO key_packages (device_id, data) VALUES ($1, $2)",
            caller.device_id,
            &data[..]
        )
        .execute(&state.db)
        .await?;
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn key_package_count(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<CountResponse>, DeliveryError> {
    let row = sqlx::query!(
        "SELECT count(*) AS \"count!\" FROM key_packages
         WHERE device_id = $1 AND consumed_at IS NULL",
        caller.device_id
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(CountResponse {
        remaining: row.count,
        refill_below: nexo_crypto::KEY_PACKAGE_REFILL_THRESHOLD as i64,
    }))
}

#[derive(Serialize)]
pub struct KeyPackageResponse {
    /// Hex-encoded KeyPackage.
    pub key_package: String,
    /// Which device it belongs to.
    pub device_id: Uuid,
}

/// Claims one KeyPackage for a handle, marking it consumed.
///
/// Single-use is enforced in one statement, not in a read-then-write: two
/// clients starting a conversation with the same person at the same moment
/// would otherwise both be handed the same package, and the second invite would
/// fail with something unhelpful much later.
async fn claim_key_package(
    State(state): State<AppState>,
    caller: Caller,
    Path(handle): Path<String>,
) -> Result<Json<KeyPackageResponse>, DeliveryError> {
    // Keyed by the caller, not by the handle being claimed: the limit exists to
    // stop one account draining everyone's supply, and keying it by target
    // would let an attacker spend a fresh budget per victim.
    //
    // Every call here consumes a KeyPackage, so an unlimited endpoint is a
    // silent denial of service against a third party -- once someone's supply
    // is gone, nobody can start a conversation with them, and they are shown
    // no error because nothing they did failed.
    if !state.limits.key_packages.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "key package rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let row = sqlx::query!(
        "UPDATE key_packages SET consumed_at = now()
         WHERE id = (
             SELECT kp.id
             FROM key_packages kp
             JOIN devices d ON d.id = kp.device_id
             JOIN users u ON u.id = d.user_id
             WHERE u.handle = $1
               AND kp.consumed_at IS NULL
               -- A retired device cannot read what is addressed to it. Handing
               -- out its package would produce a Welcome that silently goes
               -- nowhere, and the claimer is told it succeeded.
               AND d.retired_at IS NULL
             ORDER BY kp.created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1
         )
         RETURNING data, device_id",
        handle as _
    )
    .fetch_optional(&state.db)
    .await?;

    let row = row.ok_or(DeliveryError::NotFound("key package for that handle"))?;
    Ok(Json(KeyPackageResponse {
        key_package: hex(&row.data),
        device_id: row.device_id,
    }))
}

// --------------------------------------------------------- conversations ---

#[derive(Deserialize)]
pub struct CreateConversationRequest {
    /// The conversation id, chosen by the client because it is also the MLS
    /// group id and the group already exists locally by the time this is sent.
    pub conversation_id: Uuid,
    /// Handles of the other members. The caller is added automatically.
    pub members: Vec<String>,
    /// An invitation secret, when reaching somebody private.
    ///
    /// Absent for a public account and for somebody already in touch. Checked
    /// against a hash — the secret itself is never stored.
    #[serde(default)]
    pub invite: Option<String>,
}

#[derive(Serialize)]
pub struct ConversationView {
    pub conversation_id: Uuid,
    pub kind: String,
    pub epoch: i64,
    /// Id of the most recent envelope, for a client deciding whether to sync.
    pub latest_envelope_id: Option<i64>,
    /// Every member's handle, the caller included.
    ///
    /// Routing metadata the server already holds and already acts on — it is
    /// what `sync` checks before handing over an envelope. Returning it lets a
    /// client that was *invited* name the conversation: it learns of one only
    /// through this list, and MLS credentials name devices rather than
    /// accounts, so without this there is nothing to call it but "Unnamed".
    #[serde(default)]
    pub members: Vec<String>,
    /// The same members, paired with the device each is in the group as.
    ///
    /// MLS names a *device*, not an account (`crates/crypto/src/mls.rs`), so a
    /// client holding a handle has no way to say which leaf in the tree that
    /// handle is — which is what removing someone requires. This is the only
    /// place the mapping exists: the server already knows both halves, and
    /// stating them together is what lets a client act on a member by name.
    ///
    /// Retired devices are excluded. A member whose device was replaced is
    /// still in the group at their old leaf, but there is nothing useful a
    /// client can do with a leaf whose owner will never read from it again.
    #[serde(default)]
    pub member_devices: Vec<MemberDevice>,
}

/// One member, and the device they are in the group as.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberDevice {
    pub handle: String,
    pub device_id: Uuid,
}

async fn create_conversation(
    State(state): State<AppState>,
    caller: Caller,
    Json(request): Json<CreateConversationRequest>,
) -> Result<(StatusCode, Json<ConversationView>), DeliveryError> {
    // 'dm' is exactly two people. Everything else is a group -- and a 1:1 is
    // still an ordinary two-member MLS group (brief 4.2); the distinction here
    // is for the UI, not for the crypto.
    //
    // No other members is a conversation with yourself: a place to keep notes,
    // links and files. It used to be refused here, on the reasoning that a
    // conversation nobody else is in can never carry a message -- which is
    // true of a group and false of this one, where the sender and the reader
    // are the same person. It is an ordinary one-member MLS group and every
    // path below treats it as one; only the fan-out has nobody to reach, which
    // costs nothing.
    let kind = if request.members.is_empty() {
        "self"
    } else if request.members.len() == 1 {
        "dm"
    } else {
        "group"
    };

    // Refused before anything is written. A conversation that exists but can
    // never carry a message is worse than one that was never created: it shows
    // up in both people's lists as a chat that silently fails.
    let mut member_ids = Vec::with_capacity(request.members.len());
    for handle in &request.members {
        let other = sqlx::query!("SELECT id FROM users WHERE handle = $1", handle as _)
            .fetch_optional(&state.db)
            .await?
            .ok_or(DeliveryError::NotFound("user"))?;
        if crate::blocks::blocked_between(&state.db, caller.user_id, other.id).await? {
            return Err(DeliveryError::Refused);
        }
        // The other half of "private". Hiding an account from search while
        // leaving it writable would be the switch `profiles.rs` refused to
        // add: one that promises privacy it cannot keep. The same answer is
        // given whether the account is private or the invitation is spent, so
        // this does not become a way to learn who is private.
        if !crate::meet::may_reach(
            &state.db,
            caller.user_id,
            other.id,
            request.invite.as_deref(),
        )
        .await?
        {
            return Err(DeliveryError::Refused);
        }
        member_ids.push(other.id);
    }

    // One DM per pair, decided here because nowhere else can decide it.
    //
    // Both clients check for an existing conversation before starting one, and
    // both can look at the same moment and see none -- then each mints its own
    // id and the two people end up with two chats. No amount of client care
    // closes that: the check and the create are two round trips with a gap in
    // between, and only the server sees both. So a second DM between the same
    // two people is not created; the first one is handed back instead, and the
    // client that asked adopts it (`conversations::start_with`).
    //
    // Oldest wins, so both sides of a race converge on the same answer whoever
    // asks first.
    // One of these per person, for the reason the DM case gives below: two
    // launches can both look, both see none, and both create one. There is no
    // pair to key on, so the caller is the key.
    if kind == "self"
        && let Some(existing) = sqlx::query!(
            "SELECT c.id, c.epoch,
                    (SELECT max(e.id) FROM envelopes e WHERE e.conversation_id = c.id)
                        AS latest_envelope_id
             FROM conversations c
             WHERE c.kind = 'self'
               AND EXISTS (SELECT 1 FROM conversation_members m
                           WHERE m.conversation_id = c.id AND m.user_id = $1)
             ORDER BY c.created_at ASC
             LIMIT 1",
            caller.user_id
        )
        .fetch_optional(&state.db)
        .await?
    {
        return Ok((
            StatusCode::OK,
            Json(ConversationView {
                conversation_id: existing.id,
                kind: kind.to_string(),
                epoch: existing.epoch,
                latest_envelope_id: existing.latest_envelope_id,
                members: Vec::new(),
                member_devices: Vec::new(),
            }),
        ));
    }

    if let (true, Some(&other_id)) = (kind == "dm", member_ids.first())
        && let Some(existing) = sqlx::query!(
            "SELECT c.id, c.epoch,
                    (SELECT max(e.id) FROM envelopes e WHERE e.conversation_id = c.id)
                        AS latest_envelope_id
             FROM conversations c
             WHERE c.kind = 'dm'
               AND (SELECT count(*) FROM conversation_members m
                    WHERE m.conversation_id = c.id) = 2
               AND EXISTS (SELECT 1 FROM conversation_members m
                           WHERE m.conversation_id = c.id AND m.user_id = $1)
               AND EXISTS (SELECT 1 FROM conversation_members m
                           WHERE m.conversation_id = c.id AND m.user_id = $2)
             ORDER BY c.created_at ASC
             LIMIT 1",
            caller.user_id,
            other_id
        )
        .fetch_optional(&state.db)
        .await?
    {
        // 200 rather than 201, because nothing was created. The client tells
        // the two apart by the id, not the status -- an id it did not choose
        // means "use this one instead".
        return Ok((
            StatusCode::OK,
            Json(ConversationView {
                conversation_id: existing.id,
                kind: kind.to_string(),
                epoch: existing.epoch,
                latest_envelope_id: existing.latest_envelope_id,
                members: request.members.clone(),
                // Filled by the next `list_conversations`, as above.
                member_devices: Vec::new(),
            }),
        ));
    }

    let mut tx = state.db.begin().await?;

    let created = sqlx::query!(
        "INSERT INTO conversations (id, kind) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING
         RETURNING id",
        request.conversation_id,
        kind
    )
    .fetch_optional(&mut *tx)
    .await?;

    if created.is_none() {
        return Err(DeliveryError::Invalid(
            "That conversation already exists.".into(),
        ));
    }

    sqlx::query!(
        "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)",
        request.conversation_id,
        caller.user_id
    )
    .execute(&mut *tx)
    .await?;

    for handle in &request.members {
        let user = sqlx::query!("SELECT id FROM users WHERE handle = $1", handle as _)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(DeliveryError::NotFound("user"))?;

        sqlx::query!(
            "INSERT INTO conversation_members (conversation_id, user_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING",
            request.conversation_id,
            user.id
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(ConversationView {
            conversation_id: request.conversation_id,
            kind: kind.to_string(),
            epoch: 0,
            latest_envelope_id: None,
            // The creator already knows who it invited; this echoes it back
            // rather than reading the rows it just wrote.
            members: request.members.clone(),
            // The devices are not known here without a read the creator does
            // not need: it already holds the KeyPackages it claimed, and the
            // next `list_conversations` fills this in.
            member_devices: Vec::new(),
        }),
    ))
}

/// Removes a conversation that never carried anything.
///
/// # Why this exists
///
/// `create_conversation` writes the conversation and its membership rows and
/// commits them, and the client only afterwards learns whether its add commit
/// was accepted. When that send fails, the row survives with both people on
/// it and no MLS state anywhere — a chat that appears in two people's lists
/// and can never carry a message. There was no way to take it back, so it
/// stayed, and `discover` kept drawing it. That is one of the two ways the
/// same person ended up with two conversations.
///
/// # Why it cannot destroy anything real
///
/// It refuses the moment a single envelope exists. A conversation that has
/// carried one message is somebody's history — on their disk, not here — and
/// no client is allowed to reach across and end it for everyone. What this
/// deletes has, by construction, never been used.
///
/// Membership is still checked first: a stranger must not be able to probe
/// which conversation ids exist by watching which deletions are refused.
async fn discard_conversation(
    State(state): State<AppState>,
    caller: Caller,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, DeliveryError> {
    let member = sqlx::query!(
        "SELECT 1 AS \"present!\" FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2",
        id,
        caller.user_id
    )
    .fetch_optional(&state.db)
    .await?;
    if member.is_none() {
        // The same answer a conversation that does not exist gives.
        return Err(DeliveryError::NotAMember);
    }

    // One statement, so there is no window between the check and the delete in
    // which the first envelope could land.
    let deleted = sqlx::query!(
        "DELETE FROM conversations
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM envelopes e WHERE e.conversation_id = $1)
         RETURNING id",
        id
    )
    .fetch_optional(&state.db)
    .await?;

    if deleted.is_none() {
        return Err(DeliveryError::Invalid(
            "That conversation has messages in it and cannot be discarded.".into(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_conversations(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<Vec<ConversationView>>, DeliveryError> {
    let rows = sqlx::query!(
        "SELECT c.id, c.kind, c.epoch,
                (SELECT max(e.id) FROM envelopes e WHERE e.conversation_id = c.id)
                    AS latest_envelope_id,
                ARRAY(
                    SELECT u.handle::TEXT
                    FROM conversation_members cm
                    JOIN users u ON u.id = cm.user_id
                    WHERE cm.conversation_id = c.id
                    ORDER BY u.handle
                ) AS \"members!: Vec<String>\",
                COALESCE((
                    SELECT json_agg(json_build_object(
                               'handle', u.handle::TEXT,
                               'device_id', d.id
                           ) ORDER BY u.handle)
                    FROM conversation_members cm
                    JOIN users u ON u.id = cm.user_id
                    JOIN devices d ON d.user_id = u.id AND d.retired_at IS NULL
                    WHERE cm.conversation_id = c.id
                ), '[]'::json) AS \"member_devices!: sqlx::types::Json<Vec<MemberDevice>>\"
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = $1
         ORDER BY c.created_at DESC",
        caller.user_id
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|r| ConversationView {
                conversation_id: r.id,
                kind: r.kind,
                epoch: r.epoch,
                latest_envelope_id: r.latest_envelope_id,
                members: r.members,
                member_devices: r.member_devices.0,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct MemberRequest {
    /// Whose membership is changing.
    pub handle: String,
}

/// Adds someone to a conversation.
///
/// Membership here is **routing only**: it decides who may sync and who is fanned
/// out to. It grants no ability to read anything, because the server holds no
/// group secrets — the MLS commit that actually admits them is a separate,
/// client-made thing that this row cannot substitute for.
///
/// Which is why the order matters and is enforced by the client, not here: the
/// row goes in first so the invitee can *receive* the Welcome, and the Welcome
/// is what lets them read. A row without a commit is someone who can fetch
/// ciphertext they have no key for.
async fn add_member(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<MemberRequest>,
) -> Result<StatusCode, DeliveryError> {
    if !state.limits.membership.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "membership rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let mut tx = state.db.begin().await?;

    // Only a member may add a member.
    let member = sqlx::query!(
        "SELECT 1 AS \"ok!\" FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        caller.user_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(DeliveryError::NotAMember);
    }

    let user = sqlx::query!(
        "SELECT id FROM users WHERE handle = $1",
        request.handle as _
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(DeliveryError::NotFound("user"))?;

    sqlx::query!(
        "INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING",
        conversation_id,
        user.id
    )
    .execute(&mut *tx)
    .await?;

    // A 1:1 that gains a third person is a group. The distinction is for the
    // UI; MLS treats them identically (brief 4.2).
    sqlx::query!(
        "UPDATE conversations SET kind = 'group'
         WHERE id = $1
           AND (SELECT count(*) FROM conversation_members WHERE conversation_id = $1) > 2",
        conversation_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes someone from a conversation.
///
/// Again routing only. What actually stops them reading is the MLS commit that
/// removes them, which rekeys the group — this row stops them *fetching*.
/// Removing the row without the commit would leave someone who can no longer
/// sync but could still decrypt anything they had already collected.
async fn remove_member(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<MemberRequest>,
) -> Result<StatusCode, DeliveryError> {
    if !state.limits.membership.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "membership rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let mut tx = state.db.begin().await?;

    let member = sqlx::query!(
        "SELECT 1 AS \"ok!\" FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        caller.user_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if member.is_none() {
        return Err(DeliveryError::NotAMember);
    }

    let user = sqlx::query!(
        "SELECT id FROM users WHERE handle = $1",
        request.handle as _
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(DeliveryError::NotFound("user"))?;

    sqlx::query!(
        "DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        user.id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// -------------------------------------------------------------- envelopes ---

#[derive(Deserialize)]
pub struct SendRequest {
    /// Hex-encoded MLS message. Opaque to the server.
    pub ciphertext: String,
    /// The epoch this was built against.
    pub epoch: i64,
    /// Whether this carries a commit, declared by the sender.
    #[serde(default)]
    pub is_commit: bool,
    /// The client's own name for this message, for idempotent retries (M8).
    ///
    /// Optional so an older client still works, but a client with an offline
    /// queue must send one: without it, a retry after a lost reply is a
    /// duplicate message in everyone's conversation.
    #[serde(default)]
    pub client_msg_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct SendResponse {
    /// The envelope's id, which is also the sync cursor.
    pub envelope_id: i64,
    /// The epoch in force after this send. Changes only for a commit.
    pub epoch: i64,
}

/// Accepts one envelope, ordering it if it is a commit.
///
/// This is the server half of PLAN.md risk 4(b). The rule, in full:
///
/// - an application message is accepted at any epoch the sender claims — the
///   secret tree tolerates bounded reordering, so the server has no business
///   refusing them;
/// - a **commit** must cite the current epoch. The first one to arrive wins and
///   advances the epoch; anything else is refused with [`DeliveryError::StaleEpoch`]
///   and its sender resyncs and rebuilds.
///
/// The row lock is what makes "first" mean anything: without it two commits
/// citing the same epoch could both read `epoch = 3` and both be accepted.
async fn send(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<SendRequest>,
) -> Result<Json<SendResponse>, DeliveryError> {
    // Generous enough that a person typing never meets it, low enough that a
    // loop does not fill the envelope table.
    if !state.limits.send.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "send rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    // A block stops a two-person conversation and nothing else.
    //
    // Not groups, and that is a decision rather than an omission. A group is
    // one MLS state shared by everyone in it: dropping one member's envelope
    // would leave the others at an epoch that member never reaches, and every
    // message after it undecryptable to somebody. Blocking cannot mean "you
    // two stop hearing each other" inside a group without breaking the group
    // for the people who were not part of it. Leaving the group is the answer
    // there, and the app does not offer that yet either -- so it says nothing
    // about groups rather than half-doing it.
    let others = sqlx::query!(
        "SELECT user_id FROM conversation_members
         WHERE conversation_id = $1 AND user_id <> $2",
        conversation_id,
        caller.user_id
    )
    .fetch_all(&state.db)
    .await?;
    if others.len() == 1
        && crate::blocks::blocked_between(&state.db, caller.user_id, others[0].user_id).await?
    {
        return Err(DeliveryError::Refused);
    }

    // Meet&Greet's one-message rule, enforced where it is true rather than
    // where it is convenient.
    //
    // An intro from the map buys exactly one message until the person who
    // received it answers. That belongs here, beside the block check, for the
    // reason `blocks.rs` gives about itself: a cap the client applies is a
    // promise the product cannot keep, and this one guards a stranger's inbox.
    //
    // The proof this needs -- that the conversation has two members and who the
    // other one is -- was established immediately above, so the rule costs one
    // more query and nothing else. Commits are exempt: the group's own
    // machinery is not a message, and refusing one would break the
    // conversation rather than quieten it.
    if others.len() == 1 && !request.is_commit {
        let pending = sqlx::query!(
            "SELECT 1 AS \"present!\" FROM meet_requests
             WHERE conversation_id = $1 AND from_id = $2 AND state = 'pending'",
            conversation_id,
            caller.user_id
        )
        .fetch_optional(&state.db)
        .await?
        .is_some();
        if pending {
            let already = sqlx::query!(
                "SELECT count(*) AS \"n!\" FROM envelopes
                 WHERE conversation_id = $1 AND sender_device_id IN
                       (SELECT id FROM devices WHERE user_id = $2)
                   AND NOT is_commit",
                conversation_id,
                caller.user_id
            )
            .fetch_one(&state.db)
            .await?;
            if already.n > 0 {
                return Err(DeliveryError::Refused);
            }
        }
    }

    let ciphertext = unhex(&request.ciphertext, "ciphertext")?;
    if ciphertext.is_empty() {
        return Err(DeliveryError::Invalid("Empty ciphertext.".into()));
    }

    // Idempotency, checked before the epoch rule and before the lock.
    //
    // A client that queued this message while offline cannot tell "the request
    // never arrived" from "the reply was lost", so it retries. Answering with
    // the envelope the first attempt created makes the retry harmless; without
    // this, reconnecting duplicates every message that was in flight.
    //
    // It matters that this comes first. A retry of a *commit* cites the epoch
    // its first attempt advanced past, so running it through `epoch::decide`
    // would refuse it as stale -- a correct answer to the wrong question,
    // because that commit has already been applied.
    if let Some(client_msg_id) = request.client_msg_id {
        let existing = sqlx::query!(
            "SELECT e.id, e.epoch
             FROM envelopes e
             JOIN conversation_members m
               ON m.conversation_id = e.conversation_id AND m.user_id = $3
             WHERE e.conversation_id = $1
               AND e.client_msg_id = $2
               AND e.sender_device_id = $4",
            conversation_id,
            client_msg_id,
            caller.user_id,
            caller.device_id
        )
        .fetch_optional(&state.db)
        .await?;

        if let Some(existing) = existing {
            tracing::debug!(
                envelope_id = existing.id,
                "a retried send matched an envelope already written"
            );
            return Ok(Json(SendResponse {
                envelope_id: existing.id,
                epoch: existing.epoch,
            }));
        }
    }

    let mut tx = state.db.begin().await?;

    // FOR UPDATE, so two commits for the same epoch cannot both pass the check.
    let conversation = sqlx::query!(
        "SELECT c.epoch
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id
         WHERE c.id = $1 AND m.user_id = $2
         FOR UPDATE OF c",
        conversation_id,
        caller.user_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(DeliveryError::NotAMember)?;

    // The rule itself lives in `epoch::decide`, so it can be read and tested
    // without a database. This function holds the lock and does the writing.
    let epoch_after = match epoch::decide(conversation.epoch, request.epoch, request.is_commit) {
        epoch::Decision::Accept { epoch } => epoch,
        epoch::Decision::AcceptAndAdvance { epoch } => {
            sqlx::query!(
                "UPDATE conversations SET epoch = $1 WHERE id = $2",
                epoch,
                conversation_id
            )
            .execute(&mut *tx)
            .await?;
            epoch
        }
        epoch::Decision::Stale { current, cited } => {
            return Err(DeliveryError::StaleEpoch { current, cited });
        }
    };

    // ON CONFLICT closes the race the check above cannot: two retries arriving
    // at once both find nothing and both insert. The unique index decides, and
    // the loser reads back the winner's row rather than failing.
    let envelope = sqlx::query!(
        "INSERT INTO envelopes
             (conversation_id, sender_device_id, epoch, ciphertext, is_commit, client_msg_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (conversation_id, client_msg_id)
             WHERE client_msg_id IS NOT NULL
             DO UPDATE SET client_msg_id = EXCLUDED.client_msg_id
         RETURNING id",
        conversation_id,
        caller.device_id,
        request.epoch,
        &ciphertext[..],
        request.is_commit,
        request.client_msg_id
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    // Only after the commit, so nobody is told about an envelope that a
    // rollback would have removed.
    state.fanout.publish(
        conversation_id,
        nexo_protocol::ServerEvent::Envelope {
            envelope_id: envelope.id,
            conversation_id,
            sender_device_id: caller.device_id,
            epoch: request.epoch.max(0) as u64,
            ciphertext: request.ciphertext.clone(),
            is_commit: request.is_commit,
            server_timestamp_ms: 0,
        },
    );

    Ok(Json(SendResponse {
        envelope_id: envelope.id,
        epoch: epoch_after,
    }))
}

#[derive(Deserialize)]
pub struct SyncQuery {
    /// Return envelopes with an id greater than this. Absent means from the
    /// beginning of what the server still holds.
    #[serde(default)]
    pub since_id: Option<i64>,
    /// How many at most.
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Serialize)]
pub struct EnvelopeView {
    pub envelope_id: i64,
    pub conversation_id: Uuid,
    pub sender_device_id: Uuid,
    pub epoch: i64,
    /// Hex-encoded. Opaque.
    pub ciphertext: String,
    pub is_commit: bool,
    pub server_timestamp_ms: i64,
}

/// The largest page `sync` will return, so one call cannot ask for everything.
const MAX_SYNC_LIMIT: i64 = 500;

async fn sync(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<SyncQuery>,
) -> Result<Json<Vec<EnvelopeView>>, DeliveryError> {
    let member = sqlx::query!(
        "SELECT 1 AS \"ok!\" FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        caller.user_id
    )
    .fetch_optional(&state.db)
    .await?;
    if member.is_none() {
        return Err(DeliveryError::NotAMember);
    }

    let limit = query
        .limit
        .unwrap_or(MAX_SYNC_LIMIT)
        .clamp(1, MAX_SYNC_LIMIT);
    let since = query.since_id.unwrap_or(0);

    let rows = sqlx::query!(
        "SELECT id, sender_device_id, epoch, ciphertext, is_commit,
                (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS \"ts!\"
         FROM envelopes
         WHERE conversation_id = $1 AND id > $2
         ORDER BY id
         LIMIT $3",
        conversation_id,
        since,
        limit
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|r| EnvelopeView {
                envelope_id: r.id,
                conversation_id,
                sender_device_id: r.sender_device_id,
                epoch: r.epoch,
                ciphertext: hex(&r.ciphertext),
                is_commit: r.is_commit,
                server_timestamp_ms: r.ts,
            })
            .collect(),
    ))
}

// ----------------------------------------------------------------- hex -----

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(b & 0x0F), 16).unwrap());
    }
    out
}

fn unhex(s: &str, field: &str) -> Result<Vec<u8>, DeliveryError> {
    if !s.len().is_multiple_of(2) {
        return Err(DeliveryError::Invalid(format!("{field} must be hex.")));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| DeliveryError::Invalid(format!("{field} must be hex.")))
}
