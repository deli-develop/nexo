//! Windows DPAPI implementation of [`SecureStore`](crate::SecureStore).
//!
//! `CryptProtectData` wraps a secret with a key derived from the logged-in
//! user's credentials and held by the OS. The wrapped blob is useless to any
//! other Windows account, and useless on any other machine, without Nexo
//! having to invent a master password or ask the user for one.
//!
//! # Why this module contains `unsafe`
//!
//! This crate is `#![deny(unsafe_code)]` with exactly one `#[allow]`, here.
//! `apps/desktop/src-tauri` is the only other crate that is not `forbid`, for
//! the same reason and in the same shape -- WebView2 decides camera and
//! microphone access through a COM callback, and that is FFI too. DPAPI is a C API;
//! reaching it needs FFI, and FFI needs `unsafe`. The alternatives were worse:
//! a third-party DPAPI wrapper would contain the same `unsafe` somewhere we do
//! not read, and the maintained ones are thin enough that we would be
//! reviewing them anyway. Rule 8 also rules out unmaintained crates, and the
//! DPAPI wrappers on crates.io are.
//!
//! The unsafe surface is two calls, both of the same shape: hand Windows a
//! pointer to bytes we own, receive a pointer to bytes Windows allocated, copy
//! them out, free them. Nothing here is generic, nothing is reused, and no raw
//! pointer escapes a function body.
//!
//! # What is stored where
//!
//! One file per name under `%APPDATA%\Nexo`, holding only the wrapped blob.
//! The plaintext key is never written to disk in any form.

use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::SecureStore;

/// Errors from the DPAPI-backed store.
#[derive(Debug, thiserror::Error)]
pub enum DpapiError {
    /// The name would escape the keyring directory.
    #[error("`{0}` is not a valid secret name")]
    InvalidName(String),
    /// `%APPDATA%` was not set, so there is nowhere to put the keyring.
    #[error("could not locate %APPDATA% for the keyring directory")]
    NoAppData,
    /// Reading or writing the wrapped blob failed.
    #[error("keyring I/O failed: {0}")]
    Io(#[from] std::io::Error),
    /// Windows refused to wrap or unwrap.
    ///
    /// Deliberately carries no detail about the secret; unwrap failure is
    /// expected when a blob is moved between accounts or machines, and that is
    /// not a fact worth elaborating on in a log.
    #[error("DPAPI {operation} failed (os error {code})")]
    Dpapi {
        /// Which call failed.
        operation: &'static str,
        /// The value of `GetLastError`.
        code: u32,
    },
}

/// A [`SecureStore`] backed by Windows DPAPI.
#[derive(Debug, Clone)]
pub struct DpapiStore {
    dir: PathBuf,
}

impl DpapiStore {
    /// A store rooted at `%APPDATA%\Nexo`.
    pub fn new() -> Result<Self, DpapiError> {
        let appdata = std::env::var_os("APPDATA").ok_or(DpapiError::NoAppData)?;
        Ok(Self::with_dir(Path::new(&appdata).join("Nexo")))
    }

    /// A store rooted at an explicit directory. Tests use this; production
    /// should use [`DpapiStore::new`].
    pub fn with_dir(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Where the wrapped blob for `name` lives.
    ///
    /// Names are restricted rather than escaped: the callers are all in this
    /// repo, so a name containing a separator is a bug to surface, not input
    /// to sanitise.
    fn path_for(&self, name: &str) -> Result<PathBuf, DpapiError> {
        let valid = !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !valid {
            return Err(DpapiError::InvalidName(name.to_string()));
        }
        Ok(self.dir.join(format!("{name}.bin")))
    }
}

impl SecureStore for DpapiStore {
    type Error = DpapiError;

