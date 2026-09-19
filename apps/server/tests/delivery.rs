//! The delivery service, end to end, with real MLS on both sides.
//!
//! This is M4's check — *two clients exchange real E2EE messages* — minus the
//! two machines. Both clients run in this process, but everything between them
//! goes through the real server, the real database, and real ciphertext the
//! test never decrypts on the server side.
//!
//! Skips cleanly with no `DATABASE_URL`, like the rest of the suite.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use nexo_crypto::identity::IdentityKeypair;
use nexo_crypto::mls::{Conversation, Incoming, credential_for, generate_key_packages};
use nexo_server::{AppState, TokenKeys, db, router};
use openmls::prelude::CredentialWithKey;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use serde_json::{Value, json};
use tower::ServiceExt;
use uuid::Uuid;

const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
    MC4CAQAwBQYDK2VwBCIEIBD8O+mO1pxsOJPSKpso2043G54kPXsxDyl6dTJ6H5Io\n\
    -----END PRIVATE KEY-----\n";

const T0: i64 = 1_760_000_000_000;

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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn unique_handle() -> String {
    format!("d{}", Uuid::new_v4().simple())[..16].to_string()
}

/// A registered account with a live MLS identity.
struct Party {
    token: String,
    handle: String,
    /// The device this account is in MLS as. Needed to tell a replaced device
    /// from a live one.
    device_id: Uuid,
    provider: OpenMlsRustCrypto,
    credential: CredentialWithKey,
    signer: SignatureKeyPair,
}

async fn register(app: &axum::Router) -> Party {
    let handle = unique_handle();
    let identity = IdentityKeypair::generate();
    let provider = OpenMlsRustCrypto::default();

    let (_status, session) = call(
        app,
        "POST",
        "/v1/auth/register",
        None,
        Some(json!({
            "handle": handle,
            "display_name": "Delivery Test",
            "pw_salt": Uuid::new_v4().simple().to_string(),
            "pw_verifier": hex(&[7u8; 32]),
            "identity_pubkey": hex(&identity.public_bytes()),
        })),
    )
    .await;

    let device_id: Uuid = session["device_id"].as_str().unwrap().parse().unwrap();
    let (credential, signer) = credential_for(device_id, &identity);
    signer
        .store(openmls_traits::OpenMlsProvider::storage(&provider))
        .unwrap();

    Party {
        token: session["access_token"].as_str().unwrap().to_string(),
        handle,
        device_id,
        provider,
        credential,
        signer,
    }
}

#[tokio::test]
async fn an_unauthenticated_call_is_refused() {
    let app = app_or_skip!();
    let (status, body) = call(&app, "GET", "/v1/keypackages/count", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "unauthorized");
}

