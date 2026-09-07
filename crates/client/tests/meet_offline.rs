//! The map has to survive the network going away.
//!
//! A map that renders empty because a train went into a tunnel does not look
//! like a failure — it looks like a map with nobody on it, and "nobody is
//! here" is a different and much worse message than "this is how it looked an
//! hour ago". So an unreachable server falls back to the cached pins and says
//! that is what it did.

use std::cell::Cell;
use std::path::PathBuf;

use nexo_client::meet::{self, Context};
use nexo_client::transport::{
    Accepted, ClaimedKeyPackage, ConversationSummary, Envelope, SaltResponse, SessionTokens,
    Transport, TransportError,
};
use nexo_protocol::{MeetProfile, MeetProfileUpdate, MeetRequest};
use nexo_store::EncryptedStore;

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "nexo-meet-{}-{}-{tag}",
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

/// Serves one page of pins, then refuses everything once the network is cut.
struct Flaky {
    up: Cell<bool>,
    pins: Vec<MeetProfile>,
}

/// Everything this test does not exercise. Loud rather than empty: a stub that
/// answers `Ok(vec![])` would let a broken call pass as an empty map, which is
/// the exact confusion these tests exist to prevent.
macro_rules! not_here {
    ($($name:ident($($arg:ty),*) -> $ret:ty;)*) => {
        $(fn $name(&self, $(_: $arg),*) -> Result<$ret, TransportError> {
            unimplemented!(concat!(stringify!($name), " is not part of the map"))
        })*
    };
}

impl Transport for Flaky {
    fn meet_pins(&self, after: Option<&str>) -> Result<Vec<MeetProfile>, TransportError> {
        if !self.up.get() {
            return Err(TransportError::Unreachable("the network is down".into()));
        }
        // One page, and the second call ends it.
        match after {
            None => Ok(self.pins.clone()),
            Some(_) => Ok(Vec::new()),
        }
    }

    fn set_access_token(&self, _token: &str) {}

    not_here! {
        salt(&str) -> SaltResponse;
        login(&str, &str, &str) -> SessionTokens;
        refresh(&str) -> SessionTokens;
        logout(&str) -> ();
        change_password(&str, &str, &str) -> ();
        delete_account(&str) -> ();
        publish_key_packages(&[String]) -> ();
        key_package_count() -> (i64, i64);
        claim_key_package(&str) -> ClaimedKeyPackage;
        create_conversation(&str, &[String]) -> String;
        discard_conversation(&str) -> ();
        list_conversations() -> Vec<ConversationSummary>;
        add_member(&str, &str) -> ();
        remove_member(&str, &str) -> ();
        upload_url(&str, u64) -> (String, String);
        download_url(&str) -> String;
        put_object(&str, Vec<u8>) -> ();
        get_object(&str) -> Vec<u8>;
        sync(&str, i64) -> Vec<Envelope>;
        meet_me() -> Option<MeetProfile>;
        meet_set_me(&MeetProfileUpdate) -> ();
        meet_leave() -> ();
        meet_consent(i32) -> ();
        meet_requests() -> Vec<MeetRequest>;
        meet_open_request(&str, &str) -> MeetRequest;
        meet_accept(i64) -> ();
        meet_decline(i64) -> ();
        report(&str, i64, &str, Option<&str>) -> ();
        search_users(&str) -> Vec<nexo_client::transport::SearchResult>;
        ice_servers() -> nexo_protocol::IceServers;
        create_invite(Option<&str>, i64) -> nexo_client::transport::MintedInvite;
        list_invites() -> Vec<nexo_client::transport::InviteSummary>;
        revoke_invite(i64) -> ();
        story_upload_url(u64) -> (String, String);
        create_story(&str, i64) -> nexo_client::transport::StorySummary;
        story_url(i64) -> String;
        list_stories() -> Vec<nexo_client::transport::StorySummary>;
    }

