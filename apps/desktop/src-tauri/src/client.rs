//! Everything the app holds once someone is signed in.
//!
//! One place assembles it, so the several pieces that must agree — the store
//! key, the identity key, the MLS provider built from that store, and the
//! credential derived from that identity — cannot be assembled two different
//! ways in two different commands.
//!
//! # Why a mutex and `spawn_blocking`
//!
//! Everything here is blocking: SQLCipher, DPAPI, Argon2id, and a blocking HTTP
//! client. Doing any of it on the async runtime would stall every other task in
//! the process. And `EncryptedStore` wraps a `rusqlite::Connection`, which is
//! `Send` but not `Sync` — so it lives behind a mutex, and each command takes
//! the lock *inside* the blocking closure rather than holding a guard across an
//! await.
//!
//! # What the lock does and does not cover
//!
//! One mutex covers the store, the MLS provider and the transport together,
//! so commands that touch any of them run one at a time. That is deliberate
//! and stays: the connection and the provider are not `Sync`, and giving them
//! real concurrency means a connection pool and reworked provider access.
//!
//! What is *not* deliberate is holding it across the network. A download is
//! neither a store read nor an MLS operation, and holding the lock for one
//! made every other call queue behind it — opening a photo measurably delayed
//! the draft save of the message being typed at the time, and a playing video
//! did it once per range request. So the transport is an `Arc`: the media
//! paths take the lock long enough to read the payload and clone the handle,
//! let go, and download with nothing held. The rule for anything added later
//! is the same — take the lock for the store and MLS work, release it before
//! the network.

use std::sync::{Arc, Mutex};

use nexo_client::conversations::Context;
use nexo_client::{HttpTransport, Session, session};
use nexo_crypto::identity::IdentityKeypair;
use nexo_crypto::mls::credential_for;
use nexo_platform::dpapi::DpapiStore;
use nexo_protocol::DeviceId;
use nexo_store::EncryptedStore;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;

/// A signed-in client, fully assembled.
pub struct LoggedIn {
    /// Tokens. Never crosses the IPC boundary.
    pub session: Session,
    /// The network.
    ///
    /// Shared rather than owned, so a slow call can go on using it after the
    /// client lock has been let go. The transport is internally synchronised
    /// and holds the access and refresh tokens, so it must be the *same* one
    /// — a copy would rotate its own tokens and the two would disagree about
    /// which refresh token is live, which is the one mistake the server reads
    /// as theft.
    pub transport: Arc<HttpTransport>,
    /// MLS storage and crypto, restored from the encrypted store.
    pub provider: OpenMlsRustCrypto,
    /// The encrypted local store.
    pub store: EncryptedStore,
    /// This device's MLS signer.
    pub signer: SignatureKeyPair,
    /// This device's MLS credential.
    pub credential: openmls::prelude::CredentialWithKey,
}

impl LoggedIn {
    /// A borrow of everything the conversation layer needs.
    pub fn context(&self) -> Context<'_, HttpTransport> {
        Context {
            transport: &*self.transport,
            provider: &self.provider,
            store: &self.store,
            signer: &self.signer,
            credential: self.credential.clone(),
        }
    }
}

/// The app's client state. `None` until someone signs in.
#[derive(Clone, Default)]
pub struct ClientState(pub Arc<Mutex<Option<LoggedIn>>>);

