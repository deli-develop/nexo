//! The HTTP implementation of [`Transport`].
//!
//! Behind the `http` feature, so the rest of this crate stays free of a network
//! stack and an Android shell can bring its own if it ever wants to. The
//! desktop enables it.
//!
//! # Where the base URL comes from
//!
//! Compiled in, per `docs/TUTORIAL.md` 6 — a Tauri client ships whatever you
//! put in it, so an "environment variable" in a desktop binary is just a string
//! the user can read. `NEXO_API_BASE` overrides it in **debug builds only**, so
//! a development build can be pointed at `http://127.0.0.1:8080` without
//! creating a way to redirect a shipped client at someone else's server.
//!
//! # Why status codes are not errors here
//!
//! The agent is configured with `http_status_as_error(false)`, so a 4xx comes
//! back as an ordinary response. That is not laxity: the server puts
//! `current_epoch` in the body of a 409, and a transport that turned the status
//! into an error before reading the body would throw that away and force the
//! client to resync from its own cursor — correct, but a round trip slower for
//! no reason.

use std::sync::{Mutex, RwLock};
use std::time::Duration;

use serde::Deserialize;
use ureq::Agent;

use crate::feed::{
    Comment, FeedApi, FeedPage, FollowState, MyProfile, NewPost, Post, Profile, ProfileEdit,
    ReactionCount, VoteResult,
};
use crate::transport::{
    Accepted, ClaimedKeyPackage, ConversationSummary, Envelope, InviteSummary, MintedInvite,
    SaltResponse, SearchResult, SessionTokens, StorySummary, Transport, TransportError,
};

/// Where a release build talks to.
pub const DEFAULT_BASE_URL: &str = "https://api.delidev.net";

/// How long to wait before giving up on the server.
const TIMEOUT: Duration = Duration::from_secs(20);

/// A [`Transport`] over HTTPS.
pub struct HttpTransport {
    agent: Agent,
    base_url: String,
    /// Held here rather than passed to every call. A token threaded through
    /// each signature is a token that one of them eventually logs.
    access_token: RwLock<Option<String>>,
    /// The refresh token, so an expired access token can be replaced without
    /// asking anyone for their password.
    ///
    /// An access token lives fifteen minutes and expires on the clock, not on
    /// idleness. Without this the app simply stopped working a quarter of an
    /// hour after signing in: every request came back 401, the feed emptied,
    /// sync stopped, and nothing said why — it looked like the session had been
    /// locked when it had only aged.
    refresh_token: RwLock<Option<String>>,
    /// Serialises refreshing.
    ///
    /// Refresh tokens rotate, and the server treats a second use of a spent one
    /// as theft: it revokes every session for the account. Two requests that
    /// both meet a 401 would do exactly that, so only one may refresh and the
    /// other waits and takes the result.
    refreshing: Mutex<()>,
    /// The most recently issued refresh token, waiting to be written down.
    ///
    /// A rotated token that never reaches the encrypted store is worse than no
    /// refresh at all: the next launch replays the spent one, the server reads
    /// that as theft, and every session for the account is revoked. The shell
    /// drains this after each call — it owns the store, and the transport must
    /// not.
    rotated: RwLock<Option<String>>,
}

impl std::fmt::Debug for HttpTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The base URL is not a secret. The token is.
        f.debug_struct("HttpTransport")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl Default for HttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

/// Percent-encode anything that is not safe unescaped in a query value.
///
/// Handles are the only thing passed here and are in practice plain, but
/// "in practice" is not a guarantee the server makes, and a dependency for one
/// call site is worse than eight lines (rule 8: every dependency is a decision).
fn query_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

impl HttpTransport {
    /// A transport pointed at the compiled-in base URL, or at `NEXO_API_BASE`
    /// in a debug build.
    pub fn new() -> Self {
        let base_url = if cfg!(debug_assertions) {
            std::env::var("NEXO_API_BASE").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
        } else {
            DEFAULT_BASE_URL.to_string()
        };
        Self::with_base_url(base_url)
    }

