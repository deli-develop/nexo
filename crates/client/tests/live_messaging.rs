//! M4's check, as close as one process can get: two clients exchange real
//! end-to-end encrypted messages through a real server, and their safety
//! numbers match.
//!
//! Ignored by default. Run it with Postgres and the server up:
//!
//! ```text
//! docker compose up -d
//! pnpm dev:server
//! $env:NEXO_API_BASE = "http://127.0.0.1:8080"
//! cargo test -p nexo-client --features http --test live_messaging -- --ignored --nocapture
//! ```
//!
//! The two clients hold entirely separate providers, stores and keystores. The
//! only thing they share is the server, which is the point.

#![cfg(feature = "http")]

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use nexo_client::conversations::{self, Context};
use nexo_client::transport::Transport;
use nexo_client::{HttpTransport, session};
use nexo_crypto::identity::{IdentityKeypair, SafetyNumber};
use nexo_crypto::mls::{Conversation, credential_for};
use nexo_platform::SecureStore;
use nexo_protocol::{ConversationId, DeviceId};
use nexo_store::EncryptedStore;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use zeroize::Zeroizing;

#[derive(Default)]
struct FakeKeystore {
    items: RefCell<HashMap<String, Vec<u8>>>,
}

#[derive(Debug, thiserror::Error)]
#[error("fake keystore failure")]
struct FakeKeystoreError;

impl SecureStore for FakeKeystore {
    type Error = FakeKeystoreError;
    fn store(&self, name: &str, secret: &[u8]) -> Result<(), Self::Error> {
        self.items
            .borrow_mut()
            .insert(name.to_string(), secret.to_vec());
        Ok(())
    }
    fn load(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        Ok(self.items.borrow().get(name).cloned().map(Zeroizing::new))
    }
    fn erase(&self, name: &str) -> Result<(), Self::Error> {
        self.items.borrow_mut().remove(name);
        Ok(())
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "nexo-live-msg-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn db(&self) -> PathBuf {
        self.0.join("store.db")
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn base_url() -> String {
    std::env::var("NEXO_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string())
}

fn unique_handle() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    // Two clients register in the same nanosecond bucket otherwise.
    format!("m{:012}{:03}", nanos % 1_000_000_000_000u128, rand_suffix())
}

fn rand_suffix() -> u16 {
    use std::sync::atomic::{AtomicU16, Ordering};
    static N: AtomicU16 = AtomicU16::new(0);
    N.fetch_add(1, Ordering::Relaxed) % 1000
}

/// One client, with its own everything.
struct Client {
    handle: String,
    transport: HttpTransport,
    provider: OpenMlsRustCrypto,
    store: EncryptedStore,
    signer: openmls_basic_credential::SignatureKeyPair,
    credential: openmls::prelude::CredentialWithKey,
    identity: IdentityKeypair,
    #[allow(dead_code)]
    dir: TempDir,
    #[allow(dead_code)]
    keystore: FakeKeystore,
}

impl Client {
    fn new(tag: &str) -> Self {
        let dir = TempDir::new(tag);
        let keystore = FakeKeystore::default();
        let transport = HttpTransport::with_base_url(base_url());
        let handle = unique_handle();

        let created = session::register(
            &transport,
            &keystore,
            &dir.db(),
            &handle,
            "Live Messaging",
            "a development password",
        )
        .expect("register should succeed against a running server");

        transport.set_access_token(&created.access_token);

        let store = EncryptedStore::open(
            dir.db(),
            &nexo_store::key::load_or_create(&keystore).unwrap().0,
        )
        .unwrap();

        let (secret, _public) = store.identity().unwrap().expect("an identity was stored");
        let identity = IdentityKeypair::from_secret_bytes(&secret).unwrap();
        let device_id: DeviceId = created.account.device_id.parse().unwrap();
        let (credential, signer) = credential_for(device_id, &identity);
        signer
            .store(provider_storage(&OpenMlsRustCrypto::default()))
            .ok();

        let provider = nexo_client::mls_state::load(&store).unwrap();
        signer.store(provider.storage()).unwrap();

        Self {
            handle,
            transport,
            provider,
            store,
            signer,
            credential,
            identity,
            dir,
            keystore,
        }
    }

    fn ctx(&self) -> Context<'_, HttpTransport> {
        Context {
            transport: &self.transport,
            provider: &self.provider,
            store: &self.store,
            signer: &self.signer,
            credential: self.credential.clone(),
        }
    }
}

fn provider_storage(p: &OpenMlsRustCrypto) -> &openmls_rust_crypto::MemoryStorage {
    p.storage()
}

#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn two_clients_exchange_messages_and_their_safety_numbers_match() {
    let alice = Client::new("alice");
    let bob = Client::new("bob");
    println!("alice: {}  bob: {}", alice.handle, bob.handle);

