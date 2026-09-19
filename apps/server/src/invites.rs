//! Invitations, and the gate that decides who may open a conversation with
//! whom.
//!
//! This module is what is left of Meet&Greet after the map was removed, and it
//! is left because it was never really about the map. [`may_reach`] is the
//! other half of what "private account" means: `profiles.rs` hides a private
//! account from search, and this hides it from being written to. One without
//! the other would be the switch `profiles.rs` refused to add — the kind that
//! says "private" and does not mean it.
//!
//! An invitation is how somebody gets past that gate on purpose. It is a
//! secret its owner hands out, it expires by the clock, and it can be
//! withdrawn.
//!
//! Both rules live on the server for the reason `blocks.rs` gives in its own
//! header: *a rule the client applies is a promise the product cannot keep.*

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::get};
use serde::{Deserialize, Serialize};

use crate::auth::Caller;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/invites", get(list_invites).post(create_invite))
        .route("/v1/invites/{id}", axum::routing::delete(revoke_invite))
}

/// The longest an invitation may last. Also a CHECK on the table, so no future
/// writer can mint one that outlives this.
const INVITE_MAX_DAYS: i64 = 7;

/// The most invitations one request will return.
const PAGE: i64 = 500;

// ------------------------------------------------------------- reachable ---

/// Whether `caller` may open a conversation with `target`.
///
/// Public accounts: always. A private one, only if the caller already shares a
/// conversation with them — the definition of "contact" this server already
/// uses — or presents a live invitation belonging to them.
///
/// Spending an invitation is recorded, which is what lets its owner see
/// whether the link they handed out was used. The recording is best-effort in
/// one direction only: it happens before the conversation is created, so a
/// creation that fails afterwards still counts as a use. That is the honest
/// reading — the secret was presented and it worked.
pub async fn may_reach(
    db: &sqlx::PgPool,
    caller: i64,
    target: i64,
    invite_secret: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let private = sqlx::query!("SELECT is_private FROM users WHERE id = $1", target)
        .fetch_optional(db)
        .await?
        .map(|r| r.is_private)
        .unwrap_or(false);
    if !private {
        return Ok(true);
    }

    // Already in touch. Blocking is checked separately and takes precedence:
    // this only asks whether the door was ever open.
    let known = sqlx::query!(
        "SELECT 1 AS \"ok!\" FROM conversation_members m1
         JOIN conversation_members m2 ON m1.conversation_id = m2.conversation_id
         WHERE m1.user_id = $1 AND m2.user_id = $2
         LIMIT 1",
        caller,
        target
    )
    .fetch_optional(db)
    .await?
    .is_some();
    if known {
        return Ok(true);
    }

    let Some(secret) = invite_secret else {
        return Ok(false);
    };
    // Liveness is decided in the query, never by a cleanup job: this server
    // runs no scheduled work, and an invitation that only stops working once a
    // sweeper runs is one that still works.
    let invite = sqlx::query!(
        "SELECT id FROM invites
         WHERE owner_id = $1 AND secret_hash = $2
           AND revoked_at IS NULL AND expires_at > now()
         LIMIT 1",
        target,
        hash_secret(secret)
    )
    .fetch_optional(db)
    .await?;

    let Some(invite) = invite else {
        return Ok(false);
    };
    // One row per person, not per attempt: the count the owner reads is "how
    // many people came through this", and a retry is not another person.
    sqlx::query!(
        "INSERT INTO invite_uses (invite_id, user_id) VALUES ($1, $2)
         ON CONFLICT (invite_id, user_id) DO NOTHING",
        invite.id,
        caller
    )
    .execute(db)
    .await?;
    Ok(true)
}