    /// A transport pointed somewhere explicit. Tests use this.
    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        let agent: Agent = Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        Self {
            agent,
            base_url: base_url.into().trim_end_matches('/').to_string(),
            access_token: RwLock::new(None),
            refresh_token: RwLock::new(None),
            refreshing: Mutex::new(()),
            rotated: RwLock::new(None),
        }
    }

    /// The server this transport talks to. Safe to show — it is not a secret.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn bearer(&self) -> Result<String, TransportError> {
        self.access_token
            .read()
            .ok()
            .and_then(|slot| slot.clone())
            .ok_or(TransportError::InvalidCredentials)
    }

    /// Sends a request and turns the outcome into either a value or an honest
    /// error.
    ///
    /// One place decides what a status means, so the meaning cannot drift
    /// between call sites.
    fn finish<R: for<'de> Deserialize<'de>>(
        result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<R, TransportError> {
        let mut response = match result {
            Ok(response) => response,
            Err(e) => return Err(TransportError::Unreachable(e.to_string())),
        };

        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            // 204 has no body; anything expecting `()` deserialises from null.
            let text = response.body_mut().read_to_string().unwrap_or_default();
            if text.trim().is_empty() {
                return serde_json::from_str("null").map_err(|e| {
                    TransportError::Rejected(format!("expected a body, got none: {e}"))
                });
            }
            return serde_json::from_str(&text)
                .map_err(|e| TransportError::Rejected(format!("unreadable response: {e}")));
        }

        // Read the body *before* deciding, because the server puts the useful
        // part of a refusal in it.
        let text = response.body_mut().read_to_string().unwrap_or_default();
        Err(classify(status, &text))
    }

    /// Remembers the refresh token, so an aged access token can be replaced.
    pub fn set_refresh_token(&self, token: &str) {
        if let Ok(mut slot) = self.refresh_token.write() {
            *slot = Some(token.to_string());
        }
    }

    /// Takes the newly issued refresh token, if one was issued since the last
    /// call. The caller is expected to write it to the encrypted store.
    pub fn take_rotated_refresh_token(&self) -> Option<String> {
        self.rotated.write().ok().and_then(|mut slot| slot.take())
    }

    /// Trades the refresh token for a fresh pair.
    ///
    /// Returns whether anything changed. Only one caller refreshes at a time:
    /// the token rotates, and spending a rotated one is what the server reads
    /// as theft. Whoever loses the race re-reads the access token afterwards
    /// and finds the new one already in place.
    fn refresh_access(&self, stale: Option<String>) -> bool {
        let _serialised = match self.refreshing.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        // Somebody else refreshed while this thread waited for the lock. Their
        // new token is already here, so retrying with it is enough.
        let current = self.access_token.read().ok().and_then(|t| t.clone());
        if current != stale {
            return true;
        }

        let Some(refresh) = self.refresh_token.read().ok().and_then(|t| t.clone()) else {
            return false;
        };

        let Ok(tokens) = self.refresh(&refresh) else {
            return false;
        };

        self.set_access_token(&tokens.access_token);
        self.set_refresh_token(&tokens.refresh_token);
        if let Ok(mut slot) = self.rotated.write() {
            *slot = Some(tokens.refresh_token.clone());
        }
        true
    }

    /// Runs an authenticated request, refreshing once if the token has aged.
    ///
    /// One retry, never a loop: a 401 that survives a fresh token is a real
    /// refusal, and retrying it again would only spend another refresh.
    fn with_refresh<R, F>(&self, send: F) -> Result<R, TransportError>
    where
        F: Fn(&str) -> Result<R, TransportError>,
    {
        let token = self.bearer()?;
        match send(&token) {
            Err(TransportError::InvalidCredentials) => {
                if !self.refresh_access(Some(token)) {
                    return Err(TransportError::InvalidCredentials);
                }
                let token = self.bearer()?;
                send(&token)
            }
            other => other,
        }
    }

    fn get_auth<R: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<R, TransportError> {
        self.with_refresh(|token| {
            Self::finish(
                self.agent
                    .get(&format!("{}{path}", self.base_url))
                    .header("authorization", &format!("Bearer {token}"))
                    .call(),
            )
        })
    }

    fn post_auth<B: serde::Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<R, TransportError> {
        self.with_refresh(|token| {
            Self::finish(
                self.agent
                    .post(&format!("{}{path}", self.base_url))
                    .header("authorization", &format!("Bearer {token}"))
                    .send_json(body),
            )
        })
    }

    fn delete_auth(&self, path: &str) -> Result<(), TransportError> {
        self.with_refresh(|token| {
            Self::finish::<()>(
                self.agent
                    .delete(&format!("{}{path}", self.base_url))
                    .header("authorization", &format!("Bearer {token}"))
                    .call(),
            )
        })
    }

    fn patch_auth<B: serde::Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<R, TransportError> {
        self.with_refresh(|token| {
            Self::finish(
                self.agent
                    .patch(&format!("{}{path}", self.base_url))
                    .header("authorization", &format!("Bearer {token}"))
                    .send_json(body),
            )
        })
    }

    fn post<B: serde::Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<R, TransportError> {
        Self::finish(
            self.agent
                .post(&format!("{}{path}", self.base_url))
                .send_json(body),
        )
    }
}

