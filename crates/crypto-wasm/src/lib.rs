//! MLS in a browser.
//!
//! This crate exists to answer one question, and [`REWORK.md`](../../docs/REWORK.md)
//! wave 3 is where it was asked: **can OpenMLS run in a WebView?** If it
//! cannot, then "one TypeScript app that keeps end-to-end encryption" is not
//! an available shape for this product, and the plan has to change before
//! anything is built on top of it.
//!
//! It is a *facade*, not a second implementation. Every primitive still comes
//! from [`nexo_crypto`], which still comes from OpenMLS — rule 1 is untouched,
//! and nothing here computes anything. What this file adds is the seam:
//! `wasm_bindgen` types a JavaScript caller can hold, and the borrow shapes
//! that make `&Device` usable from a language that has no borrows.
//!
//! # What was actually in doubt
//!
//! Three things, and two of them turned out to be solved upstream:
//!
//! - **`std::time::SystemTime` traps on `wasm32-unknown-unknown`**, and
//!   OpenMLS reads the clock to stamp a KeyPackage's lifetime. Solved
//!   upstream: `openmls/src/key_packages/lifetime.rs` swaps in
//!   `fluvio_wasm_timer::SystemTime` under `cfg(target_arch = "wasm32")`, and
//!   OpenMLS's own `js` feature pulls that crate in.
//! - **Randomness.** `getrandom` needs a browser backend, and the tree has two
//!   majors of it for genuine reasons. Both are turned on in `Cargo.toml`, and
//!   0.3 needs a cfg besides — see `.cargo/config.toml`.
//! - **`rayon`.** OpenMLS uses parallel iterators in `treesync`, and a
//!   single-threaded wasm target has no threads to give it. This is the one
//!   that could not be answered by reading, which is what made a spike
//!   necessary rather than a survey.
//!
//! # What this is not
//!
//! Not the client. There is no transport, no store and no session here, and
//! there should not be: those are wave 6's job, in TypeScript. This crate is
//! the part that must stay Rust because rule 1 says so.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use nexo_crypto::identity::{IdentityKeypair, SafetyNumber};
use nexo_crypto::mls::{self, Conversation, Incoming, Peeked};
use openmls::prelude::CredentialWithKey;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use uuid::Uuid;
use wasm_bindgen::prelude::*;

/// Turns a wasm panic into a message rather than `unreachable executed`.
///
/// Called once, by the page, before anything else. Safe to call twice.
#[wasm_bindgen(js_name = "initPanicHook")]
pub fn init_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    console_error_panic_hook::set_once();
}

/// The version of this facade, so a page can tell which one it loaded.
#[wasm_bindgen(js_name = "version")]
#[must_use]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn js_err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn parse_uuid(value: &str) -> Result<Uuid, JsError> {
    value
        .parse::<Uuid>()
        .map_err(|_| JsError::new("not a uuid"))
}

/// What an envelope turns out to hold, without processing it.
///
/// `"welcome"`, `"group_message"` or `"other"`.
///
/// Sync needs this and cannot do without it: a device that has just been added
/// receives its Welcome as an **ordinary envelope** on the conversation's own
/// stream — there is no separate endpoint for it and there does not need to be,
/// because the invitee is already a member server-side. This is how a caller
/// tells "join this" from "decrypt this" before committing to either, and
/// guessing wrong means handing a Welcome to a group that does not exist yet.
#[wasm_bindgen(js_name = "peek")]
pub fn peek(ciphertext: &[u8]) -> Result<String, JsError> {
    Ok(match mls::peek(ciphertext).map_err(js_err)? {
        Peeked::Welcome => "welcome",
        Peeked::GroupMessage => "group_message",
        _ => "other",
    }
    .to_string())
}

/// One device's keys and MLS storage.
///
/// Everything MLS needs that is *not* a group: the identity keypair, the
/// credential naming this device, the signer, and the provider that holds
/// ratchet state. A page makes one of these per signed-in account and keeps it
/// for the session.
///
/// The identity secret never crosses back into JavaScript. It is generated
/// here or imported here, and what a caller can read is the public key and a
/// safety number.
#[wasm_bindgen]
pub struct Device {
    provider: OpenMlsRustCrypto,
    identity: IdentityKeypair,
    credential: CredentialWithKey,
    signer: SignatureKeyPair,
}

