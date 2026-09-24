//! Teams, end to end: roles over a conversation, enforced on the server.
//!
//! Routing only. Nothing here builds an MLS group, because nothing the server
//! decides about a team depends on one: who may add, remove, promote, hand on
//! and delete is decided from `conversation_members`, and the ciphertext the
//! members exchange is opaque to every test below exactly as it is to the
//! server. `packages/crypto-wasm` is where the same flow runs with real MLS.
//!
//! The database is shared and never cleaned, so every assertion is about this
//! test's own team and its own freshly registered people -- never a global
//! count (`docs/CONTEXT.md`, *Conventions*).
//!
//! Skips cleanly with no `DATABASE_URL`, like the rest of the suite.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use nexo_crypto::identity::IdentityKeypair;
use nexo_protocol::ServerEvent;
use nexo_server::stream::hub::{Fanout, LocalHub};
use nexo_server::{AppState, TokenKeys, db, router};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tower::ServiceExt;
use uuid::Uuid;

const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
    MC4CAQAwBQYDK2VwBCIEIBD8O+mO1pxsOJPSKpso2043G54kPXsxDyl6dTJ6H5Io\n\
    -----END PRIVATE KEY-----\n";

/// The app, and the hub it publishes to, so a test can listen.
struct World {
    app: axum::Router,
    hub: Arc<LocalHub>,
    db: sqlx::PgPool,
}

async fn world() -> Option<World> {
    let _ = dotenvy::dotenv();
    let url = std::env::var("DATABASE_URL").ok()?;
    let db = db::create_pool(&url)
        .await
        .expect("connect to the database");
    let hub = Arc::new(LocalHub::new());
    let app = router(AppState {
        db: db.clone(),
        auth: Arc::new(TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes()).unwrap()),
        storage: None,
        fanout: hub.clone(),
        limits: Arc::new(nexo_server::limits::Limits::permissive()),
    });
    Some(World { app, hub, db })
}

macro_rules! world_or_skip {
    () => {
        match world().await {
            Some(world) => world,
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Person {
    token: String,
    handle: String,
    user_id: i64,
}

async fn register(app: &axum::Router) -> Person {
    let handle = format!("t{}", Uuid::new_v4().simple())[..16].to_string();
    let identity = IdentityKeypair::generate();
    let (status, session) = call(
        app,
        "POST",
        "/v1/auth/register",
        None,
        Some(json!({
            "handle": handle,
            "display_name": "Team Test",
            "pw_salt": Uuid::new_v4().simple().to_string(),
            "pw_verifier": hex(&[7u8; 32]),
            "identity_pubkey": hex(&identity.public_bytes()),
        })),
    )
    .await;
    assert!(status.is_success(), "register: {status} {session}");
    Person {
        token: session["access_token"].as_str().unwrap().to_string(),
        handle,
        user_id: session["user_id"].as_i64().unwrap(),
    }
}

/// A team owned by `owner`, with `members` added by the owner.
async fn team(app: &axum::Router, owner: &Person, members: &[&Person]) -> Uuid {
    let id = Uuid::new_v4();
    let (status, body) = call(
        app,
        "POST",
        "/v1/teams",
        Some(&owner.token),
        Some(json!({ "conversation_id": id })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    for person in members {
        let (status, body) = add(app, owner, id, person).await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    }
    id
}

async fn add(app: &axum::Router, by: &Person, team: Uuid, who: &Person) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/v1/conversations/{team}/members"),
        Some(&by.token),
        Some(json!({ "handle": who.handle })),
    )
    .await
}

async fn remove(app: &axum::Router, by: &Person, team: Uuid, who: &Person) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/v1/conversations/{team}/members/remove"),
        Some(&by.token),
        Some(json!({ "handle": who.handle })),
    )
    .await
}

async fn set_role(
    app: &axum::Router,
    by: &Person,
    team: Uuid,
    who: &Person,
    role: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "PATCH",
        &format!("/v1/teams/{team}/members/{}", who.handle),
        Some(&by.token),
        Some(json!({ "role": role })),
    )
    .await
}

async fn transfer(app: &axum::Router, by: &Person, team: Uuid, to: &Person) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/v1/teams/{team}/transfer"),
        Some(&by.token),
        Some(json!({ "handle": to.handle })),
    )
    .await
}

async fn leave(app: &axum::Router, who: &Person, team: Uuid) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/v1/teams/{team}/leave"),
        Some(&who.token),
        None,
    )
    .await
}

