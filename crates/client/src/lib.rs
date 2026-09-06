//! Client-side session logic, shared by every Nexo client.
//!
//! This is the crate the original build prompt called `packages/api-client`:
//! the part of the client that is the same on Windows and on Android, kept out
//! of the platform shells so the Android port reuses it rather than
//! reimplementing it (brief 12).
//!
//! It therefore contains **no platform calls and no HTTP client**. The OS
//! reaches it through [`nexo_platform::SecureStore`] and the network through
//! [`transport::Transport`], both of which the caller supplies.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod conversations;
#[cfg(feature = "http")]
pub mod feed;
#[cfg(feature = "http")]
pub mod http;
pub mod meet;
pub mod mls_state;
pub mod outbox;
pub mod pin;
pub mod session;
pub mod stories;
// Behind the same feature as the HTTP transport, and for the same reason: a
// shell that brings its own network stack should not be handed one.
#[cfg(feature = "http")]
pub mod stream;
pub mod transport;

pub use session::{Session, SessionError};
pub use transport::{Transport, TransportError};

#[cfg(feature = "http")]
pub use http::HttpTransport;

#[cfg(test)]
mod tests {
    use super::*;
    use nexo_platform::{STORE_KEY_NAME, SecureStore};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use transport::{Argon2Params, SaltResponse, SessionTokens};
    use zeroize::Zeroizing;

    /// Cheap parameters. The real ones are 64 MiB, which would make this suite
    /// take minutes for no extra confidence: what is under test here is the
    /// orchestration, not Argon2.
    const TEST_ARGON2: Argon2Params = Argon2Params {
        memory_kib: 64,
        iterations: 1,
        parallelism: 1,
    };

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

    /// Records what the client sent, so tests can assert on it — in particular
    /// that a password never appears in any of it.
    #[derive(Default)]
    struct FakeTransport {
        salt: RefCell<Vec<u8>>,
        registered: RefCell<Vec<(String, String, String, String)>>,
        logged_in: RefCell<Vec<(String, String, String)>>,
        logged_out: RefCell<Vec<String>>,
        /// `(old verifier, new salt, new verifier)`, all hex.
        password_changes: RefCell<Vec<(String, String, String)>>,
        registered_salt: RefCell<String>,
        fail_register_as_taken: bool,
        fail_login: bool,
    }

    impl FakeTransport {
        fn new() -> Self {
            Self {
                salt: RefCell::new(vec![0xAB; 16]),
                ..Default::default()
            }
        }
    }

    impl Transport for FakeTransport {
        fn salt(&self, _handle: &str) -> Result<SaltResponse, TransportError> {
            let hex: String = self
                .salt
                .borrow()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            Ok(SaltResponse {
                salt: hex,
                argon2: TEST_ARGON2,
            })
        }

        fn register(
            &self,
            handle: &str,
            display_name: &str,
            salt: &str,
            verifier: &str,
            pubkey: &str,
        ) -> Result<SessionTokens, TransportError> {
            if self.fail_register_as_taken {
                return Err(TransportError::HandleTaken);
            }
            self.registered_salt.replace(salt.to_string());
            self.registered.borrow_mut().push((
                handle.into(),
                display_name.into(),
                verifier.into(),
                pubkey.into(),
            ));
            Ok(SessionTokens {
                access_token: "access-1".into(),
                refresh_token: "refresh-1".into(),
                expires_in: 900,
                user_id: 7,
                device_id: "device-1".into(),
            })
        }

        fn login(
            &self,
            handle: &str,
            verifier: &str,
            pubkey: &str,
        ) -> Result<SessionTokens, TransportError> {
            if self.fail_login {
                return Err(TransportError::InvalidCredentials);
            }
            self.logged_in
                .borrow_mut()
                .push((handle.into(), verifier.into(), pubkey.into()));
            Ok(SessionTokens {
                access_token: "access-2".into(),
                refresh_token: "refresh-2".into(),
                expires_in: 900,
                user_id: 7,
                device_id: "device-1".into(),
            })
        }

        fn refresh(&self, _refresh_token: &str) -> Result<SessionTokens, TransportError> {
            Ok(SessionTokens {
                access_token: "access-refreshed".into(),
                refresh_token: "refresh-refreshed".into(),
                expires_in: 900,
                user_id: 7,
                device_id: "device-1".into(),
            })
        }

