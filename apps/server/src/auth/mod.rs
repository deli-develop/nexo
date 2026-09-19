//! Registration, login, refresh and logout.
//!
//! The shape is BRIEF 5.2. What the server holds, in full: a handle, a display
//! name, a salt, a hash of a verifier, an Ed25519 public key, and hashes of
//! live refresh tokens. It never sees a password, and it never sees a private
//! key.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::post};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::state::AppState;

pub mod bearer;
pub mod password;
pub mod salt;
pub mod tokens;

pub use bearer::Caller;
pub use tokens::TokenKeys;

/// Handle rules from BRIEF 4.1, enforced here as well as by the CHECK
/// constraint on `users.handle`. The database is the backstop; this is the
/// error message a person actually reads.
const HANDLE_MIN: usize = 3;
const HANDLE_MAX: usize = 20;

/// Ed25519 public keys are 32 bytes. Anything else is not one.
const IDENTITY_PUBKEY_LEN: usize = 32;

/// Every auth route.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/auth/salt", post(salt_handler))
        .route("/v1/auth/register", post(register))
        .route("/v1/auth/login", post(login))
        .route("/v1/auth/refresh", post(refresh))
        .route("/v1/auth/logout", post(logout))
        .route("/v1/auth/change-password", post(change_password))
        .route("/v1/auth/delete-account", post(delete_account))
}

// ---------------------------------------------------------------- errors ---

