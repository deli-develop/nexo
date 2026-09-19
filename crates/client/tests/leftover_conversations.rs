//! A conversation the server lists but nobody can enter must not be drawn.
//!
//! `discover` builds the sidebar from the delivery service's membership list,
//! and membership is not the same fact as having been let in: the Welcome is
//! what admits a device, and it travels as an ordinary envelope that a failed
//! `start_with` may never have sent. What is left behind is a conversation the
//! server lists, that holds nothing, and that this device has no group for.
//!
//! Drawn, it looks like a chat and answers every message with "You are not in
//! that conversation." forever. These tests pin the cases apart: a new leftover
//! is not added, one already on the device is cleared, and anything holding an
//! envelope or a group is left strictly alone.

use std::cell::RefCell;
use std::path::PathBuf;

use nexo_client::conversations::{self, Context};
use nexo_client::transport::{
    Accepted, ClaimedKeyPackage, ConversationSummary, Envelope, SaltResponse, SessionTokens,
    Transport, TransportError,
};
use nexo_crypto::identity::IdentityKeypair;
use nexo_crypto::mls::{Conversation, credential_for};
use nexo_protocol::{ConversationId, DeviceId};
use nexo_store::EncryptedStore;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;

const T0: i64 = 1_760_000_000_000;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "nexo-leftover-{}-{}-{tag}",
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

/// Answers `list_conversations` from a script and records what was discarded.
///
/// Everything else is `unimplemented!()` on purpose: if `discover` ever starts
/// reaching for the network somewhere else, these tests should fail loudly
/// rather than quietly exercise a different path than the one they name.
struct Listing {
    summaries: Vec<ConversationSummary>,
    discarded: RefCell<Vec<String>>,
}

impl Listing {
    fn of(summaries: Vec<ConversationSummary>) -> Self {
        Self {
            summaries,
            discarded: RefCell::new(Vec::new()),
        }
    }
}

impl Transport for Listing {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, TransportError> {
        Ok(self.summaries.clone())
    }
    fn discard_conversation(&self, conversation_id: &str) -> Result<(), TransportError> {
        self.discarded
            .borrow_mut()
            .push(conversation_id.to_string());
        Ok(())
    }
    fn set_access_token(&self, _token: &str) {}

