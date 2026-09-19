//! Following, end to end.
//!
//! A follow narrows what somebody is *shown* and must never widen what they
//! are allowed to *see*. That is the claim worth testing, because it is the one
//! that would rot quietly: a Following feed is easy to write in a way that
//! reaches past a block, and nothing in the UI would ever show it.
//!
//! Skips cleanly with no `DATABASE_URL`, like the rest of the suite.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use nexo_server::{AppState, TokenKeys, db, router};
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
    MC4CAQAwBQYDK2VwBCIEIBD8O+mO1pxsOJPSKpso2043G54kPXsxDyl6dTJ6H5Io\n\
    -----END PRIVATE KEY-----\n";

async fn app() -> Option<axum::Router> {
    let _ = dotenvy::dotenv();
    let url = std::env::var("DATABASE_URL").ok()?;
    let db = db::create_pool(&url)
        .await
        .expect("connect to the database");
    Some(router(AppState {
        db,
        auth: Arc::new(TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes()).unwrap()),
        storage: None,
        fanout: Arc::new(nexo_server::stream::hub::LocalHub::new()),
        limits: Arc::new(nexo_server::limits::Limits::permissive()),
    }))
}

macro_rules! app_or_skip {
    () => {
        match app().await {
            Some(app) => app,
            None => {
                eprintln!("skipping: DATABASE_URL not set");
                return;
            }
        }
    };
}

async fn call(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(value) => builder
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

struct Party {
    token: String,
    handle: String,
}

async fn register(app: &axum::Router) -> Party {
    let handle = format!("f{}", Uuid::new_v4().simple())[..16].to_string();
    let (status, session) = call(
        app,
        "POST",
        "/v1/auth/register",
        None,
        Some(json!({
            "handle": handle,
            "display_name": "Follow Test",
            "pw_salt": Uuid::new_v4().simple().to_string(),
            "pw_verifier": "07".repeat(32),
            "identity_pubkey": format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        })),
    )
    .await;
    // Never print the body: it carries a live access token and a refresh token.
    assert!(status.is_success(), "register returned {status}");
    Party {
        token: session["access_token"].as_str().unwrap().to_string(),
        handle,
    }
}

#[tokio::test]
async fn following_narrows_the_feed_without_widening_it() {
    let app = app_or_skip!();
    let reader = register(&app).await;
    let followed = register(&app).await;
    let stranger = register(&app).await;

    for (who, what) in [
        (&followed, "from someone followed"),
        (&stranger, "from a stranger"),
    ] {
        let (status, _) = call(
            &app,
            "POST",
            "/v1/posts",
            Some(&who.token),
            Some(json!({ "body": what, "kind": "text" })),
        )
        .await;
        assert!(status.is_success(), "posting returned {status}");
    }

    // Everyone: both are there.
    let (_, everyone) = call(&app, "GET", "/v1/feed", Some(&reader.token), None).await;
    let all = everyone["posts"].as_array().unwrap();
    assert!(all.iter().any(|p| p["body"] == "from someone followed"));
    assert!(all.iter().any(|p| p["body"] == "from a stranger"));

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/users/{}/follow", followed.handle),
        Some(&reader.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "following should succeed");

    // Following: only the one, and nothing that was not already visible.
    let (_, mine) = call(
        &app,
        "GET",
        "/v1/feed?following=true",
        Some(&reader.token),
        None,
    )
    .await;
    let posts = mine["posts"].as_array().unwrap();
    assert!(posts.iter().any(|p| p["body"] == "from someone followed"));
    assert!(
        !posts.iter().any(|p| p["body"] == "from a stranger"),
        "the Following feed must not include people who are not followed"
    );
}

#[tokio::test]
async fn a_block_still_wins_over_a_follow() {
    // The rule that matters. Following somebody and then being blocked by them
    // must not leave their posts arriving through a view that skipped the check.
    let app = app_or_skip!();
    let reader = register(&app).await;
    let author = register(&app).await;

    call(
        &app,
        "POST",
        &format!("/v1/users/{}/follow", author.handle),
        Some(&reader.token),
        None,
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&author.token),
        Some(json!({ "body": "before the block", "kind": "text" })),
    )
    .await;
    assert!(status.is_success());

    // The author blocks the reader afterwards.
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", reader.handle),
        Some(&author.token),
        None,
    )
    .await;
    assert!(status.is_success(), "blocking returned {status}");

    let (_, mine) = call(
        &app,
        "GET",
        "/v1/feed?following=true",
        Some(&reader.token),
        None,
    )
    .await;
    let posts = mine["posts"].as_array().unwrap();
    assert!(
        !posts.iter().any(|p| p["body"] == "before the block"),
        "a block must survive an existing follow"
    );
}

#[tokio::test]
async fn following_yourself_is_refused() {
    let app = app_or_skip!();
    let me = register(&app).await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/users/{}/follow", me.handle),
        Some(&me.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn following_an_unknown_handle_is_a_not_found() {
    let app = app_or_skip!();
    let me = register(&app).await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/users/nobodyhere0000/follow",
        Some(&me.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_blocked_account_is_indistinguishable_from_one_that_is_not_there() {
    // "Blocked", "private" and "no such handle" answer identically on purpose:
    // a 403 would confirm the account exists, which is exactly what being
    // absent from search is meant to prevent.
    let app = app_or_skip!();
    let reader = register(&app).await;
    let author = register(&app).await;

    call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", reader.handle),
        Some(&author.token),
        None,
    )
    .await;

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/users/{}/follow", author.handle),
        Some(&reader.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unfollowing_works_even_after_being_blocked() {
    // Otherwise a block would strand a row nobody can remove: the follower can
    // no longer resolve the account, so a visibility check on this path would
    // refuse them the only action that removes their own edge.
    let app = app_or_skip!();
    let reader = register(&app).await;
    let author = register(&app).await;

    call(
        &app,
        "POST",
        &format!("/v1/users/{}/follow", author.handle),
        Some(&reader.token),
        None,
    )
    .await;
    call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", reader.handle),
        Some(&author.token),
        None,
    )
    .await;

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/users/{}/follow", author.handle),
        Some(&reader.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "unfollowing must not require being able to see the account"
    );
}

#[tokio::test]
async fn following_twice_is_not_an_error() {
    let app = app_or_skip!();
    let reader = register(&app).await;
    let author = register(&app).await;
    let path = format!("/v1/users/{}/follow", author.handle);

    for _ in 0..2 {
        let (status, _) = call(&app, "POST", &path, Some(&reader.token), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (_, state) = call(
        &app,
        "GET",
        &format!("/v1/users/{}/follow-state", author.handle),
        Some(&reader.token),
        None,
    )
    .await;
    assert_eq!(state["following"], json!(true));
    assert_eq!(state["followers"], json!(1), "one edge, not two");
}