async fn delete_team(app: &axum::Router, who: &Person, team: Uuid) -> (StatusCode, Value) {
    call(
        app,
        "DELETE",
        &format!("/v1/teams/{team}"),
        Some(&who.token),
        None,
    )
    .await
}

async fn roster(app: &axum::Router, by: &Person, team: Uuid) -> Vec<Value> {
    let (status, body) = call(
        app,
        "GET",
        &format!("/v1/teams/{team}/members"),
        Some(&by.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body.as_array().unwrap().clone()
}

fn role_of(roster: &[Value], who: &Person) -> Option<String> {
    roster
        .iter()
        .find(|m| m["handle"] == who.handle.as_str())
        .map(|m| m["role"].as_str().unwrap().to_string())
}

async fn lists(app: &axum::Router, who: &Person, path: &str, team: Uuid) -> Option<Value> {
    let (_, list) = call(app, "GET", path, Some(&who.token), None).await;
    list.as_array()
        .unwrap()
        .iter()
        .find(|c| c["conversation_id"] == team.to_string())
        .cloned()
}

#[tokio::test]
async fn a_team_starts_with_its_creator_as_owner_and_stays_a_team() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let carol = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob, &carol]).await;

    let mine = lists(&w.app, &owner, "/v1/teams", id)
        .await
        .expect("listed");
    assert_eq!(mine["role"], "owner");
    assert_eq!(mine["member_count"], 3);
    let theirs = lists(&w.app, &bob, "/v1/teams", id).await.expect("listed");
    assert_eq!(theirs["role"], "member");

    // Three people is where a 1:1 becomes a group. A team must not.
    let conversation = lists(&w.app, &owner, "/v1/conversations", id)
        .await
        .expect("a team is a conversation");
    assert_eq!(conversation["kind"], "team");
}

#[tokio::test]
async fn a_member_cannot_add_or_remove_in_a_team_but_still_can_in_a_group() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let carol = register(&w.app).await;
    let dave = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob, &carol]).await;

    let (status, body) = add(&w.app, &bob, id, &dave).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "not_permitted");
    let (status, _) = remove(&w.app, &bob, id, &carol).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        role_of(&roster(&w.app, &owner, id).await, &carol).as_deref(),
        Some("member")
    );

    // A group keeps its rule: anybody in it may add or remove.
    let group = Uuid::new_v4();
    call(
        &w.app,
        "POST",
        "/v1/conversations",
        Some(&owner.token),
        Some(json!({ "conversation_id": group, "members": [bob.handle, carol.handle] })),
    )
    .await;
    assert_eq!(
        add(&w.app, &bob, group, &dave).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        remove(&w.app, &bob, group, &carol).await.0,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn removal_goes_down_the_ladder_only() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let carol = register(&w.app).await;
    let dave = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob, &carol, &dave]).await;
    assert_eq!(
        set_role(&w.app, &owner, id, &bob, "admin").await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        set_role(&w.app, &owner, id, &carol, "admin").await.0,
        StatusCode::NO_CONTENT
    );

    // An admin removes neither the owner nor another admin.
    assert_eq!(
        remove(&w.app, &bob, id, &owner).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        remove(&w.app, &bob, id, &carol).await.0,
        StatusCode::FORBIDDEN
    );
    // An admin removes a member, and the owner removes an admin.
    assert_eq!(
        remove(&w.app, &bob, id, &dave).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        remove(&w.app, &owner, id, &carol).await.0,
        StatusCode::NO_CONTENT
    );

    let now = roster(&w.app, &owner, id).await;
    assert_eq!(role_of(&now, &carol), None);
    assert_eq!(role_of(&now, &dave), None);
    assert_eq!(role_of(&now, &owner).as_deref(), Some("owner"));
}

#[tokio::test]
async fn an_admin_promotes_but_only_the_owner_demotes() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let carol = register(&w.app).await;
    let dave = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob, &carol, &dave]).await;
    set_role(&w.app, &owner, id, &bob, "admin").await;

    assert_eq!(
        set_role(&w.app, &bob, id, &carol, "admin").await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        set_role(&w.app, &bob, id, &carol, "member").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        set_role(&w.app, &dave, id, &dave, "admin").await.0,
        StatusCode::FORBIDDEN
    );
    // Ownership is handed on, never set.
    assert_eq!(
        set_role(&w.app, &owner, id, &bob, "owner").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        set_role(&w.app, &owner, id, &bob, "editor").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        set_role(&w.app, &owner, id, &carol, "member").await.0,
        StatusCode::NO_CONTENT
    );

    let now = roster(&w.app, &owner, id).await;
    assert_eq!(role_of(&now, &bob).as_deref(), Some("admin"));
    assert_eq!(role_of(&now, &carol).as_deref(), Some("member"));
}

