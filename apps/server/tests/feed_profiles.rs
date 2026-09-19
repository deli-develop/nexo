//! The feed and profiles, end to end (§4.4, §6.2, §6.3, G2).
//!
//! The tests that matter here are the privacy ones. `profiles.rs` proves the
//! *rule* in unit tests with no database; these prove the rule is actually the
//! one the HTTP handler applies — which is a different claim, and the one that
//! would bite if a handler ever filtered after serialising instead of before.
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
            "display_name": "Feed Test",
            "pw_salt": Uuid::new_v4().simple().to_string(),
            "pw_verifier": "07".repeat(32),
            "identity_pubkey": hex_random(),
        })),
    )
    .await;
    // Never `{session}` in the message: the body holds a live access token and
    // a refresh token, and a failing assertion would print both.
    assert!(
        status.is_success(),
        "register returned {status} for `{handle}`"
    );
    Party {
        token: session["access_token"].as_str().unwrap().to_string(),
        handle,
    }
}

/// A unique 32-byte hex string, for the identity pubkey column's UNIQUE.
fn hex_random() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[tokio::test]
async fn a_post_appears_in_the_feed_and_can_be_deleted_by_its_author() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let (status, post) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&alice.token),
        Some(json!({ "body": "first post" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "create: {post}");
    let id = post["id"].as_i64().unwrap();
    assert_eq!(post["body"], "first post");
    assert_eq!(post["is_mine"], true);

    let (status, page) = call(&app, "GET", "/v1/feed", Some(&alice.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        page["posts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"].as_i64() == Some(id)),
        "the post should be in the feed"
    );

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/posts/{id}"),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_status, page) = call(&app, "GET", "/v1/feed", Some(&alice.token), None).await;
    assert!(
        !page["posts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"].as_i64() == Some(id)),
        "a deleted post must not come back"
    );
}

#[tokio::test]
async fn only_the_author_can_delete_a_post() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mallory = register(&app).await;

    let (_status, post) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&alice.token),
        Some(json!({ "body": "mine" })),
    )
    .await;
    let id = post["id"].as_i64().unwrap();

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/posts/{id}"),
        Some(&mallory.token),
        None,
    )
    .await;
    // 404 rather than 403: telling a stranger the post exists but is not
    // theirs confirms something they had no way to know.
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (_status, page) = call(&app, "GET", "/v1/feed", Some(&alice.token), None).await;
    assert!(
        page["posts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"].as_i64() == Some(id)),
        "the post must still be there"
    );
}