/// The one place that decides what a refusal means.
///
/// A 409 is `handle_taken` on the auth routes and `stale_epoch` on send, so the
/// body's `error` field decides rather than the status alone. Guessing from the
/// status would tell a user their handle was taken when in fact two commits
/// raced.
fn classify(status: u16, body: &str) -> TransportError {
    #[derive(Deserialize, Default)]
    struct Refusal {
        #[serde(default)]
        error: String,
        #[serde(default)]
        message: String,
        #[serde(default)]
        current_epoch: Option<i64>,
    }

    let refusal: Refusal = serde_json::from_str(body).unwrap_or_default();

    match (status, refusal.error.as_str()) {
        (409, "stale_epoch") => TransportError::StaleEpoch {
            // If the server did not say, -1 means "resync from your own
            // cursor" — correct, just one round trip slower.
            current: refusal.current_epoch.unwrap_or(-1),
        },
        (409, _) => TransportError::HandleTaken,
        (403, "wrong_password") => TransportError::WrongPassword,
        (401, _) => TransportError::InvalidCredentials,
        (404, _) => TransportError::NotFound,
        _ => TransportError::Rejected(if refusal.message.is_empty() {
            format!("the server returned {status}")
        } else {
            refusal.message
        }),
    }
}

#[derive(serde::Serialize)]
struct SaltBody<'a> {
    handle: &'a str,
}

#[derive(serde::Serialize)]
struct RegisterBody<'a> {
    handle: &'a str,
    display_name: &'a str,
    pw_salt: &'a str,
    pw_verifier: &'a str,
    identity_pubkey: &'a str,
}

#[derive(serde::Serialize)]
struct LoginBody<'a> {
    handle: &'a str,
    pw_verifier: &'a str,
    identity_pubkey: &'a str,
}

#[derive(serde::Serialize)]
struct RefreshBody<'a> {
    refresh_token: &'a str,
}

#[derive(serde::Serialize)]
struct ChangePasswordBody<'a> {
    pw_verifier: &'a str,
    new_pw_salt: &'a str,
    new_pw_verifier: &'a str,
}

#[derive(serde::Serialize)]
struct DeleteAccountBody<'a> {
    pw_verifier: &'a str,
}

impl Transport for HttpTransport {
    fn salt(&self, handle: &str) -> Result<SaltResponse, TransportError> {
        self.post("/v1/auth/salt", &SaltBody { handle })
    }

    fn register(
        &self,
        handle: &str,
        display_name: &str,
        pw_salt_hex: &str,
        pw_verifier_hex: &str,
        identity_pubkey_hex: &str,
    ) -> Result<SessionTokens, TransportError> {
        self.post(
            "/v1/auth/register",
            &RegisterBody {
                handle,
                display_name,
                pw_salt: pw_salt_hex,
                pw_verifier: pw_verifier_hex,
                identity_pubkey: identity_pubkey_hex,
            },
        )
    }

    fn login(
        &self,
        handle: &str,
        pw_verifier_hex: &str,
        identity_pubkey_hex: &str,
    ) -> Result<SessionTokens, TransportError> {
        self.post(
            "/v1/auth/login",
            &LoginBody {
                handle,
                pw_verifier: pw_verifier_hex,
                identity_pubkey: identity_pubkey_hex,
            },
        )
    }

    fn refresh(&self, refresh_token: &str) -> Result<SessionTokens, TransportError> {
        self.post("/v1/auth/refresh", &RefreshBody { refresh_token })
    }

    fn logout(&self, refresh_token: &str) -> Result<(), TransportError> {
        let _: serde_json::Value = self.post("/v1/auth/logout", &RefreshBody { refresh_token })?;
        Ok(())
    }