    fn salt(&self, _: &str) -> Result<SaltResponse, TransportError> {
        unimplemented!("discover does not authenticate")
    }
    fn register(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<SessionTokens, TransportError> {
        unimplemented!("discover does not register")
    }
    fn login(&self, _: &str, _: &str, _: &str) -> Result<SessionTokens, TransportError> {
        unimplemented!("discover does not log in")
    }
    fn refresh(&self, _: &str) -> Result<SessionTokens, TransportError> {
        unimplemented!()
    }
    fn logout(&self, _: &str) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn change_password(&self, _: &str, _: &str, _: &str) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn delete_account(&self, _: &str) -> Result<(), TransportError> {
        Ok(())
    }
    fn publish_key_packages(&self, _: &[String]) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn key_package_count(&self) -> Result<(i64, i64), TransportError> {
        unimplemented!()
    }
    fn claim_key_package(&self, _: &str) -> Result<ClaimedKeyPackage, TransportError> {
        unimplemented!()
    }
    fn create_conversation(&self, _: &str, _: &[String]) -> Result<String, TransportError> {
        unimplemented!("discover never creates")
    }
    fn send(&self, _: &str, _: &str, _: i64, _: bool, _: &str) -> Result<Accepted, TransportError> {
        unimplemented!("discover never sends")
    }
    fn add_member(&self, _: &str, _: &str) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn remove_member(&self, _: &str, _: &str) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn upload_url(&self, _: &str, _: u64) -> Result<(String, String), TransportError> {
        unimplemented!()
    }
    fn download_url(&self, _: &str) -> Result<String, TransportError> {
        unimplemented!()
    }
    fn put_object(&self, _: &str, _: Vec<u8>) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn get_object(&self, _: &str) -> Result<Vec<u8>, TransportError> {
        unimplemented!()
    }
    fn sync(&self, _: &str, _: i64) -> Result<Vec<Envelope>, TransportError> {
        unimplemented!("these tests never reach a syncable conversation")
    }

    // Stories are not what this file is about.
    fn story_upload_url(&self, _size: u64) -> Result<(String, String), TransportError> {
        unimplemented!("not a story test")
    }

    fn create_story(
        &self,
        _key: &str,
        _size: i64,
    ) -> Result<nexo_client::transport::StorySummary, TransportError> {
        unimplemented!("not a story test")
    }
    fn story_url(&self, _id: i64) -> Result<String, TransportError> {
        unimplemented!("not a story test")
    }
    fn list_stories(&self) -> Result<Vec<nexo_client::transport::StorySummary>, TransportError> {
        unimplemented!("not a story test")
    }

    fn search_users(
        &self,
        _term: &str,
    ) -> Result<Vec<nexo_client::transport::SearchResult>, TransportError> {
        unimplemented!("not a directory test")
    }
    fn create_invite(
        &self,
        _label: Option<&str>,
        _days: i64,
    ) -> Result<nexo_client::transport::MintedInvite, TransportError> {
        unimplemented!("not a directory test")
    }
    fn list_invites(&self) -> Result<Vec<nexo_client::transport::InviteSummary>, TransportError> {
        unimplemented!("not a directory test")
    }
    fn revoke_invite(&self, _id: i64) -> Result<(), TransportError> {
        unimplemented!("not a directory test")
    }

    fn report(
        &self,
        _kind: &str,
        _id: i64,
        _reason: &str,
        _note: Option<&str>,
    ) -> Result<(), TransportError> {
        unimplemented!("not a report test")
    }
}

fn summary(id: &str, latest: Option<i64>) -> ConversationSummary {
    ConversationSummary {
        conversation_id: id.to_string(),
        kind: "dm".into(),
        epoch: 0,
        latest_envelope_id: latest,
        members: vec!["bananaaboy".into()],
    }
}

struct Device {
    provider: OpenMlsRustCrypto,
    store: EncryptedStore,
    signer: openmls_basic_credential::SignatureKeyPair,
    credential: openmls::prelude::CredentialWithKey,
}

impl Device {
    fn new(dir: &TempDir) -> Self {
        let store = EncryptedStore::open(dir.db(), &[0x5Au8; 32]).unwrap();
        let provider = OpenMlsRustCrypto::default();
        let identity = IdentityKeypair::generate();
        let (credential, signer) = credential_for(DeviceId::new_v4(), &identity);
        signer.store(provider.storage()).unwrap();
        Self {
            provider,
            store,
            signer,
            credential,
        }
    }
    fn ctx<'a>(&'a self, transport: &'a Listing) -> Context<'a, Listing> {
        Context {
            transport,
            provider: &self.provider,
            store: &self.store,
            signer: &self.signer,
            credential: self.credential.clone(),
        }
    }
}

#[test]
fn a_listed_conversation_with_no_envelopes_and_no_group_is_not_added() {
    let dir = TempDir::new("new");
    let device = Device::new(&dir);
    let id = ConversationId::new_v4().to_string();
    let transport = Listing::of(vec![summary(&id, None)]);

    let added = conversations::discover(&device.ctx(&transport)).unwrap();

    assert_eq!(added, 0, "a leftover is not a conversation to show");
    assert!(
        device.store.conversations().unwrap().is_empty(),
        "nothing should have been written to the sidebar"
    );
}

#[test]
fn a_leftover_already_on_the_device_is_cleared_from_both_sides() {
    let dir = TempDir::new("known");
    let device = Device::new(&dir);
    let id = ConversationId::new_v4().to_string();

    // As an earlier sync would have left it, before the check existed.
    device.store.set_conversation_cursor(&id, 0).unwrap();
    device
        .store
        .set_conversation_title(&id, "bananaaboy")
        .unwrap();
    assert_eq!(device.store.conversations().unwrap().len(), 1);

    let transport = Listing::of(vec![summary(&id, None)]);
    conversations::discover(&device.ctx(&transport)).unwrap();

    assert!(
        device.store.conversations().unwrap().is_empty(),
        "the row that could never be opened should be gone"
    );
    assert_eq!(
        transport.discarded.borrow().as_slice(),
        &[id],
        "and the server should be told to let go of it too"
    );
}

/// The guard must not touch a conversation that is merely new.
#[test]
fn a_conversation_holding_an_envelope_is_left_alone() {
    let dir = TempDir::new("real");
    let device = Device::new(&dir);
    let id = ConversationId::new_v4().to_string();

    // A real invitation always arrives with a Welcome behind it, so the server
    // reports an envelope even before this device has joined.
    let transport = Listing::of(vec![summary(&id, Some(7))]);
    let added = conversations::discover(&device.ctx(&transport)).unwrap();

    assert_eq!(added, 1, "an invitation must still appear");
    assert!(
        transport.discarded.borrow().is_empty(),
        "nothing to discard"
    );
}

/// Holding the group is enough on its own, envelopes or not.
#[test]
fn a_conversation_this_device_created_is_kept_before_anyone_speaks() {
    let dir = TempDir::new("mine");
    let device = Device::new(&dir);
    let id = ConversationId::new_v4();

    Conversation::create(
        &device.provider,
        &device.signer,
        device.credential.clone(),
        id,
        T0,
    )
    .unwrap();

    let raw = id.to_string();
    let transport = Listing::of(vec![summary(&raw, None)]);
    let added = conversations::discover(&device.ctx(&transport)).unwrap();

    assert_eq!(added, 1, "a group we hold is usable, however quiet it is");
    assert!(transport.discarded.borrow().is_empty());
}