#[wasm_bindgen]
impl Device {
    /// A device with a fresh identity keypair.
    ///
    /// `device_id` is a UUID, and it is what the MLS credential names — the
    /// group member is the device, not the account, which is what makes a
    /// second device later an added member rather than a schema change.
    #[wasm_bindgen(constructor)]
    pub fn new(device_id: &str) -> Result<Device, JsError> {
        let device_id = parse_uuid(device_id)?;
        let identity = IdentityKeypair::generate();
        let (credential, signer) = mls::credential_for(device_id, &identity);
        Ok(Device {
            provider: OpenMlsRustCrypto::default(),
            identity,
            credential,
            signer,
        })
    }

    /// A device rebuilt from an identity secret this page stored earlier.
    ///
    /// The MLS state is *not* part of this: import it separately with
    /// [`Device::import_state`], because the two have different lifetimes —
    /// the identity outlives every group, and the group state changes on every
    /// message.
    #[wasm_bindgen(js_name = "fromSecret")]
    pub fn from_secret(device_id: &str, secret: &[u8]) -> Result<Device, JsError> {
        let device_id = parse_uuid(device_id)?;
        let identity = IdentityKeypair::from_secret_bytes(secret).map_err(js_err)?;
        let (credential, signer) = mls::credential_for(device_id, &identity);
        Ok(Device {
            provider: OpenMlsRustCrypto::default(),
            identity,
            credential,
            signer,
        })
    }

    /// This device's public identity key.
    #[wasm_bindgen(js_name = "publicKey")]
    #[must_use]
    pub fn public_key(&self) -> Vec<u8> {
        self.identity.public_bytes().to_vec()
    }

    /// The identity secret, for the page to put somewhere it trusts.
    ///
    /// The one call here that hands key material to JavaScript, and it exists
    /// because a browser has no process below the page to keep it in. That is
    /// the trade [`REWORK.md`](../../docs/REWORK.md) records against invariant
    /// 2, written down rather than discovered.
    #[wasm_bindgen(js_name = "exportSecret")]
    #[must_use]
    pub fn export_secret(&self) -> Vec<u8> {
        self.identity.secret_bytes().to_vec()
    }

    /// The safety number to compare with somebody else, aloud.
    #[wasm_bindgen(js_name = "safetyNumber")]
    pub fn safety_number(&self, other_public_key: &[u8]) -> Result<String, JsError> {
        let number =
            SafetyNumber::new(&self.identity.public_bytes(), other_public_key).map_err(js_err)?;
        Ok(number.to_display_string())
    }

    /// One KeyPackage, so somebody else can add this device to a group.
    ///
    /// Single-use: an invitation consumes it. A real client publishes a batch
    /// (`nexo_crypto::KEY_PACKAGE_TARGET`); this returns one at a time because
    /// the page decides how many it wants.
    #[wasm_bindgen(js_name = "keyPackage")]
    pub fn key_package(&self) -> Result<Vec<u8>, JsError> {
        let mut packages =
            mls::generate_key_packages(&self.provider, &self.signer, self.credential.clone(), 1)
                .map_err(js_err)?;
        packages.pop().ok_or_else(|| JsError::new("no key package"))
    }

    /// The whole MLS provider, as one blob.
    ///
    /// Deliberately one blob rather than a `StorageProvider`, for the reasons
    /// `crates/client/src/mls_state.rs` sets out at length: the state is small,
    /// there is one writer, and a blob either round-trips or it does not.
    ///
    /// **The encoding is the same one** that file uses, byte for byte, so a
    /// desktop store and a browser store hold the same thing. That it is
    /// written twice is a wave-3 expedient and nothing more — wave 6 moves the
    /// codec into `nexo-crypto` where both callers can reach it.
    #[wasm_bindgen(js_name = "exportState")]
    pub fn export_state(&self) -> Result<Vec<u8>, JsError> {
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| JsError::new("the MLS state lock was poisoned"))?;

        let mut blob = Vec::with_capacity(1 + 8 + values.len() * 32);
        blob.push(FORMAT_V1);
        blob.extend_from_slice(&(values.len() as u64).to_be_bytes());
        for (key, value) in values.iter() {
            blob.extend_from_slice(&(key.len() as u64).to_be_bytes());
            blob.extend_from_slice(&(value.len() as u64).to_be_bytes());
            blob.extend_from_slice(key);
            blob.extend_from_slice(value);
        }
        Ok(blob)
    }

    /// Puts a blob from [`Device::export_state`] back.
    ///
    /// Additive: existing entries with the same key are replaced and the rest
    /// are left alone, which is what makes restoring into a fresh device work
    /// and restoring twice harmless.
    #[wasm_bindgen(js_name = "importState")]
    pub fn import_state(&mut self, blob: &[u8]) -> Result<(), JsError> {
        let entries = decode_state(blob)?;
        self.provider
            .storage()
            .values
            .write()
            .map_err(|_| JsError::new("the MLS state lock was poisoned"))?
            .extend(entries);
        Ok(())
    }
}