    // Bob publishes KeyPackages so he can be invited.
    conversations::publish_key_packages(&bob.ctx(), 5).expect("publish");
    println!("ok: bob published key packages");

    // Alice starts a conversation with him.
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).expect("start");
    println!("ok: alice started conversation {conversation_id}");

    // Bob syncs: he receives the Welcome and joins.
    let outcome = conversations::sync(&bob.ctx(), conversation_id).expect("bob sync");
    println!("ok: bob synced {outcome:?}");
    assert_eq!(
        outcome.failed, 0,
        "joining a conversation must not report a failure: the commit that          added Bob simply predates him, which is `skipped`, not `failed`"
    );

    // Alice sends a message.
    conversations::send_message(&alice.ctx(), conversation_id, "the eagle has landed")
        .expect("send");
    println!("ok: alice sent a message");

    // Bob syncs again and reads it.
    let outcome = conversations::sync(&bob.ctx(), conversation_id).expect("bob sync 2");
    assert!(
        outcome.messages >= 1,
        "bob should have received a message, got {outcome:?}"
    );

    let messages = bob
        .store
        .messages(&conversation_id.to_string())
        .expect("read local history");
    assert!(
        messages.iter().any(|m| m.body == "the eagle has landed"),
        "the message should be in bob's local history: {messages:?}"
    );
    println!("ok: bob decrypted the message");

    // Bob replies.
    conversations::send_message(&bob.ctx(), conversation_id, "copy that").expect("bob send");
    let outcome = conversations::sync(&alice.ctx(), conversation_id).expect("alice sync");
    assert!(
        outcome.messages >= 1,
        "alice should have received the reply, got {outcome:?}"
    );
    let messages = alice.store.messages(&conversation_id.to_string()).unwrap();
    assert!(
        messages.iter().any(|m| m.body == "copy that"),
        "the reply should be in alice's history: {messages:?}"
    );
    println!("ok: messages flow in both directions");

    // M4's other half: the safety numbers match.
    let from_alice = conversations::safety_number(&alice.provider, conversation_id)
        .expect("alice safety number")
        .expect("a 1:1 conversation has one");
    let from_bob = conversations::safety_number(&bob.provider, conversation_id)
        .expect("bob safety number")
        .expect("a 1:1 conversation has one");

    assert_eq!(
        from_alice, from_bob,
        "both sides must compute the same safety number, or the ceremony is useless"
    );

    // And it is the fingerprint over the two identity keys, not something else.
    let expected = SafetyNumber::new(&alice.identity.public_bytes(), &bob.identity.public_bytes())
        .unwrap()
        .to_display_string();
    assert_eq!(
        from_alice, expected,
        "the safety number must cover the identity keys the accounts registered"
    );
    println!("ok: safety numbers match — {from_alice}");
}

