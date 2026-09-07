//! Where a call's media goes, and the credential that opens it.
//!
//! This module holds the *only* thing calls need from the server. Signalling —
//! the offer, the answer, the hangup — never comes here: it travels as an
//! encrypted payload inside the conversation, so the delivery service moves it
//! as the opaque envelope it already moves and rule 4 needs no help. What is
//! left is the relay, and a relay needs an address and a password.
//!
//! # Why the credential is minted rather than configured
//!
//! coturn's REST API takes a shared secret and derives a username/password pair
//! from it: the username is an expiry timestamp, and the password is an HMAC of
//! that username under the secret. The relay verifies the pair without ever
//! having been told about the account, which means no per-user state on the
//! relay and no database between the two.
//!
//! What it buys here is that **the shared secret never leaves this process.**
//! A static TURN password shipped in the client would be extractable from every
//! installation and good for ever; these expire, so a credential lifted off a
//! device stops working on its own.
//!
//! # What the server still sees
//!
//! Asking for a relay is asking for permission to place a call, so this route
//! tells the server that somebody is about to call *somebody*. It does not say
//! who: the callee's name is inside the ciphertext of the offer, which this
//! process cannot read. The relay sees both endpoints' addresses and the
//! encrypted media, and nothing else — SRTP is negotiated end to end.
//! `docs/THREAT-MODEL.md` carries the same paragraph in longer form.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::{Json, Router, extract::State, routing::get};
use base64::Engine;
use hmac::{Hmac, Mac};
use nexo_protocol::{IceServer, IceServers};
use sha1::Sha1;

use crate::auth::bearer::Caller;
use crate::state::AppState;

/// How long a minted credential lasts, unless the environment says otherwise.
///
/// An hour: comfortably longer than any call, short enough that a leaked pair
/// is worth little. It is the credential's life, not the call's — a call that
/// outlives it keeps running, because TURN checks the credential when the
/// allocation is made and not on every packet.
const DEFAULT_TTL_SECS: u64 = 3600;

/// The variables that configure the relay. All of them, or none.
const REQUIRED_VARS: [&str; 2] = ["NEXO_TURN_SECRET", "NEXO_TURN_URLS"];

/// The relay, as this process knows it.
#[derive(Clone, Debug)]
pub struct TurnConfig {
    /// coturn's `static-auth-secret`. Never leaves this process.
    secret: String,
    /// Every way to reach the relay: UDP, TCP, TLS.
    urls: Vec<String>,
    /// Plain STUN servers, which need no credential. Usually the same host.
    stun_urls: Vec<String>,
    ttl_secs: u64,
    relay_only: bool,
}

impl TurnConfig {
    /// Reads the relay's configuration, or decides there is none.
    ///
    /// Absent entirely is fine and means calls are switched off — the route
    /// then answers 503 and the app says so, rather than offering a call button
    /// that fails at the worst moment. *Partly* configured is fatal, the same
    /// rule `Storage::from_env` follows and for the same reason: a secret set
    /// with no URL is a deployment somebody half-finished, and booting anyway
    /// hides it until the first call.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let is_set = |name: &&str| std::env::var(name).is_ok_and(|v| !v.trim().is_empty());
        let missing: Vec<&str> = REQUIRED_VARS
            .iter()
            .filter(|name| !is_set(name))
            .copied()
            .collect();

        if missing.len() == REQUIRED_VARS.len() {
            return Ok(None);
        }
        if !missing.is_empty() {
            anyhow::bail!(
                "the TURN relay is partly configured: {} of {} variables set, missing {}. \
                 Set all of them or none.",
                REQUIRED_VARS.len() - missing.len(),
                REQUIRED_VARS.len(),
                missing.join(", ")
            );
        }

        let urls = split_urls(&std::env::var("NEXO_TURN_URLS")?);
        if urls.is_empty() {
            anyhow::bail!("NEXO_TURN_URLS is set but lists no usable URL");
        }