#[tokio::test]
async fn reacting_twice_with_the_same_emoji_counts_once() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;

    let (_status, post) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&alice.token),
        Some(json!({ "body": "react to me" })),
    )
    .await;
    let id = post["id"].as_i64().unwrap();
    let path = format!("/v1/posts/{id}/react");

    for _ in 0..3 {
        let (status, counts) = call(
            &app,
            "POST",
            &path,
            Some(&bob.token),
            Some(json!({ "emoji": "\u{1f44d}" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "react: {counts}");
        assert_eq!(counts[0]["count"], 1, "a repeat must not add a count");
    }

    // A second person is a second count.
    let (_status, counts) = call(
        &app,
        "POST",
        &path,
        Some(&alice.token),
        Some(json!({ "emoji": "\u{1f44d}" })),
    )
    .await;
    assert_eq!(counts[0]["count"], 2);

    // And turning it off removes exactly one.
    let (_status, counts) = call(
        &app,
        "POST",
        &path,
        Some(&bob.token),
        Some(json!({ "emoji": "\u{1f44d}", "on": false })),
    )
    .await;
    assert_eq!(counts[0]["count"], 1);
}

#[tokio::test]
async fn a_post_cannot_claim_someone_elses_image() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    for hostile in [
        "media/999999/11111111-1111-1111-1111-111111111111",
        "enc/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222",
        "../media/1/x",
    ] {
        let (status, body) = call(
            &app,
            "POST",
            "/v1/posts",
            Some(&alice.token),
            Some(json!({ "body": "look", "media_keys": [hostile] })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "`{hostile}`: {body}");
    }
}

#[tokio::test]
async fn a_location_is_not_shown_to_a_stranger_until_it_is_made_public() {
    // G2, over HTTP. The unit tests prove the rule; this proves the handler
    // applies it -- which is what would break if filtering ever moved to the
    // client.
    let app = app_or_skip!();
    let alice = register(&app).await;
    let stranger = register(&app).await;

    let (status, _) = call(
        &app,
        "PATCH",
        "/v1/me",
        Some(&alice.token),
        Some(json!({ "bio": "hello", "location": "Berlin" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let path = format!("/v1/users/{}", alice.handle);

    let (status, seen) = call(&app, "GET", &path, Some(&stranger.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["bio"], "hello", "a bio defaults to public");
    assert!(
        seen["location"].is_null(),
        "a location must default to private: {seen}"
    );

    // Alice opens it deliberately.
    let (status, _) = call(
        &app,
        "PATCH",
        "/v1/me/visibility",
        Some(&alice.token),
        Some(json!({ "visibility": { "location": "public" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (_status, seen) = call(&app, "GET", &path, Some(&stranger.token), None).await;
    assert_eq!(seen["location"], "Berlin");

    // And can close it again.
    let (_status, _) = call(
        &app,
        "PATCH",
        "/v1/me/visibility",
        Some(&alice.token),
        Some(json!({ "visibility": { "location": "private" } })),
    )
    .await;
    let (_status, seen) = call(&app, "GET", &path, Some(&stranger.token), None).await;
    assert!(seen["location"].is_null(), "closing it must take effect");
}

#[tokio::test]
async fn the_owner_always_sees_their_own_private_fields() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    call(
        &app,
        "PATCH",
        "/v1/me",
        Some(&alice.token),
        Some(json!({ "location": "Berlin" })),
    )
    .await;

    // Through the public endpoint, looking at herself.
    let (_status, seen) = call(
        &app,
        "GET",
        &format!("/v1/users/{}", alice.handle),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(seen["location"], "Berlin");
    assert_eq!(seen["is_me"], true);

    // And through /v1/me, which hides nothing and reports every setting.
    let (_status, me) = call(&app, "GET", "/v1/me", Some(&alice.token), None).await;
    assert_eq!(me["location"], "Berlin");
    assert_eq!(me["visibility"]["location"], "private");
    assert_eq!(me["visibility"]["bio"], "public");
}

#[tokio::test]
async fn a_javascript_link_is_refused_at_the_boundary() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let (status, body) = call(
        &app,
        "PATCH",
        "/v1/me",
        Some(&alice.token),
        Some(json!({ "links": [{ "label": "Site", "url": "javascript:alert(1)" }] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // And a real one goes through.
    let (status, me) = call(
        &app,
        "PATCH",
        "/v1/me",
        Some(&alice.token),
        Some(json!({ "links": [{ "label": "Site", "url": "https://example.com" }] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["links"][0]["url"], "https://example.com");
}

#[tokio::test]
async fn the_feed_pages_backwards_without_repeating_or_skipping() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let mut created = Vec::new();
    for i in 0..5 {
        let (_status, post) = call(
            &app,
            "POST",
            "/v1/posts",
            Some(&alice.token),
            Some(json!({ "body": format!("post {i}") })),
        )
        .await;
        created.push(post["id"].as_i64().unwrap());
    }

    // Two pages of two, from this author only, so other tests' posts cannot
    // interleave and make the assertion depend on the whole table.
    let path = format!("/v1/users/{}/posts?limit=2", alice.handle);
    let (_status, first) = call(&app, "GET", &path, Some(&alice.token), None).await;
    let cursor = first["next_cursor"]
        .as_i64()
        .expect("a full page has a cursor");
    let (_status, second) = call(
        &app,
        "GET",
        &format!("{path}&before={cursor}"),
        Some(&alice.token),
        None,
    )
    .await;

    let ids = |page: &Value| -> Vec<i64> {
        page["posts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_i64().unwrap())
            .collect()
    };
    let (a, b) = (ids(&first), ids(&second));
    assert_eq!(a.len(), 2);
    assert_eq!(b.len(), 2);
    assert!(
        a.iter().all(|id| !b.contains(id)),
        "pages must not repeat: {a:?} {b:?}"
    );
    // Reverse-chronological, and contiguous: the four newest, newest first.
    let mut newest: Vec<i64> = created.clone();
    newest.sort_unstable_by(|x, y| y.cmp(x));
    assert_eq!([a, b].concat(), newest[..4].to_vec());
}

#[tokio::test]
async fn an_oversized_post_is_refused() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let (status, _) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&alice.token),
        Some(json!({ "body": "x".repeat(2001) })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Exactly at the limit is fine -- an off-by-one here would be invisible
    // until someone wrote a long post.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&alice.token),
        Some(json!({ "body": "x".repeat(2000) })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_feed_needs_a_token() {
    let app = app_or_skip!();
    let (status, _) = call(&app, "GET", "/v1/feed", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "GET", "/v1/users/nobody", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