/// The gap the two-client test above leaves open.
///
/// That test hands Bob the conversation id straight from Alice's `start_with`.
/// A real invitee is told nothing: being added happens on the server, and the
/// Welcome waits inside a conversation the invitee's app has never heard of.
/// Syncing iterates the *local* list, so without discovery that list stays
/// empty and the invitation is invisible forever.
#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn an_invitee_discovers_a_conversation_it_was_never_told_about() {
    let alice = Client::new("alice");
    let bob = Client::new("bob");

    conversations::publish_key_packages(&bob.ctx(), 5).expect("publish");
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).expect("start");

    assert!(
        bob.store.conversation_ids().expect("ids").is_empty(),
        "bob is told nothing when he is added; that is the whole problem"
    );

    let added = conversations::discover(&bob.ctx()).expect("discover");
    assert_eq!(
        added, 1,
        "the server knows bob is a member, so he should find it"
    );
    assert!(
        bob.store
            .conversation_ids()
            .expect("ids")
            .contains(&conversation_id.to_string()),
        "the conversation should now be one bob's own sync loop will visit"
    );

    // And it is readable: discovery has to leave the cursor early enough that
    // the Welcome is still ahead of it.
    conversations::send_message(&alice.ctx(), conversation_id, "found me").expect("send");
    let outcome = conversations::sync(&bob.ctx(), conversation_id).expect("bob sync");
    assert_eq!(outcome.failed, 0, "nothing here should fail: {outcome:?}");

    let messages = bob
        .store
        .messages(&conversation_id.to_string())
        .expect("history");
    assert!(
        messages.iter().any(|m| m.body == "found me"),
        "bob should have read the message he discovered his way to: {messages:?}"
    );
}

/// A sender's own envelopes come back from the delivery service, and MLS cannot
/// decrypt a message this device sent -- the ratchet moved on as it encrypted.
/// Feeding them back to `decrypt` therefore fails every time, and reported the
/// sender's own message as one that "couldn't be decrypted".
#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn a_sender_does_not_report_its_own_message_as_undecryptable() {
    let alice = Client::new("alice");
    let bob = Client::new("bob");

    conversations::publish_key_packages(&bob.ctx(), 5).expect("publish");
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).expect("start");
    conversations::sync(&bob.ctx(), conversation_id).expect("bob joins");

    conversations::send_message(&alice.ctx(), conversation_id, "the eagle has landed")
        .expect("send");

    // Alice syncs her own conversation, as the app's sync loop does on a timer.
    let outcome = conversations::sync(&alice.ctx(), conversation_id).expect("alice sync");
    assert_eq!(
        outcome.failed, 0,
        "a sender syncing must not count its own traffic as unreadable: {outcome:?}"
    );
}

#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn syncing_twice_does_not_duplicate_messages() {
    // Reconnecting replays from the cursor by design, so this has to be a
    // no-op the second time.
    let alice = Client::new("dupe-a");
    let bob = Client::new("dupe-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    conversations::send_message(&alice.ctx(), conversation_id, "only once").unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    let first = bob.store.messages(&conversation_id.to_string()).unwrap();
    let count = first.iter().filter(|m| m.body == "only once").count();
    assert_eq!(count, 1);

    // A second sync, and a third for good measure.
    conversations::sync(&bob.ctx(), conversation_id).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    let again = bob.store.messages(&conversation_id.to_string()).unwrap();
    let count = again.iter().filter(|m| m.body == "only once").count();
    assert_eq!(count, 1, "syncing again must not duplicate history");
    println!("ok: sync is idempotent");
}

#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn key_packages_are_topped_up_when_low() {
    let alice = Client::new("refill");

    // Start below the threshold.
    conversations::publish_key_packages(&alice.ctx(), 2).unwrap();
    let (remaining, refill_below) = alice.transport.key_package_count().unwrap();
    assert!(remaining < refill_below);

    let published = conversations::refill_key_packages_if_low(&alice.ctx()).unwrap();
    assert!(published > 0, "a low supply should be topped up");

    let (after, _) = alice.transport.key_package_count().unwrap();
    assert!(
        after >= refill_below,
        "after a refill the supply should be above the threshold, got {after}"
    );

    // And a healthy supply is left alone.
    let again = conversations::refill_key_packages_if_low(&alice.ctx()).unwrap();
    assert_eq!(again, 0, "a healthy supply must not be topped up again");
    println!("ok: key packages refill only when low");
}