    fn change_password(
        &self,
        old_verifier: &str,
        new_salt: &str,
        new_verifier: &str,
    ) -> Result<(), TransportError> {
        let _: serde_json::Value = self.post_auth(
            "/v1/auth/change-password",
            &ChangePasswordBody {
                pw_verifier: old_verifier,
                new_pw_salt: new_salt,
                new_pw_verifier: new_verifier,
            },
        )?;
        Ok(())
    }

    fn delete_account(&self, pw_verifier: &str) -> Result<(), TransportError> {
        let _: serde_json::Value = self.post_auth(
            "/v1/auth/delete-account",
            &DeleteAccountBody { pw_verifier },
        )?;
        Ok(())
    }

    fn set_access_token(&self, token: &str) {
        if let Ok(mut slot) = self.access_token.write() {
            *slot = Some(token.to_string());
        }
    }

    fn publish_key_packages(&self, key_packages: &[String]) -> Result<(), TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            key_packages: &'a [String],
        }
        let _: serde_json::Value = self.post_auth("/v1/keypackages", &Body { key_packages })?;
        Ok(())
    }

    fn key_package_count(&self) -> Result<(i64, i64), TransportError> {
        #[derive(Deserialize)]
        struct Body {
            remaining: i64,
            refill_below: i64,
        }
        let body: Body = self.get_auth("/v1/keypackages/count")?;
        Ok((body.remaining, body.refill_below))
    }

    fn claim_key_package(&self, handle: &str) -> Result<ClaimedKeyPackage, TransportError> {
        self.get_auth(&format!("/v1/keypackages/{handle}"))
    }

    fn create_conversation(
        &self,
        conversation_id: &str,
        members: &[String],
    ) -> Result<String, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            conversation_id: &'a str,
            members: &'a [String],
        }
        #[derive(serde::Deserialize)]
        struct Created {
            conversation_id: String,
        }
        let created: Created = self.post_auth(
            "/v1/conversations",
            &Body {
                conversation_id,
                members,
            },
        )?;
        Ok(created.conversation_id)
    }

    fn discard_conversation(&self, conversation_id: &str) -> Result<(), TransportError> {
        self.delete_auth(&format!("/v1/conversations/{conversation_id}"))
    }

    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, TransportError> {
        self.get_auth("/v1/conversations")
    }

    fn send(
        &self,
        conversation_id: &str,
        ciphertext_hex: &str,
        epoch: i64,
        is_commit: bool,
        client_msg_id: &str,
    ) -> Result<Accepted, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            ciphertext: &'a str,
            epoch: i64,
            is_commit: bool,
            client_msg_id: &'a str,
        }
        self.post_auth(
            &format!("/v1/conversations/{conversation_id}/send"),
            &Body {
                ciphertext: ciphertext_hex,
                epoch,
                is_commit,
                client_msg_id,
            },
        )
    }

    fn add_member(&self, conversation_id: &str, handle: &str) -> Result<(), TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            handle: &'a str,
        }
        let _: serde_json::Value = self.post_auth(
            &format!("/v1/conversations/{conversation_id}/members"),
            &Body { handle },
        )?;
        Ok(())
    }

    fn remove_member(&self, conversation_id: &str, handle: &str) -> Result<(), TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            handle: &'a str,
        }
        let _: serde_json::Value = self.post_auth(
            &format!("/v1/conversations/{conversation_id}/members/remove"),
            &Body { handle },
        )?;
        Ok(())
    }

    fn upload_url(
        &self,
        conversation_id: &str,
        size: u64,
    ) -> Result<(String, String), TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            bucket: &'a str,
            conversation_id: &'a str,
            size: u64,
        }
        #[derive(Deserialize)]
        struct Reply {
            url: String,
            key: String,
        }
        let reply: Reply = self.post_auth(
            "/v1/media/upload",
            &Body {
                bucket: "encrypted",
                conversation_id,
                size,
            },
        )?;
        Ok((reply.url, reply.key))
    }

    fn story_upload_url(&self, size: u64) -> Result<(String, String), TransportError> {
        #[derive(serde::Serialize)]
        struct Body {
            bucket: &'static str,
            size: u64,
        }
        #[derive(Deserialize)]
        struct Reply {
            url: String,
            key: String,
        }
        // No conversation: a story has none, and the server mints the key
        // under `story/` so the caller cannot choose where it writes.
        let reply: Reply = self.post_auth(
            "/v1/media/upload",
            &Body {
                bucket: "story",
                size,
            },
        )?;
        Ok((reply.url, reply.key))
    }

    fn download_url(&self, key: &str) -> Result<String, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            bucket: &'a str,
            key: &'a str,
        }
        #[derive(Deserialize)]
        struct Reply {
            url: String,
        }
        let reply: Reply = self.post_auth(
            "/v1/media/download",
            &Body {
                bucket: "encrypted",
                key,
            },
        )?;
        Ok(reply.url)
    }

    fn put_object(&self, url: &str, bytes: Vec<u8>) -> Result<(), TransportError> {
        // No Authorization header: a presigned URL carries its own permission,
        // and adding a bearer token would be sending our access token to the
        // storage provider for no reason.
        match self
            .agent
            .put(url)
            .header("content-type", "application/octet-stream")
            .send(&bytes[..])
        {
            Ok(response) => {
                let status = response.status().as_u16();
                if (200..300).contains(&status) {
                    Ok(())
                } else {
                    Err(TransportError::Rejected(format!(
                        "the storage provider returned {status}"
                    )))
                }
            }
            Err(e) => Err(TransportError::Unreachable(e.to_string())),
        }
    }

    fn get_object(&self, url: &str) -> Result<Vec<u8>, TransportError> {
        match self.agent.get(url).call() {
            Ok(mut response) => {
                let status = response.status().as_u16();
                if !(200..300).contains(&status) {
                    return Err(TransportError::Rejected(format!(
                        "the storage provider returned {status}"
                    )));
                }
                response
                    .body_mut()
                    .with_config()
                    // The server caps uploads well below this; the ceiling here
                    // exists so a hostile or broken response cannot be read
                    // into memory without bound.
                    .limit(32 * 1024 * 1024)
                    .read_to_vec()
                    .map_err(|e| TransportError::Rejected(format!("reading the object: {e}")))
            }
            Err(e) => Err(TransportError::Unreachable(e.to_string())),
        }
    }

    fn get_object_range(&self, url: &str, from: u64, to: u64) -> Result<Vec<u8>, TransportError> {
        // A real `Range` request, which is the whole point: opening one
        // segment of a large video should move one segment.
        //
        // 206 is the success we want. A store that ignores the header answers
        // 200 with the whole object, and that is handled rather than trusted --
        // the slice below is applied either way, so a server that does not
        // support ranges is slow instead of wrong.
        match self
            .agent
            .get(url)
            .header("Range", format!("bytes={from}-{to}"))
            .call()
        {
            Ok(mut response) => {
                let status = response.status().as_u16();
                if !(200..300).contains(&status) {
                    return Err(TransportError::Rejected(format!(
                        "the storage provider returned {status}"
                    )));
                }
                let partial = status == 206;
                let bytes = response
                    .body_mut()
                    .with_config()
                    .limit(32 * 1024 * 1024)
                    .read_to_vec()
                    .map_err(|e| TransportError::Rejected(format!("reading the object: {e}")))?;
                if partial {
                    return Ok(bytes);
                }
                let start = (from as usize).min(bytes.len());
                let stop = (to as usize).saturating_add(1).min(bytes.len());
                Ok(bytes.get(start..stop).unwrap_or_default().to_vec())
            }
            Err(e) => Err(TransportError::Unreachable(e.to_string())),
        }
    }

    fn sync(&self, conversation_id: &str, since_id: i64) -> Result<Vec<Envelope>, TransportError> {
        self.get_auth(&format!(
            "/v1/conversations/{conversation_id}/sync?since_id={since_id}"
        ))
    }

    fn create_story(&self, s3_key: &str, size: i64) -> Result<StorySummary, TransportError> {
        self.post_auth(
            "/v1/stories",
            &serde_json::json!({ "s3_key": s3_key, "size": size }),
        )
    }

    fn story_url(&self, id: i64) -> Result<String, TransportError> {
        #[derive(serde::Deserialize)]
        struct Url {
            url: String,
        }
        let answer: Url = self.post_auth(&format!("/v1/stories/{id}/url"), &())?;
        Ok(answer.url)
    }

    fn list_stories(&self) -> Result<Vec<StorySummary>, TransportError> {
        self.get_auth("/v1/stories")
    }

    // --------------------------------------------------------------- people ---

    fn search_users(&self, term: &str) -> Result<Vec<SearchResult>, TransportError> {
        self.get_auth(&format!("/v1/users?q={}", query_escape(term)))
    }

    fn create_invite(
        &self,
        label: Option<&str>,
        days: i64,
    ) -> Result<MintedInvite, TransportError> {
        self.post_auth(
            "/v1/invites",
            &serde_json::json!({ "label": label, "days": days }),
        )
    }

    fn list_invites(&self) -> Result<Vec<InviteSummary>, TransportError> {
        self.get_auth("/v1/invites")
    }

    fn revoke_invite(&self, id: i64) -> Result<(), TransportError> {
        self.delete_auth(&format!("/v1/invites/{id}"))
    }

    fn report(
        &self,
        subject_kind: &str,
        subject_id: i64,
        reason: &str,
        note: Option<&str>,
    ) -> Result<(), TransportError> {
        self.post_auth(
            "/v1/reports",
            &serde_json::json!({
                "subject_kind": subject_kind,
                "subject_id": subject_id,
                "reason": reason,
                "note": note,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trailing_slash_does_not_produce_a_double_slash() {
        let t = HttpTransport::with_base_url("https://api.delidev.net/");
        assert_eq!(t.base_url(), "https://api.delidev.net");
    }

    #[test]
    fn the_release_default_is_the_real_api() {
        assert_eq!(DEFAULT_BASE_URL, "https://api.delidev.net");
        assert!(DEFAULT_BASE_URL.starts_with("https://"));
    }

    /// A 409 means two different things depending on the route, so the body
    /// decides. Guessing from the status alone would tell someone their handle
    /// was taken when in fact two commits raced.
    #[test]
    fn conflict_is_disambiguated_by_the_body() {
        assert!(matches!(
            classify(409, r#"{"error":"stale_epoch","current_epoch":4}"#),
            TransportError::StaleEpoch { current: 4 }
        ));
        assert!(matches!(
            classify(409, r#"{"error":"handle_taken"}"#),
            TransportError::HandleTaken
        ));
    }

    #[test]
    fn a_stale_epoch_without_a_hint_still_reports_stale() {
        // -1 means "resync from your own cursor": correct, one round trip
        // slower, and never mistaken for a real epoch.
        assert!(matches!(
            classify(409, r#"{"error":"stale_epoch"}"#),
            TransportError::StaleEpoch { current: -1 }
        ));
    }

    #[test]
    fn unauthorized_is_credentials_whatever_the_body_says() {
        assert!(matches!(
            classify(401, ""),
            TransportError::InvalidCredentials
        ));
    }

    #[test]
    fn an_unparseable_refusal_still_produces_an_error() {
        // A proxy returning HTML must not panic the client.
        assert!(matches!(
            classify(502, "<html>bad gateway</html>"),
            TransportError::Rejected(_)
        ));
    }

    #[test]
    fn a_server_message_is_preferred_over_a_generic_one() {
        match classify(
            400,
            r#"{"error":"invalid_request","message":"Empty ciphertext."}"#,
        ) {
            TransportError::Rejected(message) => assert_eq!(message, "Empty ciphertext."),
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[test]
    fn an_unreachable_server_is_not_reported_as_bad_credentials() {
        // Port 1 has nothing on it. A connection failure must not tell the user
        // their password is wrong.
        let t = HttpTransport::with_base_url("http://127.0.0.1:1");
        let error = t.salt("alice").unwrap_err();
        assert!(
            matches!(error, TransportError::Unreachable(_)),
            "got {error:?}"
        );
    }

    #[test]
    fn a_call_without_a_token_does_not_reach_the_network() {
        // Otherwise an unauthenticated call looks like a server problem.
        let t = HttpTransport::with_base_url("http://127.0.0.1:1");
        assert!(matches!(
            t.key_package_count().unwrap_err(),
            TransportError::InvalidCredentials
        ));
    }
}

/// The feed and profile API over HTTP.
///
/// None of this is encrypted, and none of it touches MLS. See `feed.rs` for
/// why it is a separate trait rather than more methods on `Transport`.
impl FeedApi for HttpTransport {
    fn feed(
        &self,
        before: Option<i64>,
        limit: Option<i64>,
        sort: Option<&str>,
        following: bool,
    ) -> Result<FeedPage, TransportError> {
        let mut path = paged("/v1/feed", before, limit);
        if let Some(sort) = sort {
            path.push(if path.contains('?') { '&' } else { '?' });
            path.push_str("sort=");
            path.push_str(sort);
        }
        // Only sent when it is on: the parameter's absence is what the server
        // reads as "everybody", and sending `following=false` everywhere would
        // put a flag in every request that means what leaving it out means.
        if following {
            path.push(if path.contains('?') { '&' } else { '?' });
            path.push_str("following=true");
        }
        self.get_auth(&path)
    }

    fn set_following(&self, handle: &str, follow: bool) -> Result<(), TransportError> {
        // Escaped, not interpolated -- the same reason `posts_by` gives: a
        // handle is `[a-z0-9_]` today and this must not silently become an
        // injection point if that ever widens.
        let path = format!("/v1/users/{}/follow", escape(handle));
        if follow {
            // The route takes no body; `send_json(&())` is how this client
            // sends an empty one everywhere else.
            self.post_auth::<(), serde_json::Value>(&path, &())
                .map(|_| ())
        } else {
            self.delete_auth(&path)
        }
    }

    fn follow_state(&self, handle: &str) -> Result<FollowState, TransportError> {
        self.get_auth(&format!("/v1/users/{}/follow-state", escape(handle)))
    }

    fn posts_by(
        &self,
        handle: &str,
        before: Option<i64>,
        limit: Option<i64>,
    ) -> Result<FeedPage, TransportError> {
        // The handle came from a profile the server itself returned, but it
        // still goes into a path segment, so it is escaped rather than
        // interpolated -- a handle is `[a-z0-9_]` today and this should not
        // silently become an injection point if that ever widens.
        let path = format!("/v1/users/{}/posts", escape(handle));
        self.get_auth(&paged(&path, before, limit))
    }

    fn create_post(&self, new: &NewPost) -> Result<Post, TransportError> {
        self.post_auth("/v1/posts", new)
    }

    fn delete_post(&self, id: i64) -> Result<(), TransportError> {
        let token = self.bearer()?;
        let _: serde_json::Value = Self::finish(
            self.agent
                .delete(&format!("{}/v1/posts/{id}", self.base_url))
                .header("authorization", &format!("Bearer {token}"))
                .call(),
        )?;
        Ok(())
    }

    fn react(&self, id: i64, emoji: &str, on: bool) -> Result<Vec<ReactionCount>, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            emoji: &'a str,
            on: bool,
        }
        self.post_auth(&format!("/v1/posts/{id}/react"), &Body { emoji, on })
    }

    fn vote(&self, id: i64, value: i16) -> Result<VoteResult, TransportError> {
        #[derive(serde::Serialize)]
        struct Body {
            value: i16,
        }
        self.post_auth(&format!("/v1/posts/{id}/vote"), &Body { value })
    }

    fn comments(&self, post_id: i64) -> Result<Vec<Comment>, TransportError> {
        self.get_auth(&format!("/v1/posts/{post_id}/comments"))
    }

    fn add_comment(
        &self,
        post_id: i64,
        body: &str,
        parent_id: Option<i64>,
    ) -> Result<Comment, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            body: &'a str,
            parent_id: Option<i64>,
        }
        self.post_auth(
            &format!("/v1/posts/{post_id}/comments"),
            &Body { body, parent_id },
        )
    }

    fn delete_comment(&self, id: i64) -> Result<(), TransportError> {
        let token = self.bearer()?;
        let _: serde_json::Value = Self::finish(
            self.agent
                .delete(&format!("{}/v1/comments/{id}", self.base_url))
                .header("authorization", &format!("Bearer {token}"))
                .call(),
        )?;
        Ok(())
    }

    fn profile(&self, handle: &str) -> Result<Profile, TransportError> {
        self.get_auth(&format!("/v1/users/{}", escape(handle)))
    }

    fn my_profile(&self) -> Result<MyProfile, TransportError> {
        self.get_auth("/v1/me")
    }

    fn update_profile(&self, edit: &ProfileEdit) -> Result<MyProfile, TransportError> {
        self.patch_auth("/v1/me", edit)
    }

    fn update_visibility(
        &self,
        visibility: &std::collections::BTreeMap<String, String>,
    ) -> Result<MyProfile, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            visibility: &'a std::collections::BTreeMap<String, String>,
        }
        self.patch_auth("/v1/me/visibility", &Body { visibility })
    }

    fn pin_post(&self, id: i64) -> Result<(), TransportError> {
        let _: serde_json::Value = self.post_auth(&format!("/v1/posts/{id}/pin"), &())?;
        Ok(())
    }

    fn unpin_post(&self, id: i64) -> Result<(), TransportError> {
        let token = self.bearer()?;
        let _: serde_json::Value = Self::finish(
            self.agent
                .delete(&format!("{}/v1/posts/{id}/pin", self.base_url))
                .header("authorization", &format!("Bearer {token}"))
                .call(),
        )?;
        Ok(())
    }

    fn blocks(&self) -> Result<Vec<crate::feed::Block>, TransportError> {
        self.get_auth("/v1/blocks")
    }

    fn block(&self, handle: &str) -> Result<(), TransportError> {
        // An empty object rather than no body: `post_auth` sends JSON, and a
        // route that takes nothing still has to be given something to send.
        let _: serde_json::Value =
            self.post_auth(&format!("/v1/blocks/{}", escape(handle)), &())?;
        Ok(())
    }

    fn unblock(&self, handle: &str) -> Result<(), TransportError> {
        let token = self.bearer()?;
        let _: serde_json::Value = Self::finish(
            self.agent
                .delete(&format!("{}/v1/blocks/{}", self.base_url, escape(handle)))
                .header("authorization", &format!("Bearer {token}"))
                .call(),
        )?;
        Ok(())
    }

    fn media_upload_url(&self, size: u64) -> Result<(String, String), TransportError> {
        #[derive(serde::Serialize)]
        struct Body {
            bucket: &'static str,
            size: u64,
        }
        #[derive(Deserialize)]
        struct Reply {
            url: String,
            key: String,
        }
        let reply: Reply = self.post_auth(
            "/v1/media/upload",
            &Body {
                bucket: "media",
                size,
            },
        )?;
        Ok((reply.url, reply.key))
    }

    fn media_download_url(&self, key: &str) -> Result<String, TransportError> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            bucket: &'static str,
            key: &'a str,
        }
        #[derive(Deserialize)]
        struct Reply {
            url: String,
        }
        let reply: Reply = self.post_auth(
            "/v1/media/download",
            &Body {
                bucket: "media",
                key,
            },
        )?;
        Ok(reply.url)
    }
}

