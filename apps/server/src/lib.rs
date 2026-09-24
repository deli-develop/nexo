//! Nexo server: HTTP API, MLS Delivery Service, and WebSocket fanout.
//!
//! TLS is terminated by Caddy in front of this process (§5.2), so the server
//! itself listens plaintext on loopback and holds no certificate. Postgres is
//! reached over loopback too (docs/OPS.md Phase 4). Object storage is the
//! exception: Hetzner is off-box, so that one is HTTPS.
//!
//! The rule that shapes this whole crate: it stores and forwards ciphertext it
//! cannot read. If a handler is ever written that touches message plaintext,
//! that is a bug in the design, not a feature (rule 4).
//!
//! This is a library so that `pub` items are public API rather than dead code,
//! and so integration tests can reach them. `src/main.rs` is startup and
//! nothing else.

#![forbid(unsafe_code)]

use axum::http::{HeaderValue, Method, header};
use axum::{Router, routing::get};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub mod auth;
pub mod blocks;
pub mod db;
pub mod delivery;
pub mod follows;
pub mod health;
pub mod invites;
pub mod limits;
pub mod media;
pub mod posts;
pub mod profiles;
pub mod reports;
pub mod state;
pub mod storage;
pub mod stories;
pub mod stream;
pub mod teams;

pub use auth::TokenKeys;
pub use state::AppState;
pub use storage::Storage;

/// The environment variable naming the browser origins allowed to call this
/// API, comma-separated.
///
/// Unset means no CORS layer at all, which is the correct configuration for a
/// deployment that serves only the desktop app.
pub const CORS_ORIGINS_ENV: &str = "NEXO_CORS_ORIGINS";

/// Parses [`CORS_ORIGINS_ENV`] into exact origins.
///
/// Refuses, loudly and at startup rather than per request:
///
/// - `*`, in any position. A wildcard on this API would let every page on the
///   internet make authenticated requests on a visitor's behalf the moment it
///   obtained a token, and "just to get it working" is exactly how it would
///   arrive. There is no configuration in which it is right here.
/// - anything that is not `https://`, except loopback — which covers local
///   development and the packaged desktop app, whose page is served from
///   `http://tauri.localhost`.
/// - anything carrying a path, query or trailing slash: an `Origin` header is
///   scheme, host and port, and a value with more in it never matches, which
///   would fail as a confusing CORS error rather than a configuration one.
fn parse_origins(raw: &str) -> Vec<HeaderValue> {
    raw.split(',')
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .map(|candidate| {
            assert!(
                candidate != "*" && !candidate.contains('*'),
                "{CORS_ORIGINS_ENV}: a wildcard origin is never correct for this API"
            );

            let url = url_parts(candidate);
            assert!(
                url.https || url.loopback,
                "{CORS_ORIGINS_ENV}: {candidate} is not https://"
            );
            assert!(
                !url.has_extra,
                "{CORS_ORIGINS_ENV}: {candidate} must be scheme://host[:port] with nothing after it"
            );

            HeaderValue::from_str(candidate)
                .unwrap_or_else(|_| panic!("{CORS_ORIGINS_ENV}: {candidate} is not a header value"))
        })
        .collect()
}

struct UrlParts {
    https: bool,
    loopback: bool,
    has_extra: bool,
}

fn url_parts(candidate: &str) -> UrlParts {
    let (scheme, rest) = match candidate.split_once("://") {
        Some(split) => split,
        None => {
            return UrlParts {
                https: false,
                loopback: false,
                has_extra: true,
            };
        }
    };
    let host = rest.split(':').next().unwrap_or_default();
    UrlParts {
        https: scheme == "https",
        // `.localhost` is reserved by RFC 6761 and always resolves to the
        // loopback interface, which is what makes this safe to widen: no
        // amount of DNS can point `tauri.localhost` at somebody else's
        // machine. The Tauri build needs it — a packaged desktop app serves
        // its page from `http://tauri.localhost`, so once the page started
        // making its own requests (REWORK wave 7) it began sending that as an
        // `Origin` where the old Rust client sent none at all.
        loopback: scheme == "http"
            && (host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost")),
        has_extra: rest.contains('/')
            || rest.contains('?')
            || rest.contains('#')
            || rest.is_empty(),
    }
}

/// The CORS layer, or `None` when no browser origin is configured.
///
/// Note what is absent: `allow_credentials`. Nexo authenticates with a
/// `Bearer` token in a header, so a browser client needs no ambient cookie —
/// and because it needs none, this API never has to send
/// `Access-Control-Allow-Credentials`. That keeps a whole class of cross-site
/// request forgery off the table rather than mitigated, and it is the reason
/// the web client calls `fetch` with `credentials: "omit"`.
pub fn cors_layer() -> Option<CorsLayer> {
    let configured = std::env::var(CORS_ORIGINS_ENV).ok()?;
    let origins = parse_origins(&configured);
    if origins.is_empty() {
        return None;
    }
    Some(layer_for(origins))
}

/// The layer itself, separated from reading the environment so the tests can
/// exercise the policy without a process-global variable they would have to
/// serialise around.
fn layer_for(origins: Vec<HeaderValue>) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT])
        .max_age(std::time::Duration::from_secs(600))
}