/// Version tag on the state blob, matching `crates/client/src/mls_state.rs`.
const FORMAT_V1: u8 = 1;

/// One key/value pair as OpenMLS stores it, named the same way
/// `crates/client/src/mls_state.rs` names it.
type Entry = (Vec<u8>, Vec<u8>);

/// Parses the blob [`Device::export_state`] writes.
///
/// Every length is checked against what is actually left, so a truncated or
/// corrupt blob is an error rather than a panic or a silently short read.
fn decode_state(blob: &[u8]) -> Result<Vec<Entry>, JsError> {
    let unreadable = || JsError::new("the stored MLS state is not readable by this version");
    let mut cursor = 0usize;

    let mut take = |n: usize| -> Result<&[u8], JsError> {
        let end = cursor.checked_add(n).ok_or_else(unreadable)?;
        let slice = blob.get(cursor..end).ok_or_else(unreadable)?;
        cursor = end;
        Ok(slice)
    };

    if take(1)?[0] != FORMAT_V1 {
        return Err(unreadable());
    }
    let count = u64::from_be_bytes(take(8)?.try_into().map_err(|_| unreadable())?);

    let mut entries = Vec::new();
    for _ in 0..count {
        let key_len = u64::from_be_bytes(take(8)?.try_into().map_err(|_| unreadable())?);
        let value_len = u64::from_be_bytes(take(8)?.try_into().map_err(|_| unreadable())?);
        let key = take(usize::try_from(key_len).map_err(|_| unreadable())?)?.to_vec();
        let value = take(usize::try_from(value_len).map_err(|_| unreadable())?)?.to_vec();
        entries.push((key, value));
    }
    Ok(entries)
}

/// A commit that has been staged but not yet accepted by the server.
///
/// Staged, because **a commit can lose**: the delivery service orders commits
/// and the first writer wins. A client that applied its own optimistically
/// would believe it had moved to an epoch nobody else is in. So a caller sends
/// `message`, and then calls [`Group::confirm_commit`] or
/// [`Group::abandon_commit`] depending on what the server said.
#[wasm_bindgen]
pub struct StagedCommit {
    message: Vec<u8>,
    welcome: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl StagedCommit {
    /// The commit to hand to the delivery service.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn message(&self) -> Vec<u8> {
        self.message.clone()
    }

    /// The Welcome for a newly added member, when this commit added one.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn welcome(&self) -> Option<Vec<u8>> {
        self.welcome.clone()
    }
}

/// What [`Group::decrypt`] found.
///
/// Flattened into one type with a `kind` string rather than modelled as a
/// union, because the page has to branch on the kind anyway and a shape
/// JavaScript can read without a wrapper is one fewer thing to get wrong.
#[wasm_bindgen]
pub struct Decrypted {
    kind: String,
    sender: Option<String>,
    plaintext: Option<Vec<u8>>,
    epoch: u64,
}

#[wasm_bindgen]
impl Decrypted {
    /// `"message"`, `"commit"` or `"proposal"`.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn kind(&self) -> String {
        self.kind.clone()
    }

    /// The device that sent it, when MLS could name one.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn sender(&self) -> Option<String> {
        self.sender.clone()
    }

    /// The plaintext, for a message.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn plaintext(&self) -> Option<Vec<u8>> {
        self.plaintext.clone()
    }

    /// The epoch now in force.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

/// One conversation's MLS group.
///
/// Every method takes the [`Device`] it belongs to rather than holding a
/// reference to it. That is not elegance — `wasm_bindgen` cannot express a
/// lifetime across the boundary, so the alternative is an owning copy of the
/// provider per group, and then two groups on one device would have two
/// disagreeing copies of the same ratchet state.
#[wasm_bindgen]
pub struct Group {
    conversation: Conversation,
}