/// The correction: after a restart the account must be *reachable*, not merely
/// remembered. `restore` answers from disk alone; `resume` trades the stored
/// refresh token for a usable access token.
#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn a_restarted_client_can_still_send() {
    let alice = Client::new("resume-a");
    let bob = Client::new("resume-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    // --- alice's app closes and reopens ---
    // A brand-new transport with no token, and the store reopened from disk.
    let transport = HttpTransport::with_base_url(base_url());
    let resumed = session::resume(&transport, &alice.keystore, &alice.dir.db())
        .expect("resume should succeed")
        .expect("a stored session should be there");
    assert_eq!(resumed.account.handle, alice.handle);
    println!("ok: alice resumed without a password");

    let store = EncryptedStore::open(
        alice.dir.db(),
        &nexo_store::key::load_or_create(&alice.keystore).unwrap().0,
    )
    .unwrap();
    let provider = nexo_client::mls_state::load(&store).unwrap();
    let (secret, _) = store.identity().unwrap().unwrap();
    let identity = IdentityKeypair::from_secret_bytes(&secret).unwrap();
    let device_id: DeviceId = resumed.account.device_id.parse().unwrap();
    let (credential, signer) = credential_for(device_id, &identity);
    signer.store(provider.storage()).unwrap();

    let ctx = Context {
        transport: &transport,
        provider: &provider,
        store: &store,
        signer: &signer,
        credential,
    };

    // The real test: a restarted client can still reach the server *and* still
    // hold the conversation.
    conversations::send_message(&ctx, conversation_id, "sent after a restart")
        .expect("a resumed session must be able to send");
    println!("ok: alice sent after restarting");

    let outcome = conversations::sync(&bob.ctx(), conversation_id).expect("bob sync");
    assert!(
        outcome.messages >= 1,
        "bob should receive it, got {outcome:?}"
    );
    let messages = bob.store.messages(&conversation_id.to_string()).unwrap();
    assert!(
        messages.iter().any(|m| m.body == "sent after a restart"),
        "the far side must read a message sent after a restart: {messages:?}"
    );
    println!("ok: bob read it");
}

/// M5's check, and the sharpest claim in the whole product: **a member added at
/// epoch N provably cannot read anything before N.**
///
/// Not a policy the server enforces — the server cannot read any of it — but a
/// property of the MLS ratchet. Carol joins after Alice and Bob have already
/// talked, and the earlier ciphertext is simply not decryptable with the keys
/// she is given.
/// A group's name is content, so creating one has to *send* it.
///
/// The server holds no title. `rename` always carried the name as an encrypted
/// `Payload::Rename`, but creation only wrote it into the creator's own store
/// -- so the person who named the group was the only one who ever saw the
/// name, and everybody else fell back to a list of handles.
#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn a_group_reaches_its_members_under_the_name_it_was_given() {
    let alice = Client::new("title-a");
    let bob = Client::new("title-b");
    let carol = Client::new("title-c");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    conversations::publish_key_packages(&carol.ctx(), 2).unwrap();

    let members = vec![bob.handle.clone(), carol.handle.clone()];
    let conversation_id =
        conversations::start_group_with(&alice.ctx(), &members, "Weekend plans").expect("group");

    for member in [&bob, &carol] {
        conversations::discover(&member.ctx()).expect("discover");
        conversations::sync(&member.ctx(), conversation_id).expect("sync");

        let stored = member
            .store
            .conversations()
            .unwrap()
            .into_iter()
            .find(|c| c.id == conversation_id.to_string())
            .expect("the member should know the conversation");

        assert_eq!(
            stored.title.as_deref(),
            Some("Weekend plans"),
            "every member should see the name the group was created with, not a list of handles"
        );
    }
    println!("ok: the group's name reached both members");
}