/// Every route the server answers.
pub fn router(state: AppState) -> Router {
    let routes = Router::new()
        .route("/v1/health", get(health::health))
        // The auth router carries its own limit, keyed by client address
        // rather than by account: `/v1/auth/salt` and `/v1/auth/login` are both
        // reached before there is an account to key on. Applied here because
        // `auth::router()` is built before the state exists.
        .merge(auth::router().layer(axum::middleware::from_fn_with_state(
            state.clone(),
            limits::limit_auth,
        )))
        .merge(blocks::router())
        .merge(delivery::router())
        .merge(media::router())
        .merge(invites::router())
        .merge(profiles::router())
        .merge(posts::router())
        .merge(reports::router())
        .merge(stories::router())
        .merge(follows::router())
        .merge(stream::router())
        .merge(teams::router())
        .layer(TraceLayer::new_for_http());

    // Applied outermost, so a preflight is answered before anything else runs.
    // When no browser origin is configured the layer is not added at all,
    // which is what keeps a desktop-only deployment exactly as it was.
    match cors_layer() {
        Some(cors) => routes.layer(cors),
        None => routes,
    }
    .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_responds_through_the_router() {
        let res = router(state::test_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn unknown_routes_are_not_found() {
        let res = router(state::test_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    // --- CORS ------------------------------------------------------------
    //
    // The web client (github.com/deli-develop/nexo-web) is a browser and is
    // therefore the first caller this API has ever had that the same-origin
    // policy applies to. These tests exist so the allow-list stays an
    // allow-list.

    const WEB: &str = "https://nexo.delidev.net";

    #[test]
    fn an_https_origin_is_accepted() {
        assert_eq!(parse_origins(WEB), vec![HeaderValue::from_static(WEB)]);
    }

    #[test]
    fn several_origins_may_be_listed() {
        assert_eq!(
            parse_origins(&format!("{WEB} , https://staging.delidev.net")).len(),
            2
        );
    }

    #[test]
    fn an_empty_setting_yields_nothing() {
        assert!(parse_origins("").is_empty());
        assert!(parse_origins("  , ").is_empty());
    }

    #[test]
    fn loopback_may_be_plaintext_for_local_development() {
        assert_eq!(parse_origins("http://localhost:5173").len(), 1);
        assert_eq!(parse_origins("http://127.0.0.1:5173").len(), 1);
    }

    /// The desktop app is a browser now, and it has an origin.
    ///
    /// Before the page made its own requests, the Windows client called this
    /// API from Rust and sent no `Origin` at all, so CORS never applied to it.
    /// A packaged Tauri app serves its page from `http://tauri.localhost`, and
    /// refusing that is the whole desktop app failing with "Failed to fetch"
    /// while the website works perfectly.
    #[test]
    fn the_packaged_desktop_origin_is_accepted() {
        assert_eq!(parse_origins("http://tauri.localhost").len(), 1);
    }

    /// Reserved-TLD loopback only, and still only over `http`.
    ///
    /// `.localhost` cannot be pointed anywhere by DNS (RFC 6761). A host that
    /// merely *contains* the word is an ordinary internet name and gets no
    /// exemption — `http://localhost.example.com` is somebody else's server.
    #[test]
    #[should_panic(expected = "not https")]
    fn a_hostname_that_merely_mentions_localhost_is_refused() {
        parse_origins("http://localhost.example.com");
    }

    #[test]
    #[should_panic(expected = "wildcard")]
    fn a_wildcard_is_refused() {
        parse_origins("*");
    }

    #[test]
    #[should_panic(expected = "wildcard")]
    fn a_wildcard_subdomain_is_refused() {
        // Netlify hands every pull request its own deploy-preview URL. Allowing
        // the whole domain to reach production would be the tempting way to
        // make previews work, and it would put production data one pull
        // request away from anyone who can open one.
        parse_origins("https://*.netlify.app");
    }

    #[test]
    #[should_panic(expected = "not https")]
    fn a_plaintext_origin_is_refused() {
        parse_origins("http://nexo.delidev.net");
    }

    #[test]
    #[should_panic(expected = "nothing after it")]
    fn an_origin_with_a_path_is_refused() {
        parse_origins("https://nexo.delidev.net/");
    }

    #[tokio::test]
    async fn a_configured_origin_is_allowed() {
        let app = router(state::test_state()).layer(layer_for(parse_origins(WEB)));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .header("origin", WEB)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            res.headers().get("access-control-allow-origin"),
            Some(&HeaderValue::from_static(WEB))
        );
        // No cookie is used for auth, so the browser must never be told it may
        // send one. See cors_layer's doc comment.
        assert!(
            res.headers()
                .get("access-control-allow-credentials")
                .is_none()
        );
    }

    #[tokio::test]
    async fn an_unlisted_origin_gets_no_allow_header() {
        let app = router(state::test_state()).layer(layer_for(parse_origins(WEB)));
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .header("origin", "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // The request itself still runs -- CORS is enforced by the browser, not
        // by the server refusing. What matters is that the browser is never
        // told the response may be read.
        assert!(res.headers().get("access-control-allow-origin").is_none());
    }

    #[tokio::test]
    async fn the_desktop_app_sends_no_origin_and_is_unaffected() {
        let res = router(state::test_state())
            .oneshot(
                Request::builder()
                    .uri("/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get("access-control-allow-origin").is_none());
    }
}
