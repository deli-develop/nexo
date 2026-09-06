//! What sign-out and account deletion must actually leave behind: nothing.
//!
//! These cover the half of the wipe that does not need a server. The bug they
//! exist for was found by signing out of the running app and watching the
//! database survive: `nexo_store::delete` unlinks the file, Windows refuses
//! while anything still holds it open, and the `?` on that line skipped
//! erasing the store key and the PIN underneath it. The dialog promised the
//! local store was gone; all three were still there.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;

use nexo_client::{pin, session};
use nexo_platform::SecureStore;
use nexo_store::EncryptedStore;
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
        let dir = std::env::temp_dir().join(format!("nexo-wipe-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
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

/// Builds a store with something in it, plus a PIN, the way a signed-in
/// installation looks.
fn populate(keystore: &FakeKeystore, db: &std::path::Path) {
    let (key, _created) = nexo_store::key::load_or_create(keystore).unwrap();
    let store = EncryptedStore::open(db, &key).unwrap();
    store
        .set_account(7, "someone", "Someone", "device-1")
        .unwrap();
    pin::set(keystore, "246810").unwrap();
    // The caller of `wipe_local` is required to have dropped every handle;
    // this is that drop.
    drop(store);
}

#[test]
fn wiping_removes_the_database_the_key_and_the_pin() {
    let dir = TempDir::new("all");
    let keystore = FakeKeystore::default();
    populate(&keystore, &dir.db());

    assert!(dir.db().exists(), "the store should exist before the wipe");
    assert!(
        keystore
            .load(nexo_platform::STORE_KEY_NAME)
            .unwrap()
            .is_some(),
        "the store key should exist before the wipe"
    );
    assert!(pin::status(&keystore).unwrap().set, "a PIN was set");

    session::wipe_local(&keystore, &dir.db()).expect("the wipe should succeed");

    assert!(!dir.db().exists(), "the database must be gone");
    assert!(
        keystore
            .load(nexo_platform::STORE_KEY_NAME)
            .unwrap()
            .is_none(),
        "the store key must be gone: a database without it is still readable with it"
    );
    assert!(
        !pin::status(&keystore).unwrap().set,
        "the PIN must be gone -- it is a live prompt in front of a dead store"
    );
}

/// The regression proper: an unlink that cannot happen must not leave the key
/// behind, because the key is what makes the leftover file readable.
///
/// A directory standing where the database should be is the portable way to
/// make `remove_file` fail on every platform; on Windows the real cause was an
/// open handle, which no test can hold across the call.
#[test]
fn a_failed_unlink_still_erases_the_key_and_the_pin() {
    let dir = TempDir::new("stubborn");
    let keystore = FakeKeystore::default();
    let (_key, _created) = nexo_store::key::load_or_create(&keystore).unwrap();
    pin::set(&keystore, "246810").unwrap();

    std::fs::create_dir_all(dir.db()).unwrap();

    let result = session::wipe_local(&keystore, &dir.db());

    assert!(result.is_err(), "a wipe that could not finish must say so");
    assert!(
        keystore
            .load(nexo_platform::STORE_KEY_NAME)
            .unwrap()
            .is_none(),
        "the store key must be erased even when the file could not be removed"
    );
    assert!(
        !pin::status(&keystore).unwrap().set,
        "the PIN must be erased even when the file could not be removed"
    );
}
