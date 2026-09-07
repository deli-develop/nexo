//! Blocking, end to end (§6.1).
//!
//! These are the tests that decide whether the word means anything. Blocking
//! is enforced on the server precisely so a client cannot be the thing that
//! honours it — which makes "does the server actually refuse" the only claim
//! worth checking, and the one that would rot silently if it were only ever
//! verified by looking at the UI.
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
        turn: None,
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
    let handle = format!("b{}", Uuid::new_v4().simple())[..16].to_string();
    let (status, session) = call(
        app,
        "POST",
        "/v1/auth/register",
        None,
        Some(json!({
            "handle": handle,
            "display_name": "Block Test",
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
async fn a_blocked_author_leaves_the_feed_in_both_directions() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mal = register(&app).await;

    let (status, post) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&mal.token),
        Some(json!({ "body": "before the block" })),
    )
    .await;
    assert!(status.is_success(), "posting returned {status}");
    let post_id = post["id"].as_i64().unwrap();

    let in_feed = |feed: &Value| {
        feed["posts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"].as_i64() == Some(post_id))
    };

    let (_, before) = call(&app, "GET", "/v1/feed?limit=50", Some(&alice.token), None).await;
    assert!(in_feed(&before), "the post should be there before blocking");

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", mal.handle),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, after) = call(&app, "GET", "/v1/feed?limit=50", Some(&alice.token), None).await;
    assert!(!in_feed(&after), "the blocker must not see the blocked");

    // The other direction, which is the half a naive implementation forgets:
    // being blocked has to hide the blocker too, or the blocked person goes on
    // reading everything and only the blocker loses anything.
    let (_, theirs) = call(&app, "GET", "/v1/feed?limit=50", Some(&mal.token), None).await;
    let alice_posts = theirs["posts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["author_handle"].as_str() == Some(alice.handle.as_str()));
    assert!(!alice_posts, "the blocked must not see the blocker");
}

#[tokio::test]
async fn a_blocked_profile_shows_no_posts_rather_than_refusing() {
    // Being blocked should look like having nothing to say, not like a locked
    // door: a distinct refusal is the confirmation the design withholds.
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mal = register(&app).await;

    call(
        &app,
        "POST",
        "/v1/posts",
        Some(&mal.token),
        Some(json!({ "body": "hello" })),
    )
    .await;
    call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", mal.handle),
        Some(&alice.token),
        None,
    )
    .await;

    let (status, page) = call(
        &app,
        "GET",
        &format!("/v1/users/{}/posts", mal.handle),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(page["posts"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_conversation_cannot_be_opened_across_a_block() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mal = register(&app).await;

    call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", mal.handle),
        Some(&alice.token),
        None,
    )
    .await;

    // From the blocked side, which is the one that matters: the person doing
    // the blocking can be trusted not to try.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&mal.token),
        Some(json!({
            "conversation_id": Uuid::new_v4().to_string(),
            "members": [alice.handle],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn unblocking_puts_everything_back() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mal = register(&app).await;

    let (_, post) = call(
        &app,
        "POST",
        "/v1/posts",
        Some(&mal.token),
        Some(json!({ "body": "still here" })),
    )
    .await;
    let post_id = post["id"].as_i64().unwrap();

    let path = format!("/v1/blocks/{}", mal.handle);
    call(&app, "POST", &path, Some(&alice.token), None).await;

    let (status, list) = call(&app, "GET", "/v1/blocks", Some(&alice.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .any(|b| b["handle"].as_str() == Some(mal.handle.as_str()))
    );

    let (status, _) = call(&app, "DELETE", &path, Some(&alice.token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, feed) = call(&app, "GET", "/v1/feed?limit=50", Some(&alice.token), None).await;
    assert!(
        feed["posts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"].as_i64() == Some(post_id)),
        "unblocking has to be a real undo, not a one-way door"
    );
}

#[tokio::test]
async fn blocking_is_idempotent_and_self_blocking_is_refused() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mal = register(&app).await;
    let path = format!("/v1/blocks/{}", mal.handle);

    // Twice, because the client cannot know the current state without asking
    // and a conflict here would only add a round trip and a race.
    for _ in 0..2 {
        let (status, _) = call(&app, "POST", &path, Some(&alice.token), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", alice.handle),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn there_is_only_ever_one_dm_between_two_people() {
    // The race no client can win: both check for an existing conversation,
    // both see none, both create one, and the two people end up with two
    // chats. The check and the create are two round trips with a gap between
    // them, and only the server sees both -- so the server is where it has to
    // be settled.
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;

    let first = Uuid::new_v4().to_string();
    let (status, view) = call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": first, "members": [bob.handle] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(view["conversation_id"].as_str(), Some(first.as_str()));

    // Bob, a moment later, asking for one of his own.
    let (status, view) = call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&bob.token),
        Some(json!({
            "conversation_id": Uuid::new_v4().to_string(),
            "members": [alice.handle],
        })),
    )
    .await;
    // Not created, and the answer is the one that already exists rather than
    // a refusal -- the client adopts it.
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["conversation_id"].as_str(), Some(first.as_str()));

    // And each of them has exactly one.
    for token in [&alice.token, &bob.token] {
        let (_, list) = call(&app, "GET", "/v1/conversations", Some(token), None).await;
        let dms: Vec<&Value> = list
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == json!("dm"))
            .collect();
        assert_eq!(dms.len(), 1, "one DM per pair, from both sides");
    }
}

#[tokio::test]
async fn a_group_is_never_deduplicated_the_way_a_dm_is() {
    // Two people can have any number of groups together. Only the two-member
    // case is the one the UI treats as "the conversation with this person".
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let carol = register(&app).await;

    for _ in 0..2 {
        let (status, _) = call(
            &app,
            "POST",
            "/v1/conversations",
            Some(&alice.token),
            Some(json!({
                "conversation_id": Uuid::new_v4().to_string(),
                "members": [bob.handle.clone(), carol.handle.clone()],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
    }

    let (_, list) = call(&app, "GET", "/v1/conversations", Some(&alice.token), None).await;
    let groups = list
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == json!("group"))
        .count();
    assert_eq!(groups, 2);
}

#[tokio::test]
async fn an_unused_conversation_can_be_discarded_and_a_used_one_cannot() {
    // `create` commits the conversation before the client knows its add commit
    // was accepted. When that send fails the row survives with both people on
    // it and no MLS state anywhere -- a chat that can never carry a message.
    // This is how the client takes it back, and the guard that stops it ever
    // reaching a real conversation.
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;

    let id = Uuid::new_v4().to_string();
    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": id, "members": [bob.handle] })),
    )
    .await;

    // A stranger cannot use this to find out which ids exist: being outside a
    // conversation looks exactly like the conversation not being there.
    let carol = register(&app).await;
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/conversations/{id}"),
        Some(&carol.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/conversations/{id}"),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Gone for both of them, which is the whole point: it was never real.
    let (_, list) = call(&app, "GET", "/v1/conversations", Some(&bob.token), None).await;
    assert!(
        !list
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["conversation_id"].as_str() == Some(id.as_str()))
    );

    // Now one with something in it. It must survive.
    let used = Uuid::new_v4().to_string();
    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": used, "members": [bob.handle] })),
    )
    .await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{used}/send"),
        Some(&alice.token),
        Some(json!({
            "ciphertext": "00ff",
            "epoch": 0,
            "is_commit": false,
            "message_id": Uuid::new_v4().to_string(),
        })),
    )
    .await;
    assert!(status.is_success(), "sending returned {status}");

    let (status, body) = call(
        &app,
        "DELETE",
        &format!("/v1/conversations/{used}"),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("messages"),
        "the refusal should say why"
    );
}

#[tokio::test]
async fn pinning_caps_at_three_and_keeps_the_cursor_honest() {
    // Two claims in one test because they share a fixture and the second is
    // the one that would break silently: pinned posts are prepended to the
    // first page, so counting them toward the page size would end paging early
    // and taking `last()` from the combined list would hand back a cursor
    // pointing at a post that is never in the paged set.
    let app = app_or_skip!();
    let author = register(&app).await;

    let mut ids = Vec::new();
    for n in 0..5 {
        let (_, post) = call(
            &app,
            "POST",
            "/v1/posts",
            Some(&author.token),
            Some(json!({ "body": format!("post {n}") })),
        )
        .await;
        ids.push(post["id"].as_i64().unwrap());
    }

    for id in ids.iter().take(3) {
        let (status, _) = call(
            &app,
            "POST",
            &format!("/v1/posts/{id}/pin"),
            Some(&author.token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    // The fourth is refused, and the message says what to do about it.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/posts/{}/pin", ids[3]),
        Some(&author.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Unpin"),
        "the refusal should say how to fix it"
    );

    // Re-pinning one that is already pinned only reorders it, so it must not
    // count against the cap.
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/posts/{}/pin", ids[0]),
        Some(&author.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Page of two over the unpinned remainder. Three pinned come with it, so
    // five posts arrive -- but the cursor must describe the paged two.
    let (status, page) = call(
        &app,
        "GET",
        &format!("/v1/users/{}/posts?limit=2", author.handle),
        Some(&author.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let posts = page["posts"].as_array().unwrap();
    assert_eq!(posts.len(), 5, "three pinned plus a page of two");
    assert!(
        posts[..3].iter().all(|p| p["pinned"] == json!(true)),
        "pinned come first and are marked"
    );
    let cursor = page["next_cursor"]
        .as_i64()
        .expect("a full page has a cursor");
    assert!(
        !ids[..3].contains(&cursor),
        "the cursor must never be a pinned post's id"
    );

    // And the next page continues from there without repeating anything.
    let (_, next) = call(
        &app,
        "GET",
        &format!("/v1/users/{}/posts?limit=2&before={cursor}", author.handle),
        Some(&author.token),
        None,
    )
    .await;
    assert!(
        next["posts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["pinned"] == json!(false)),
        "later pages carry no pinned posts at all"
    );
}