#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn a_member_added_later_cannot_read_earlier_messages() {
    let alice = Client::new("grp-a");
    let bob = Client::new("grp-b");
    let carol = Client::new("grp-c");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    conversations::publish_key_packages(&carol.ctx(), 2).unwrap();

    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    // A private exchange, before Carol exists to the group.
    conversations::send_message(&alice.ctx(), conversation_id, "secret before carol").unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();
    assert!(
        bob.store
            .messages(&conversation_id.to_string())
            .unwrap()
            .iter()
            .any(|m| m.body == "secret before carol"),
        "bob should have read it"
    );
    println!("ok: alice and bob exchanged a message privately");

    // Now Carol is added.
    conversations::add_to(&alice.ctx(), conversation_id, &carol.handle).expect("add carol");
    println!("ok: carol added");

    let outcome = conversations::sync(&carol.ctx(), conversation_id).expect("carol sync");
    println!("carol's first sync: {outcome:?}");

    // She sees the conversation, and none of its history.
    let hers = carol.store.messages(&conversation_id.to_string()).unwrap();
    assert!(
        !hers.iter().any(|m| m.body == "secret before carol"),
        "a member added at epoch N must not be able to read anything before N: {hers:?}"
    );
    println!("ok: carol cannot read what predates her");

    // But she is a full member from here on.
    conversations::send_message(&alice.ctx(), conversation_id, "hello carol").unwrap();
    let outcome = conversations::sync(&carol.ctx(), conversation_id).unwrap();
    assert!(
        outcome.messages >= 1,
        "carol should receive messages sent after she joined, got {outcome:?}"
    );
    let hers = carol.store.messages(&conversation_id.to_string()).unwrap();
    assert!(
        hers.iter().any(|m| m.body == "hello carol"),
        "carol should read messages sent after she joined: {hers:?}"
    );
    println!("ok: carol reads everything from her epoch onward");

    // And bob, who was there all along, still works after the rekey.
    conversations::sync(&bob.ctx(), conversation_id).unwrap();
    let his = bob.store.messages(&conversation_id.to_string()).unwrap();
    assert!(
        his.iter().any(|m| m.body == "hello carol"),
        "adding a member must not break the existing ones: {his:?}"
    );
    println!("ok: bob still reads the group after the add");
}

