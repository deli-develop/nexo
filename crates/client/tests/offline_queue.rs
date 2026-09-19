//! M8's check: *network killed mid-send; the message delivers on reconnect,
//! once.*
//!
//! Two scenarios, and the second is the one that matters.
//!
//! **Truly offline.** The request never leaves. The message is queued, nothing
//! reaches the server, and a flush after reconnecting delivers it. Easy, and
//! not where duplicates come from.
//!
//! **The reply was lost.** The request arrives, the server writes the envelope,
//! and the response dies on the way back. The client sees a timeout — exactly
//! what it saw in the first scenario — and has no way to tell the two apart, so
//! it retries. Without an idempotency key that retry is a second copy of the
//! message in everyone's conversation. This is the case the whole design is
//! for, and `CutNetwork` reproduces it precisely: it performs the real request
//! and then throws the answer away.
//!
//! Ignored by default; needs Postgres and a running server.

#![cfg(feature = "http")]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;

use nexo_client::conversations::{self, Context, Sent};
use nexo_client::outbox;
use nexo_client::transport::{
    Accepted, ClaimedKeyPackage, ConversationSummary, Envelope, SaltResponse, SessionTokens,
    Transport, TransportError,
};
use nexo_client::{HttpTransport, session};
use nexo_crypto::identity::IdentityKeypair;
use nexo_crypto::mls::credential_for;
use nexo_platform::SecureStore;
use nexo_protocol::DeviceId;
use nexo_store::EncryptedStore;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use zeroize::Zeroizing;

// --------------------------------------------------------------- harness ---

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
            "nexo-outbox-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
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

/// How the network is behaving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Net {
    /// Everything works.
    Up,
    /// The request never leaves this machine.
    Down,
    /// The request goes through and the **reply** is thrown away.
    ///
    /// The dangerous one. Indistinguishable from `Down` to the caller, and the
    /// only reason exactly-once delivery needs the server's cooperation.
    ReplyLost,
}

/// An `HttpTransport` whose network can be cut.
struct CutNetwork {
    inner: HttpTransport,
    net: Cell<Net>,
    /// How many sends were actually attempted against the server.
    attempts: Cell<usize>,
}

impl CutNetwork {
    fn new(inner: HttpTransport) -> Self {
        CutNetwork {
            inner,
            net: Cell::new(Net::Up),
            attempts: Cell::new(0),
        }
    }
    fn set(&self, net: Net) {
        self.net.set(net);
    }
}

impl Transport for CutNetwork {
    fn salt(&self, handle: &str) -> Result<SaltResponse, TransportError> {
        self.inner.salt(handle)
    }
    fn register(
        &self,
        handle: &str,
        display_name: &str,
        pw_salt_hex: &str,
        pw_verifier_hex: &str,
        identity_pubkey_hex: &str,
    ) -> Result<SessionTokens, TransportError> {
        self.inner.register(
            handle,
            display_name,
            pw_salt_hex,
            pw_verifier_hex,
            identity_pubkey_hex,
        )
    }
    fn login(
        &self,
        handle: &str,
        pw_verifier_hex: &str,
        identity_pubkey_hex: &str,
    ) -> Result<SessionTokens, TransportError> {
        self.inner
            .login(handle, pw_verifier_hex, identity_pubkey_hex)
    }
    fn refresh(&self, refresh_token: &str) -> Result<SessionTokens, TransportError> {
        self.inner.refresh(refresh_token)
    }
    fn logout(&self, refresh_token: &str) -> Result<(), TransportError> {
        self.inner.logout(refresh_token)
    }
    fn change_password(
        &self,
        old_verifier: &str,
        new_salt: &str,
        new_verifier: &str,
    ) -> Result<(), TransportError> {
        self.inner
            .change_password(old_verifier, new_salt, new_verifier)
    }
    fn delete_account(&self, pw_verifier: &str) -> Result<(), TransportError> {
        self.inner.delete_account(pw_verifier)
    }
    fn publish_key_packages(&self, packages: &[String]) -> Result<(), TransportError> {
        self.inner.publish_key_packages(packages)
    }
    fn key_package_count(&self) -> Result<(i64, i64), TransportError> {
        self.inner.key_package_count()
    }
    fn claim_key_package(&self, handle: &str) -> Result<ClaimedKeyPackage, TransportError> {
        self.inner.claim_key_package(handle)
    }
    fn create_conversation(
        &self,
        conversation_id: &str,
        members: &[String],
    ) -> Result<String, TransportError> {
        self.inner.create_conversation(conversation_id, members)
    }
    fn discard_conversation(&self, conversation_id: &str) -> Result<(), TransportError> {
        self.inner.discard_conversation(conversation_id)
    }