    fn register(
        &self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<SessionTokens, TransportError> {
        unimplemented!("register is not part of the map")
    }

    fn send(&self, _: &str, _: &str, _: i64, _: bool, _: &str) -> Result<Accepted, TransportError> {
        unimplemented!("send is not part of the map")
    }
}

fn a_pin(handle: &str) -> MeetProfile {
    MeetProfile {
        handle: handle.into(),
        display_name: handle.to_uppercase(),
        lat: 47.1,
        lon: 8.2,
        headline: None,
        char_config: serde_json::json!({ "topVariant": "hoodie" }),
        updated_at_ms: 1_760_000_000_000,
    }
}

#[test]
fn an_unreachable_server_draws_the_cached_map_rather_than_an_empty_one() {
    let dir = TempDir::new("offline");
    let store = EncryptedStore::open(dir.db(), &[0x5Au8; 32]).unwrap();
    let transport = Flaky {
        up: Cell::new(true),
        pins: vec![a_pin("dice"), a_pin("bananaaboy")],
    };
    let ctx = Context {
        transport: &transport,
        store: &store,
    };

    let fresh = meet::map(&ctx, 1_000).expect("first fetch");
    assert_eq!(fresh.pins.len(), 2);
    assert!(!fresh.stale, "a live fetch is not stale");
    assert_eq!(fresh.fetched_at_ms, 1_000);

    transport.up.set(false);

    let offline = meet::map(&ctx, 2_000).expect("offline must not be an error");
    assert_eq!(
        offline.pins.len(),
        2,
        "the cached map is what stands in for the live one"
    );
    assert!(offline.stale, "and the UI has to be able to say so");
    assert_eq!(
        offline.fetched_at_ms, 1_000,
        "the age shown is when it was fetched, not when it was read"
    );
}

/// With nothing cached there is genuinely nothing to draw, and that is not an
/// error either — it is a first run without a network.
#[test]
fn an_unreachable_server_with_no_cache_is_an_empty_stale_map() {
    let dir = TempDir::new("offline-cold");
    let store = EncryptedStore::open(dir.db(), &[0x5Au8; 32]).unwrap();
    let transport = Flaky {
        up: Cell::new(false),
        pins: Vec::new(),
    };
    let ctx = Context {
        transport: &transport,
        store: &store,
    };

    let map = meet::map(&ctx, 5_000).expect("no cache is not a failure");
    assert!(map.pins.is_empty());
    assert!(map.stale);
    assert_eq!(map.fetched_at_ms, 0, "never fetched");
}

/// A refusal that is not the network must not be disguised as staleness.
#[test]
fn a_rejection_is_reported_rather_than_hidden_behind_the_cache() {
    struct Refusing;
    impl Transport for Refusing {
        fn meet_pins(&self, _: Option<&str>) -> Result<Vec<MeetProfile>, TransportError> {
            Err(TransportError::InvalidCredentials)
        }
        fn set_access_token(&self, _token: &str) {}
        not_here! {
            salt(&str) -> SaltResponse;
            login(&str, &str, &str) -> SessionTokens;
            refresh(&str) -> SessionTokens;
            logout(&str) -> ();
            change_password(&str, &str, &str) -> ();
        delete_account(&str) -> ();
            publish_key_packages(&[String]) -> ();
            key_package_count() -> (i64, i64);
            claim_key_package(&str) -> ClaimedKeyPackage;
            create_conversation(&str, &[String]) -> String;
            discard_conversation(&str) -> ();
            list_conversations() -> Vec<ConversationSummary>;
            add_member(&str, &str) -> ();
            remove_member(&str, &str) -> ();
            upload_url(&str, u64) -> (String, String);
            download_url(&str) -> String;
            put_object(&str, Vec<u8>) -> ();
            get_object(&str) -> Vec<u8>;
            sync(&str, i64) -> Vec<Envelope>;
            meet_me() -> Option<MeetProfile>;
            meet_set_me(&MeetProfileUpdate) -> ();
            meet_leave() -> ();
            meet_consent(i32) -> ();
            meet_requests() -> Vec<MeetRequest>;
            meet_open_request(&str, &str) -> MeetRequest;
            meet_accept(i64) -> ();
            meet_decline(i64) -> ();
        report(&str, i64, &str, Option<&str>) -> ();
        search_users(&str) -> Vec<nexo_client::transport::SearchResult>;
        ice_servers() -> nexo_protocol::IceServers;
        create_invite(Option<&str>, i64) -> nexo_client::transport::MintedInvite;
        list_invites() -> Vec<nexo_client::transport::InviteSummary>;
        revoke_invite(i64) -> ();
        story_upload_url(u64) -> (String, String);
        create_story(&str, i64) -> nexo_client::transport::StorySummary;
        story_url(i64) -> String;
        list_stories() -> Vec<nexo_client::transport::StorySummary>;
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
        fn send(
            &self,
            _: &str,
            _: &str,
            _: i64,
            _: bool,
            _: &str,
        ) -> Result<Accepted, TransportError> {
            unimplemented!()
        }
    }

    let dir = TempDir::new("offline-refused");
    let store = EncryptedStore::open(dir.db(), &[0x5Au8; 32]).unwrap();
    let ctx = Context {
        transport: &Refusing,
        store: &store,
    };

    assert!(
        meet::map(&ctx, 1).is_err(),
        "an expired session is not a stale map, and saying it is would hide it"
    );
}
