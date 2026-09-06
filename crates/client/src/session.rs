//! Registration, login, and restoring a session after a restart.
//!
//! This is the module M2's definition of done is about: *register, restart the
//! app, still be signed in*. [`Session::restore`] is the "still signed in"
//! half, and it works because the identity key and the account row live in the
//! encrypted store while the store's key lives in the OS keystore.
//!
//! # The password never leaves the machine
//!
//! [`derive_verifier`] is the whole reason the flow has three steps instead of
//! one. The client asks for a salt, derives `Argon2id(password, salt)` locally,
//! and sends only that. The server hashes it again before storing. A server
//! that is compromised later never had the password; a server compromised
//! *during* a login sees the verifier, which is worse than a PAKE and better
//! than a password, and `docs/THREAT-MODEL.md` 5 says so plainly.

use argon2::{Algorithm, Argon2, Params, Version};
use nexo_crypto::identity::IdentityKeypair;
use nexo_platform::SecureStore;
use nexo_store::{Account, EncryptedStore, key};
use rand::RngCore;
use rand::rngs::OsRng;
use zeroize::Zeroizing;

use crate::transport::{Transport, TransportError};

/// Everything that can go wrong signing in.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// The network layer failed.
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// The local store failed.
    #[error(transparent)]
    Store(#[from] nexo_store::StoreError),
    /// The keystore failed.
    #[error("the OS keystore failed: {0}")]
    Keystore(String),
    /// Deriving the verifier failed.
    #[error("could not derive the password verifier: {0}")]
    Derivation(String),
    /// The server sent something unusable.
    #[error("the server sent an unusable response: {0}")]
    BadResponse(String),
    /// Identity key material was rejected.
    #[error(transparent)]
    Identity(#[from] nexo_crypto::identity::IdentityError),
    /// The store on this machine belongs to somebody else.
    ///
    /// Carries the handle it belongs to, because the only way out is to sign
    /// in as that account and sign out of it, and a message that cannot name
    /// it is a message nobody can act on.
    #[error("this device is signed in as @{0}")]
    DifferentAccount(String),
}

/// A signed-in session.
///
/// The **access** token is memory-only: it lasts fifteen minutes and a fresh
/// one is a single call away, so writing it down would be pure liability.
///
/// The **refresh** token is persisted, in the encrypted store. An earlier
/// version of this module refused to, reasoning that it widened the window a
/// stolen laptop opens — which does not survive contact with what is already in
/// that file. The identity private key lives there, and anyone who can read the
/// token can read that instead, which is far worse. Withholding it bought
/// nothing and cost the user their session on every restart, leaving them
/// "signed in" locally but unable to reach the server at all.
pub struct Session {
    /// Who is signed in.
    pub account: Account,
    /// Bearer token for API calls.
    pub access_token: String,
    /// Used once, to get the next pair.
    pub refresh_token: String,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Tokens are bearer credentials. Printing one into a log hands over the
        // account for as long as it is valid.
        f.debug_struct("Session")
            .field("account", &self.account)
            .finish_non_exhaustive()
    }
}

/// Derives the password verifier the server expects.
///
/// The parameters come from the server (see
/// [`crate::transport::Argon2Params`]), so raising the cost later does not need
/// a client release.
pub fn derive_verifier(
    password: &str,
    salt: &[u8],
    params: crate::transport::Argon2Params,
) -> Result<Zeroizing<Vec<u8>>, SessionError> {
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(
            params.memory_kib,
            params.iterations,
            params.parallelism,
            Some(32),
        )
        .map_err(|e| SessionError::Derivation(e.to_string()))?,
    );

    let mut out = Zeroizing::new(vec![0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| SessionError::Derivation(e.to_string()))?;
    Ok(out)
}

/// The salt length the server requires.
const SALT_LEN: usize = 16;

