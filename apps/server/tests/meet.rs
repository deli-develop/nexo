//! Meet&Greet, end to end.
//!
//! Four claims are checked here, and each is one the client cannot be trusted
//! to keep on the server's behalf:
//!
//!   * a submitted pin is never what gets stored;
//!   * the same account is coarsened identically every time, so saving twice
//!     discloses no more than saving once;
//!   * a blocked person is off the map in both directions;
//!   * an intro buys one message, and the second is refused by the server.
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

/// Whether a handle is anywhere on the map, following the cursor to the end.
///
/// The map is paged — five hundred pins at a time, keyset on the handle — and
/// this suite runs against a shared development database that every previous
/// run has added to and none has cleaned up. Reading only the first page
/// therefore asks "is this handle among the first five hundred alphabetically",
/// which is a different question and one that quietly stops matching the first
/// as the database fills. It passed on a fresh database and failed on a used
/// one, which is the worst way for a test to be wrong.
///
/// Walking the pages asks what the test means to ask. Termination is the
/// cursor's: each page starts strictly after the last handle of the one
/// before, so the walk always advances.
async fn on_map(app: &axum::Router, token: &str, handle: &str) -> bool {
    let mut after: Option<String> = None;
    loop {
        let path = match &after {
            Some(cursor) => format!("/v1/meet/pins?after={cursor}"),
            None => "/v1/meet/pins".to_string(),
        };
        let (status, pins) = call(app, "GET", &path, Some(token), None).await;
        assert!(status.is_success(), "the map returned {status}");

        let page = pins.as_array().expect("the map is an array");
        if page.is_empty() {
            return false;
        }
        if page.iter().any(|pin| pin["handle"] == handle) {
            return true;
        }
        match page.last().and_then(|pin| pin["handle"].as_str()) {
            Some(last) => after = Some(last.to_string()),
            None => return false,
        }
    }
}