    fn set_access_token(&self, token: &str) {
        self.inner.set_access_token(token);
    }
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, TransportError> {
        self.inner.list_conversations()
    }

    fn send(
        &self,
        conversation_id: &str,
        ciphertext_hex: &str,
        epoch: i64,
        is_commit: bool,
        client_msg_id: &str,
    ) -> Result<Accepted, TransportError> {
        match self.net.get() {
            Net::Down => Err(TransportError::Unreachable("the network is down".into())),
            Net::Up | Net::ReplyLost => {
                self.attempts.set(self.attempts.get() + 1);
                let result = self.inner.send(
                    conversation_id,
                    ciphertext_hex,
                    epoch,
                    is_commit,
                    client_msg_id,
                );
                if self.net.get() == Net::ReplyLost {
                    // The server has it. The client will never know.
                    Err(TransportError::Unreachable("the reply was lost".into()))
                } else {
                    result
                }
            }
        }
    }

    fn upload_url(
        &self,
        conversation_id: &str,
        size: u64,
    ) -> Result<(String, String), TransportError> {
        self.inner.upload_url(conversation_id, size)
    }
    fn download_url(&self, key: &str) -> Result<String, TransportError> {
        self.inner.download_url(key)
    }
    fn put_object(&self, url: &str, bytes: Vec<u8>) -> Result<(), TransportError> {
        self.inner.put_object(url, bytes)
    }
    fn get_object(&self, url: &str) -> Result<Vec<u8>, TransportError> {
        self.inner.get_object(url)
    }
    fn sync(&self, conversation_id: &str, since_id: i64) -> Result<Vec<Envelope>, TransportError> {
        self.inner.sync(conversation_id, since_id)
    }
    fn add_member(&self, conversation_id: &str, handle: &str) -> Result<(), TransportError> {
        self.inner.add_member(conversation_id, handle)
    }
    fn remove_member(&self, conversation_id: &str, handle: &str) -> Result<(), TransportError> {
        self.inner.remove_member(conversation_id, handle)
    }

    // Delegated like everything else: this file cuts the network for `send`
    // and nothing more, so stories behave normally through it.
    fn story_upload_url(&self, size: u64) -> Result<(String, String), TransportError> {
        self.inner.story_upload_url(size)
    }

    fn create_story(
        &self,
        key: &str,
        size: i64,
    ) -> Result<nexo_client::transport::StorySummary, TransportError> {
        self.inner.create_story(key, size)
    }
    fn story_url(&self, id: i64) -> Result<String, TransportError> {
        self.inner.story_url(id)
    }
    fn list_stories(&self) -> Result<Vec<nexo_client::transport::StorySummary>, TransportError> {
        self.inner.list_stories()
    }

    fn search_users(
        &self,
        term: &str,
    ) -> Result<Vec<nexo_client::transport::SearchResult>, TransportError> {
        self.inner.search_users(term)
    }
    fn create_invite(
        &self,
        label: Option<&str>,
        days: i64,
    ) -> Result<nexo_client::transport::MintedInvite, TransportError> {
        self.inner.create_invite(label, days)
    }
    fn list_invites(&self) -> Result<Vec<nexo_client::transport::InviteSummary>, TransportError> {
        self.inner.list_invites()
    }
    fn revoke_invite(&self, id: i64) -> Result<(), TransportError> {
        self.inner.revoke_invite(id)
    }

    fn report(
        &self,
        kind: &str,
        id: i64,
        reason: &str,
        note: Option<&str>,
    ) -> Result<(), TransportError> {
        self.inner.report(kind, id, reason, note)
    }
}