        Ok(Some(Self {
            secret: std::env::var("NEXO_TURN_SECRET")?,
            urls,
            stun_urls: std::env::var("NEXO_STUN_URLS")
                .map(|raw| split_urls(&raw))
                .unwrap_or_default(),
            ttl_secs: std::env::var("NEXO_TURN_TTL_SECS")
                .ok()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(DEFAULT_TTL_SECS),
            // Defaults to relaying. Turning it off is a decision about handing
            // one caller's IP address to the other, and a default that leaks is
            // the wrong way round for a default to be wrong.
            relay_only: std::env::var("NEXO_TURN_RELAY_ONLY")
                .map(|v| !v.trim().eq_ignore_ascii_case("false"))
                .unwrap_or(true),
        }))
    }

    /// Mints a credential for one account, good until `now + ttl`.
    ///
    /// The username is `<expiry>:<user id>` because that is the form coturn
    /// parses: it reads the timestamp to decide whether the pair is still
    /// valid, and everything after the colon is opaque to it. Putting the
    /// account id there is what makes a relay log answer "who was this" during
    /// an incident, and it is not a secret — the server already knows it.
    fn credential_for(&self, user_id: i64, now_secs: u64) -> (String, String, i64) {
        let expiry = now_secs + self.ttl_secs;
        let username = format!("{expiry}:{user_id}");

        // `new_from_slice` on an HMAC accepts any key length, so this cannot
        // fail for a non-empty secret -- but it returns a Result, and unwrapping
        // it in a request handler would be a panic path for a misconfiguration.
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(self.secret.as_bytes())
            .expect("HMAC accepts a key of any length");
        mac.update(username.as_bytes());
        let credential =
            base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());

        (username, credential, (expiry as i64) * 1000)
    }

    /// What to hand a client that is about to place a call.
    fn ice_servers(&self, user_id: i64, now_secs: u64) -> IceServers {
        let (username, credential, expires_at_ms) = self.credential_for(user_id, now_secs);

        let mut servers = Vec::new();
        // STUN first: it is the cheap answer, and a client that is told to
        // relay ignores it anyway. Listing it costs nothing and means turning
        // `relay_only` off later needs no second deployment.
        if !self.stun_urls.is_empty() {
            servers.push(IceServer {
                urls: self.stun_urls.clone(),
                username: None,
                credential: None,
            });
        }
        servers.push(IceServer {
            urls: self.urls.clone(),
            username: Some(username),
            credential: Some(credential),
        });

        IceServers {
            servers,
            expires_at_ms,
            relay_only: self.relay_only,
        }
    }
}