/// What can go wrong assembling a signed-in client.
#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("could not locate the application data folder")]
    NoAppData,
    #[error("the Windows credential store is unavailable: {0}")]
    Keystore(String),
    #[error(transparent)]
    Store(#[from] nexo_store::StoreError),
    #[error(transparent)]
    MlsState(#[from] nexo_client::mls_state::MlsStateError),
    #[error(transparent)]
    Identity(#[from] nexo_crypto::identity::IdentityError),
    #[error("this installation has no identity key; sign in again")]
    NoIdentity,
    #[error("the stored device id is not a uuid")]
    BadDeviceId,
    #[error("registering this device's MLS signer failed: {0}")]
    Signer(String),
}

/// Assembles a signed-in client from a session and whatever is on disk.
///
/// The transport is handed in already carrying its access token, because the
/// caller is the only one that knows whether it came from a login or a resume.
pub fn build(session: Session, transport: HttpTransport) -> Result<LoggedIn, BuildError> {
    let transport = Arc::new(transport);
    let path = nexo_store::default_path().ok_or(BuildError::NoAppData)?;
    let keystore = DpapiStore::new().map_err(|e| BuildError::Keystore(e.to_string()))?;

    let (store_key, _created) = nexo_store::key::load_or_create(&keystore)
        .map_err(|e| BuildError::Keystore(e.to_string()))?;
    let store = EncryptedStore::open(&path, &store_key)?;

    // The store's refresh token wins over the session's.
    //
    // They agree right after a login or a resume, because both write what they
    // were just issued. They stop agreeing once the transport rotates one
    // mid-call: `with_client` writes the new one to the store, and nothing
    // updates the `Session` the shell is holding. Reopening after a lock is
    // where that shows -- the transport that did the rotating went with the
    // dropped client, so the only live token is the one in the store, and
    // handing the new transport the older one replays a spent token. The
    // server reads that as theft and revokes every session for the account.
    if let Ok(Some(stored)) = store.refresh_token() {
        transport.set_refresh_token(stored.as_str());
    }

    // The provider is rebuilt from the store, so a restart continues the
    // conversations rather than starting new ones.
    let provider = nexo_client::mls_state::load(&store)?;

    let (secret, _public) = store.identity()?.ok_or(BuildError::NoIdentity)?;
    let identity = IdentityKeypair::from_secret_bytes(&secret)?;

    let device_id: DeviceId = session
        .account
        .device_id
        .parse()
        .map_err(|_| BuildError::BadDeviceId)?;
    let (credential, signer) = credential_for(device_id, &identity);

    // OpenMLS looks the signer up in the provider's storage, so it has to be
    // there before any group operation — including one restored from disk.
    signer
        .store(provider.storage())
        .map_err(|e| BuildError::Signer(format!("{e:?}")))?;

    Ok(LoggedIn {
        session,
        transport,
        provider,
        store,
        signer,
        credential,
    })
}

/// Resumes a session from disk, or returns `None` if there is nothing to
/// resume.
///
/// Used at startup. `session::resume` is what makes the account *reachable*
/// again — it trades the stored refresh token for a fresh access token — where
/// `session::restore` only answers who is signed in.
pub fn resume() -> Result<Resumed, BuildError> {
    let path = nexo_store::default_path().ok_or(BuildError::NoAppData)?;
    if !path.exists() {
        return Ok(Resumed::SignedOut);
    }
    let keystore = DpapiStore::new().map_err(|e| BuildError::Keystore(e.to_string()))?;
    let transport = HttpTransport::new();

    match session::resume(&transport, &keystore, &path) {
        Ok(Some(session)) => build(session, transport).map(|c| Resumed::Active(Box::new(c))),
        // The stored token was rejected and has been cleared. Whoever was
        // signed in here is not signed in any more.
        Ok(None) => Ok(Resumed::SignedOut),
        // A server we cannot reach is not a reason to throw the user out.
        Err(error) => {
            tracing::warn!(%error, "could not resume the session");
            Ok(Resumed::Offline)
        }
    }
}

/// What [`resume`] found, kept apart because the three cases need different
/// answers and collapsing them is a lie in one direction or the other.
///
/// The distinction that matters is `SignedOut` versus `Offline`. Both used to
/// come back as "nothing resumed", and the caller answered both by reading the
/// account off disk — so a *rejected* token produced a UI that said "signed in
/// as you" over a Rust side that had no client, and every command behind it
/// answered "You are not signed in". Being told you are signed in by one half
/// of the app and not by the other is worse than either answer alone.
pub enum Resumed {
    /// A live client: tokens refreshed, store open, ready for commands.
    Active(Box<LoggedIn>),
    /// Nothing stored, or the server rejected what was stored. Sign in again.
    SignedOut,
    /// The server could not be reached. The account on disk is still ours; the
    /// app may open to its own history and say it is offline.
    Offline,
}
