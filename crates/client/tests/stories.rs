//! A received story sits with a blank author until something resolves it.
//!
//! MLS names devices, not accounts, so `insert_story` on the receive path
//! (`conversations.rs`) writes `author_handle: String::new()` on purpose --
//! inventing a handle from a device id would put a UUID under somebody's
//! story. `stories::live` is where that gets fixed: it asks the server's
//! `GET /v1/stories` listing, by id, who a story actually belongs to. These
//! tests pin that reconciliation down, including the two ways it must not
//! make things worse: it must never overwrite a handle that is already
//! known (the reader's own story), and a transport failure must fall back
//! to the unresolved list rather than losing the read entirely -- the same
//! promise `live_stories` already makes for working offline.

use std::path::PathBuf;

use nexo_client::conversations::Context;
use nexo_client::stories;
use nexo_client::transport::{
    Accepted, ClaimedKeyPackage, ConversationSummary, Envelope, SaltResponse, SessionTokens,
    StorySummary, Transport, TransportError,
};
use nexo_crypto::identity::IdentityKeypair;
use nexo_crypto::mls::credential_for;
use nexo_protocol::DeviceId;
use nexo_store::{EncryptedStore, StoredStory};
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;

const T0: i64 = 1_760_000_000_000;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "nexo-stories-{}-{}-{tag}",
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

/// Answers `list_stories` from a script, or refuses to answer at all.
///
/// Everything else is `unimplemented!()`: `stories::live` should touch
/// nothing but the store and this one call, and a test here should fail
/// loudly the moment that stops being true rather than quietly exercise a
/// different path than the one it names.
struct Listing {
    answer: Result<Vec<StorySummary>, ()>,
}

impl Listing {
    fn of(stories: Vec<StorySummary>) -> Self {
        Self {
            answer: Ok(stories),
        }
    }
    fn unreachable() -> Self {
        Self { answer: Err(()) }
    }
}

impl Transport for Listing {
    fn list_stories(&self) -> Result<Vec<StorySummary>, TransportError> {
        self.answer
            .clone()
            .map_err(|()| TransportError::Unreachable("the network is down".into()))
    }
    fn set_access_token(&self, _token: &str) {}