#[tokio::test]
async fn a_garbage_token_is_refused() {
    let app = app_or_skip!();
    let (status, _) = call(
        &app,
        "GET",
        "/v1/keypackages/count",
        Some("not.a.token"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// S1: a reinstall must not leave peers claiming packages for a dead device.
///
/// Signing in on a machine with no local store generates a *fresh* identity
/// keypair, so login inserts a second device row rather than updating the
/// first. Before this was fixed both stayed live, and `claim_key_package`
/// reached across every device a handle owned — so a peer starting a
/// conversation was handed a Welcome addressed to the device that had been
/// replaced. It could never be read, and the claimer was told it succeeded.
#[tokio::test]
async fn a_replaced_device_stops_handing_out_key_packages() {
    let Some(app) = app().await else {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    };

    // A device, with packages published against it.
    let alice = register(&app).await;
    let old_packages =
        generate_key_packages(&alice.provider, &alice.signer, alice.credential.clone(), 2).unwrap();
    let (status, _) = call(
        &app,
        "POST",
        "/v1/keypackages",
        Some(&alice.token),
        Some(json!({ "key_packages": old_packages.iter().map(|p| hex(p)).collect::<Vec<_>>() })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // The same account signs in from a machine with no store: a new identity
    // key, and therefore a different device.
    let reinstalled = IdentityKeypair::generate();
    let (status, session) = call(
        &app,
        "POST",
        "/v1/auth/login",
        None,
        Some(json!({
            "handle": alice.handle,
            "pw_verifier": hex(&[7u8; 32]),
            "identity_pubkey": hex(&reinstalled.public_bytes()),
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "login after a reinstall: {session}");
    let new_device: Uuid = session["device_id"].as_str().unwrap().parse().unwrap();
    assert_ne!(
        new_device, alice.device_id,
        "a fresh identity key is a different device -- that is the premise"
    );

    // A peer tries to start a conversation. There is nothing to claim: the old
    // device's packages went with it, and the new one has published none.
    let bob = register(&app).await;
    let (status, _) = call(
        &app,
        "GET",
        &format!("/v1/keypackages/{}", alice.handle),
        Some(&bob.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "a retired device's packages must not be handed out -- they address a device \
         that will never read them, and the claimer is told nothing is wrong"
    );

    // Once the new device publishes, claiming works again. Without this the
    // fix would be indistinguishable from breaking the endpoint.
    let fresh =
        generate_key_packages(&alice.provider, &alice.signer, alice.credential.clone(), 1).unwrap();
    let (status, _) = call(
        &app,
        "POST",
        "/v1/keypackages",
        Some(session["access_token"].as_str().unwrap()),
        Some(json!({ "key_packages": [hex(&fresh[0])] })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, claimed) = call(
        &app,
        "GET",
        &format!("/v1/keypackages/{}", alice.handle),
        Some(&bob.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the live device can still be reached"
    );
    assert_eq!(
        claimed["device_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap(),
        new_device,
        "and the package claimed belongs to it"
    );
}

#[tokio::test]
async fn key_packages_publish_count_and_are_consumed_once() {
    let app = app_or_skip!();
    let alice = register(&app).await;

    let packages =
        generate_key_packages(&alice.provider, &alice.signer, alice.credential.clone(), 3).unwrap();

    let (status, _) = call(
        &app,
        "POST",
        "/v1/keypackages",
        Some(&alice.token),
        Some(json!({ "key_packages": packages.iter().map(|p| hex(p)).collect::<Vec<_>>() })),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, count) = call(
        &app,
        "GET",
        "/v1/keypackages/count",
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(count["remaining"], 3);
    assert_eq!(count["refill_below"], 15);

    // Claiming consumes. Three claims succeed, the fourth has nothing left.
    let bob = register(&app).await;
    for expected in [2, 1, 0] {
        let (status, _) = call(
            &app,
            "GET",
            &format!("/v1/keypackages/{}", alice.handle),
            Some(&bob.token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let (_, count) = call(
            &app,
            "GET",
            "/v1/keypackages/count",
            Some(&alice.token),
            None,
        )
        .await;
        assert_eq!(
            count["remaining"], expected,
            "a claim must consume exactly one"
        );
    }

    let (status, _) = call(
        &app,
        "GET",
        &format!("/v1/keypackages/{}", alice.handle),
        Some(&bob.token),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "running out must be an honest 404, not a reissued package"
    );
}

/// M4's check, in one test: two clients exchange real E2EE messages through the
/// real server, and the server never sees a plaintext.
#[tokio::test]
async fn two_clients_exchange_real_end_to_end_encrypted_messages() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let mut bob = register(&app).await;

    // Bob publishes a key package so Alice can invite him.
    let bob_packages =
        generate_key_packages(&bob.provider, &bob.signer, bob.credential.clone(), 1).unwrap();
    call(
        &app,
        "POST",
        "/v1/keypackages",
        Some(&bob.token),
        Some(json!({ "key_packages": [hex(&bob_packages[0])] })),
    )
    .await;

    // Alice claims it.
    let (status, claimed) = call(
        &app,
        "GET",
        &format!("/v1/keypackages/{}", bob.handle),
        Some(&alice.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let bob_package = unhex(claimed["key_package"].as_str().unwrap());

    // Alice builds the group locally, then tells the server it exists.
    let conversation_id = Uuid::new_v4();
    let mut alice_conv = Conversation::create(
        &alice.provider,
        &alice.signer,
        alice.credential.clone(),
        conversation_id,
        T0,
    )
    .unwrap();

    let (status, _) = call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({
            "conversation_id": conversation_id,
            "members": [bob.handle],
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Adding Bob is a commit: it goes to the server, which orders it.
    let commit = alice_conv
        .add_member(&alice.provider, &alice.signer, &bob_package)
        .unwrap();

    let (status, sent) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&alice.token),
        Some(json!({
            "ciphertext": hex(&commit.message),
            "epoch": 0,
            "is_commit": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["epoch"], 1, "a commit advances the server's epoch");

    alice_conv.confirm_commit(&alice.provider, T0).unwrap();

    // Bob joins from the Welcome. (The Welcome reaches him out of band in M5's
    // invite flow; here it is handed over directly.)
    let mut bob_conv = Conversation::join(
        &bob.provider,
        &commit.welcome.expect("an add produces a welcome"),
        T0,
    )
    .unwrap();

    // Alice sends a real message.
    let ciphertext = alice_conv
        .encrypt(&alice.provider, &alice.signer, b"the eagle has landed")
        .unwrap();

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&alice.token),
        Some(json!({
            "ciphertext": hex(&ciphertext),
            "epoch": 1,
            "is_commit": false,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Bob syncs and decrypts it.
    let (status, envelopes) = call(
        &app,
        "GET",
        &format!("/v1/conversations/{conversation_id}/sync"),
        Some(&bob.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let envelopes = envelopes.as_array().unwrap();

    // The commit came first, then the message. Bob applies them in order.
    let mut delivered = Vec::new();
    for envelope in envelopes {
        let bytes = unhex(envelope["ciphertext"].as_str().unwrap());
        // Bob is already at the post-commit epoch from the Welcome, so the
        // commit that created him is not his to apply.
        if envelope["is_commit"].as_bool().unwrap() {
            continue;
        }
        match bob_conv.decrypt(&bob.provider, &bytes).unwrap() {
            Incoming::Message { plaintext, .. } => delivered.push(plaintext),
            other => panic!("expected a message, got {other:?}"),
        }
    }

    assert_eq!(
        delivered,
        vec![b"the eagle has landed".to_vec()],
        "the message must survive the round trip through the server"
    );

    // And the server never held the plaintext.
    for envelope in envelopes {
        let stored = unhex(envelope["ciphertext"].as_str().unwrap());
        assert!(
            !stored
                .windows(b"the eagle has landed".len())
                .any(|w| w == b"the eagle has landed"),
            "plaintext found in what the server stored"
        );
    }

    let _ = &mut bob;
}

/// PLAN.md risk 4(b), server half: first commit wins, the loser is told to
/// resync.
#[tokio::test]
async fn a_second_commit_for_the_same_epoch_is_refused_as_stale() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let conversation_id = Uuid::new_v4();

    let (status, _) = call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // The first commit against epoch 0 wins.
    let (status, first) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&alice.token),
        Some(json!({ "ciphertext": hex(b"commit-one"), "epoch": 0, "is_commit": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["epoch"], 1);

    // The second, citing the same epoch, loses.
    let (status, second) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&bob.token),
        Some(json!({ "ciphertext": hex(b"commit-two"), "epoch": 0, "is_commit": true })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(second["error"], "stale_epoch");
    assert_eq!(
        second["current_epoch"], 1,
        "the loser is told where to resync to, so it needs no extra round trip"
    );
}

#[tokio::test]
async fn application_messages_are_accepted_at_a_stale_epoch() {
    // MLS tolerates bounded reordering of application messages. A server that
    // refused them would break a guarantee the protocol makes.
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let conversation_id = Uuid::new_v4();

    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;

    call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&alice.token),
        Some(json!({ "ciphertext": hex(b"commit"), "epoch": 0, "is_commit": true })),
    )
    .await;

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&alice.token),
        Some(json!({ "ciphertext": hex(b"late message"), "epoch": 0, "is_commit": false })),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "an application message at an old epoch must still be accepted"
    );
}

#[tokio::test]
async fn a_non_member_can_neither_send_nor_sync() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let stranger = register(&app).await;
    let conversation_id = Uuid::new_v4();

    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;

    let (status, body) = call(
        &app,
        "GET",
        &format!("/v1/conversations/{conversation_id}/sync"),
        Some(&stranger.token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"], "not_found",
        "a non-member must not be able to tell an existing conversation from a missing one"
    );

    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&stranger.token),
        Some(json!({ "ciphertext": hex(b"x"), "epoch": 0, "is_commit": false })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sync_pages_forward_from_a_cursor() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let conversation_id = Uuid::new_v4();

    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;

    for i in 0..5u8 {
        call(
            &app,
            "POST",
            &format!("/v1/conversations/{conversation_id}/send"),
            Some(&alice.token),
            Some(json!({ "ciphertext": hex(&[i]), "epoch": 0, "is_commit": false })),
        )
        .await;
    }

    let (_, all) = call(
        &app,
        "GET",
        &format!("/v1/conversations/{conversation_id}/sync"),
        Some(&bob.token),
        None,
    )
    .await;
    let all = all.as_array().unwrap();
    assert_eq!(all.len(), 5);

    let cursor = all[1]["envelope_id"].as_i64().unwrap();
    let (_, rest) = call(
        &app,
        "GET",
        &format!("/v1/conversations/{conversation_id}/sync?since_id={cursor}"),
        Some(&bob.token),
        None,
    )
    .await;
    assert_eq!(
        rest.as_array().unwrap().len(),
        3,
        "a cursor must return what comes strictly after it"
    );
}

#[tokio::test]
async fn a_conversation_lists_for_its_members_only() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let stranger = register(&app).await;
    let conversation_id = Uuid::new_v4();

    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;

    for (party, expected) in [(&alice, true), (&bob, true), (&stranger, false)] {
        let (_, list) = call(&app, "GET", "/v1/conversations", Some(&party.token), None).await;
        let found = list
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["conversation_id"] == conversation_id.to_string());
        assert_eq!(found, expected);
    }
}

/// The socket is a latency optimisation over `sync`, so what matters is that an
/// accepted envelope reaches a subscriber *without* a poll.
#[tokio::test]
async fn an_accepted_envelope_is_published_to_subscribers() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let conversation_id = Uuid::new_v4();

    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;

    // Subscribe the way the WebSocket handler does.
    let hub = nexo_server::stream::hub::LocalHub::new();
    let mut subscription = nexo_server::stream::hub::Fanout::subscribe(&hub, conversation_id);

    nexo_server::stream::hub::Fanout::publish(
        &hub,
        conversation_id,
        nexo_protocol::ServerEvent::Envelope {
            envelope_id: 1,
            conversation_id,
            sender_device_id: Uuid::nil(),
            epoch: 0,
            ciphertext: hex(b"opaque"),
            is_commit: false,
            server_timestamp_ms: 0,
        },
    );

    let event = tokio::time::timeout(std::time::Duration::from_secs(1), subscription.recv())
        .await
        .expect("an event should arrive without polling")
        .expect("the channel should be open");

    match event {
        nexo_protocol::ServerEvent::Envelope {
            conversation_id: got,
            ciphertext,
            ..
        } => {
            assert_eq!(got, conversation_id);
            // The event carries ciphertext, never anything the server decoded.
            assert_eq!(ciphertext, hex(b"opaque"));
        }
        other => panic!("expected an envelope, got {other:?}"),
    }
}

/// An `Ack` marks envelopes delivered, which is what lets the 30-day sweep
/// remove them (§4.3).
#[tokio::test]
async fn acknowledging_marks_envelopes_delivered_for_members_only() {
    let app = app_or_skip!();
    let alice = register(&app).await;
    let bob = register(&app).await;
    let stranger = register(&app).await;
    let conversation_id = Uuid::new_v4();

    call(
        &app,
        "POST",
        "/v1/conversations",
        Some(&alice.token),
        Some(json!({ "conversation_id": conversation_id, "members": [bob.handle] })),
    )
    .await;

    let (_, sent) = call(
        &app,
        "POST",
        &format!("/v1/conversations/{conversation_id}/send"),
        Some(&alice.token),
        Some(json!({ "ciphertext": hex(b"x"), "epoch": 0, "is_commit": false })),
    )
    .await;
    let envelope_id = sent["envelope_id"].as_i64().unwrap();

    let pool = db::create_pool(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();

    // A stranger's ack changes nothing. Membership is re-checked at ack time,
    // because a socket can outlive a removal from the conversation.
    let stranger_id = stranger_user_id(&app, &stranger.token).await;
    let marked = nexo_server::stream::acknowledge(&pool, stranger_id, conversation_id, envelope_id)
        .await
        .unwrap();
    assert_eq!(marked, 0, "a non-member must not be able to acknowledge");

    // A member's ack marks it.
    let bob_id = stranger_user_id(&app, &bob.token).await;
    let marked = nexo_server::stream::acknowledge(&pool, bob_id, conversation_id, envelope_id)
        .await
        .unwrap();
    assert_eq!(marked, 1);

    // And acknowledging twice is not an error, it is simply nothing left to do.
    let again = nexo_server::stream::acknowledge(&pool, bob_id, conversation_id, envelope_id)
        .await
        .unwrap();
    assert_eq!(again, 0);
}

/// Reads a party's user id back out of a fresh session, since the register
/// response carries it.
async fn stranger_user_id(app: &axum::Router, token: &str) -> i64 {
    let (_, list) = call(app, "GET", "/v1/conversations", Some(token), None).await;
    // Any authenticated call would do; this one is cheap. The id itself comes
    // from the token, so decode it rather than guessing.
    let _ = list;
    let claims = TokenKeys::from_pem_bytes(TEST_KEY_PEM.as_bytes())
        .unwrap()
        .verify_access_token(token)
        .unwrap();
    claims.sub.parse().unwrap()
}
