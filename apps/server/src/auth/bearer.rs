//! Who is calling: the extractor every authenticated route depends on.
//!
//! An axum extractor rather than a middleware layer, because it makes the
//! requirement visible in each handler's signature. A route that takes
//! [`Caller`] is authenticated; a route that does not, is not. There is no way
//! to forget to apply a layer, and no way to read a route and be unsure.
//!
//! A token that verifies is not enough on its own: it names a device, and a
//! later sign-in may have retired that device since the token was issued. One
//! indexed lookup per request is what closes the fifteen minutes in between.

use axum::Json;
use axum::extract::{FromRef, FromRequestParts};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use std::sync::Arc;

use super::tokens::TokenKeys;

/// The authenticated device behind a request.
///
/// Carries the device as well as the user, because the MLS group member is the
/// device (brief 4.2). A handler that only knows the user cannot tell which of
/// an account's devices sent something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caller {
    /// The account.
    pub user_id: i64,
    /// The device the access token was issued to.
    pub device_id: Uuid,
}

/// Why a request was refused.
///
/// Deliberately one shape for every case. "Expired", "malformed" and "signed by
/// the wrong key" are all the same instruction to the client — get a new token
/// — and telling them apart only helps someone probing.
#[derive(Debug)]
pub struct Unauthorized;

#[derive(Serialize)]
struct Body {
    error: &'static str,
    message: &'static str,
}

impl IntoResponse for Unauthorized {
    fn into_response(self) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            // The header RFC 6750 says to send, so a client library knows this
            // is an auth failure rather than a permission one.
            [("www-authenticate", "Bearer")],
            Json(Body {
                error: "unauthorized",
                message: "A valid access token is required.",
            }),
        )
            .into_response()
    }
}

impl<S> FromRequestParts<S> for Caller
where
    Arc<TokenKeys>: FromRef<S>,
    PgPool: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(bearer_token)
            .ok_or(Unauthorized)
            .map_err(IntoResponse::into_response)?;

        let keys = Arc::<TokenKeys>::from_ref(state);
        Self::from_access_token(&keys, token)
            .map_err(IntoResponse::into_response)?
            .current(&PgPool::from_ref(state))
            .await
    }
}

impl Caller {
    /// Authenticates a token carried by a bearer header or the browser stream
    /// subprotocol. Both transports must make the same authorization decision.
    pub(crate) fn from_access_token(keys: &TokenKeys, token: &str) -> Result<Self, Unauthorized> {
        let claims = keys.verify_access_token(token).map_err(|error| {
            // At debug only: a token is a credential, and even a rejected one
            // should not sit in a production log.
            tracing::debug!(%error, "rejected an access token");
            Unauthorized
        })?;

        Ok(Self {
            user_id: claims.sub.parse().map_err(|_| Unauthorized)?,
            device_id: claims.did.parse().map_err(|_| Unauthorized)?,
        })
    }

    /// Refuses a device that is no longer this account's.
    ///
    /// Signing in retires every other device the account has (one device per
    /// account), but an access token keeps verifying until it expires. Until
    /// this check the replaced device went on for up to fifteen minutes --
    /// syncing, fetching Welcomes addressed to its successor, moving its
    /// cursor past messages it could never read -- and then quietly failed
    /// its next refresh. Refused here, it learns at once, and the page says
    /// so. A deleted account's devices are gone, and are refused the same way.
    ///
    /// The same 401 as any other bad token: which of them it was is nobody's
    /// business but the account's. A database that cannot answer is a 500,
    /// not a 401 -- an outage must not look like being signed out everywhere.
    pub(crate) async fn current(self, db: &PgPool) -> Result<Self, Response> {
        let live = sqlx::query_scalar!(
            "SELECT retired_at IS NULL AS \"live!\" FROM devices WHERE id = $1 AND user_id = $2",
            self.device_id,
            self.user_id
        )
        .fetch_optional(db)
        .await
        .map_err(|error| {
            tracing::error!(%error, "could not read whether a device is current");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(Body {
                    error: "internal",
                    message: "Something went wrong. Try again.",
                }),
            )
                .into_response()
        })?;
        match live {
            Some(true) => Ok(self),
            _ => Err(Unauthorized.into_response()),
        }
    }
}

/// Pulls the token out of an `Authorization` header value.
///
/// The scheme is case-insensitive per RFC 7235, which is the kind of detail
/// that works everywhere in testing and then fails against one HTTP client.
fn bearer_token(header: &str) -> Option<&str> {
    let (scheme, rest) = header.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() { None } else { Some(token) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_bearer_header_parses() {
        assert_eq!(bearer_token("Bearer abc.def.ghi"), Some("abc.def.ghi"));
    }

    #[test]
    fn the_scheme_is_case_insensitive() {
        // RFC 7235. Works everywhere until it meets the one client that sends
        // lowercase.
        assert_eq!(bearer_token("bearer abc"), Some("abc"));
        assert_eq!(bearer_token("BEARER abc"), Some("abc"));
    }

    #[test]
    fn other_schemes_are_refused() {
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token("Bearerabc"), None);
    }

    #[test]
    fn an_empty_token_is_not_a_token() {
        assert_eq!(bearer_token("Bearer "), None);
        assert_eq!(bearer_token("Bearer    "), None);
        assert_eq!(bearer_token(""), None);
    }

    #[test]
    fn surrounding_whitespace_is_tolerated() {
        assert_eq!(bearer_token("Bearer  abc  "), Some("abc"));
    }
}