/// Two transfers at once from the same owner: one wins, and the team still has
/// exactly one owner. The lock makes the loser a clean refusal; the partial
/// unique index would have refused a second owner even without it.
#[tokio::test]
async fn one_owner_holds_under_a_concurrent_transfer() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let carol = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob, &carol]).await;

    let ((first, _), (second, _)) = tokio::join!(
        transfer(&w.app, &owner, id, &bob),
        transfer(&w.app, &owner, id, &carol)
    );
    let won = [first, second]
        .iter()
        .filter(|s| **s == StatusCode::NO_CONTENT)
        .count();
    assert_eq!(won, 1, "exactly one transfer wins: {first} {second}");

    let now = roster(&w.app, &owner, id).await;
    let owners = now.iter().filter(|m| m["role"] == "owner").count();
    assert_eq!(owners, 1);
    assert_eq!(
        role_of(&now, &owner).as_deref(),
        Some("admin"),
        "the old owner stays, as an admin"
    );
}

#[tokio::test]
async fn the_owner_cannot_leave_or_be_removed_but_anyone_else_can_leave() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob]).await;

    assert_eq!(leave(&w.app, &owner, id).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        remove(&w.app, &owner, id, &owner).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(leave(&w.app, &bob, id).await.0, StatusCode::NO_CONTENT);
    assert!(lists(&w.app, &bob, "/v1/teams", id).await.is_none());
}

#[tokio::test]
async fn the_two_hundred_and_first_member_is_refused() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let id = team(&w.app, &owner, &[]).await;

    // Seats filled in the database directly: registering two hundred accounts
    // through the API is most of a minute of password hashing spent on
    // something this test is not about. The last seat, and the refused one
    // after it, go through the real route.
    let filled = nexo_server::teams::MAX_MEMBERS - 2;
    sqlx::query(
        "WITH fresh AS (
             INSERT INTO users (handle, display_name, pw_salt, pw_hash)
             SELECT 'f' || substr(md5(random()::text || g::text), 1, 15),
                    'Seat filler', decode('00', 'hex'), 'unused'
             FROM generate_series(1, $2::bigint) g
             RETURNING id
         )
         INSERT INTO conversation_members (conversation_id, user_id)
         SELECT $1, id FROM fresh",
    )
    .bind(id)
    .bind(filled)
    .execute(&w.db)
    .await
    .unwrap();
    let last = register(&w.app).await;
    assert_eq!(
        add(&w.app, &owner, id, &last).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        roster(&w.app, &owner, id).await.len() as i64,
        nexo_server::teams::MAX_MEMBERS
    );

    let one_more = register(&w.app).await;
    let (status, body) = add(&w.app, &owner, id, &one_more).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "team_full");
}

#[tokio::test]
async fn a_block_or_a_private_account_keeps_someone_out() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let blocker = register(&w.app).await;
    let private = register(&w.app).await;
    let id = team(&w.app, &owner, &[]).await;

    let (status, _) = call(
        &w.app,
        "POST",
        &format!("/v1/blocks/{}", owner.handle),
        Some(&blocker.token),
        None,
    )
    .await;
    assert!(status.is_success(), "block: {status}");
    let (status, _) = call(
        &w.app,
        "PATCH",
        "/v1/me",
        Some(&private.token),
        Some(json!({ "is_private": true })),
    )
    .await;
    assert!(status.is_success(), "private: {status}");

    for who in [&blocker, &private] {
        let (status, body) = add(&w.app, &owner, id, who).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // The same answer for both, so neither a block nor privacy is revealed.
        assert_eq!(body["error"], "refused");
        assert!(lists(&w.app, who, "/v1/teams", id).await.is_none());
    }
}

/// A team of two is one MLS state, so a block between its two members must not
/// drop envelopes the way it does in a 1:1 -- that would split the group.
#[tokio::test]
async fn a_block_inside_a_team_does_not_split_it() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob]).await;
    call(
        &w.app,
        "POST",
        &format!("/v1/blocks/{}", owner.handle),
        Some(&bob.token),
        None,
    )
    .await;

    let (status, body) = call(
        &w.app,
        "POST",
        &format!("/v1/conversations/{id}/send"),
        Some(&owner.token),
        Some(json!({ "ciphertext": hex(b"opaque"), "epoch": 0, "is_commit": false })),
    )
    .await;
    assert!(status.is_success(), "{status} {body}");
}

