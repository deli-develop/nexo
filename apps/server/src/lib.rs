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

use axum::{Router, routing::get};
use tower_http::trace::TraceLayer;

pub mod auth;
pub mod blocks;
pub mod calls;
pub mod db;
pub mod delivery;
pub mod follows;
pub mod health;
pub mod limits;
pub mod media;
pub mod meet;
pub mod posts;
pub mod profiles;
pub mod reports;
pub mod state;
pub mod storage;
pub mod stories;
pub mod stream;

pub use auth::TokenKeys;
pub use state::AppState;
pub use storage::Storage;

/// Every route the server answers.
pub fn router(state: AppState) -> Router {
    Router::new()
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
        .merge(calls::router())
        .merge(delivery::router())
        .merge(media::router())
        .merge(meet::router())
        .merge(profiles::router())
        .merge(posts::router())
        .merge(reports::router())
        .merge(stories::router())
        .merge(follows::router())
        .merge(stream::router())
        .layer(TraceLayer::new_for_http())
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
}