/// M6's check: a 20 MB file round-trips, and the stored object is verifiably
/// ciphertext.
///
/// "Verifiably" is the load-bearing word. It is not enough that the client
/// encrypts — the test fetches what actually landed in the bucket and asserts
/// the plaintext is not in it.
#[test]
#[ignore = "needs a running server, Postgres, and real Hetzner credentials"]
fn a_twenty_megabyte_attachment_round_trips_as_ciphertext() {
    let alice = Client::new("att-a");
    let bob = Client::new("att-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    // Incompressible, so nothing along the path can flatter the result, and
    // with a recognisable marker to search the stored object for.
    let mut contents: Vec<u8> = (0..20 * 1024 * 1024usize)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    let marker = b"NEXO-ATTACHMENT-PLAINTEXT-MARKER";
    contents[..marker.len()].copy_from_slice(marker);

    conversations::send_attachment(
        &alice.ctx(),
        conversation_id,
        "report.bin",
        "application/octet-stream",
        &contents,
        Some("the file you asked for"),
        None,
    )
    .expect("sending a 20 MB attachment should succeed");
    println!("ok: alice uploaded {} bytes", contents.len());

    // Bob syncs and finds the message.
    let outcome = conversations::sync(&bob.ctx(), conversation_id).expect("bob sync");
    assert!(
        outcome.messages >= 1,
        "bob should see the message: {outcome:?}"
    );
    let messages = bob.store.messages(&conversation_id.to_string()).unwrap();
    assert!(
        messages.iter().any(|m| m.body == "the file you asked for"),
        "the accompanying message should be readable: {messages:?}"
    );
    println!("ok: bob received the message");

    // Bob opens the file the way the UI will: by envelope id, with the key
    // read out of his own encrypted store. This is the part that makes it
    // end-to-end -- the key was never anywhere the server could reach it.
    let message = messages
        .iter()
        .find(|m| m.body == "the file you asked for")
        .expect("the attachment message");
    assert!(
        message.payload.is_some(),
        "the payload must be persisted, or the file is unreachable forever"
    );

    let fetched = conversations::fetch_attachment_by_id(&bob.ctx(), message.envelope_id)
        .expect("bob should be able to fetch and decrypt");
    assert_eq!(fetched.name, "report.bin");
    assert_eq!(
        fetched.contents.len(),
        contents.len(),
        "size changed in transit"
    );
    assert_eq!(fetched.contents, contents, "the file is not what was sent");
    println!(
        "ok: bob decrypted {} bytes, identical",
        fetched.contents.len()
    );

    // And now the part the milestone actually asks for: what is *in the
    // bucket*. Fetched raw, with no decryption.
    let s3_key = match nexo_protocol::Payload::decode(message.payload.as_ref().unwrap().as_bytes())
    {
        nexo_protocol::Payload::Attachment { s3_key, .. } => s3_key,
        other => panic!("expected an attachment, got {other:?}"),
    };
    use nexo_client::transport::Transport as _;
    let url = bob.transport.download_url(&s3_key).expect("download url");
    let stored = bob.transport.get_object(&url).expect("raw object");
    assert!(
        !stored.windows(marker.len()).any(|w| w == marker),
        "the stored object contains plaintext"
    );
    assert_ne!(stored, contents, "the stored object is the plaintext");
    assert!(
        stored.len() > contents.len(),
        "GCM adds a tag, so ciphertext should be longer than plaintext"
    );
    println!("ok: the object in the bucket is verifiably ciphertext");
}

/// A conversation whose Welcome was never sent must not trap the person in it.
///
/// This is the state a `start_with` leaves when the commit reaches the server
/// and the Welcome behind it does not: the conversation exists, both people are
/// members, one envelope is in the stream, and nobody holds a group the other
/// can be admitted to.
///
/// Left alone it is a trap with no exit, and each part of the trap is
/// reasonable on its own. The server keeps one DM per pair, so every attempt to
/// start a fresh chat is answered with this one. `discard_conversation` refuses
/// anything holding an envelope, and this holds the commit. And the Welcome
/// that would admit the second device is never coming, because the device that
/// would have sent it failed first. The chat therefore opens, looks ordinary,
/// and answers every message with "You are not in that conversation." forever.
///
/// The exit is leaving: once the membership row is gone the pair no longer has
/// a DM, and the next create makes one that works.
#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn a_conversation_whose_welcome_never_came_does_not_trap_anyone() {
    let alice = Client::new("trap-alice");
    let bob = Client::new("trap-bob");
    conversations::publish_key_packages(&alice.ctx(), 5).expect("alice publishes");
    conversations::publish_key_packages(&bob.ctx(), 5).expect("bob publishes");

    // Exactly what a half-finished `start_with` leaves behind: the rows, and a
    // commit, and no Welcome.
    let orphan = ConversationId::new_v4().to_string();
    alice
        .transport
        .create_conversation(&orphan, std::slice::from_ref(&bob.handle))
        .expect("the server creates it");
    alice
        .transport
        .send(
            &orphan,
            "00ff00ff",
            0,
            true,
            &ConversationId::new_v4().to_string(),
        )
        .expect("a commit reaches the server");

    // Bob asks to talk to alice. The server will offer him the orphan.
    let opened = conversations::open_with(&bob.ctx(), &alice.handle).expect("open");

    assert_ne!(
        opened.to_string(),
        orphan,
        "bob must not be handed the conversation he can never enter"
    );
    assert!(
        Conversation::load(&bob.provider, opened, 1_760_000_000_000)
            .expect("load")
            .is_some(),
        "the conversation bob is given must be one he holds the group for"
    );

    // The proof that matters: he can actually send in it.
    conversations::send_message(&bob.ctx(), opened, "hello at last").expect("bob can send");
}