/// Appends cursor and limit to a path, omitting either when absent.
fn paged(path: &str, before: Option<i64>, limit: Option<i64>) -> String {
    let mut query = Vec::new();
    if let Some(before) = before {
        query.push(format!("before={before}"));
    }
    if let Some(limit) = limit {
        query.push(format!("limit={limit}"));
    }
    if query.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", query.join("&"))
    }
}

/// Percent-encodes a path segment.
///
/// Minimal on purpose: handles are `[a-z0-9_]{3,20}`, so in practice nothing is
/// ever escaped. It exists so that a path is built by a function that knows it
/// is building a path, rather than by string interpolation that happens to be
/// safe today.
fn escape(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod feed_tests {
    use super::*;

    #[test]
    fn a_page_without_a_cursor_has_no_query_string() {
        assert_eq!(paged("/v1/feed", None, None), "/v1/feed");
    }

    #[test]
    fn a_cursor_and_a_limit_both_appear() {
        assert_eq!(paged("/v1/feed", Some(7), None), "/v1/feed?before=7");
        assert_eq!(paged("/v1/feed", None, Some(5)), "/v1/feed?limit=5");
        assert_eq!(
            paged("/v1/feed", Some(7), Some(5)),
            "/v1/feed?before=7&limit=5"
        );
    }

    #[test]
    fn an_ordinary_handle_is_untouched() {
        assert_eq!(escape("alice_01"), "alice_01");
    }

    #[test]
    fn anything_that_could_change_the_path_is_escaped() {
        // None of these can be a handle today. The point is that the function
        // does not depend on that staying true.
        assert_eq!(escape("../admin"), "..%2Fadmin");
        assert_eq!(escape("a b"), "a%20b");
        assert_eq!(escape("a?b=c"), "a%3Fb%3Dc");
        assert_eq!(escape("a#b"), "a%23b");
    }
}
