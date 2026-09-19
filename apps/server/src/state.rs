//! Shared application state handed to every axum handler.

use std::sync::Arc;

use sqlx::PgPool;

use axum::extract::FromRef;

use crate::auth::TokenKeys;
use crate::limits::Limits;
use crate::storage::Storage;
use crate::stream::hub::SharedFanout;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    /// Signs and verifies access tokens. `Arc` because `TokenKeys` holds key
    /// material and there is no reason to copy it per request.
    pub auth: Arc<TokenKeys>,
    /// Object storage, when it is configured. `None` until M6.
    pub storage: Option<Storage>,
    /// Where an accepted envelope goes so connected clients see it now rather
    /// than on their next sync.
    pub fanout: SharedFanout,
    /// BRIEF 4.5's three limits. `Arc` because the counters are shared state,
    /// not per-request state -- a copy per handler would count nothing.
    pub limits: Arc<Limits>,
}

#[cfg(test)]
pub(crate) fn test_state() -> AppState {
    // `connect_lazy` never touches the network, so tests that build a
    // router and state but don't run a query (e.g. the health check)
    // don't need a real database.
    let db = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused/unused")
        .expect("connect_lazy only fails on a malformed URL");
    AppState {
        db,
        auth: Arc::new(TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes()).expect("test key")),
        storage: None,
        fanout: Arc::new(crate::stream::hub::LocalHub::new()),
        limits: Arc::new(Limits::default()),
    }
}

/// A throwaway Ed25519 key for tests. It signs nothing outside the test binary.
#[cfg(test)]
const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
    MC4CAQAwBQYDK2VwBCIEIBD8O+mO1pxsOJPSKpso2043G54kPXsxDyl6dTJ6H5Io\n\
    -----END PRIVATE KEY-----\n";

// So the `Caller` extractor can verify a token without knowing what else the
// state holds. `TokenKeys` is not `Clone` -- it wraps key material and there is
// no reason to copy it -- so the extractor takes the `Arc`.
impl FromRef<AppState> for std::sync::Arc<TokenKeys> {
    fn from_ref(state: &AppState) -> Self {
        state.auth.clone()
    }
}