/// A fresh salt for a new account, from the OS CSPRNG.
fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Creates an account and persists everything needed to come back to it.
///
/// Order matters. The identity key is generated first and written to the store
/// *after* the server accepts the registration: writing it first would leave a
/// key behind for an account that does not exist, and the next attempt would
/// have to decide whether to reuse it.
pub fn register<T: Transport, S: SecureStore>(
    transport: &T,
    keystore: &S,
    store_path: &std::path::Path,
    handle: &str,
    display_name: &str,
    password: &str,
) -> Result<Session, SessionError>
where
    S::Error: 'static,
{
    // The parameters come from the server; the salt does not.
    //
    // Before the account exists, `/v1/auth/salt` returns a *decoy* — that is
    // the whole point of it, so an unknown handle is indistinguishable from a
    // known one. Deriving the verifier against that decoy and letting the
    // server mint its own salt would give the two sides different verifiers,
    // and the account could never be logged into. So registration chooses the
    // salt and sends it. A salt needs uniqueness, not secrecy.
    let params = transport.salt(handle)?.argon2;
    let salt = generate_salt();
    let verifier = derive_verifier(password, &salt, params)?;

    let identity = IdentityKeypair::generate();
    let public = identity.public_bytes();

    let tokens = transport.register(
        handle,
        display_name,
        &hex(&salt),
        &hex(&verifier),
        &hex(&public),
    )?;

    let store = open_store(keystore, store_path)?;
    guard_store_belongs_to(&store, handle)?;
    store.set_identity(&*identity.secret_bytes(), &public)?;
    store.set_account(tokens.user_id, handle, display_name, &tokens.device_id)?;
    store.set_refresh_token(&tokens.refresh_token)?;

    Ok(Session {
        account: Account {
            user_id: tokens.user_id,
            handle: handle.to_string(),
            display_name: display_name.to_string(),
            device_id: tokens.device_id,
        },
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// Signs in to an existing account on this machine or a new one.
///
/// Reuses the stored identity key when there is one. Generating a fresh key on
/// every login would change the account's cryptographic identity each time,
/// and every contact who had verified a safety number would see a mismatch —
/// indistinguishable, from their side, from the attack safety numbers exist to
/// catch.
pub fn login<T: Transport, S: SecureStore>(
    transport: &T,
    keystore: &S,
    store_path: &std::path::Path,
    handle: &str,
    password: &str,
) -> Result<Session, SessionError>
where
    S::Error: 'static,
{
    let salt_response = transport.salt(handle)?;
    let salt = unhex(&salt_response.salt)?;
    let verifier = derive_verifier(password, &salt, salt_response.argon2)?;

    let store = open_store(keystore, store_path)?;
    guard_store_belongs_to(&store, handle)?;
    let identity = match store.identity()? {
        Some((secret, _public)) => IdentityKeypair::from_secret_bytes(&secret)?,
        None => IdentityKeypair::generate(),
    };
    let public = identity.public_bytes();

    let tokens = transport.login(handle, &hex(&verifier), &hex(&public))?;

    // Keep the display name already on record. The login response does not
    // carry one, and defaulting to the handle would quietly rename the account
    // every time someone signed in. M4's profile fetch is what refreshes it.
    let display_name = store
        .account()?
        .map(|a| a.display_name)
        .unwrap_or_else(|| handle.to_string());

    store.set_identity(&*identity.secret_bytes(), &public)?;
    store.set_account(tokens.user_id, handle, &display_name, &tokens.device_id)?;
    store.set_refresh_token(&tokens.refresh_token)?;

    let account = store
        .account()?
        .ok_or_else(|| SessionError::BadResponse("the account row vanished".into()))?;

    Ok(Session {
        account,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    })
}

/// The account this installation is signed in as, if any.
///
/// This is the "still signed in after a restart" check, and it deliberately
/// does **not** touch the network: a client that cannot reach the server should
/// still open to its own history rather than to a login screen.
///
/// It returns the account rather than a [`Session`] because the tokens are gone
/// — they were never written down. Getting a usable access token again is a
/// refresh call, which belongs to M4 along with the rest of the transport.
pub fn restore<S: SecureStore>(
    keystore: &S,
    store_path: &std::path::Path,
) -> Result<Option<Account>, SessionError>
where
    S::Error: 'static,
{
    if !store_path.exists() {
        return Ok(None);
    }
    let store = open_store(keystore, store_path)?;
    Ok(store.account()?)
}

/// Brings a stored session back after a restart, without a password.
///
/// [`restore`] answers "who is signed in" from the disk alone and never touches
/// the network. This goes one step further and trades the stored refresh token
/// for a usable access token, which is what makes the account *reachable*
/// rather than merely remembered.
///
/// Returns `Ok(None)` when there is nothing to resume. A refresh token the
/// server rejects is **cleared**, because a dead token kept on disk is a dead
/// token retried on every launch — and the honest outcome is a sign-in prompt.
///
/// Rotation means the token that comes back replaces the one that went in; the
/// old one is already dead by the time this returns.
pub fn resume<T: Transport, S: SecureStore>(
    transport: &T,
    keystore: &S,
    store_path: &std::path::Path,
) -> Result<Option<Session>, SessionError>
where
    S::Error: 'static,
{
    if !store_path.exists() {
        return Ok(None);
    }
    let store = open_store(keystore, store_path)?;
    let Some(account) = store.account()? else {
        return Ok(None);
    };
    let Some(stored) = store.refresh_token()? else {
        return Ok(None);
    };

    let tokens = match transport.refresh(&stored) {
        Ok(tokens) => tokens,
        Err(TransportError::InvalidCredentials) => {
            store.clear_refresh_token()?;
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };

    store.set_refresh_token(&tokens.refresh_token)?;
    transport.set_access_token(&tokens.access_token);
    // So the transport can replace the access token by itself when it ages,
    // rather than every request failing until the next restart.
    transport.set_refresh_token(&tokens.refresh_token);

    Ok(Some(Session {
        account,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
    }))
}

/// This device's identity fingerprint, for the Security screen (brief 4.1).
///
/// Derived from the public half of the identity keypair in the encrypted
/// store, so it is the real key or it is nothing. `None` before registration
/// has written one: a screen that tells people to compare digits in person is
/// the last place that may show invented ones.
///
/// This is *not* a safety number. See [`SafetyNumber::for_identity`] for why
/// the two are domain-separated.
///
/// [`SafetyNumber::for_identity`]: nexo_crypto::identity::SafetyNumber::for_identity
pub fn device_fingerprint(store: &EncryptedStore) -> Result<Option<String>, SessionError> {
    let Some((_secret, public)) = store.identity()? else {
        return Ok(None);
    };
    let number = nexo_crypto::identity::SafetyNumber::for_identity(&public)?;
    Ok(Some(number.to_display_string()))
}

/// Changes the account password (§6.4).
///
/// Two derivations, and the shape of them is the whole point:
///
/// - the **old** verifier against the salt the server already has, which is
///   what proves knowledge of the current password rather than mere possession
///   of an unlocked machine;
/// - the **new** verifier against a freshly generated salt, so no precomputed
///   table for this account survives the change.
///
/// Neither password is sent, stored, or logged. Nothing local changes: the
/// SQLCipher key is derived from the OS keystore, not from the password, so a
/// password change does not re-encrypt the store and cannot lose history —
/// worth stating, because in most apps it would.
pub fn change_password<T: Transport>(
    transport: &T,
    handle: &str,
    current_password: &str,
    new_password: &str,
) -> Result<(), SessionError> {
    if new_password.is_empty() {
        return Err(SessionError::Derivation(
            "the new password is empty".to_string(),
        ));
    }

    let salt_response = transport.salt(handle)?;
    let current_salt = unhex(&salt_response.salt)?;
    let old_verifier = derive_verifier(current_password, &current_salt, salt_response.argon2)?;

    let new_salt = generate_salt();
    let new_verifier = derive_verifier(new_password, &new_salt, salt_response.argon2)?;

    transport.change_password(&hex(&old_verifier), &hex(&new_salt), &hex(&new_verifier))?;
    Ok(())
}

/// Signs out: revoke server-side, then destroy everything local.
///
/// The local half runs even when the server call fails. A user who asks to be
/// signed out on a machine they are handing over cares about the disk, not
/// about whether a token somewhere expires in fifteen minutes.
pub fn logout<T: Transport, S: SecureStore>(
    transport: &T,
    keystore: &S,
    store_path: &std::path::Path,
    refresh_token: &str,
) -> Result<(), SessionError>
where
    S::Error: 'static,
{
    let server = transport.logout(refresh_token);

    // The keys go before the file, and no step is allowed to skip another.
    //
    // Both rules are here because of the same failure. This used to read
    // `delete(...)?; erase(...)?; pin::clear(...)?`, and on Windows the unlink
    // fails whenever anything still holds the database open -- so the `?` on
    // the first line returned early and the store key and the PIN were never
    // erased. Sign-out reported an error nobody surfaced, and left the
    // database *and* the key that opens it sitting on disk.
    //
    // Erasing first inverts the worst case. If the unlink still fails -- a
    // handle this crate does not own, a virus scanner holding the file -- what
    // is left behind is ciphertext with no key anywhere on the machine, rather
    // than a readable history. And every step now runs regardless of what the
    // ones before it did; the first failure is remembered and reported at the
    // end.
    let mut failure: Option<SessionError> = None;
    let mut remember = |result: Result<(), SessionError>| {
        if let Err(e) = result
            && failure.is_none()
        {
            failure = Some(e);
        }
    };

    // The unlock PIN goes with it.
    //
    // It was left behind before, and the effect was that signing out did not
    // finish: the next person to sign in on this machine met a lock screen
    // asking for a PIN that was not theirs and that they could not clear, and
    // the previous account's failed-attempt counter was still counting. The
    // PIN only ever unlocked the store that was just deleted, so keeping it is
    // not caution -- it is a dead credential with a live prompt in front of it.
    remember(crate::pin::clear(keystore).map_err(|e| SessionError::Keystore(e.to_string())));
    remember(
        keystore
            .erase(nexo_platform::STORE_KEY_NAME)
            .map_err(|e| SessionError::Keystore(e.to_string())),
    );
    remember(nexo_store::delete(store_path).map_err(SessionError::from));

    if let Some(e) = failure {
        return Err(e);
    }

    // Only now surface a server-side failure, and only as an error the caller
    // can report rather than one that skipped the wipe.
    server?;
    Ok(())
}

/// Deletes the account: the server's copy, then everything on this machine.
///
/// The order is the opposite of [`logout`]'s and the reason is the opposite
/// too. Signing out wipes the disk whatever the server says, because somebody
/// handing a laptop over cares about the disk. Deleting must hear from the
/// server *first*: wiping locally and then failing would leave an account that
/// still exists, that nothing on this machine can reach any more, and that has
/// no recovery — the worst of both outcomes.
///
/// The password is proved to the server rather than merely typed at us. A
/// bearer token is possession of a session; this is the one call where that
/// distinction is the difference between an inconvenience and an account
/// nobody can get back.
///
/// What this cannot reach, and what the UI has to say: messages already
/// delivered to other people. They are on those machines, and the server never
/// had the keys to them.
pub fn delete_account<T: Transport, S: SecureStore>(
    transport: &T,
    keystore: &S,
    store_path: &std::path::Path,
    handle: &str,
    password: &str,
) -> Result<(), SessionError>
where
    S::Error: 'static,
{
    delete_account_on_server(transport, handle, password)?;
    wipe_local(keystore, store_path)
}

/// Proves the password to the server and deletes the account there.
///
/// Split out from [`delete_account`] so a shell that holds the store open can
/// close it between the two halves. On Windows an open database cannot be
/// unlinked, and the order this function exists to preserve -- server first,
/// disk second -- leaves no other moment to do it in.
pub fn delete_account_on_server<T: Transport>(
    transport: &T,
    handle: &str,
    password: &str,
) -> Result<(), SessionError> {
    let salt_response = transport.salt(handle)?;
    let salt = unhex(&salt_response.salt)?;
    let verifier = derive_verifier(password, &salt, salt_response.argon2)?;

    // Before anything local. If this refuses, nothing has been lost.
    transport.delete_account(&hex(&verifier))?;
    Ok(())
}

/// Destroys everything this machine holds for an account: the PIN, the store
/// key, then the database itself.
///
/// The order and the error handling are the ones [`logout`] explains: keys
/// first, so a unlink that cannot happen leaves ciphertext with no key rather
/// than a readable history, and one failure never skips the steps after it.
///
/// The caller must have dropped every handle to the store before calling this.
pub fn wipe_local<S: SecureStore>(
    keystore: &S,
    store_path: &std::path::Path,
) -> Result<(), SessionError>
where
    S::Error: 'static,
{
    let mut failure: Option<SessionError> = None;
    let mut remember = |result: Result<(), SessionError>| {
        if let Err(e) = result
            && failure.is_none()
        {
            failure = Some(e);
        }
    };
    remember(crate::pin::clear(keystore).map_err(|e| SessionError::Keystore(e.to_string())));
    remember(
        keystore
            .erase(nexo_platform::STORE_KEY_NAME)
            .map_err(|e| SessionError::Keystore(e.to_string())),
    );
    remember(nexo_store::delete(store_path).map_err(SessionError::from));

    match failure {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Refuses a store that belongs to a different account.
///
/// A store is one account's. Nothing about it is keyed by user, so signing a
/// second account into an existing one hands that account the first one's
/// conversations, its message bodies, its peers and its verification state --
/// and `login` would go further and reuse the stored identity keypair, giving
/// two accounts one cryptographic identity and carrying safety numbers across
/// the boundary they exist to mark.
///
/// This is reachable without anybody doing anything strange: a refresh token
/// the server has retired drops the app to the sign-in screen with the store
/// still on disk, and the next handle typed there need not be the same one.
///
/// It refuses rather than wiping. The data belongs to the account named in the
/// error, not to the one signing in, and destroying somebody's only copy of
/// their history -- the server keeps none -- is not a decision this function
/// gets to make on its own. Signing out is what erases it, and it now does.
fn guard_store_belongs_to(store: &EncryptedStore, handle: &str) -> Result<(), SessionError> {
    match store.account()? {
        Some(existing) if !existing.handle.eq_ignore_ascii_case(handle) => {
            Err(SessionError::DifferentAccount(existing.handle))
        }
        _ => Ok(()),
    }
}

fn open_store<S: SecureStore>(
    keystore: &S,
    path: &std::path::Path,
) -> Result<EncryptedStore, SessionError>
where
    S::Error: 'static,
{
    let (store_key, _created) =
        key::load_or_create(keystore).map_err(|e| SessionError::Keystore(e.to_string()))?;
    Ok(EncryptedStore::open(path, &store_key)?)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(b & 0x0F), 16).unwrap());
    }
    out
}

fn unhex(s: &str) -> Result<Vec<u8>, SessionError> {
    if !s.len().is_multiple_of(2) {
        return Err(SessionError::BadResponse("salt is not hex".into()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| SessionError::BadResponse("salt is not hex".into()))
}
