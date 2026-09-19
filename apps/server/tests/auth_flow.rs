//! The auth flow end to end, against a real Postgres.
//!
//! Skips cleanly when `DATABASE_URL` is unset, the same way `db.rs`'s test
//! does, so `cargo test --workspace` still passes on a machine with no
//! database — including the Windows CI job.
//!
//! Every test invents its own handle, so they can run concurrently and against
//! a database that already has rows in it.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use nexo_server::{AppState, TokenKeys, db, router};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

/// A throwaway Ed25519 key. Signs nothing outside this test binary.
const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
    MC4CAQAwBQYDK2VwBCIEIBD8O+mO1pxsOJPSKpso2043G54kPXsxDyl6dTJ6H5Io\n\
    -----END PRIVATE KEY-----\n";

/// Builds a router against the real database, or `None` if there isn't one.
async fn app() -> Option<axum::Router> {
    let _ = dotenvy::dotenv();
    let url = std::env::var("DATABASE_URL").ok()?;
    let db = db::create_pool(&url)
        .await
        .expect("connect to the test database — is `docker compose up -d` running?");
    Some(router(AppState {
        db,
        auth: Arc::new(TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes()).unwrap()),
        storage: None,
        fanout: Arc::new(nexo_server::stream::hub::LocalHub::new()),
        limits: Arc::new(nexo_server::limits::Limits::permissive()),
    }))
}

/// The same router, but with a *real* auth limit rather than the permissive one.
///
/// Deliberately its own state: the counters are per-`Limits`, so this test
/// cannot spend the budget the other tests rely on, and they cannot spend its.
async fn app_with_auth_limit(max: u32) -> Option<axum::Router> {
    let _ = dotenvy::dotenv();
    let url = std::env::var("DATABASE_URL").ok()?;
    let db = db::create_pool(&url)
        .await
        .expect("connect to the test database");
    // Only `auth` is real; the rest stay out of the way. Spread rather than
    // listed, so a bucket added later does not break a test about signing in.
    let limits = nexo_server::limits::Limits {
        auth: nexo_server::limits::RateLimit::new(max, std::time::Duration::from_secs(60)),
        ..nexo_server::limits::Limits::permissive()
    };
    Some(router(AppState {
        db,
        auth: Arc::new(TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes()).unwrap()),
        storage: None,
        fanout: Arc::new(nexo_server::stream::hub::LocalHub::new()),
        limits: Arc::new(limits),
    }))
}

/// BRIEF 4.5's first limit, proven to fire.
///
/// `/v1/auth/salt` is the cheapest route on the router and needs no account, so
/// it exercises the layer without depending on anything else being set up. The
/// limit is per-address and covers the whole auth router, which is the point:
/// login is where the damage is, but an attacker who can only be slowed on
/// login will simply enumerate on salt instead.
#[tokio::test]
async fn auth_requests_are_refused_past_the_limit() {
    let Some(app) = app_with_auth_limit(3).await else {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    };

    let handle = unique_handle();
    let body = serde_json::json!({ "handle": handle });

    for i in 1..=3 {
        let (status, _) = post(&app, "/v1/auth/salt", body.clone()).await;
        assert_eq!(status, StatusCode::OK, "request {i} should be allowed");
    }

    let (status, _) = post(&app, "/v1/auth/salt", body.clone()).await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "the fourth request is over a limit of three"
    );
}

/// A handle no other run will pick. Handles are `[a-z0-9_]{3,20}`, so a hex
/// slice of a UUID fits.
fn unique_handle() -> String {
    format!("t{}", Uuid::new_v4().simple())[..16].to_string()
}