async fn register(app: &axum::Router) -> Party {
    let handle = format!("m{}", Uuid::new_v4().simple())[..16].to_string();
    let (status, session) = call(
        app,
        "POST",
        "/v1/auth/register",
        None,
        Some(json!({
            "handle": handle,
            "display_name": "Meet Test",
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

/// Accept the agreement and drop a pin. Returns what the server stored.
async fn place(app: &axum::Router, who: &Party, lat: f64, lon: f64) -> Value {
    let (status, _) = call(
        app,
        "POST",
        "/v1/meet/consent",
        Some(&who.token),
        Some(json!({ "version": 1 })),
    )
    .await;
    assert!(status.is_success(), "consent returned {status}");

    let (status, _) = call(
        app,
        "PUT",
        "/v1/meet/me",
        Some(&who.token),
        Some(json!({
            "lat": lat,
            "lon": lon,
            "char_config": { "topVariant": "hoodie" },
            "active": true,
        })),
    )
    .await;
    assert!(status.is_success(), "PUT /v1/meet/me returned {status}");

    let (status, mine) = call(app, "GET", "/v1/meet/me", Some(&who.token), None).await;
    assert_eq!(status, StatusCode::OK);
    mine
}

#[tokio::test]
async fn the_pin_that_is_stored_is_never_the_pin_that_was_sent() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let lat = 47.376_9;
    let lon = 8.541_7;
    let stored = place(&app, &alice, lat, lon).await;

    assert_ne!(
        stored["lat"].as_f64().unwrap(),
        lat,
        "the submitted latitude must not survive the write"
    );
    assert_ne!(stored["lon"].as_f64().unwrap(), lon);

    // Still roughly where they said, or the feature does not work.
    assert!((stored["lat"].as_f64().unwrap() - lat).abs() < 0.5);
    assert!((stored["lon"].as_f64().unwrap() - lon).abs() < 0.5);
}

/// Saving twice must disclose no more than saving once.
#[tokio::test]
async fn moving_a_pin_back_lands_it_in_the_same_place_again() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let first = place(&app, &alice, 47.376_9, 8.541_7).await;
    let elsewhere = place(&app, &alice, 12.0, 34.0).await;
    let back = place(&app, &alice, 47.376_9, 8.541_7).await;

    assert_ne!(first["lat"], elsewhere["lat"], "the pin should have moved");
    assert_eq!(
        first["lat"], back["lat"],
        "a re-rolled jitter would let an observer average the offsets away"
    );
    assert_eq!(first["lon"], back["lon"]);
}

#[tokio::test]
async fn a_blocked_person_is_off_the_map_in_both_directions() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mal = register(&app).await;

    place(&app, &alice, 47.0, 8.0).await;
    place(&app, &mal, 47.1, 8.1).await;

    assert!(
        on_map(&app, &alice.token, &mal.handle).await,
        "they start out visible"
    );

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", mal.handle),
        Some(&alice.token),
        None,
    )
    .await;
    assert!(status.is_success(), "block returned {status}");

    assert!(
        !on_map(&app, &alice.token, &mal.handle).await,
        "the blocked pin must be gone"
    );

    // And the other way, which is the half a client-side filter would miss.
    assert!(
        !on_map(&app, &mal.token, &alice.handle).await,
        "blocking removes both pins, not one"
    );
}

#[tokio::test]
async fn the_map_needs_the_agreement_first() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let (status, body) = call(
        &app,
        "PUT",
        "/v1/meet/me",
        Some(&alice.token),
        Some(json!({ "lat": 1.0, "lon": 2.0, "char_config": {} })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "consent_required");
}

/// A conversation, and the request that makes it an intro.
async fn intro(app: &axum::Router, from: &Party, to: &Party) -> Uuid {
    let conversation_id = Uuid::new_v4();
    let (status, _) = call(
        app,
        "POST",
        "/v1/conversations",
        Some(&from.token),
        Some(json!({
            "conversation_id": conversation_id,
            "members": [to.handle],
        })),
    )
    .await;
    assert!(status.is_success(), "create conversation returned {status}");

    let (status, _) = call(
        app,
        "POST",
        "/v1/meet/requests",
        Some(&from.token),
        Some(json!({ "handle": to.handle, "conversation_id": conversation_id })),
    )
    .await;
    assert!(status.is_success(), "open request returned {status}");
    conversation_id
}

async fn send(app: &axum::Router, who: &Party, conversation: Uuid, text: &str) -> StatusCode {
    let (status, _) = call(
        app,
        "POST",
        &format!("/v1/conversations/{conversation}/send"),
        Some(&who.token),
        Some(json!({
            "ciphertext": hex_of(text),
            "epoch": 0,
            "is_commit": false,
            "client_msg_id": Uuid::new_v4(),
        })),
    )
    .await;
    status
}

fn hex_of(text: &str) -> String {
    text.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// The rule the whole feature rests on, and the one a client cannot keep.
#[tokio::test]
async fn an_intro_buys_exactly_one_message() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    place(&app, &alice, 47.0, 8.0).await;
    place(&app, &bob, 48.0, 9.0).await;

    let conversation = intro(&app, &alice, &bob).await;

    assert!(
        send(&app, &alice, conversation, "hello").await.is_success(),
        "the first message is the whole point"
    );
    assert_eq!(
        send(&app, &alice, conversation, "hello again").await,
        StatusCode::FORBIDDEN,
        "the second must be refused by the server, not by the app"
    );
}

#[tokio::test]
async fn answering_an_intro_lifts_the_cap() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    place(&app, &alice, 47.0, 8.0).await;
    place(&app, &bob, 48.0, 9.0).await;

    let conversation = intro(&app, &alice, &bob).await;
    assert!(send(&app, &alice, conversation, "hello").await.is_success());

    let (_, inbox) = call(&app, "GET", "/v1/meet/requests", Some(&bob.token), None).await;
    let id = inbox.as_array().unwrap()[0]["id"].as_i64().unwrap();

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/meet/requests/{id}/accept"),
        Some(&bob.token),
        None,
    )
    .await;
    assert!(status.is_success(), "accept returned {status}");

    assert!(
        send(&app, &alice, conversation, "thanks")
            .await
            .is_success(),
        "once answered it is an ordinary conversation"
    );
}