#[wasm_bindgen]
impl Group {
    /// A new conversation with this device as its only member.
    ///
    /// The MLS group id *is* the conversation id, so the two can never
    /// disagree and there is no mapping table between them.
    pub fn create(device: &Device, conversation_id: &str, now_ms: f64) -> Result<Group, JsError> {
        let id = parse_uuid(conversation_id)?;
        let conversation = Conversation::create(
            &device.provider,
            &device.signer,
            device.credential.clone(),
            id,
            now_ms as i64,
        )
        .map_err(js_err)?;
        Ok(Group { conversation })
    }

    /// Joins from a Welcome that arrived over the wire.
    pub fn join(device: &Device, welcome: &[u8], now_ms: f64) -> Result<Group, JsError> {
        let conversation =
            Conversation::join(&device.provider, welcome, now_ms as i64).map_err(js_err)?;
        Ok(Group { conversation })
    }

    /// Reopens a conversation from imported state. `undefined` when this
    /// device is not in it — an ordinary answer, not a failure.
    pub fn load(
        device: &Device,
        conversation_id: &str,
        now_ms: f64,
    ) -> Result<Option<Group>, JsError> {
        let id = parse_uuid(conversation_id)?;
        let found = Conversation::load(&device.provider, id, now_ms as i64).map_err(js_err)?;
        Ok(found.map(|conversation| Group { conversation }))
    }

    /// The epoch this group is in.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.conversation.epoch()
    }

    /// How many devices are in it.
    #[wasm_bindgen(getter, js_name = "memberCount")]
    #[must_use]
    pub fn member_count(&self) -> usize {
        self.conversation.member_count()
    }

    /// Adds a device, from a KeyPackage it published.
    ///
    /// Returns a staged commit. Nothing has moved yet — see [`StagedCommit`].
    #[wasm_bindgen(js_name = "addMember")]
    pub fn add_member(
        &mut self,
        device: &Device,
        key_package: &[u8],
    ) -> Result<StagedCommit, JsError> {
        let commit = self
            .conversation
            .add_member(&device.provider, &device.signer, key_package)
            .map_err(js_err)?;
        Ok(StagedCommit {
            message: commit.message,
            welcome: commit.welcome,
        })
    }

    /// Applies the staged commit, because the server accepted it.
    ///
    /// Returns the epoch now in force, which is what the caller has to record
    /// beside the conversation.
    #[wasm_bindgen(js_name = "confirmCommit")]
    pub fn confirm_commit(&mut self, device: &Device, now_ms: f64) -> Result<u64, JsError> {
        self.conversation
            .confirm_commit(&device.provider, now_ms as i64)
            .map_err(js_err)
    }

    /// Throws the staged commit away, because the server did not.
    #[wasm_bindgen(js_name = "abandonCommit")]
    pub fn abandon_commit(&mut self, device: &Device) -> Result<(), JsError> {
        self.conversation
            .abandon_commit(&device.provider)
            .map_err(js_err)
    }

    /// Encrypts one message for the group.
    pub fn encrypt(&mut self, device: &Device, plaintext: &[u8]) -> Result<Vec<u8>, JsError> {
        self.conversation
            .encrypt(&device.provider, &device.signer, plaintext)
            .map_err(js_err)
    }

    /// Decrypts whatever arrived, applying it if it is a commit.
    ///
    /// Rule 7 reaches JavaScript here: a message that will not decrypt throws,
    /// and there is no plaintext fallback and no silent skip.
    pub fn decrypt(&mut self, device: &Device, ciphertext: &[u8]) -> Result<Decrypted, JsError> {
        let epoch_before = self.conversation.epoch();
        match self
            .conversation
            .decrypt(&device.provider, ciphertext)
            .map_err(js_err)?
        {
            Incoming::Message { sender, plaintext } => Ok(Decrypted {
                kind: "message".into(),
                sender: sender.map(|s| s.to_string()),
                plaintext: Some(plaintext),
                epoch: epoch_before,
            }),
            Incoming::CommitApplied { epoch } => Ok(Decrypted {
                kind: "commit".into(),
                sender: None,
                plaintext: None,
                epoch,
            }),
            Incoming::ProposalQueued => Ok(Decrypted {
                kind: "proposal".into(),
                sender: None,
                plaintext: None,
                epoch: epoch_before,
            }),
            // `Incoming` is `#[non_exhaustive]`, so a variant added upstream
            // reaches here. Rule 7: say so rather than guess at it.
            other => Err(JsError::new(&format!(
                "this build does not understand {other:?}"
            ))),
        }
    }
}