#[test]
#[ignore = "needs a running nexo-server and Postgres"]
fn a_picture_a_gif_and_a_video_all_round_trip() {
    // The gap this closes: the 20 MB test above sends
    // `application/octet-stream`, which is sealed whole. Video is sealed in
    // *segments* so it can be streamed, and for a while nothing exercised
    // receiving one — `fetch_attachment` decrypted whole-object regardless, so
    // saving a video and opening one in the lightbox both failed while the
    // bubble, which streams, looked fine.
    let alice = Client::new("media-a");
    let bob = Client::new("media-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    // A real PNG header, a real GIF89a header, and enough bytes after each to
    // span more than one segment for the video. The headers matter because the
    // receiver sniffs the bytes rather than trusting the declared type.
    let png = {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend((0..4096).map(|i| (i % 251) as u8));
        v
    };
    let gif = {
        let mut v = b"GIF89a".to_vec();
        v.extend((0..2048).map(|i| (i % 241) as u8));
        v
    };
    // Deliberately more than one segment, so the reassembly is exercised
    // rather than a single-segment special case that would pass either way.
    let mp4 = {
        let mut v = vec![
            0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'm', b'p', b'4', b'2',
        ];
        v.extend((0..700_000usize).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8));
        v
    };

    for (name, mime, bytes) in [
        ("holiday.png", "image/png", &png),
        ("reaction.gif", "image/gif", &gif),
        ("clip.mp4", "video/mp4", &mp4),
    ] {
        conversations::send_attachment(
            &alice.ctx(),
            conversation_id,
            name,
            mime,
            bytes,
            Some(name),
            None,
        )
        .unwrap_or_else(|e| panic!("sending {name} should succeed: {e:?}"));
    }
    println!("ok: alice sent a picture, a gif and a video");

    let outcome = conversations::sync(&bob.ctx(), conversation_id).expect("bob sync");
    assert!(
        outcome.messages >= 3,
        "bob should receive all three: {outcome:?}"
    );

    let messages = bob.store.messages(&conversation_id.to_string()).unwrap();
    for (name, expected) in [
        ("holiday.png", &png),
        ("reaction.gif", &gif),
        ("clip.mp4", &mp4),
    ] {
        let message = messages
            .iter()
            .find(|m| m.body == name)
            .unwrap_or_else(|| panic!("{name} should have arrived: {messages:?}"));

        // Exactly what "Save as…" and the lightbox do: fetch the whole file by
        // envelope id, with the key from Bob's own store.
        let fetched = conversations::fetch_attachment_by_id(&bob.ctx(), message.envelope_id)
            .unwrap_or_else(|e| panic!("bob should be able to open {name}: {e:?}"));

        assert_eq!(fetched.name, name);
        assert_eq!(
            fetched.contents.len(),
            expected.len(),
            "{name} changed size in transit"
        );
        assert_eq!(&fetched.contents, expected, "{name} came back different");
        println!("ok: bob opened {name}, {} bytes, identical", expected.len());
    }

    // The video, and only the video, must be the segmented encoding -- that is
    // what the streaming path reads, and what the whole-file path above had to
    // learn to handle.
    let clip = messages.iter().find(|m| m.body == "clip.mp4").unwrap();
    let info = conversations::stream_info(&bob.ctx(), clip.envelope_id)
        .expect("stream info should be readable")
        .expect("a video must be streamable");
    assert_eq!(info.size, mp4.len() as u64);
    assert!(
        info.segments > 1,
        "the test file must span more than one segment, got {}",
        info.segments
    );

    let picture = messages.iter().find(|m| m.body == "holiday.png").unwrap();
    assert!(
        conversations::stream_info(&bob.ctx(), picture.envelope_id)
            .unwrap()
            .is_none(),
        "a picture is sealed whole, not segmented"
    );

    // And one segment on its own opens, which is what a range request becomes.
    let first = conversations::attachment_segment(&bob.ctx(), clip.envelope_id, 0)
        .expect("the first segment should open on its own");
    assert_eq!(&first[..12], &mp4[..12], "the file header should be intact");
    let last = conversations::attachment_segment(&bob.ctx(), clip.envelope_id, info.segments - 1)
        .expect("the last segment should open on its own");
    assert!(!last.is_empty());
    println!(
        "ok: the video is {} segments, and segments open individually",
        info.segments
    );
}