    fn store(&self, name: &str, secret: &[u8]) -> Result<(), Self::Error> {
        let path = self.path_for(name)?;
        let wrapped = ffi::protect(secret, entropy(name).as_bytes())?;
        std::fs::create_dir_all(&self.dir)?;
        // Write-then-rename, so an interrupted write cannot leave a truncated
        // blob where a good one used to be. Losing this file loses the
        // database, so a half-written one is the worst outcome available.
        let temp = path.with_extension("bin.tmp");
        std::fs::write(&temp, &wrapped)?;
        std::fs::rename(&temp, &path)?;
        Ok(())
    }

    fn load(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, Self::Error> {
        let path = self.path_for(name)?;
        let wrapped = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            // A missing keyring is first-run, not a failure.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        Ok(Some(ffi::unprotect(&wrapped, entropy(name).as_bytes())?))
    }

    fn erase(&self, name: &str) -> Result<(), Self::Error> {
        let path = self.path_for(name)?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            // Already gone is the state we wanted.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// Extra entropy mixed into the wrap, so a blob produced for one name cannot be
/// unwrapped as another — and so another application's DPAPI blob cannot be
/// dropped into our keyring directory and unwrapped by us.
fn entropy(name: &str) -> String {
    format!("nexo:v1:{name}")
}

#[cfg(target_os = "windows")]
mod ffi {
    //! The only `unsafe` in the workspace. See this module's parent docs.

    use super::DpapiError;
    use zeroize::Zeroizing;

    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    /// Borrows a slice as the BLOB shape the API wants.
    ///
    /// `pbData` is `*mut` in the signature but DPAPI does not write through the
    /// input blobs, so a cast from a shared reference is sound for the duration
    /// of the call — and the blob never outlives the borrow.
    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr() as *mut u8,
        }
    }

    /// Copies an output blob out and frees what Windows allocated.
    #[allow(unsafe_code)]
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success DPAPI guarantees `pbData` points to `cbData`
        // readable bytes allocated with LocalAlloc. We copy them and hand the
        // allocation straight back, so nothing dangles and nothing leaks.
        let copied =
            unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        #[allow(unsafe_code)]
        // SAFETY: `pbData` is the LocalAlloc pointer DPAPI just gave us and is
        // not used again after this call.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut core::ffi::c_void)));
        }
        copied
    }