    fn salt(&self, _: &str) -> Result<SaltResponse, TransportError> {
        unimplemented!("not what this file tests")
    }
    fn register(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<SessionTokens, TransportError> {
        unimplemented!()
    }
    fn login(&self, _: &str, _: &str, _: &str) -> Result<SessionTokens, TransportError> {
        unimplemented!()
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
        unimplemented!()
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
        unimplemented!()
    }
    fn discard_conversation(&self, _: &str) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, TransportError> {
        unimplemented!()
    }
    fn send(&self, _: &str, _: &str, _: i64, _: bool, _: &str) -> Result<Accepted, TransportError> {
        unimplemented!()
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
        unimplemented!()
    }
    fn story_upload_url(&self, _size: u64) -> Result<(String, String), TransportError> {
        unimplemented!()
    }
    fn create_story(&self, _key: &str, _size: i64) -> Result<StorySummary, TransportError> {
        unimplemented!()
    }
    fn story_url(&self, _id: i64) -> Result<String, TransportError> {
        unimplemented!()
    }
    fn ice_servers(&self) -> Result<nexo_protocol::IceServers, TransportError> {
        Ok(nexo_protocol::IceServers {
            servers: Vec::new(),
            expires_at_ms: 0,
            relay_only: true,
        })
    }

    fn search_users(
        &self,
        _term: &str,
    ) -> Result<Vec<nexo_client::transport::SearchResult>, TransportError> {
        unimplemented!()
    }
    fn meet_me(&self) -> Result<Option<nexo_protocol::MeetProfile>, TransportError> {
        unimplemented!()
    }
    fn meet_set_me(&self, _: &nexo_protocol::MeetProfileUpdate) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn meet_leave(&self) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn meet_consent(&self, _: i32) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn meet_pins(
        &self,
        _: Option<&str>,
    ) -> Result<Vec<nexo_protocol::MeetProfile>, TransportError> {
        unimplemented!()
    }
    fn meet_requests(&self) -> Result<Vec<nexo_protocol::MeetRequest>, TransportError> {
        unimplemented!()
    }
    fn meet_open_request(
        &self,
        _: &str,
        _: &str,
    ) -> Result<nexo_protocol::MeetRequest, TransportError> {
        unimplemented!()
    }
    fn meet_accept(&self, _: i64) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn meet_decline(&self, _: i64) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn report(&self, _: &str, _: i64, _: &str, _: Option<&str>) -> Result<(), TransportError> {
        unimplemented!()
    }
    fn create_invite(
        &self,
        _: Option<&str>,
        _: i64,
    ) -> Result<nexo_client::transport::MintedInvite, TransportError> {
        unimplemented!()
    }
    fn list_invites(&self) -> Result<Vec<nexo_client::transport::InviteSummary>, TransportError> {
        unimplemented!()
    }
    fn revoke_invite(&self, _: i64) -> Result<(), TransportError> {
        unimplemented!()
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

fn received(id: i64, device_id: &str) -> StoredStory {
    StoredStory {
        id,
        author_handle: String::new(),
        author_device_id: device_id.into(),
        s3_key: format!("story/{id}"),
        enc_key: "aa".into(),
        nonce: "bb".into(),
        sha256: "cc".into(),
        mime: "image/jpeg".into(),
        size: 1024,
        created_at_ms: T0,
        expires_at_ms: T0 + 60_000,
    }
}

fn listed(id: i64, handle: &str) -> StorySummary {
    StorySummary {
        id,
        author_handle: handle.into(),
        created_at_ms: T0,
        expires_at_ms: T0 + 60_000,
    }
}

#[test]
fn a_received_story_is_named_from_the_servers_listing() {
    let dir = TempDir::new("resolve");
    let device = Device::new(&dir);
    device
        .store
        .insert_story(&received(1, "dev-alice"))
        .unwrap();

    let transport = Listing::of(vec![listed(1, "alice")]);
    let live = stories::live(&device.ctx(&transport), T0).unwrap();

    assert_eq!(live.len(), 1);
    assert_eq!(live[0].author_handle, "alice");
}

#[test]
fn a_story_the_listing_does_not_mention_stays_blank_rather_than_guessed() {
    let dir = TempDir::new("unmatched");
    let device = Device::new(&dir);
    device
        .store
        .insert_story(&received(1, "dev-alice"))
        .unwrap();

    // The listing knows about a *different* story. Nothing here licenses a
    // guess -- an unmatched row keeps the honest "unknown" it already had.
    let transport = Listing::of(vec![listed(2, "bob")]);
    let live = stories::live(&device.ctx(&transport), T0).unwrap();

    assert_eq!(live.len(), 1);
    assert_eq!(live[0].author_handle, "");
}

#[test]
fn an_own_story_already_named_is_not_overwritten() {
    let dir = TempDir::new("own");
    let device = Device::new(&dir);
    // The author's own copy is written with a handle at post time (`post`,
    // in stories.rs) -- unlike a received one, which starts blank.
    let mut mine = received(1, "");
    mine.author_handle = "me".into();
    device.store.insert_story(&mine).unwrap();

    // The listing does not distinguish "you" from any other contact, so if
    // this ever preferred the listing's answer over what is already known,
    // a coincidence in the data could rename the reader's own story.
    let transport = Listing::of(vec![listed(1, "someone-else")]);
    let live = stories::live(&device.ctx(&transport), T0).unwrap();

    assert_eq!(live[0].author_handle, "me");
}

#[test]
fn an_unreachable_server_falls_back_to_the_unresolved_list() {
    let dir = TempDir::new("offline");
    let device = Device::new(&dir);
    device
        .store
        .insert_story(&received(1, "dev-alice"))
        .unwrap();

    // The same promise `live_stories` already makes for reading offline: a
    // device with no network still gets its cached stories back, just
    // without the name filled in -- not an error, and not an empty list.
    let transport = Listing::unreachable();
    let live = stories::live(&device.ctx(&transport), T0).unwrap();

    assert_eq!(live.len(), 1);
    assert_eq!(live[0].author_handle, "");
}