struct Client {
    handle: String,
    transport: CutNetwork,
    provider: OpenMlsRustCrypto,
    store: EncryptedStore,
    signer: openmls_basic_credential::SignatureKeyPair,
    credential: openmls::prelude::CredentialWithKey,
    #[allow(dead_code)]
    dir: TempDir,
    #[allow(dead_code)]
    keystore: FakeKeystore,
}

impl Client {
    fn new(tag: &str) -> Self {
        let dir = TempDir::new(tag);
        let keystore = FakeKeystore::default();
        let http = HttpTransport::with_base_url(base_url());
        let handle = unique_handle();

        let created = session::register(
            &http,
            &keystore,
            &dir.db(),
            &handle,
            "Offline Queue",
            "a development password",
        )
        .expect("register should succeed against a running server");
        http.set_access_token(&created.access_token);

        let store = EncryptedStore::open(
            dir.db(),
            &nexo_store::key::load_or_create(&keystore).unwrap().0,
        )
        .unwrap();

        let (secret, _public) = store.identity().unwrap().expect("an identity was stored");
        let identity = IdentityKeypair::from_secret_bytes(&secret).unwrap();
        let device_id: DeviceId = created.account.device_id.parse().unwrap();
        let provider = OpenMlsRustCrypto::default();
        let (credential, signer) = credential_for(device_id, &identity);
        signer.store(provider.storage()).ok();

        Client {
            handle,
            transport: CutNetwork::new(http),
            provider,
            store,
            signer,
            credential,
            dir,
            keystore,
        }
    }

    fn ctx(&self) -> Context<'_, CutNetwork> {
        Context {
            transport: &self.transport,
            provider: &self.provider,
            store: &self.store,
            signer: &self.signer,
            credential: self.credential.clone(),
        }
    }
}