#[tokio::test]
async fn the_roster_says_who_and_what_and_never_when_last_seen() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let stranger = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob]).await;

    let now = roster(&w.app, &bob, id).await;
    assert_eq!(
        now[0]["handle"],
        owner.handle.as_str(),
        "the owner is listed first"
    );
    for member in &now {
        let mut keys: Vec<&str> = member
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["handle", "joined_at_ms", "role"],
            "no activity field, ever"
        );
    }

    let (status, _) = call(
        &w.app,
        "GET",
        &format!("/v1/teams/{id}/members"),
        Some(&stranger.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a stranger cannot tell a team exists"
    );
}

#[tokio::test]
async fn deleting_is_the_owners_and_takes_the_team_from_every_list() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob]).await;
    call(
        &w.app,
        "POST",
        &format!("/v1/conversations/{id}/send"),
        Some(&owner.token),
        Some(json!({ "ciphertext": hex(b"a post"), "epoch": 0, "is_commit": false })),
    )
    .await;

    assert_eq!(delete_team(&w.app, &bob, id).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        delete_team(&w.app, &owner, id).await.0,
        StatusCode::NO_CONTENT
    );

    for who in [&owner, &bob] {
        assert!(lists(&w.app, who, "/v1/teams", id).await.is_none());
        assert!(lists(&w.app, who, "/v1/conversations", id).await.is_none());
    }
    // And the envelopes went with it.
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM envelopes WHERE conversation_id = $1")
        .bind(id)
        .fetch_one(&w.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

/// A socket opened before a removal must stop carrying the team once the
/// removal lands, without waiting for a reconnect.
#[tokio::test]
async fn a_removed_member_stops_receiving_the_team() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob]).await;

    // Bob's socket, as `stream::run` would build it for this team.
    let (queue, mut received) = mpsc::channel(16);
    let forwarder = tokio::spawn(nexo_server::stream::forward(
        w.hub.subscribe(id),
        queue,
        w.db.clone(),
        id,
        bob.user_id,
    ));

    let envelope = |n: i64| ServerEvent::Envelope {
        envelope_id: n,
        conversation_id: id,
        sender_device_id: Uuid::nil(),
        epoch: 0,
        ciphertext: hex(b"opaque"),
        is_commit: false,
        server_timestamp_ms: 0,
    };
    w.hub.publish(id, envelope(1));
    let first = tokio::time::timeout(Duration::from_secs(1), received.recv()).await;
    assert_eq!(first.unwrap(), Some(envelope(1)));

    assert_eq!(
        remove(&w.app, &owner, id, &bob).await.0,
        StatusCode::NO_CONTENT
    );
    let nudge = tokio::time::timeout(Duration::from_secs(1), received.recv()).await;
    assert_eq!(
        nudge.unwrap(),
        Some(ServerEvent::Membership {
            conversation_id: id
        }),
        "the removed member is told to look"
    );

    w.hub.publish(id, envelope(2));
    let after = tokio::time::timeout(Duration::from_secs(1), received.recv()).await;
    assert_eq!(after.unwrap(), None, "and then hears nothing more");
    forwarder.await.unwrap();
}

/// Everybody still in the team is nudged too, so their rosters update without
/// a reload -- and the forwarder keeps going for them.
#[tokio::test]
async fn a_role_change_nudges_the_members_who_remain() {
    let w = world_or_skip!();
    let owner = register(&w.app).await;
    let bob = register(&w.app).await;
    let id = team(&w.app, &owner, &[&bob]).await;

    let (queue, mut received) = mpsc::channel(16);
    let forwarder = tokio::spawn(nexo_server::stream::forward(
        w.hub.subscribe(id),
        queue,
        w.db.clone(),
        id,
        bob.user_id,
    ));

    assert_eq!(
        set_role(&w.app, &owner, id, &bob, "admin").await.0,
        StatusCode::NO_CONTENT
    );
    let nudge = tokio::time::timeout(Duration::from_secs(1), received.recv()).await;
    assert_eq!(
        nudge.unwrap(),
        Some(ServerEvent::Membership {
            conversation_id: id
        })
    );

    // Still subscribed.
    w.hub.publish(
        id,
        ServerEvent::Membership {
            conversation_id: id,
        },
    );
    let again = tokio::time::timeout(Duration::from_secs(1), received.recv()).await;
    assert!(again.unwrap().is_some());
    forwarder.abort();
}