/// What the caller is told.
///
/// Deliberately coarse. `InvalidCredentials` covers "no such handle" and "wrong
/// verifier" alike, because telling those apart is the enumeration leak that
/// `salt.rs` goes to trouble to avoid — it would be pointless to close the door
/// there and leave it open here.
#[derive(Debug)]
pub enum AuthError {
    InvalidCredentials,
    HandleTaken,
    /// The *current* password given to change-password was wrong.
    ///
    /// Distinct from `InvalidCredentials` on purpose: that one is a 401, which
    /// the client also gets for an expired token, and the two need different
    /// prose — "sign in again" versus "that is not your password". There is no
    /// enumeration concern here; the caller is already authenticated as the
    /// account it is asking about.
    WrongPassword,
    Invalid(String),
    Internal(anyhow::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: &'static str,
    message: String,
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        let (status, error, message) = match self {
            AuthError::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "That handle and password do not match an account.".to_string(),
            ),
            AuthError::HandleTaken => (
                StatusCode::CONFLICT,
                "handle_taken",
                "That handle is already in use.".to_string(),
            ),
            AuthError::WrongPassword => (
                StatusCode::FORBIDDEN,
                "wrong_password",
                "Your current password is not correct.".to_string(),
            ),
            AuthError::Invalid(message) => (StatusCode::BAD_REQUEST, "invalid_request", message),
            AuthError::Internal(error) => {
                // The reason goes to the operator, never to the caller: it can
                // contain query text and column names.
                tracing::error!(%error, "auth request failed");
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

impl<E: Into<anyhow::Error>> From<E> for AuthError {
    fn from(error: E) -> Self {
        AuthError::Internal(error.into())
    }
}

// ----------------------------------------------------------------- salt ----

#[derive(Deserialize)]
pub struct SaltRequest {
    pub handle: String,
}

#[derive(Serialize)]
pub struct SaltResponse {
    /// Hex, because it is read by a browser-side crypto routine and hex has no
    /// alphabet ambiguity to get wrong.
    pub salt: String,
    /// The Argon2id parameters the client must use. Sent rather than hardcoded
    /// so they can be raised later without shipping a new client.
    pub argon2: Argon2Params,
}

#[derive(Serialize)]
pub struct Argon2Params {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

/// BRIEF 4.1: m=64 MiB, t=3, p=1, on the client.
const CLIENT_ARGON2: Argon2Params = Argon2Params {
    memory_kib: 64 * 1024,
    iterations: 3,
    parallelism: 1,
};

async fn salt_handler(
    State(state): State<AppState>,
    Json(request): Json<SaltRequest>,
) -> Result<Json<SaltResponse>, AuthError> {
    validate_handle(&request.handle)?;

    let existing = sqlx::query!(
        "SELECT pw_salt FROM users WHERE handle = $1",
        request.handle as _
    )
    .fetch_optional(&state.db)
    .await?;

    // An unknown handle gets a decoy rather than a 404. See salt.rs.
    let salt = match existing {
        Some(row) => row.pw_salt,
        None => salt::decoy_salt(state.auth.salt_seed(), &request.handle).to_vec(),
    };

    Ok(Json(SaltResponse {
        salt: hex(&salt),
        argon2: CLIENT_ARGON2,
    }))
}

// ------------------------------------------------------------- register ----

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub handle: String,
    pub display_name: String,
    /// Hex of the 16-byte salt the client derived its verifier against.
    ///
    /// Client-chosen on purpose. The salt endpoint cannot supply it: before
    /// the account exists it returns a *decoy*, and if the server then minted
    /// its own salt the two sides would derive different verifiers and the
    /// account could never be logged into. A salt needs uniqueness, not
    /// secrecy, so letting the registering client pick it costs nothing --
    /// and a client that picks a bad one only weakens itself.
    pub pw_salt: String,
    /// Hex of the client's Argon2id output. Never the password.
    pub pw_verifier: String,
    /// Hex of the device's Ed25519 identity public key.
    pub identity_pubkey: String,
}

#[derive(Serialize)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub user_id: i64,
    pub device_id: Uuid,
}

async fn register(
    State(state): State<AppState>,
    Json(request): Json<RegisterRequest>,
) -> Result<(StatusCode, Json<Session>), AuthError> {
    validate_handle(&request.handle)?;
    let display_name = request.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 60 {
        return Err(AuthError::Invalid(
            "Display name must be between 1 and 60 characters.".into(),
        ));
    }
    let verifier = unhex(&request.pw_verifier, "pw_verifier")?;
    let identity_pubkey = unhex(&request.identity_pubkey, "identity_pubkey")?;
    if identity_pubkey.len() != IDENTITY_PUBKEY_LEN {
        return Err(AuthError::Invalid(format!(
            "identity_pubkey must be {IDENTITY_PUBKEY_LEN} bytes."
        )));
    }

    let client_salt = unhex(&request.pw_salt, "pw_salt")?;
    if client_salt.len() != password::CLIENT_SALT_LEN {
        return Err(AuthError::Invalid(format!(
            "pw_salt must be {} bytes.",
            password::CLIENT_SALT_LEN
        )));
    }
    let pw_hash = password::hash_verifier(&verifier)?;

    // One transaction: an account with no device, or a device with no account,
    // are both states nothing else knows how to handle.
    let mut tx = state.db.begin().await?;

    let user = sqlx::query!(
        "INSERT INTO users (handle, display_name, pw_salt, pw_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (handle) DO NOTHING
         RETURNING id",
        request.handle as _,
        display_name,
        &client_salt[..],
        pw_hash
    )
    .fetch_optional(&mut *tx)
    .await?;

    let Some(user) = user else {
        // Handle collision is the one case where telling the truth is correct:
        // the caller is choosing a name, not guessing an existing one.
        return Err(AuthError::HandleTaken);
    };

    let device = sqlx::query!(
        "INSERT INTO devices (user_id, identity_pubkey) VALUES ($1, $2) RETURNING id",
        user.id,
        &identity_pubkey[..]
    )
    .fetch_one(&mut *tx)
    .await?;

    let session = issue_session(&mut tx, &state, user.id, device.id).await?;
    tx.commit().await?;

    tracing::info!(user_id = user.id, "account registered");
    Ok((StatusCode::CREATED, Json(session)))
}

// ---------------------------------------------------------------- login ----

#[derive(Deserialize)]
pub struct LoginRequest {
    pub handle: String,
    pub pw_verifier: String,
    /// Hex of this device's identity public key. v0.1 is one device per
    /// account, so logging in on machine B replaces machine A.
    pub identity_pubkey: String,
}

async fn login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> Result<Json<Session>, AuthError> {
    validate_handle(&request.handle)?;
    let verifier = unhex(&request.pw_verifier, "pw_verifier")?;
    let identity_pubkey = unhex(&request.identity_pubkey, "identity_pubkey")?;
    if identity_pubkey.len() != IDENTITY_PUBKEY_LEN {
        return Err(AuthError::Invalid(format!(
            "identity_pubkey must be {IDENTITY_PUBKEY_LEN} bytes."
        )));
    }

    let user = sqlx::query!(
        "SELECT id, pw_hash FROM users WHERE handle = $1",
        request.handle as _
    )
    .fetch_optional(&state.db)
    .await?;

    let Some(user) = user else {
        return Err(AuthError::InvalidCredentials);
    };
    if !password::verify(&verifier, &user.pw_hash)? {
        return Err(AuthError::InvalidCredentials);
    }

    let mut tx = state.db.begin().await?;

    // One device per account (PLAN.md, "Decisions taken"): logging in here
    // revokes whatever was signed in before, and retires the device it
    // replaces.
    sqlx::query!(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL",
        user.id
    )
    .execute(&mut *tx)
    .await?;

    let device = sqlx::query!(
        "INSERT INTO devices (user_id, identity_pubkey, last_seen)
         VALUES ($1, $2, now())
         ON CONFLICT (identity_pubkey)
           DO UPDATE SET last_seen = now(), retired_at = NULL
         RETURNING id",
        user.id,
        &identity_pubkey[..]
    )
    .fetch_one(&mut *tx)
    .await?;

    // Every *other* device for this account is now retired.
    //
    // This is what the comment above claimed for a long time and the code did
    // not do. Signing in on a machine with no local store generates a fresh
    // identity keypair, so the upsert above inserted a second row rather than
    // updating the first, and both stayed live.
    //
    // Retiring here rather than deleting: the old row is still referenced by
    // `conversation_members` and by envelopes that were addressed to it, and a
    // delete would either cascade history away or fail on the constraint.
    sqlx::query!(
        "UPDATE devices SET retired_at = now()
         WHERE user_id = $1 AND id <> $2 AND retired_at IS NULL",
        user.id,
        device.id
    )
    .execute(&mut *tx)
    .await?;

    // Its unclaimed KeyPackages go with it. They are the live half of the
    // problem: `claim_key_package` reaches across every device a handle owns,
    // so leaving these would keep handing peers a Welcome addressed to a
    // device that will never read it -- and the sender is told the claim
    // succeeded, which is why nobody could see what had gone wrong.
    //
    // Deleted rather than marked consumed: consumed means "somebody has this
    // one", and nobody does.
    let orphaned = sqlx::query!(
        "DELETE FROM key_packages
         WHERE consumed_at IS NULL
           AND device_id IN (
               SELECT id FROM devices WHERE user_id = $1 AND retired_at IS NOT NULL
           )",
        user.id
    )
    .execute(&mut *tx)
    .await?;
    if orphaned.rows_affected() > 0 {
        tracing::info!(
            user_id = user.id,
            count = orphaned.rows_affected(),
            "discarded key packages belonging to a retired device"
        );
    }

    let session = issue_session(&mut tx, &state, user.id, device.id).await?;
    tx.commit().await?;

    tracing::info!(user_id = user.id, "login");
    Ok(Json(session))
}

// -------------------------------------------------------------- refresh ----

#[derive(Deserialize)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

async fn refresh(
    State(state): State<AppState>,
    Json(request): Json<RefreshRequest>,
) -> Result<Json<Session>, AuthError> {
    let hash = tokens::hash_refresh_token(&request.refresh_token);

    let mut tx = state.db.begin().await?;

    let row = sqlx::query!(
        "SELECT id, user_id, device_id,
                expires_at <= now() AS \"expired!\",
                revoked_at IS NOT NULL AS \"revoked!\",
                used_at IS NOT NULL AS \"used!\"
         FROM refresh_tokens WHERE token_hash = $1
         FOR UPDATE",
        &hash[..]
    )
    .fetch_optional(&mut *tx)
    .await?;

    let Some(row) = row else {
        return Err(AuthError::InvalidCredentials);
    };

    if let Err(rejection) = tokens::classify(row.expired, row.revoked, row.used) {
        if rejection.revokes_family() {
            // A rotated token came back. Two parties hold it and there is no
            // way to tell which is the thief, so every live token for this user
            // dies and both are forced to log in again.
            sqlx::query!(
                "UPDATE refresh_tokens SET revoked_at = now()
                 WHERE user_id = $1 AND revoked_at IS NULL",
                row.user_id
            )
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            tracing::warn!(
                user_id = row.user_id,
                "refresh token reuse detected; revoked every session for this account"
            );
        }
        return Err(AuthError::InvalidCredentials);
    }

    let Some(device_id) = row.device_id else {
        // The device was deleted under us. Nothing to refresh onto.
        return Err(AuthError::InvalidCredentials);
    };

    sqlx::query!(
        "UPDATE refresh_tokens SET used_at = now() WHERE id = $1",
        row.id
    )
    .execute(&mut *tx)
    .await?;

    let session = issue_session(&mut tx, &state, row.user_id, device_id).await?;
    tx.commit().await?;
    Ok(Json(session))
}

// --------------------------------------------------------------- logout ----

async fn logout(
    State(state): State<AppState>,
    Json(request): Json<RefreshRequest>,
) -> Result<StatusCode, AuthError> {
    let hash = tokens::hash_refresh_token(&request.refresh_token);
    // No 404 for an unknown token: logging out something that is already gone
    // is a success from the caller's point of view, and saying otherwise would
    // confirm which tokens exist.
    sqlx::query!(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL",
        &hash[..]
    )
    .execute(&state.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------ change password ----

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    /// Hex of the **current** password's verifier.
    ///
    /// The caller already holds a bearer token, but a token is possession of a
    /// session, not knowledge of the password — an unattended, unlocked
    /// machine must not be enough to set a new password and lock the owner
    /// out of their own account.
    pub pw_verifier: String,
    /// Hex of the fresh 16-byte salt the new verifier was derived against.
    ///
    /// Fresh on purpose: reusing the old salt would keep any precomputed
    /// table for this account working across the change.
    pub new_pw_salt: String,
    /// Hex of the new verifier. Never the password (BRIEF 4.1).
    pub new_pw_verifier: String,
}

async fn change_password(
    State(state): State<AppState>,
    caller: Caller,
    Json(request): Json<ChangePasswordRequest>,
) -> Result<StatusCode, AuthError> {
    let old_verifier = unhex(&request.pw_verifier, "pw_verifier")?;
    let new_verifier = unhex(&request.new_pw_verifier, "new_pw_verifier")?;
    let new_salt = unhex(&request.new_pw_salt, "new_pw_salt")?;
    if new_salt.len() != password::CLIENT_SALT_LEN {
        return Err(AuthError::Invalid(format!(
            "new_pw_salt must be {} bytes.",
            password::CLIENT_SALT_LEN
        )));
    }

    let mut tx = state.db.begin().await?;

    // FOR UPDATE: two racing changes must serialise, or the loser could verify
    // against a hash the winner is about to replace and then overwrite it.
    let user = sqlx::query!(
        "SELECT pw_hash FROM users WHERE id = $1 FOR UPDATE",
        caller.user_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(user) = user else {
        // The account vanished under a valid token; nothing to change.
        return Err(AuthError::InvalidCredentials);
    };
    if !password::verify(&old_verifier, &user.pw_hash)? {
        return Err(AuthError::WrongPassword);
    }

    let pw_hash = password::hash_verifier(&new_verifier)?;
    sqlx::query!(
        "UPDATE users SET pw_salt = $2, pw_hash = $3 WHERE id = $1",
        caller.user_id,
        &new_salt[..],
        pw_hash
    )
    .execute(&mut *tx)
    .await?;

    // Changing a password is what someone does when they suspect the old one
    // is known. Every session on any *other* device dies with it; the caller's
    // own survives, having just proven it knows the new password's provenance.
    // (v0.1 is one device per account, so "other device" here means a stale or
    // stolen session — exactly the thing to kill.)
    sqlx::query!(
        "UPDATE refresh_tokens SET revoked_at = now()
         WHERE user_id = $1 AND device_id IS DISTINCT FROM $2 AND revoked_at IS NULL",
        caller.user_id,
        caller.device_id
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    tracing::info!(user_id = caller.user_id, "password changed");
    Ok(StatusCode::NO_CONTENT)
}

// --------------------------------------------------------------- shared ----

async fn issue_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    state: &AppState,
    user_id: i64,
    device_id: Uuid,
) -> Result<Session, AuthError> {
    let access_token = state.auth.issue_access_token(user_id, device_id)?;
    let refresh_token = tokens::new_refresh_token();

    sqlx::query!(
        "INSERT INTO refresh_tokens (user_id, device_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4))",
        user_id,
        device_id,
        &refresh_token.hash[..],
        tokens::REFRESH_TOKEN_TTL_DAYS
    )
    .execute(&mut **tx)
    .await?;

    Ok(Session {
        access_token,
        refresh_token: refresh_token.secret,
        expires_in: tokens::ACCESS_TOKEN_TTL_SECS,
        user_id,
        device_id,
    })
}

/// BRIEF 4.1: 3–20 characters, `[a-z0-9_]`.
fn validate_handle(handle: &str) -> Result<(), AuthError> {
    let bad = |m: &str| AuthError::Invalid(m.to_string());
    if handle.len() < HANDLE_MIN || handle.len() > HANDLE_MAX {
        return Err(bad(&format!(
            "Handle must be between {HANDLE_MIN} and {HANDLE_MAX} characters."
        )));
    }
    if !handle
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(bad(
            "Handle may contain only lowercase letters, digits and underscores.",
        ));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(b & 0x0F), 16).unwrap());
    }
    out
}

/// What deleting an account asks for.
#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    /// Hex of the current password's verifier.
    ///
    /// The same reasoning as change-password, with more resting on it: a
    /// bearer token is possession of a session, not knowledge of the password,
    /// and an unattended unlocked machine must not be enough to destroy an
    /// account that has no recovery. Nothing here is reversible afterwards.
    pub pw_verifier: String,
}

