//! Startup. Everything else lives in the library beside this file.

#![forbid(unsafe_code)]

use std::net::SocketAddr;

use std::sync::Arc;

use nexo_server::stream::hub::LocalHub;
use nexo_server::{AppState, Storage, auth, db, router};

/// The rate limits, unless the environment says otherwise.
///
/// Anything other than `off` -- including the variable being absent, which is
/// the normal case -- gives the real limits.
fn limits_from_env() -> nexo_server::limits::Limits {
    match std::env::var("NEXO_RATE_LIMITS").as_deref() {
        Ok("off") => {
            tracing::warn!(
                "NEXO_RATE_LIMITS=off: rate limiting is DISABLED. Local testing only; never set this in production."
            );
            nexo_server::limits::Limits::permissive()
        }
        _ => nexo_server::limits::Limits::default(),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nexo_server=info,tower_http=info".into()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL must be set — see .env.example");
    let db = db::create_pool(&database_url).await?;

    // Not fatal when absent: object storage is M6, and everything before it
    // runs without it. A *partly* configured one is fatal, and says so.
    let storage = Storage::from_env()?;

    // Fails closed: no signing key, no server. An auth system that silently
    // invents a key on each boot signs everyone out on every restart and looks
    // like a bug rather than a misconfiguration.
    let auth = Arc::new(auth::tokens::load_from_env()?);

    // One process, one hub. A second instance needs Redis behind the same
    // trait -- see stream::hub and PLAN.md G5.
    let fanout = Arc::new(LocalHub::new());

    let state = AppState {
        db,
        auth,
        storage,
        fanout,
        // In-process counters, so they reset on restart and are per-instance.
        // Both are fine at one process on one machine (PLAN.md G5); a second
        // instance would need them in Redis beside the fan-out, for the same
        // reason and at the same time.
        //
        // `NEXO_RATE_LIMITS=off` exists for one reason: the integration suite
        // in `crates/client/tests` registers a dozen accounts in a couple of
        // seconds, all from 127.0.0.1, and the auth limit is per address. With
        // limits on, every one of those tests fails with 429 before it reaches
        // the thing it is testing -- so the only end-to-end coverage Nexo has
        // could not be run against a local server at all.
        //
        // It is opt-in, it is loud, and it must never be set in production.
        limits: Arc::new(limits_from_env()),
    };
    match &state.storage {
        Some(storage) => tracing::info!(
            media = storage.media().name(),
            encrypted = storage.encrypted().name(),
            "object storage configured"
        ),
        None => tracing::info!("object storage not configured; attachments are unavailable"),
    }

    let addr: SocketAddr = std::env::var("NEXO_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_string())
        .parse()?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "nexo-server listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