        fn logout(&self, refresh_token: &str) -> Result<(), TransportError> {
            self.logged_out.borrow_mut().push(refresh_token.into());
            Ok(())
        }

        fn delete_account(&self, _pw_verifier: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn change_password(
            &self,
            old_verifier: &str,
            new_salt: &str,
            new_verifier: &str,
        ) -> Result<(), TransportError> {
            self.password_changes.borrow_mut().push((
                old_verifier.into(),
                new_salt.into(),
                new_verifier.into(),
            ));
            Ok(())
        }

        // The delivery half of the trait. These tests are about the session
        // flow, so each one is the honest empty answer rather than a stub that
        // could quietly satisfy an assertion. The conversation layer is
        // exercised against a real server in tests/live_messaging.rs, where a
        // fake would prove nothing anyway.
        fn set_access_token(&self, _token: &str) {}

        fn publish_key_packages(&self, _packages: &[String]) -> Result<(), TransportError> {
            Ok(())
        }

        fn key_package_count(&self) -> Result<(i64, i64), TransportError> {
            Ok((0, 15))
        }

        fn claim_key_package(
            &self,
            _handle: &str,
        ) -> Result<transport::ClaimedKeyPackage, TransportError> {
            Err(TransportError::Rejected(
                "no key packages in this fake".into(),
            ))
        }

        fn create_conversation(
            &self,
            conversation_id: &str,
            _members: &[String],
        ) -> Result<String, TransportError> {
            Ok(conversation_id.to_string())
        }

        fn discard_conversation(&self, _conversation_id: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn list_conversations(
            &self,
        ) -> Result<Vec<transport::ConversationSummary>, TransportError> {
            Ok(Vec::new())
        }

        fn send(
            &self,
            _conversation_id: &str,
            _ciphertext_hex: &str,
            _epoch: i64,
            _is_commit: bool,
            _client_msg_id: &str,
        ) -> Result<transport::Accepted, TransportError> {
            Err(TransportError::Rejected("no delivery in this fake".into()))
        }

        fn upload_url(
            &self,
            _conversation_id: &str,
            _size: u64,
        ) -> Result<(String, String), TransportError> {
            Err(TransportError::Rejected("no storage in this fake".into()))
        }

        fn download_url(&self, _key: &str) -> Result<String, TransportError> {
            Err(TransportError::Rejected("no storage in this fake".into()))
        }

        fn put_object(&self, _url: &str, _bytes: Vec<u8>) -> Result<(), TransportError> {
            Err(TransportError::Rejected("no storage in this fake".into()))
        }

        fn get_object(&self, _url: &str) -> Result<Vec<u8>, TransportError> {
            Err(TransportError::Rejected("no storage in this fake".into()))
        }

        fn add_member(&self, _conversation_id: &str, _handle: &str) -> Result<(), TransportError> {
            Ok(())
        }

        fn remove_member(
            &self,
            _conversation_id: &str,
            _handle: &str,
        ) -> Result<(), TransportError> {
            Ok(())
        }

        fn sync(
            &self,
            _conversation_id: &str,
            _since_id: i64,
        ) -> Result<Vec<transport::Envelope>, TransportError> {
            Ok(Vec::new())
        }

        // Meet&Greet is not what these tests are about. `unimplemented!` rather
        // than an empty answer, so that a test which starts touching the map
        // fails loudly instead of quietly exercising a stub.
        fn story_upload_url(&self, _size: u64) -> Result<(String, String), TransportError> {
            unimplemented!("not a story test")
        }

        fn create_story(
            &self,
            _key: &str,
            _size: i64,
        ) -> Result<transport::StorySummary, TransportError> {
            unimplemented!("not a story test")
        }
        fn story_url(&self, _id: i64) -> Result<String, TransportError> {
            unimplemented!("not a story test")
        }
        fn list_stories(&self) -> Result<Vec<transport::StorySummary>, TransportError> {
            unimplemented!("not a story test")
        }

        fn search_users(
            &self,
            _term: &str,
        ) -> Result<Vec<transport::SearchResult>, TransportError> {
            unimplemented!("not a directory test")
        }
        fn create_invite(
            &self,
            _label: Option<&str>,
            _days: i64,
        ) -> Result<transport::MintedInvite, TransportError> {
            unimplemented!("not a directory test")
        }
        fn list_invites(&self) -> Result<Vec<transport::InviteSummary>, TransportError> {
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
            unimplemented!("these tests do not report")
        }

        fn meet_pins(
            &self,
            _after: Option<&str>,
        ) -> Result<Vec<nexo_protocol::MeetProfile>, TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_me(&self) -> Result<Option<nexo_protocol::MeetProfile>, TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_set_me(
            &self,
            _update: &nexo_protocol::MeetProfileUpdate,
        ) -> Result<(), TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_leave(&self) -> Result<(), TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_consent(&self, _version: i32) -> Result<(), TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_requests(&self) -> Result<Vec<nexo_protocol::MeetRequest>, TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_open_request(
            &self,
            _handle: &str,
            _conversation_id: &str,
        ) -> Result<nexo_protocol::MeetRequest, TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_accept(&self, _id: i64) -> Result<(), TransportError> {
            unimplemented!("these tests do not touch the map")
        }
        fn meet_decline(&self, _id: i64) -> Result<(), TransportError> {
            unimplemented!("these tests do not touch the map")
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nexo-client-{}-{}-{tag}",
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

    #[test]
    fn registering_persists_the_account_and_identity() {
        let dir = TempDir::new("register");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        let session = session::register(
            &transport,
            &keystore,
            &dir.db(),
            "alice",
            "Alice",
            "correct horse battery staple",
        )
        .unwrap();

        assert_eq!(session.account.handle, "alice");
        assert_eq!(session.account.user_id, 7);
        assert_eq!(session.access_token, "access-1");
    }

    /// A store belongs to one account, and a second one must not inherit it.
    ///
    /// Reachable without anybody doing anything strange: a retired refresh
    /// token drops the app to the sign-in screen with the store still on disk,
    /// and the handle typed there need not be the one it belongs to.
    #[test]
    fn a_second_account_cannot_open_the_first_ones_store() {
        let dir = TempDir::new("two-accounts");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(
            &transport,
            &keystore,
            &dir.db(),
            "alice",
            "Alice",
            "correct horse battery staple",
        )
        .unwrap();

        for outcome in [
            session::login(&transport, &keystore, &dir.db(), "bob", "hunter2 hunter2").err(),
            session::register(
                &transport,
                &keystore,
                &dir.db(),
                "bob",
                "Bob",
                "hunter2 hunter2",
            )
            .err(),
        ] {
            match outcome {
                Some(session::SessionError::DifferentAccount(handle)) => {
                    assert_eq!(handle, "alice", "the refusal has to name the account");
                }
                other => panic!("a second account should be refused, got {other:?}"),
            }
        }

        // And the first account is untouched: refusing is not a wipe.
        let store = nexo_store::EncryptedStore::open(
            dir.db(),
            &nexo_store::key::load_or_create(&keystore).unwrap().0,
        )
        .unwrap();
        assert_eq!(store.account().unwrap().unwrap().handle, "alice");
    }

    /// Signing the *same* account back in keeps its history and its identity.
    #[test]
    fn the_same_account_still_signs_in_over_its_own_store() {
        let dir = TempDir::new("same-account");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(
            &transport,
            &keystore,
            &dir.db(),
            "alice",
            "Alice",
            "correct horse battery staple",
        )
        .unwrap();

        let again = session::login(
            &transport,
            &keystore,
            &dir.db(),
            "alice",
            "correct horse battery staple",
        )
        .expect("the account that owns the store must still be able to sign in");
        assert_eq!(again.account.handle, "alice");
    }

    /// The property the three-step flow exists for.
    #[test]
    fn the_password_is_never_sent() {
        let dir = TempDir::new("no-password");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();
        let password = "correct horse battery staple";

        session::register(&transport, &keystore, &dir.db(), "alice", "Alice", password).unwrap();

        let sent = transport.registered.borrow();
        let (_, _, verifier, pubkey) = &sent[0];
        assert!(!verifier.contains(password));
        assert!(!pubkey.contains(password));
        // And the verifier is a 32-byte Argon2 output, not the password in any
        // encoding.
        assert_eq!(verifier.len(), 64, "verifier should be 32 bytes as hex");
    }

    /// M2's definition of done: register, restart, still signed in.
    #[test]
    fn an_account_survives_a_restart() {
        let dir = TempDir::new("restart");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();

        // A "restart" is exactly this: new objects, same keystore and same
        // file, nothing carried over in memory.
        let restored = session::restore(&keystore, &dir.db()).unwrap().unwrap();
        assert_eq!(restored.handle, "alice");
        assert_eq!(restored.user_id, 7);
    }

    /// The correction: a restart must come back *reachable*, not merely
    /// remembered.
    #[test]
    fn a_stored_session_resumes_without_a_password() {
        let dir = TempDir::new("resume");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();

        // A restart: nothing carried over but the keystore and the file.
        let resumed = session::resume(&transport, &keystore, &dir.db())
            .unwrap()
            .expect("a stored session should resume");

        assert_eq!(resumed.account.handle, "alice");
        assert_eq!(
            resumed.access_token, "access-refreshed",
            "resuming must obtain a fresh access token, not reuse a stored one"
        );
    }

    #[test]
    fn resuming_rotates_the_stored_refresh_token() {
        // The token that went in is dead the moment it is used; keeping it
        // would mean presenting a revoked token on the next launch, which the
        // server treats as theft.
        let dir = TempDir::new("rotate");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();
        let first = session::resume(&transport, &keystore, &dir.db())
            .unwrap()
            .unwrap();
        assert_eq!(first.refresh_token, "refresh-refreshed");
        assert_ne!(first.refresh_token, "refresh-1");
    }

    #[test]
    fn resuming_a_fresh_install_is_none() {
        let dir = TempDir::new("resume-fresh");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();
        assert!(
            session::resume(&transport, &keystore, &dir.db())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn logging_out_removes_the_stored_refresh_token_with_everything_else() {
        let dir = TempDir::new("logout-token");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        let s =
            session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();
        session::logout(&transport, &keystore, &dir.db(), &s.refresh_token).unwrap();

        // The whole file is gone, so there is nothing left to resume from.
        assert!(
            session::resume(&transport, &keystore, &dir.db())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn restoring_without_a_store_is_none_rather_than_an_error() {
        // First ever launch. Not a failure.
        let dir = TempDir::new("fresh");
        let keystore = FakeKeystore::default();
        assert!(session::restore(&keystore, &dir.db()).unwrap().is_none());
    }

    /// The identity key must not change on login, or every contact who verified
    /// a safety number sees what looks exactly like an attack.
    #[test]
    fn logging_in_again_keeps_the_same_identity_key() {
        let dir = TempDir::new("stable-identity");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();
        let first_pubkey = transport.registered.borrow()[0].3.clone();

        session::login(&transport, &keystore, &dir.db(), "alice", "pw").unwrap();
        let second_pubkey = transport.logged_in.borrow()[0].2.clone();

        assert_eq!(
            first_pubkey, second_pubkey,
            "a new identity key on every login is indistinguishable from a key-substitution attack"
        );
    }

    #[test]
    fn logging_in_does_not_rename_the_account() {
        // The login response carries no display name. Defaulting to the handle
        // would quietly rename the account on every sign-in.
        let dir = TempDir::new("display-name");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(
            &transport,
            &keystore,
            &dir.db(),
            "alice",
            "Alice Example",
            "pw",
        )
        .unwrap();
        let session = session::login(&transport, &keystore, &dir.db(), "alice", "pw").unwrap();

        assert_eq!(session.account.display_name, "Alice Example");
    }

    /// The bug the live test caught: registration must send the salt it used,
    /// or login derives against a different one and the account is unusable.
    #[test]
    fn registration_sends_the_salt_it_derived_against() {
        let dir = TempDir::new("salt-sent");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();

        let salt = transport.registered_salt.borrow().clone();
        assert_eq!(salt.len(), 32, "16 bytes as hex");
        assert_ne!(
            salt,
            transport.salt("alice").unwrap().salt,
            "the salt must be freshly generated, not the decoy from /salt"
        );
    }

    #[test]
    fn the_same_password_and_salt_always_derive_the_same_verifier() {
        let salt = [1u8; 16];
        let a = session::derive_verifier("pw", &salt, TEST_ARGON2).unwrap();
        let b = session::derive_verifier("pw", &salt, TEST_ARGON2).unwrap();
        assert_eq!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn a_different_salt_derives_a_different_verifier() {
        // Otherwise one precomputed table would open every account.
        let a = session::derive_verifier("pw", &[1u8; 16], TEST_ARGON2).unwrap();
        let b = session::derive_verifier("pw", &[2u8; 16], TEST_ARGON2).unwrap();
        assert_ne!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn a_taken_handle_is_reported_as_such() {
        let dir = TempDir::new("taken");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport {
            fail_register_as_taken: true,
            ..FakeTransport::new()
        };
        let error = session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw")
            .unwrap_err();
        assert!(matches!(
            error,
            SessionError::Transport(TransportError::HandleTaken)
        ));
    }

    #[test]
    fn a_failed_registration_leaves_nothing_behind() {
        // The identity key is written only after the server accepts. Otherwise
        // a key would be left for an account that does not exist, and the next
        // attempt would have to decide whether to trust it.
        let dir = TempDir::new("no-residue");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport {
            fail_register_as_taken: true,
            ..FakeTransport::new()
        };
        let _ = session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw");
        assert!(session::restore(&keystore, &dir.db()).unwrap().is_none());
    }

    #[test]
    fn logging_out_destroys_the_local_store_and_the_key() {
        let dir = TempDir::new("logout");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();

        let s =
            session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();
        assert!(dir.db().exists());

        session::logout(&transport, &keystore, &dir.db(), &s.refresh_token).unwrap();

        assert!(!dir.db().exists(), "the store file must be gone");
        assert!(
            keystore.load(STORE_KEY_NAME).unwrap().is_none(),
            "the wrapped key must be gone too"
        );
        assert_eq!(transport.logged_out.borrow().len(), 1);
    }

    #[test]
    fn changing_a_password_sends_neither_password() {
        let transport = FakeTransport::new();
        session::change_password(&transport, "alice", "old one", "new one").unwrap();

        let changes = transport.password_changes.borrow();
        let (old_verifier, new_salt, new_verifier) = &changes[0];
        for field in [old_verifier, new_salt, new_verifier] {
            assert!(!field.contains("old one"));
            assert!(!field.contains("new one"));
        }
        assert_eq!(old_verifier.len(), 64, "verifier should be 32 bytes as hex");
        assert_eq!(new_verifier.len(), 64);
    }

    #[test]
    fn a_new_password_gets_a_new_salt() {
        // Reusing the old salt would keep any precomputed table for this
        // account working across the change.
        let transport = FakeTransport::new();
        session::change_password(&transport, "alice", "old", "new").unwrap();

        let changes = transport.password_changes.borrow();
        let (_, new_salt, _) = &changes[0];
        assert_eq!(new_salt.len(), 32, "16 bytes as hex");
        assert_ne!(
            new_salt,
            &transport.salt("alice").unwrap().salt,
            "the new salt must be freshly generated"
        );
    }

    #[test]
    fn the_two_verifiers_differ_because_both_inputs_did() {
        let transport = FakeTransport::new();
        session::change_password(&transport, "alice", "old", "new").unwrap();
        let changes = transport.password_changes.borrow();
        let (old_verifier, _, new_verifier) = &changes[0];
        assert_ne!(old_verifier, new_verifier);
    }

    #[test]
    fn an_empty_new_password_is_refused_before_the_network() {
        let transport = FakeTransport::new();
        assert!(session::change_password(&transport, "alice", "old", "").is_err());
        assert!(
            transport.password_changes.borrow().is_empty(),
            "nothing should have been sent"
        );
    }

    #[test]
    fn a_session_does_not_print_its_tokens() {
        // Debug output ends up in logs. A bearer token in a log is the account.
        let dir = TempDir::new("debug");
        let keystore = FakeKeystore::default();
        let transport = FakeTransport::new();
        let s =
            session::register(&transport, &keystore, &dir.db(), "alice", "Alice", "pw").unwrap();

        let printed = format!("{s:?}");
        assert!(!printed.contains("access-1"));
        assert!(!printed.contains("refresh-1"));
        assert!(printed.contains("alice"));
    }
}