/// Deletes the account and everything the server holds for it.
///
/// # Why the deletes are written out rather than left to the schema
///
/// Most tables cascade from `users`, but **`devices` deliberately does not** —
/// it references `users(id)` with no `ON DELETE` clause, so a stray delete of
/// a user cannot silently take a device, its published KeyPackages and every
/// envelope it ever sent. That is a good default and this route does not
/// change it; it deletes devices on purpose, in an order it states, so the
/// destruction is legible at the one place that means to do it.
///
/// What goes, in order:
///
/// 1. **Devices**, and with them the account's KeyPackages and every envelope
///    it sent that the server still holds. Ciphertext nobody has synced yet is
///    included, so a message sent minutes ago may never arrive. The UI says
///    so; it is the one consequence people do not expect.
/// 2. **The user row**, and with it posts, comments, reactions, votes, blocks,
///    profile fields and their visibility, invitations and the uses recorded
///    against them, reports, refresh tokens, and conversation membership.
/// 3. **Conversations left with nobody in them.** Bounded to the ones this
///    account was in: a two-person conversation whose other member is gone is
///    unreachable for anyone, and leaving it would be the first orphan row in
///    a schema that has none.
///
/// What does not go, and cannot: messages already delivered to other people.
/// They are on those machines, and the server never had the keys.
async fn delete_account(
    State(state): State<AppState>,
    caller: Caller,
    Json(request): Json<DeleteAccountRequest>,
) -> Result<StatusCode, AuthError> {
    let verifier = unhex(&request.pw_verifier, "pw_verifier")?;

    let mut tx = state.db.begin().await?;

    // FOR UPDATE for the same reason change-password takes it: the verify and
    // the write must not straddle another change to this row.
    let user = sqlx::query!(
        "SELECT pw_hash FROM users WHERE id = $1 FOR UPDATE",
        caller.user_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(user) = user else {
        // The account vanished under a valid token; nothing left to delete.
        return Err(AuthError::InvalidCredentials);
    };
    if !password::verify(&verifier, &user.pw_hash)? {
        return Err(AuthError::WrongPassword);
    }

    // Noted before the membership rows go, because afterwards there is nothing
    // left to say which conversations this account was in.
    let conversations: Vec<Uuid> = sqlx::query_scalar!(
        "SELECT conversation_id FROM conversation_members WHERE user_id = $1",
        caller.user_id
    )
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query!("DELETE FROM devices WHERE user_id = $1", caller.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query!("DELETE FROM users WHERE id = $1", caller.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query!(
        "DELETE FROM conversations c
         WHERE c.id = ANY($1)
           AND NOT EXISTS (
               SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id
           )",
        &conversations[..]
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    tracing::info!("account deleted");
    Ok(StatusCode::NO_CONTENT)
}

fn unhex(s: &str, field: &str) -> Result<Vec<u8>, AuthError> {
    if !s.len().is_multiple_of(2) {
        return Err(AuthError::Invalid(format!("{field} must be hex.")));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| AuthError::Invalid(format!("{field} must be hex.")))
}

/// Pool type alias kept so callers do not need sqlx in scope.
pub type Db = PgPool;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_follow_the_brief() {
        assert!(validate_handle("alice").is_ok());
        assert!(validate_handle("a_1").is_ok());
        assert!(validate_handle("abcdefghijklmnopqrst").is_ok()); // exactly 20

        assert!(validate_handle("ab").is_err()); // too short
        assert!(validate_handle("abcdefghijklmnopqrstu").is_err()); // 21
        assert!(validate_handle("Alice").is_err()); // uppercase
        assert!(validate_handle("al ice").is_err()); // space
        assert!(validate_handle("al-ice").is_err()); // hyphen
        assert!(validate_handle("alice!").is_err());
        assert!(validate_handle("älice").is_err()); // non-ascii
    }

    #[test]
    fn hex_round_trips() {
        let bytes = vec![0x00, 0x0f, 0xa5, 0xff];
        assert_eq!(hex(&bytes), "000fa5ff");
        assert_eq!(unhex("000fa5ff", "x").unwrap(), bytes);
    }

    #[test]
    fn bad_hex_is_rejected_rather_than_truncated() {
        assert!(unhex("abc", "x").is_err()); // odd length
        assert!(unhex("zz", "x").is_err()); // not hex
    }
}