fn base_url() -> String {
    std::env::var("NEXO_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string())
}

fn unique_handle() -> String {
    format!("o{}", uuid::Uuid::new_v4().simple())[..16].to_string()
}

// ----------------------------------------------------------------- tests ---

#[test]
#[ignore = "needs a running server and Postgres"]
fn a_message_sent_offline_is_queued_and_delivers_on_reconnect() {
    let alice = Client::new("q-a");
    let bob = Client::new("q-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    // The network dies.
    alice.transport.set(Net::Down);

    let sent = conversations::send_message(&alice.ctx(), conversation_id, "written offline")
        .expect("sending while offline is not an error -- it queues");
    assert!(
        matches!(sent, Sent::Queued { .. }),
        "should have been queued, got {sent:?}"
    );
    assert_eq!(alice.store.outbox_len().unwrap(), 1);
    println!("ok: queued while offline");

    // Bob sees nothing, because nothing was sent.
    let outcome = conversations::sync(&bob.ctx(), conversation_id).unwrap();
    assert_eq!(
        outcome.messages, 0,
        "nothing should have reached the server"
    );

    // The network returns.
    alice.transport.set(Net::Up);
    let flushed = outbox::flush(&alice.ctx()).expect("flush");
    assert_eq!(flushed.sent + flushed.already_sent, 1, "{flushed:?}");
    assert_eq!(
        alice.store.outbox_len().unwrap(),
        0,
        "the queue should be empty"
    );
    println!("ok: flushed on reconnect: {flushed:?}");

    // And exactly one message arrives.
    let outcome = conversations::sync(&bob.ctx(), conversation_id).unwrap();
    assert_eq!(outcome.messages, 1, "{outcome:?}");
    let messages = bob.store.messages(&conversation_id.to_string()).unwrap();
    let copies = messages
        .iter()
        .filter(|m| m.body == "written offline")
        .count();
    assert_eq!(copies, 1, "delivered {copies} times, expected once");
    println!("ok: delivered exactly once");
}

#[test]
#[ignore = "needs a running server and Postgres"]
fn a_send_whose_reply_was_lost_is_not_delivered_twice() {
    // The case duplicates actually come from. The server has the message; the
    // client does not know it, retries, and must not produce a second copy.
    let alice = Client::new("d-a");
    let bob = Client::new("d-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    alice.transport.set(Net::ReplyLost);
    let sent = conversations::send_message(&alice.ctx(), conversation_id, "sent but unconfirmed")
        .expect("a lost reply looks like being offline");
    assert!(matches!(sent, Sent::Queued { .. }), "got {sent:?}");
    assert_eq!(alice.store.outbox_len().unwrap(), 1);
    println!("ok: the server has it; alice thinks it failed");

    // Alice retries, twice, believing she is offline.
    alice.transport.set(Net::Up);
    let flushed = outbox::flush(&alice.ctx()).expect("flush");
    assert_eq!(alice.store.outbox_len().unwrap(), 0, "{flushed:?}");
    let flushed_again = outbox::flush(&alice.ctx()).expect("a second flush is a no-op");
    assert_eq!(flushed_again.sent + flushed_again.already_sent, 0);
    println!("ok: retried after reconnect");

    // Bob has one copy, not two.
    let outcome = conversations::sync(&bob.ctx(), conversation_id).unwrap();
    let messages = bob.store.messages(&conversation_id.to_string()).unwrap();
    let copies = messages
        .iter()
        .filter(|m| m.body == "sent but unconfirmed")
        .count();
    assert_eq!(
        copies, 1,
        "delivered {copies} times, expected once (sync: {outcome:?})"
    );
    println!(
        "ok: exactly one copy despite {} attempts",
        alice.transport.attempts.get()
    );
}

#[test]
#[ignore = "needs a running server and Postgres"]
fn queued_messages_keep_their_order() {
    // Out-of-order delivery is a visible bug in a chat app, and for a commit it
    // would leave the group's epoch inconsistent with what this device thinks.
    let alice = Client::new("or-a");
    let bob = Client::new("or-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();
    conversations::sync(&bob.ctx(), conversation_id).unwrap();

    alice.transport.set(Net::Down);
    for i in 0..5 {
        conversations::send_message(&alice.ctx(), conversation_id, &format!("message {i}"))
            .unwrap();
    }
    assert_eq!(alice.store.outbox_len().unwrap(), 5);

    alice.transport.set(Net::Up);
    let flushed = outbox::flush(&alice.ctx()).unwrap();
    assert_eq!(flushed.sent + flushed.already_sent, 5, "{flushed:?}");

    conversations::sync(&bob.ctx(), conversation_id).unwrap();
    let bodies: Vec<String> = bob
        .store
        .messages(&conversation_id.to_string())
        .unwrap()
        .into_iter()
        .map(|m| m.body)
        .filter(|b| b.starts_with("message "))
        .collect();
    assert_eq!(
        bodies,
        (0..5).map(|i| format!("message {i}")).collect::<Vec<_>>(),
        "the queue must flush in order"
    );
    println!("ok: five queued messages arrived in order");
}

#[test]
#[ignore = "needs a running server and Postgres"]
fn a_flush_that_cannot_reach_the_server_leaves_the_queue_intact() {
    // Being offline is the ordinary state this exists for. A flush that fails
    // must not consume anything, and must not report a failure the user has to
    // act on.
    let alice = Client::new("k-a");
    let bob = Client::new("k-b");

    conversations::publish_key_packages(&bob.ctx(), 2).unwrap();
    let conversation_id = conversations::start_with(&alice.ctx(), &bob.handle).unwrap();

    alice.transport.set(Net::Down);
    conversations::send_message(&alice.ctx(), conversation_id, "still waiting").unwrap();
    conversations::send_message(&alice.ctx(), conversation_id, "also waiting").unwrap();

    let flushed = outbox::flush(&alice.ctx()).expect("an offline flush is not an error");
    assert_eq!(flushed.sent, 0);
    assert_eq!(flushed.failed, 0, "being offline is not a failure");
    assert_eq!(flushed.still_queued, 2);
    assert_eq!(
        alice.store.outbox_len().unwrap(),
        2,
        "nothing may be dropped"
    );

    // And the reason is recorded, so the UI can say more than "pending".
    let queued = alice.store.outbox().unwrap();
    assert!(queued[0].attempts >= 1);
    assert!(queued[0].last_error.is_some());
    println!("ok: the queue survived an offline flush");
}