/// Splits a comma-separated list, dropping the empties a trailing comma leaves.
fn split_urls(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// `GET /v1/calls/ice` — where to send this call's media.
///
/// Authenticated, because an unauthenticated one would be a public source of
/// relay credentials, which is a public source of bandwidth.
async fn ice(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<IceServers>, CallsError> {
    if !state.limits.calls.check(&caller.user_id.to_string()) {
        return Err(CallsError::TooMany);
    }

    let Some(turn) = state.turn.as_ref() else {
        return Err(CallsError::NotConfigured);
    };

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| CallsError::NotConfigured)?;

    Ok(Json(turn.ice_servers(caller.user_id, now_secs)))
}

/// What can go wrong asking for a relay.
#[derive(Debug)]
pub enum CallsError {
    /// No relay is configured, so calls are off. Said plainly rather than
    /// dressed up as a failure, because a deployment without a relay is a
    /// choice and the app should be able to tell the user calls are
    /// unavailable rather than that something broke.
    NotConfigured,
    TooMany,
}

/// The refusal shape every module here uses.
///
/// Not decoration: `HttpTransport` parses exactly this, and a plain-text body
/// falls through to "the server returned 503" — which is the opposite of what
/// `NotConfigured` is for. Found by driving the running app, not by review.
#[derive(serde::Serialize)]
struct ErrorBody {
    error: &'static str,
    message: &'static str,
}

impl axum::response::IntoResponse for CallsError {
    fn into_response(self) -> axum::response::Response {
        use axum::http::StatusCode;
        let (status, error, message) = match self {
            CallsError::NotConfigured => (
                StatusCode::SERVICE_UNAVAILABLE,
                "calls_unavailable",
                "Calls are not available on this server.",
            ),
            CallsError::TooMany => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Too many call attempts. Wait a moment.",
            ),
        };
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

/// This module's routes.
pub fn router() -> Router<AppState> {
    Router::new().route("/v1/calls/ice", get(ice))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> TurnConfig {
        TurnConfig {
            secret: "a shared secret".into(),
            urls: vec!["turn:relay.example:3478?transport=udp".into()],
            stun_urls: vec!["stun:relay.example:3478".into()],
            ttl_secs: 3600,
            relay_only: true,
        }
    }

    #[test]
    fn the_username_carries_the_expiry_that_coturn_reads() {
        // coturn parses everything before the colon as a unix timestamp and
        // refuses the pair once it has passed. Getting this shape wrong makes
        // every credential fail at the relay, with nothing in this process to
        // show for it.
        let (username, _, expires_at_ms) = config().credential_for(42, 1_000_000);
        // now + ttl, then the account it was minted for.
        assert_eq!(username, "1003600:42");
        // The same instant, in the milliseconds the rest of the wire uses.
        assert_eq!(expires_at_ms, 1_003_600_000);
    }

    #[test]
    fn the_credential_matches_an_independent_implementation() {
        // A known-answer test, and the only one here that proves anything about
        // *coturn*. Every other test in this module checks that this code
        // agrees with itself, which it would do just as happily with the wrong
        // algorithm, the wrong encoding or the wrong input -- and the symptom
        // would be every call failing at the relay, with nothing in this
        // process to show for it.
        //
        // The vector below was produced independently:
        //
        //     python3 -c "import hmac,hashlib,base64; \
        //       print(base64.b64encode(hmac.new(b'a shared secret', \
        //       b'1003600:42', hashlib.sha1).digest()).decode())"
        //
        // which is the same computation coturn performs when it verifies the
        // pair: HMAC-SHA1 over the username, keyed by the shared secret, then
        // standard base64.
        let (username, credential, _) = config().credential_for(42, 1_000_000);
        assert_eq!(username, "1003600:42");
        assert_eq!(credential, "0ztIHLDl8JhsZEbYjx++/fwk9RI=");
    }

    #[test]
    fn the_credential_is_an_hmac_of_the_username_and_changes_with_the_secret() {
        // The property the relay actually checks. Two servers sharing a secret
        // agree; one with a different secret does not, which is what stops a
        // credential minted elsewhere from opening this relay.
        let (_, mine, _) = config().credential_for(42, 1_000_000);

        let mut other = config();
        other.secret = "a different secret".into();
        let (_, theirs, _) = other.credential_for(42, 1_000_000);

        assert_ne!(mine, theirs);
        // Stable for the same inputs -- the relay recomputes it and compares.
        let (_, again, _) = config().credential_for(42, 1_000_000);
        assert_eq!(mine, again);
    }

    #[test]
    fn two_accounts_never_share_a_credential() {
        let (_, one, _) = config().credential_for(1, 1_000_000);
        let (_, two, _) = config().credential_for(2, 1_000_000);
        assert_ne!(one, two);
    }

    #[test]
    fn stun_is_offered_without_a_credential_and_turn_with_one() {
        let servers = config().ice_servers(7, 1_000_000);
        assert!(servers.relay_only);
        assert_eq!(servers.servers.len(), 2);

        let stun = &servers.servers[0];
        assert!(stun.username.is_none(), "STUN needs no credential");
        assert!(stun.credential.is_none());

        let turn = &servers.servers[1];
        assert!(turn.username.is_some(), "TURN does");
        assert!(turn.credential.is_some());
    }

    #[test]
    fn a_relay_with_no_stun_offers_only_itself() {
        let mut cfg = config();
        cfg.stun_urls.clear();
        let servers = cfg.ice_servers(7, 1_000_000);
        assert_eq!(servers.servers.len(), 1);
        assert!(servers.servers[0].credential.is_some());
    }

    #[tokio::test]
    async fn a_refusal_is_json_the_client_can_read() {
        // This one exists because the first version got it wrong, and nothing
        // caught it until the app was driven for real.
        //
        // `HttpTransport::refusal` parses the body as `{error, message}` and
        // falls back to "the server returned 503" when it cannot. A plain-text
        // body therefore turned the one refusal that is *not* a malfunction --
        // "this deployment has no relay" -- into a generic failure, which is
        // precisely the honesty rule 5 asks for, lost in the last ten yards.
        use axum::body::to_bytes;
        use axum::response::IntoResponse;

        let response = CallsError::NotConfigured.into_response();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::SERVICE_UNAVAILABLE
        );

        let body = to_bytes(response.into_body(), 4096).await.expect("a body");
        let parsed: serde_json::Value = serde_json::from_slice(&body)
            .expect("the client parses this as JSON; so must the test");
        assert_eq!(parsed["error"], "calls_unavailable");
        assert_eq!(
            parsed["message"], "Calls are not available on this server.",
            "the message reaches the user verbatim -- it is the sentence they read"
        );
    }

    #[test]
    fn a_url_list_survives_spaces_and_a_trailing_comma() {
        assert_eq!(
            split_urls("turn:a:3478?transport=udp , turn:a:3478?transport=tcp ,"),
            vec![
                "turn:a:3478?transport=udp".to_string(),
                "turn:a:3478?transport=tcp".to_string()
            ]
        );
    }
}