/// SHA-256 of an invite secret, hex.
///
/// The secret itself is never stored, for the reason a password is not: a
/// leaked table should not hand out working invitations. Lookup is by exact
/// hash, so nothing is lost by it.
pub fn hash_secret(secret: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(secret.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------- errors ---

/// Why an invitation request was refused.
#[derive(Debug)]
pub enum InviteError {
    /// No such invitation.
    NotFound,
    /// The request was malformed.
    Invalid(String),
    /// Over the account's rate limit.
    TooManyRequests,
    /// Something the caller cannot act on.
    Internal(anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: String,
}

impl IntoResponse for InviteError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            InviteError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "That is not there.".to_string(),
            ),
            InviteError::Invalid(message) => (StatusCode::BAD_REQUEST, "invalid_request", message),
            InviteError::TooManyRequests => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many requests. Slow down.".to_string(),
            ),
            InviteError::Internal(error) => {
                tracing::error!(%error, "invite request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "Something went wrong. Try again.".to_string(),
                )
            }
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for InviteError {
    fn from(error: E) -> Self {
        InviteError::Internal(error.into())
    }
}

// --------------------------------------------------------------- invites ---

/// One invitation, as its owner sees it.
#[derive(Debug, Serialize)]
pub struct InviteView {
    pub id: i64,
    pub label: Option<String>,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub revoked: bool,
    /// Whether it can be used right now. Computed, never stored: an invitation
    /// expires by the clock, not by anybody running a job.
    pub live: bool,
    /// How many people have reached the owner through it.
    pub used: i64,
}

#[derive(Deserialize)]
struct NewInvite {
    label: Option<String>,
    /// How long it should last, in days. At most seven.
    days: Option<i64>,
}

/// What a freshly minted invitation returns.
///
/// The **only** time the secret is readable. It is stored as a hash, so if the
/// owner loses it there is nothing to look up — they revoke it and make
/// another, which is the same answer a password reset gives and for the same
/// reason.
#[derive(Debug, Serialize)]
pub struct MintedInvite {
    pub id: i64,
    pub secret: String,
    pub expires_at_ms: i64,
}

async fn create_invite(
    State(state): State<AppState>,
    caller: Caller,
    Json(request): Json<NewInvite>,
) -> Result<Json<MintedInvite>, InviteError> {
    if !state.limits.invites.check(&caller.user_id.to_string()) {
        return Err(InviteError::TooManyRequests);
    }
    let days = request.days.unwrap_or(INVITE_MAX_DAYS);
    if !(1..=INVITE_MAX_DAYS).contains(&days) {
        return Err(InviteError::Invalid(format!(
            "An invitation lasts between 1 and {INVITE_MAX_DAYS} days."
        )));
    }
    if let Some(label) = &request.label
        && label.chars().count() > 40
    {
        return Err(InviteError::Invalid("That label is too long.".into()));
    }

    // 256 bits from the OS. The secret leaves in the response and is never
    // stored, so it has to be unguessable rather than merely unique.
    let secret: String = {
        use rand::RngCore as _;
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };

    let row = sqlx::query!(
        "INSERT INTO invites (owner_id, secret_hash, label, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4::int))
         RETURNING id, (EXTRACT(EPOCH FROM expires_at) * 1000)::BIGINT AS expires_at_ms",
        caller.user_id,
        hash_secret(&secret),
        request.label,
        days as i32
    )
    .fetch_one(&state.db)
    .await?;

    Ok(Json(MintedInvite {
        id: row.id,
        secret,
        expires_at_ms: row.expires_at_ms.unwrap_or(0),
    }))
}

async fn list_invites(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<Vec<InviteView>>, InviteError> {
    let rows = sqlx::query!(
        "SELECT i.id, i.label, (i.revoked_at IS NOT NULL) AS revoked,
                (EXTRACT(EPOCH FROM i.created_at) * 1000)::BIGINT AS created_at_ms,
                (EXTRACT(EPOCH FROM i.expires_at) * 1000)::BIGINT AS expires_at_ms,
                (i.revoked_at IS NULL AND i.expires_at > now()) AS live,
                (SELECT count(*) FROM invite_uses u WHERE u.invite_id = i.id) AS used
         FROM invites i
         WHERE i.owner_id = $1
         ORDER BY i.created_at DESC
         LIMIT $2",
        caller.user_id,
        PAGE
    )
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(|r| InviteView {
                id: r.id,
                label: r.label,
                created_at_ms: r.created_at_ms.unwrap_or(0),
                expires_at_ms: r.expires_at_ms.unwrap_or(0),
                revoked: r.revoked.unwrap_or(false),
                live: r.live.unwrap_or(false),
                used: r.used.unwrap_or(0),
            })
            .collect(),
    ))
}

/// Withdraw an invitation. The row stays, so the uses recorded against it can
/// still be counted.
async fn revoke_invite(
    State(state): State<AppState>,
    caller: Caller,
    Path(id): Path<i64>,
) -> Result<StatusCode, InviteError> {
    let updated = sqlx::query!(
        "UPDATE invites SET revoked_at = now()
         WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL
         RETURNING id",
        id,
        caller.user_id
    )
    .fetch_optional(&state.db)
    .await?;
    updated.ok_or(InviteError::NotFound)?;
    Ok(StatusCode::NO_CONTENT)
}