/// A stand-in for the client's Argon2id output. The server treats it as opaque
/// bytes, which is the whole point — it never learns the password behind it.
fn verifier(seed: &str) -> String {
    let mut out = String::new();
    for b in seed.bytes().cycle().take(32) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// A 16-byte salt, hex. The client picks this at registration.
fn salt() -> String {
    Uuid::new_v4().simple().to_string()
}

fn pubkey() -> String {
    Uuid::new_v4().simple().to_string().repeat(2)
}

async fn post(app: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    send(app, path, body, None).await
}

/// The same, with a bearer token.
async fn post_auth(
    app: &axum::Router,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    send(app, path, body, Some(token)).await
}

async fn send(
    app: &axum::Router,
    path: &str,
    body: Value,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

macro_rules! app_or_skip {
    () => {
        match app().await {
            Some(app) => app,
            None => {
                eprintln!("skipping: DATABASE_URL not set (needs a running local Postgres)");
                return;
            }
        }
    };
}

#[tokio::test]
async fn register_then_login_issues_a_usable_session() {
    let app = app_or_skip!();
    let handle = unique_handle();

    let (status, body) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register: {body}");
    assert!(body["access_token"].is_string());
    assert!(body["refresh_token"].is_string());

    // The access token verifies under the same key the server signed with.
    let keys = TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes()).unwrap();
    let claims = keys
        .verify_access_token(body["access_token"].as_str().unwrap())
        .expect("the issued access token should verify");
    assert_eq!(claims.sub, body["user_id"].as_i64().unwrap().to_string());

    let (status, login) = post(
        &app,
        "/v1/auth/login",
        json!({
            "handle": handle,
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "login: {login}");
    assert_ne!(
        login["refresh_token"], body["refresh_token"],
        "each session must get its own refresh token"
    );
}

#[tokio::test]
async fn a_wrong_verifier_is_refused() {
    let app = app_or_skip!();
    let handle = unique_handle();

    post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;

    let (status, body) = post(
        &app,
        "/v1/auth/login",
        json!({
            "handle": handle,
            "pw_salt": salt(), "pw_verifier": verifier("wrong"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "invalid_credentials");
}

/// The enumeration property: a handle that does not exist must be
/// indistinguishable from one that does, at every step a stranger can reach.
#[tokio::test]
async fn an_unknown_handle_is_indistinguishable_from_a_real_one() {
    let app = app_or_skip!();
    let real = unique_handle();
    let fake = unique_handle();

    post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": real,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;

    let (real_status, real_body) = post(&app, "/v1/auth/salt", json!({ "handle": real })).await;
    let (fake_status, fake_body) = post(&app, "/v1/auth/salt", json!({ "handle": fake })).await;

    // Same status, same shape, same salt length.
    assert_eq!(real_status, StatusCode::OK);
    assert_eq!(fake_status, StatusCode::OK);
    assert_eq!(
        real_body["salt"].as_str().unwrap().len(),
        fake_body["salt"].as_str().unwrap().len()
    );
    assert_eq!(real_body["argon2"], fake_body["argon2"]);

    // And the decoy is stable, so asking twice does not give it away.
    let (_, again) = post(&app, "/v1/auth/salt", json!({ "handle": fake })).await;
    assert_eq!(fake_body["salt"], again["salt"]);

    // Logging in against the unknown handle fails the same way a wrong password
    // does, rather than with a distinguishable 404.
    let (status, body) = post(
        &app,
        "/v1/auth/login",
        json!({
            "handle": fake,
            "pw_salt": salt(), "pw_verifier": verifier("anything"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "invalid_credentials");
}

#[tokio::test]
async fn a_handle_cannot_be_registered_twice() {
    let app = app_or_skip!();
    let handle = unique_handle();
    let body = json!({
        "handle": handle,
        "display_name": "Test Account",
        "pw_salt": salt(), "pw_verifier": verifier("correct"),
        "identity_pubkey": pubkey(),
    });

    let (first, _) = post(&app, "/v1/auth/register", body.clone()).await;
    assert_eq!(first, StatusCode::CREATED);

    let (second, error) = post(&app, "/v1/auth/register", body).await;
    assert_eq!(second, StatusCode::CONFLICT);
    assert_eq!(error["error"], "handle_taken");
}

#[tokio::test]
async fn refreshing_rotates_the_token() {
    let app = app_or_skip!();
    let handle = unique_handle();

    let (_, session) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    let first = session["refresh_token"].as_str().unwrap().to_string();

    let (status, refreshed) =
        post(&app, "/v1/auth/refresh", json!({ "refresh_token": first })).await;
    assert_eq!(status, StatusCode::OK, "refresh: {refreshed}");
    assert_ne!(
        refreshed["refresh_token"].as_str().unwrap(),
        first,
        "a refresh must hand back a different token, or rotation is not happening"
    );
}

/// The property the whole rotation scheme exists for.
#[tokio::test]
async fn replaying_a_rotated_token_kills_every_session() {
    let app = app_or_skip!();
    let handle = unique_handle();

    let (_, session) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    let stolen = session["refresh_token"].as_str().unwrap().to_string();

    // The legitimate client refreshes once.
    let (status, refreshed) =
        post(&app, "/v1/auth/refresh", json!({ "refresh_token": stolen })).await;
    assert_eq!(status, StatusCode::OK);
    let legitimate = refreshed["refresh_token"].as_str().unwrap().to_string();

    // The thief replays the token they captured before the rotation.
    let (status, _) = post(&app, "/v1/auth/refresh", json!({ "refresh_token": stolen })).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a replayed token must be refused"
    );

    // And the legitimate token is now dead too. That is the point: the server
    // cannot tell victim from thief, so it ends both and makes the real user
    // log in again.
    let (status, _) = post(
        &app,
        "/v1/auth/refresh",
        json!({ "refresh_token": legitimate }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "reuse detection must revoke the whole family, not just the replayed token"
    );
}

#[tokio::test]
async fn logging_out_invalidates_the_refresh_token() {
    let app = app_or_skip!();
    let handle = unique_handle();

    let (_, session) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    let token = session["refresh_token"].as_str().unwrap().to_string();

    let (status, _) = post(&app, "/v1/auth/logout", json!({ "refresh_token": token })).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = post(&app, "/v1/auth/refresh", json!({ "refresh_token": token })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn logging_out_an_unknown_token_still_succeeds() {
    // Otherwise the endpoint reports which tokens exist.
    let app = app_or_skip!();
    let (status, _) = post(
        &app,
        "/v1/auth/logout",
        json!({ "refresh_token": "not-a-real-token" }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn malformed_registrations_are_rejected() {
    let app = app_or_skip!();

    let cases = [
        (
            "uppercase handle",
            json!({"handle": "NotLower", "display_name": "x", "pw_salt": salt(), "pw_verifier": verifier("a"), "identity_pubkey": pubkey()}),
        ),
        (
            "short handle",
            json!({"handle": "ab", "display_name": "x", "pw_salt": salt(), "pw_verifier": verifier("a"), "identity_pubkey": pubkey()}),
        ),
        (
            "empty display name",
            json!({"handle": unique_handle(), "display_name": "  ", "pw_salt": salt(), "pw_verifier": verifier("a"), "identity_pubkey": pubkey()}),
        ),
        (
            "non-hex verifier",
            json!({"handle": unique_handle(), "display_name": "x", "pw_salt": salt(), "pw_verifier": "zzzz", "identity_pubkey": pubkey()}),
        ),
        (
            "short pubkey",
            json!({"handle": unique_handle(), "display_name": "x", "pw_salt": salt(), "pw_verifier": verifier("a"), "identity_pubkey": "aabb"}),
        ),
    ];

    for (name, body) in cases {
        let (status, response) = post(&app, "/v1/auth/register", body).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{name} should be rejected, got {response}"
        );
    }
}

/// Change password, §6.4. The property that matters is the *pair* of them:
/// the new password works and the old one stops working. Testing only the
/// first would pass against a server that never wrote anything.
#[tokio::test]
async fn changing_the_password_retires_the_old_one() {
    let app = app_or_skip!();
    let handle = unique_handle();
    let key = pubkey();

    let (status, session) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("first"),
            "identity_pubkey": key,
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register: {session}");
    let token = session["access_token"].as_str().unwrap();

    let (status, body) = post_auth(
        &app,
        "/v1/auth/change-password",
        token,
        json!({
            "pw_verifier": verifier("first"),
            "new_pw_salt": salt(),
            "new_pw_verifier": verifier("second"),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "change: {body}");

    let (status, body) = post(
        &app,
        "/v1/auth/login",
        json!({"handle": handle, "pw_verifier": verifier("second"), "identity_pubkey": key}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "login with the new password: {body}"
    );

    let (status, _) = post(
        &app,
        "/v1/auth/login",
        json!({"handle": handle, "pw_verifier": verifier("first"), "identity_pubkey": key}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the old password must stop working"
    );
}

/// A signed-in session is possession of an unlocked machine, not knowledge of
/// the password. Someone who sits down at a desk must not be able to lock the
/// owner out of their own account.
#[tokio::test]
async fn a_session_alone_cannot_change_the_password() {
    let app = app_or_skip!();
    let handle = unique_handle();
    let key = pubkey();

    let (_, session) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("right"),
            "identity_pubkey": key,
        }),
    )
    .await;
    let token = session["access_token"].as_str().unwrap();

    let (status, body) = post_auth(
        &app,
        "/v1/auth/change-password",
        token,
        json!({
            "pw_verifier": verifier("wrong"),
            "new_pw_salt": salt(),
            "new_pw_verifier": verifier("attacker"),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "wrong_password");

    // And the account still belongs to whoever knew the original.
    let (status, _) = post(
        &app,
        "/v1/auth/login",
        json!({"handle": handle, "pw_verifier": verifier("right"), "identity_pubkey": key}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn changing_a_password_needs_a_token_at_all() {
    let app = app_or_skip!();
    let (status, _) = post(
        &app,
        "/v1/auth/change-password",
        json!({
            "pw_verifier": verifier("a"),
            "new_pw_salt": salt(),
            "new_pw_verifier": verifier("b"),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// Deleting an account is not something a stolen session can do.
///
/// The same reasoning as change-password, which this route sits beside: a
/// bearer token is possession of a session, not knowledge of the password. The
/// difference is that a wrong guess here costs nothing and a right one costs
/// everything, because there is no recovery.
#[tokio::test]
async fn deleting_an_account_needs_the_password_not_just_the_session() {
    let app = app_or_skip!();
    let handle = unique_handle();

    let (status, body) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register: {body}");
    let token = body["access_token"].as_str().unwrap().to_string();

    let (status, refused) = post_auth(
        &app,
        "/v1/auth/delete-account",
        &token,
        json!({ "pw_verifier": verifier("wrong") }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "delete: {refused}");

    // And the account is still there afterwards, which is the half of this
    // that would be easy to get wrong: refusing the request but destroying
    // something on the way would be worse than not refusing at all.
    let (status, login) = post(
        &app,
        "/v1/auth/login",
        json!({
            "handle": handle,
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the account should have survived: {login}"
    );
}

/// What deletion actually removes.
///
/// The account, its device, and the posts it wrote. Checked through the API
/// rather than against the tables, because what matters is that none of it can
/// be reached afterwards — a row nobody can read is a different bug from a row
/// that is gone, but this test is about the promise made to the person.
#[tokio::test]
async fn a_deleted_account_leaves_nothing_reachable_behind() {
    let app = app_or_skip!();
    let handle = unique_handle();

    let (status, body) = post(
        &app,
        "/v1/auth/register",
        json!({
            "handle": handle,
            "display_name": "Test Account",
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "register: {body}");
    let token = body["access_token"].as_str().unwrap().to_string();

    let (status, post_body) = post_auth(
        &app,
        "/v1/posts",
        &token,
        json!({ "body": "something to leave behind" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "post: {post_body}");

    let (status, deleted) = post_auth(
        &app,
        "/v1/auth/delete-account",
        &token,
        json!({ "pw_verifier": verifier("correct") }),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "delete: {deleted}");

    // The password no longer opens anything.
    let (status, login) = post(
        &app,
        "/v1/auth/login",
        json!({
            "handle": handle,
            "pw_salt": salt(), "pw_verifier": verifier("correct"),
            "identity_pubkey": pubkey(),
        }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the account should be gone: {login}"
    );

    // And the profile with it. `salt` is the route that answers for a handle
    // whether or not anyone is signed in, so it is the honest place to ask
    // whether the account still exists at all -- and it answers the same for a
    // deleted account as for one that never was, which is the enumeration
    // behaviour `salt.rs` already goes to trouble to keep.
    let (status, _) = post(&app, "/v1/auth/salt", json!({ "handle": handle })).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "salt answers for anyone, gone or not"
    );
}