/// A retry and a second attempt look identical from the handler; only the
/// UNIQUE constraint can tell them apart, and it must not produce two.
#[tokio::test]
async fn a_repeated_intro_is_refused_rather_than_duplicated() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    place(&app, &alice, 47.0, 8.0).await;
    place(&app, &bob, 48.0, 9.0).await;

    let first = intro(&app, &alice, &bob).await;

    let second = Uuid::new_v4();
    let (status, _) = call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": second, "members": [bob.handle] })),
    )
    .await;
    assert!(status.is_success());

    let (status, _) = call(
        &app,
        "POST",
        "/v1/meet/requests",
        Some(&alice.token),
        Some(json!({ "handle": bob.handle, "conversation_id": second })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a second intro is refused");

    let (_, inbox) = call(&app, "GET", "/v1/meet/requests", Some(&bob.token), None).await;
    let waiting = inbox.as_array().unwrap();
    assert_eq!(waiting.len(), 1, "one intro, however many times it is sent");
    assert_eq!(waiting[0]["conversation_id"], json!(first));
}

#[tokio::test]
async fn leaving_the_map_keeps_the_character() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    place(&app, &alice, 47.0, 8.0).await;

    let (status, _) = call(&app, "DELETE", "/v1/meet/me", Some(&alice.token), None).await;
    assert!(status.is_success());

    let (status, _) = call(&app, "GET", "/v1/meet/me", Some(&alice.token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "off the map");

    // Coming back is one tap, and the character is still there.
    let (status, _) = call(
        &app,
        "PUT",
        "/v1/meet/me",
        Some(&alice.token),
        Some(json!({ "active": true })),
    )
    .await;
    assert!(status.is_success(), "returning returned {status}");

    let (status, mine) = call(&app, "GET", "/v1/meet/me", Some(&alice.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mine["char_config"]["topVariant"], "hoodie");
}

// ------------------------------------------------------ private accounts ---

async fn go_private(app: &axum::Router, who: &Party) {
    let (status, _) = call(
        app,
        "PATCH",
        "/v1/me",
        Some(&who.token),
        Some(json!({ "is_private": true })),
    )
    .await;
    assert!(status.is_success(), "going private returned {status}");
}

async fn mint_invite(app: &axum::Router, who: &Party, days: i64) -> (i64, String) {
    let (status, body) = call(
        app,
        "POST",
        "/v1/meet/invites",
        Some(&who.token),
        Some(json!({ "label": "a friend", "days": days })),
    )
    .await;
    assert!(status.is_success(), "minting returned {status}");
    (
        body["id"].as_i64().unwrap(),
        body["secret"].as_str().unwrap().to_string(),
    )
}

async fn try_open(
    app: &axum::Router,
    from: &Party,
    to: &Party,
    invite: Option<&str>,
) -> StatusCode {
    let mut payload = json!({
        "conversation_id": Uuid::new_v4(),
        "members": [to.handle],
    });
    if let Some(secret) = invite {
        payload["invite"] = json!(secret);
    }
    let (status, _) = call(
        app,
        "POST",
        "/v1/conversations",
        Some(&from.token),
        Some(payload),
    )
    .await;
    status
}

#[tokio::test]
async fn a_public_account_is_findable_and_a_private_one_is_not() {
    let app = app_or_skip!();
    let seeker = register(&app).await;
    let open = register(&app).await;
    let shy = register(&app).await;
    go_private(&app, &shy).await;

    let found = |body: &Value, handle: &str| -> bool {
        body.as_array()
            .unwrap()
            .iter()
            .any(|r| r["handle"] == handle)
    };

    let (status, body) = call(
        &app,
        "GET",
        &format!("/v1/users?q={}", open.handle),
        Some(&seeker.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(found(&body, &open.handle), "a public account is findable");

    let (_, body) = call(
        &app,
        "GET",
        &format!("/v1/users?q={}", shy.handle),
        Some(&seeker.token),
        None,
    )
    .await;
    assert!(
        !found(&body, &shy.handle),
        "a private account must not appear in search"
    );
}

/// The half that makes the word mean something. Hiding somebody from search
/// while leaving them writable would be the switch `profiles.rs` refused.
#[tokio::test]
async fn a_private_account_cannot_be_written_to_without_an_invite() {
    let app = app_or_skip!();
    let stranger = register(&app).await;
    let shy = register(&app).await;
    go_private(&app, &shy).await;

    assert_eq!(
        try_open(&app, &stranger, &shy, None).await,
        StatusCode::FORBIDDEN,
        "no invitation, no conversation"
    );

    let (_, secret) = mint_invite(&app, &shy, 7).await;
    assert!(
        try_open(&app, &stranger, &shy, Some(&secret))
            .await
            .is_success(),
        "a live invitation opens the door"
    );
}

#[tokio::test]
async fn a_revoked_invite_is_refused() {
    let app = app_or_skip!();
    let stranger = register(&app).await;
    let shy = register(&app).await;
    go_private(&app, &shy).await;

    let (id, secret) = mint_invite(&app, &shy, 7).await;
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/meet/invites/{id}"),
        Some(&shy.token),
        None,
    )
    .await;
    assert!(status.is_success(), "revoking returned {status}");

    assert_eq!(
        try_open(&app, &stranger, &shy, Some(&secret)).await,
        StatusCode::FORBIDDEN,
        "a withdrawn invitation is not an invitation"
    );
}

/// Liveness is decided in the query, so an expired invite stops working the
/// moment it expires — not when some job gets round to it.
#[tokio::test]
async fn an_expired_invite_is_refused() {
    let app = app_or_skip!();
    let stranger = register(&app).await;
    let shy = register(&app).await;
    go_private(&app, &shy).await;

    let (id, secret) = mint_invite(&app, &shy, 1).await;

    // Age it past its expiry. There is no clock to move, so the row moves --
    // and both timestamps have to, because the table's own CHECK refuses an
    // expiry that precedes its creation. (That refusal is the constraint
    // working; it caught this test's first version.)
    let url = std::env::var("DATABASE_URL").unwrap();
    let pool = db::create_pool(&url).await.unwrap();
    sqlx::query(
        "UPDATE meet_invites
         SET created_at = now() - INTERVAL '2 days',
             expires_at = now() - INTERVAL '1 minute'
         WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        try_open(&app, &stranger, &shy, Some(&secret)).await,
        StatusCode::FORBIDDEN,
        "an expired invitation is not an invitation"
    );
}

#[tokio::test]
async fn an_invitation_cannot_outlast_a_week() {
    let app = app_or_skip!();
    let shy = register(&app).await;

    let (status, _) = call(
        &app,
        "POST",
        "/v1/meet/invites",
        Some(&shy.token),
        Some(json!({ "days": 30 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// Somebody already in touch does not need an invitation to write again.
#[tokio::test]
async fn going_private_does_not_cut_off_people_already_in_touch() {
    let app = app_or_skip!();
    let friend = register(&app).await;
    let shy = register(&app).await;

    assert!(
        try_open(&app, &friend, &shy, None).await.is_success(),
        "they talked while the account was public"
    );

    go_private(&app, &shy).await;

    assert!(
        try_open(&app, &friend, &shy, None).await.is_success(),
        "an existing contact keeps its way in"
    );
}

// ---------------------------------------------------------------- stories ---

async fn post_story(app: &axum::Router, who: &Party) -> i64 {
    let (status, body) = call(
        app,
        "POST",
        "/v1/stories",
        Some(&who.token),
        Some(json!({
            "s3_key": format!("enc/{}/{}", Uuid::new_v4(), Uuid::new_v4()),
            "size": 4096,
        })),
    )
    .await;
    assert!(status.is_success(), "posting a story returned {status}");
    body["id"].as_i64().unwrap()
}

async fn stories_for(app: &axum::Router, who: &Party) -> Value {
    let (status, body) = call(app, "GET", "/v1/stories", Some(&who.token), None).await;
    assert_eq!(status, StatusCode::OK);
    body
}

fn lists(body: &Value, id: i64) -> bool {
    body.as_array().unwrap().iter().any(|s| s["id"] == id)
}

/// The audience is contacts, and "contact" here means exactly what the server
/// already meant by it: sharing a conversation.
#[tokio::test]
async fn a_story_reaches_contacts_and_nobody_else() {
    let app = app_or_skip!();
    let author = register(&app).await;
    let friend = register(&app).await;
    let stranger = register(&app).await;

    // A conversation is what makes somebody a contact.
    assert!(try_open(&app, &author, &friend, None).await.is_success());

    let id = post_story(&app, &author).await;

    assert!(
        lists(&stories_for(&app, &friend).await, id),
        "a contact sees it"
    );
    assert!(
        !lists(&stories_for(&app, &stranger).await, id),
        "somebody with no conversation does not"
    );
    assert!(
        lists(&stories_for(&app, &author).await, id),
        "and so does the author"
    );
}

/// Blocking works here without a line of story-specific code, which is the
/// whole reason for not building a story group: `blocked_between` only ever
/// applied to two-member conversations, and a group would have slipped past it.
#[tokio::test]
async fn blocking_takes_a_story_away_in_both_directions() {
    let app = app_or_skip!();
    let author = register(&app).await;
    let reader = register(&app).await;
    assert!(try_open(&app, &author, &reader, None).await.is_success());

    let mine = post_story(&app, &author).await;
    let theirs = post_story(&app, &reader).await;
    assert!(lists(&stories_for(&app, &reader).await, mine));

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/blocks/{}", author.handle),
        Some(&reader.token),
        None,
    )
    .await;
    assert!(status.is_success());

    assert!(
        !lists(&stories_for(&app, &reader).await, mine),
        "a blocked author's story is gone"
    );
    assert!(
        !lists(&stories_for(&app, &author).await, theirs),
        "and the other direction too"
    );
}

/// The layer that turns 24 hours from a courtesy into a property: past it,
/// nobody gets the bytes, whatever client they use.
#[tokio::test]
async fn an_expired_story_is_neither_listed_nor_served() {
    let app = app_or_skip!();
    let author = register(&app).await;
    let friend = register(&app).await;
    assert!(try_open(&app, &author, &friend, None).await.is_success());

    let id = post_story(&app, &author).await;
    assert!(lists(&stories_for(&app, &friend).await, id));

    // Age it. Both timestamps move, because the table refuses an expiry that
    // precedes creation.
    let url = std::env::var("DATABASE_URL").unwrap();
    let pool = db::create_pool(&url).await.unwrap();
    sqlx::query(
        "UPDATE stories
         SET created_at = now() - INTERVAL '25 hours',
             expires_at = now() - INTERVAL '1 hour'
         WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();

    assert!(
        !lists(&stories_for(&app, &friend).await, id),
        "an expired story is not listed"
    );

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/stories/{id}/url"),
        Some(&friend.token),
        None,
    )
    .await;
    assert_ne!(status, StatusCode::OK, "and no URL is issued for it either");
}

/// A stranger cannot get a URL even knowing the id.
#[tokio::test]
async fn a_stranger_is_refused_a_story_url() {
    let app = app_or_skip!();
    let author = register(&app).await;
    let stranger = register(&app).await;
    let id = post_story(&app, &author).await;

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/stories/{id}/url"),
        Some(&stranger.token),
        None,
    )
    .await;
    assert_ne!(status, StatusCode::OK, "not a contact, no bytes");
}

/// A story cannot be minted to outlive its promise.
#[tokio::test]
async fn a_story_expires_within_a_day() {
    let app = app_or_skip!();
    let author = register(&app).await;
    let id = post_story(&app, &author).await;

    let body = stories_for(&app, &author).await;
    let story = body
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == id)
        .unwrap();
    let life = story["expires_at_ms"].as_i64().unwrap() - story["created_at_ms"].as_i64().unwrap();
    assert!(
        life <= 24 * 60 * 60 * 1000,
        "at most 24 hours, got {life}ms"
    );
    assert!(life > 23 * 60 * 60 * 1000, "and not much less");
}

/// The seam the first version of stories fell through.
///
/// Every other story test posts a *fabricated* `s3_key` straight to
/// `/v1/stories`, which exercised the bookkeeping and never the upload. The
/// upload could not have worked: it borrowed a random conversation id, and the
/// attachment route checks membership, so nobody is a member of a conversation
/// that does not exist.
#[tokio::test]
async fn a_story_gets_an_upload_url_without_belonging_to_a_conversation() {
    let app = app_or_skip!();
    let author = register(&app).await;

    let (status, body) = call(
        &app,
        "POST",
        "/v1/media/upload",
        Some(&author.token),
        Some(json!({ "bucket": "story", "size": 4096 })),
    )
    .await;

    // The claim under test is that the *request* is valid without a
    // conversation. Validation now runs before the storage lookup, so a
    // deployment with no object store answers `503 unavailable` rather than
    // `400 invalid` — and only `400` would mean the bug is back.
    assert_ne!(
        status,
        StatusCode::BAD_REQUEST,
        "a story upload must not need a conversation"
    );

    if status == StatusCode::SERVICE_UNAVAILABLE {
        eprintln!("object storage not configured: prefix not asserted");
        return;
    }
    assert!(status.is_success(), "expected an upload URL, got {status}");

    let key = body["key"].as_str().expect("a key");
    assert!(
        key.starts_with("story/"),
        "a story needs its own prefix so a lifecycle rule can reach it          without reaching every attachment: got {key}"
    );
}

/// An attachment upload still needs a conversation, and still checks it.
#[tokio::test]
async fn an_attachment_upload_still_needs_a_conversation_you_are_in() {
    let app = app_or_skip!();
    let author = register(&app).await;

    let (status, _) = call(
        &app,
        "POST",
        "/v1/media/upload",
        Some(&author.token),
        Some(json!({
            "bucket": "encrypted",
            "conversation_id": Uuid::new_v4(),
            "size": 10,
        })),
    )
    .await;
    // `400`, not `503`: this is refused because the request is wrong, and it
    // stays refused on a deployment with no object storage at all.
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a conversation you are not in must not yield an upload URL"
    );
}

/// The generic download route must not hand out a story: its audience rules
/// live in `stories.rs`, which has the row to check them against.
#[tokio::test]
async fn the_media_route_refuses_to_serve_a_story() {
    let app = app_or_skip!();
    let reader = register(&app).await;

    let (status, _) = call(
        &app,
        "POST",
        "/v1/media/download",
        Some(&reader.token),
        Some(json!({ "bucket": "story", "key": "story/whatever" })),
    )
    .await;
    assert_ne!(status, StatusCode::OK, "stories go through their own route");
}