    #[allow(unsafe_code)]
    pub fn protect(secret: &[u8], entropy: &[u8]) -> Result<Vec<u8>, DpapiError> {
        let input = blob(secret);
        let extra = blob(entropy);
        let mut out = CRYPT_INTEGER_BLOB::default();

        // SAFETY: all three blobs point at memory we own and outlive the call.
        // `out` is written only on success, and is copied and freed by `take`.
        let result = unsafe {
            CryptProtectData(
                &input,
                None, // no description: it is stored in the clear alongside the blob
                Some(&extra),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };

        result.map_err(|e| DpapiError::Dpapi {
            operation: "CryptProtectData",
            code: e.code().0 as u32,
        })?;
        Ok(take(out))
    }

    #[allow(unsafe_code)]
    pub fn unprotect(wrapped: &[u8], entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>, DpapiError> {
        let input = blob(wrapped);
        let extra = blob(entropy);
        let mut out = CRYPT_INTEGER_BLOB::default();

        // SAFETY: as in `protect`.
        let result = unsafe {
            CryptUnprotectData(
                &input,
                None,
                Some(&extra),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };

        result.map_err(|e| DpapiError::Dpapi {
            operation: "CryptUnprotectData",
            code: e.code().0 as u32,
        })?;
        Ok(Zeroizing::new(take(out)))
    }
}

/// A stub so the crate still compiles for Android and Linux CI. Calling it is a
/// programming error, not a runtime condition, so it says so.
#[cfg(not(target_os = "windows"))]
mod ffi {
    use super::DpapiError;
    use zeroize::Zeroizing;

    pub fn protect(_secret: &[u8], _entropy: &[u8]) -> Result<Vec<u8>, DpapiError> {
        unreachable!("DpapiStore is Windows-only; use the platform's own SecureStore")
    }

    pub fn unprotect(_wrapped: &[u8], _entropy: &[u8]) -> Result<Zeroizing<Vec<u8>>, DpapiError> {
        unreachable!("DpapiStore is Windows-only; use the platform's own SecureStore")
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// A directory of this test's own, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nexo-dpapi-{}-{}-{tag}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store(tag: &str) -> (DpapiStore, TempDir) {
        let dir = TempDir::new(tag);
        (DpapiStore::with_dir(&dir.0), dir)
    }

    #[test]
    fn a_secret_round_trips() {
        let (s, _dir) = store("roundtrip");
        let secret = [0xABu8; 32];
        s.store(crate::STORE_KEY_NAME, &secret).unwrap();
        let loaded = s.load(crate::STORE_KEY_NAME).unwrap().unwrap();
        assert_eq!(&loaded[..], &secret[..]);
    }

    #[test]
    fn a_missing_secret_is_none_rather_than_an_error() {
        // First run has no keyring. That is normal, not a failure.
        let (s, _dir) = store("missing");
        assert!(s.load(crate::STORE_KEY_NAME).unwrap().is_none());
    }

    #[test]
    fn the_plaintext_never_reaches_the_file() {
        let (s, dir) = store("ciphertext");
        let secret = b"sqlcipher-key-material-goes-here";
        s.store(crate::STORE_KEY_NAME, secret).unwrap();

        let on_disk = std::fs::read(dir.0.join(format!("{}.bin", crate::STORE_KEY_NAME))).unwrap();
        assert!(
            !on_disk.windows(secret.len()).any(|w| w == secret),
            "the wrapped blob must not contain the secret verbatim"
        );
        assert!(
            on_disk.len() > secret.len(),
            "DPAPI output should be framed"
        );
    }

    #[test]
    fn erasing_makes_the_secret_unrecoverable() {
        // BRIEF section 10: deleting the keyring blob makes store.db
        // permanently unreadable. This is the half of that claim we can test.
        let (s, _dir) = store("erase");
        s.store(crate::STORE_KEY_NAME, &[7u8; 32]).unwrap();
        assert!(s.load(crate::STORE_KEY_NAME).unwrap().is_some());

        s.erase(crate::STORE_KEY_NAME).unwrap();
        assert!(s.load(crate::STORE_KEY_NAME).unwrap().is_none());
    }

    #[test]
    fn erasing_something_absent_succeeds() {
        // Logout runs this whether or not a session existed.
        let (s, _dir) = store("erase-absent");
        assert!(s.erase(crate::STORE_KEY_NAME).is_ok());
    }

    #[test]
    fn a_blob_stored_under_one_name_will_not_unwrap_as_another() {
        // The per-name entropy is what enforces this. Without it, any blob in
        // the directory would unwrap under any name.
        let (s, dir) = store("entropy");
        s.store("first", b"secret-one").unwrap();
        std::fs::copy(dir.0.join("first.bin"), dir.0.join("second.bin")).unwrap();

        assert!(s.load("first").unwrap().is_some());
        assert!(
            s.load("second").is_err(),
            "a blob wrapped for `first` must not unwrap as `second`"
        );
    }

    #[test]
    fn names_that_would_escape_the_directory_are_refused() {
        let (s, _dir) = store("names");
        for bad in ["../escape", "a/b", "a\\b", "", "with space", "dot.name"] {
            assert!(
                matches!(s.store(bad, b"x"), Err(DpapiError::InvalidName(_))),
                "`{bad}` should be refused"
            );
        }
    }

    #[test]
    fn overwriting_replaces_the_stored_secret() {
        let (s, _dir) = store("overwrite");
        s.store(crate::STORE_KEY_NAME, b"old").unwrap();
        s.store(crate::STORE_KEY_NAME, b"new").unwrap();
        let loaded = s.load(crate::STORE_KEY_NAME).unwrap().unwrap();
        assert_eq!(&loaded[..], b"new");
    }
}
