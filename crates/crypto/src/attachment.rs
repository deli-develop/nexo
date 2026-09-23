//! Attachment encryption.
//!
//! Brief 5.3: the client generates a fresh AES-256-GCM key and nonce, encrypts
//! the file, uploads the **ciphertext**, and puts the key inside the
//! MLS-encrypted message. The server sees an opaque blob and never learns the
//! key, the filename, or the type.
//!
//! That is what makes an attachment end-to-end encrypted rather than merely
//! encrypted-at-rest. Encryption at rest protects a disposed disk; this
//! protects against the server itself, which is named in
//! `docs/THREAT-MODEL.md` as an adversary in scope.
//!
//! # One key per file, never reused
//!
//! GCM fails catastrophically on nonce reuse — two files under the same
//! key/nonce pair leak the XOR of their plaintexts and let an attacker forge
//! tags. A fresh 256-bit key *and* a fresh nonce per file makes reuse
//! impossible rather than unlikely, and there is no key schedule to get wrong
//! because no key is ever used twice.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// AES-256 key length.
pub const KEY_LEN: usize = 32;
/// GCM nonce length.
pub const NONCE_LEN: usize = 12;

/// Errors from attachment handling.
#[derive(Debug, thiserror::Error)]
pub enum AttachmentError {
    /// The key or nonce was the wrong size.
    #[error("expected {expected} bytes, found {found}")]
    WrongLength {
        /// How many were expected.
        expected: usize,
        /// How many were supplied.
        found: usize,
    },
    /// Decryption failed.
    ///
    /// GCM authenticates, so this means the ciphertext was altered, truncated,
    /// or encrypted under a different key — not that it decoded to nonsense.
    /// Rule 7: this is shown as a failure, never as a partial file.
    #[error("the attachment could not be decrypted")]
    Undecryptable,
    /// The plaintext did not match the hash the sender published.
    ///
    /// Separate from [`AttachmentError::Undecryptable`] because it means
    /// something different: the ciphertext *was* authentic, so this is a
    /// mismatch between what was uploaded and what was described, which is a
    /// bug rather than an attack.
    #[error("the attachment does not match its published hash")]
    HashMismatch,
}

/// A freshly encrypted attachment, ready to upload.
pub struct Encrypted {
    /// What to upload. Opaque.
    pub ciphertext: Vec<u8>,
    /// The key, which goes inside the MLS message and nowhere else.
    pub key: Zeroizing<[u8; KEY_LEN]>,
    /// The nonce.
    pub nonce: [u8; NONCE_LEN],
    /// SHA-256 of the plaintext, so the recipient can verify what they got.
    pub sha256: [u8; 32],
    /// Plaintext size.
    pub size: u64,
}

impl std::fmt::Debug for Encrypted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key is the whole secret. Never print it.
        f.debug_struct("Encrypted")
            .field("size", &self.size)
            .field("ciphertext_len", &self.ciphertext.len())
            .finish_non_exhaustive()
    }
}

/// Encrypts a file with a fresh key and nonce.
pub fn encrypt(plaintext: &[u8]) -> Result<Encrypted, AttachmentError> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(key.as_mut_slice());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_slice()));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        // Encryption fails only on absurd input sizes; there is nothing a
        // caller can do differently, and the detail is not useful.
        .map_err(|_| AttachmentError::Undecryptable)?;

    let sha256: [u8; 32] = Sha256::digest(plaintext).into();

    Ok(Encrypted {
        ciphertext,
        key,
        nonce,
        sha256,
        size: plaintext.len() as u64,
    })
}

/// Decrypts a downloaded attachment and checks it against its published hash.
///
/// Both checks matter and they catch different things. GCM's tag catches a
/// ciphertext that was altered in the bucket or in transit. The hash catches a
/// sender whose upload and whose description disagree — which authentication
/// alone would happily accept, because both would be authentic.
pub fn decrypt(
    ciphertext: &[u8],
    key: &[u8],
    nonce: &[u8],
    expected_sha256: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AttachmentError> {
    let key: [u8; KEY_LEN] = key.try_into().map_err(|_| AttachmentError::WrongLength {
        expected: KEY_LEN,
        found: key.len(),
    })?;
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| AttachmentError::WrongLength {
        expected: NONCE_LEN,
        found: nonce.len(),
    })?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext)
        .map_err(|_| AttachmentError::Undecryptable)?;

    let actual: [u8; 32] = Sha256::digest(&plaintext).into();
    if actual.as_slice() != expected_sha256 {
        return Err(AttachmentError::HashMismatch);
    }

    Ok(Zeroizing::new(plaintext))
}

/// How much plaintext goes into one segment.
///
/// 256 KiB. The trade is between how much has to arrive before the first frame
/// can be decoded and how much the per-segment overhead costs: a 16-byte tag on
/// 256 KiB is 0.006%, while a segment small enough to make that overhead
/// noticeable would also mean thousands of them for an ordinary video.
///
/// Fixed rather than carried in the payload. A reader that took the size from
/// the sender would have to trust it to compute segment boundaries, and a lie
/// there is a way to make a reader index past the end of its own buffer.
pub const SEGMENT_LEN: usize = 256 * 1024;

/// A segment's ciphertext length: the plaintext plus GCM's tag.
pub const SEGMENT_CIPHERTEXT_LEN: usize = SEGMENT_LEN + 16;

/// Encrypts a file in segments that can be decrypted one at a time.
///
/// The same primitive as [`encrypt`], applied per segment, so that a byte range
/// can be read without the whole file — which is what lets a video start
/// playing before it has finished arriving. Nothing new is invented here
/// (rule 1): it is AES-256-GCM from the same crate, with a counter-derived
/// nonce and an authenticated segment header.
///
/// # Why this is not simply `encrypt` in a loop
///
/// Three attacks that per-segment encryption invites, and what stops each:
///
/// - **Reordering.** Segments encrypted independently under one key are
///   interchangeable. The segment index goes in the AAD, so a segment moved to
///   a different position fails its tag.
/// - **Truncation.** Dropping the tail of a file leaves every remaining segment
///   valid. The total count goes in the AAD too, so every segment names how
///   many there were and a short file is caught at the first one read.
/// - **Nonce reuse.** The catastrophic one. The nonce is the random 96-bit base
///   with the segment index added into its last eight bytes, so no two segments
///   under one key share a nonce, and no two *files* share the base.
///
/// The published SHA-256 is still of the whole plaintext, unchanged, and is
/// still checked when the whole file is read.
pub fn encrypt_segmented(plaintext: &[u8]) -> Result<Encrypted, AttachmentError> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(key.as_mut_slice());
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_slice()));
    let total = segment_count(plaintext.len() as u64);

    let mut ciphertext = Vec::with_capacity(plaintext.len() + total as usize * 16);
    for (index, chunk) in plaintext.chunks(SEGMENT_LEN).enumerate() {
        let sealed = seal_segment(&cipher, &nonce, index as u64, total, chunk)?;
        ciphertext.extend_from_slice(&sealed);
    }
    // An empty file is one empty segment rather than none, so that "no
    // segments" is never a valid encoding -- otherwise a truncation to zero
    // would be indistinguishable from an empty file.
    if plaintext.is_empty() {
        let sealed = seal_segment(&cipher, &nonce, 0, total, &[])?;
        ciphertext.extend_from_slice(&sealed);
    }

    let sha256: [u8; 32] = Sha256::digest(plaintext).into();
    Ok(Encrypted {
        ciphertext,
        key,
        nonce,
        sha256,
        size: plaintext.len() as u64,
    })
}

/// How many segments a plaintext of this size occupies.
///
/// Zero-length is one segment, for the reason in [`encrypt_segmented`].
#[must_use]
pub fn segment_count(size: u64) -> u64 {
    if size == 0 {
        return 1;
    }
    size.div_ceil(SEGMENT_LEN as u64)
}

/// Decrypts one segment of a segmented attachment.
///
/// `index` and `total` are what the reader believes; if either disagrees with
/// what was sealed, the tag fails and this returns
/// [`AttachmentError::Undecryptable`] rather than plaintext. That is rule 7 at
/// the smallest scale it applies: a stream that has been cut short or shuffled
/// does not play a shortened video, it refuses.
///
/// `segment` is exactly the ciphertext of one segment — the caller slices it
/// out by [`SEGMENT_CIPHERTEXT_LEN`], which is why that length is fixed rather
/// than described by the sender.
pub fn decrypt_segment(
    segment: &[u8],
    key: &[u8],
    nonce: &[u8],
    index: u64,
    total: u64,
) -> Result<Zeroizing<Vec<u8>>, AttachmentError> {
    let key: [u8; KEY_LEN] = key.try_into().map_err(|_| AttachmentError::WrongLength {
        expected: KEY_LEN,
        found: key.len(),
    })?;
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| AttachmentError::WrongLength {
        expected: NONCE_LEN,
        found: nonce.len(),
    })?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let payload = aes_gcm::aead::Payload {
        msg: segment,
        aad: &segment_aad(index, total),
    };
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&segment_nonce(&nonce, index)), payload)
        .map_err(|_| AttachmentError::Undecryptable)?;
    Ok(Zeroizing::new(plaintext))
}

/// Decrypts a whole segmented attachment and checks its published hash.
///
/// The counterpart to [`decrypt`] for the segmented encoding: a caller that
/// wants the entire file rather than a byte range gets it here, without having
/// to know how segments are laid out or having to reimplement the hash check.
///
/// Every segment is authenticated with its index and the total, so a reordered
/// or truncated object fails before the hash is ever reached. The SHA-256 is
/// still of the whole plaintext and is checked once at the end, catching the
/// different thing it always caught: an upload that disagrees with the message
/// describing it.
///
/// `size` is the sender's declared plaintext length, and it is not trusted. It
/// decides how many segments to expect — a wrong count fails the AAD check on
/// the first segment read — and it must agree with the ciphertext's own length,
/// checked before anything is allocated. Sizing the buffer from a number a
/// sender chose would let a message ask a browser for as much memory as it
/// liked, and on a 32-bit target `as usize` would truncate it besides.
pub fn decrypt_segmented(
    ciphertext: &[u8],
    key: &[u8],
    nonce: &[u8],
    expected_sha256: &[u8],
    size: u64,
) -> Result<Zeroizing<Vec<u8>>, AttachmentError> {
    let total = segment_count(size);
    // Every segment is its plaintext plus a 16-byte tag, so the two lengths
    // determine each other exactly.
    let expected_len = total
        .checked_mul(16)
        .and_then(|tags| tags.checked_add(size));
    if expected_len != Some(ciphertext.len() as u64) {
        return Err(AttachmentError::Undecryptable);
    }
    let mut plaintext = Vec::with_capacity(ciphertext.len());

    for index in 0..total {
        let from = (index as usize) * SEGMENT_CIPHERTEXT_LEN;
        let to = (from + SEGMENT_CIPHERTEXT_LEN).min(ciphertext.len());
        // A missing segment is a truncated object. `decrypt_segment` would
        // refuse an empty slice anyway; failing here says which thing was
        // wrong rather than blaming the tag.
        let part = ciphertext
            .get(from..to)
            .filter(|part| !part.is_empty())
            .ok_or(AttachmentError::Undecryptable)?;
        let opened = decrypt_segment(part, key, nonce, index, total)?;
        plaintext.extend_from_slice(&opened);
    }

    let actual: [u8; 32] = Sha256::digest(&plaintext).into();
    if actual.as_slice() != expected_sha256 {
        return Err(AttachmentError::HashMismatch);
    }
    Ok(Zeroizing::new(plaintext))
}

/// Encrypts one segment under the file's key.
fn seal_segment(
    cipher: &Aes256Gcm,
    base_nonce: &[u8; NONCE_LEN],
    index: u64,
    total: u64,
    chunk: &[u8],
) -> Result<Vec<u8>, AttachmentError> {
    let payload = aes_gcm::aead::Payload {
        msg: chunk,
        aad: &segment_aad(index, total),
    };
    cipher
        .encrypt(
            Nonce::from_slice(&segment_nonce(base_nonce, index)),
            payload,
        )
        .map_err(|_| AttachmentError::Undecryptable)
}

/// What each segment authenticates besides its own bytes.
///
/// Its position and how many there are. Both are needed and neither is
/// sufficient: without the index segments can be swapped, and without the total
/// the file can be cut short at any segment boundary.
fn segment_aad(index: u64, total: u64) -> [u8; 16] {
    let mut aad = [0u8; 16];
    aad[..8].copy_from_slice(&index.to_be_bytes());
    aad[8..].copy_from_slice(&total.to_be_bytes());
    aad
}

/// The nonce for one segment: the file's random base, plus the index.
///
/// Adding into the last eight bytes rather than overwriting them keeps the
/// first four random across files, so two files never share a segment nonce
/// even at the same index. Wrapping is unreachable in practice -- it would take
/// 2^64 segments -- and is defined behaviour rather than a panic if it ever
/// were reached.
fn segment_nonce(base: &[u8; NONCE_LEN], index: u64) -> [u8; NONCE_LEN] {
    let mut nonce = *base;
    let tail = u64::from_be_bytes(nonce[4..].try_into().unwrap_or([0; 8]));
    nonce[4..].copy_from_slice(&tail.wrapping_add(index).to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ciphertext for a plaintext of `len` bytes, plus what opens it.
    fn segmented(len: usize) -> (Encrypted, Vec<u8>) {
        let plaintext: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        let sealed = encrypt_segmented(&plaintext).expect("encryption");
        (sealed, plaintext)
    }

    /// One segment's ciphertext, sliced out by the fixed length.
    fn segment(ciphertext: &[u8], index: usize) -> &[u8] {
        let from = index * SEGMENT_CIPHERTEXT_LEN;
        let to = (from + SEGMENT_CIPHERTEXT_LEN).min(ciphertext.len());
        &ciphertext[from..to]
    }

    #[test]
    fn a_segmented_file_round_trips_segment_by_segment() {
        let len = SEGMENT_LEN * 2 + 1234;
        let (sealed, plaintext) = segmented(len);
        let total = segment_count(len as u64);
        assert_eq!(total, 3);

        let mut rebuilt = Vec::new();
        for index in 0..total {
            let part = decrypt_segment(
                segment(&sealed.ciphertext, index as usize),
                sealed.key.as_slice(),
                &sealed.nonce,
                index,
                total,
            )
            .expect("each segment opens");
            rebuilt.extend_from_slice(&part);
        }
        assert_eq!(rebuilt, plaintext);
    }

    #[test]
    fn any_segment_opens_without_the_ones_before_it() {
        // The whole point: a reader can start in the middle, which is what
        // lets a video seek without downloading everything up to that moment.
        let (sealed, plaintext) = segmented(SEGMENT_LEN * 3);
        let total = segment_count((SEGMENT_LEN * 3) as u64);

        let third = decrypt_segment(
            segment(&sealed.ciphertext, 2),
            sealed.key.as_slice(),
            &sealed.nonce,
            2,
            total,
        )
        .expect("the third segment opens on its own");
        assert_eq!(&third[..], &plaintext[SEGMENT_LEN * 2..SEGMENT_LEN * 3]);
    }

    #[test]
    fn a_segmented_file_opens_whole_as_well_as_in_parts() {
        // What `save_attachment` and the lightbox need: the same bytes back,
        // without the caller knowing anything about segments.
        let (sealed, plaintext) = segmented(SEGMENT_LEN * 2 + 77);
        let opened = decrypt_segmented(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            &sealed.sha256,
            sealed.size,
        )
        .expect("a segmented file opens whole");
        assert_eq!(&opened[..], &plaintext[..]);
    }

    #[test]
    fn an_empty_segmented_file_opens_whole() {
        let (sealed, _) = segmented(0);
        let opened = decrypt_segmented(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            &sealed.sha256,
            0,
        )
        .expect("an empty file still opens");
        assert!(opened.is_empty());
    }

    #[test]
    fn a_truncated_segmented_file_does_not_open_whole() {
        // Rule 7 at the whole-file level: a short object refuses rather than
        // handing back the part of it that happened to authenticate.
        let (sealed, _) = segmented(SEGMENT_LEN * 3);
        let cut = &sealed.ciphertext[..sealed.ciphertext.len() - SEGMENT_CIPHERTEXT_LEN];
        let result = decrypt_segmented(
            cut,
            sealed.key.as_slice(),
            &sealed.nonce,
            &sealed.sha256,
            sealed.size,
        );
        assert!(matches!(result, Err(AttachmentError::Undecryptable)));
    }

    #[test]
    fn a_segmented_file_whose_hash_disagrees_is_refused() {
        // The per-segment tags are about tampering; this is about a sender
        // whose upload and whose description do not match.
        let (sealed, _) = segmented(SEGMENT_LEN);
        let wrong = [0u8; 32];
        let result = decrypt_segmented(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            &wrong,
            sealed.size,
        );
        assert!(matches!(result, Err(AttachmentError::HashMismatch)));
    }

    #[test]
    fn a_lie_about_the_size_does_not_open_the_file() {
        // `size` decides how many segments to expect, and it is the sender's
        // number. A wrong one must fail the AAD rather than be believed.
        let (sealed, _) = segmented(SEGMENT_LEN * 3);
        let result = decrypt_segmented(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            &sealed.sha256,
            (SEGMENT_LEN * 2) as u64,
        );
        assert!(matches!(result, Err(AttachmentError::Undecryptable)));
    }

    #[test]
    fn a_size_the_ciphertext_cannot_hold_is_refused_before_anything_is_allocated() {
        // Nothing past the length check could reach this: an allocation of
        // `u64::MAX` bytes aborts rather than failing a tag.
        let (sealed, _) = segmented(10);
        for size in [u64::MAX, u64::MAX / 2, 11] {
            let result = decrypt_segmented(
                &sealed.ciphertext,
                sealed.key.as_slice(),
                &sealed.nonce,
                &sealed.sha256,
                size,
            );
            assert!(
                matches!(result, Err(AttachmentError::Undecryptable)),
                "size {size} was not refused",
            );
        }
    }

    #[test]
    fn a_reordered_segment_is_refused() {
        // Segments encrypted independently under one key would be
        // interchangeable. The index in the AAD is what stops that.
        let (sealed, _) = segmented(SEGMENT_LEN * 2);
        let total = 2;
        let result = decrypt_segment(
            segment(&sealed.ciphertext, 1),
            sealed.key.as_slice(),
            &sealed.nonce,
            // Claiming the second segment is the first.
            0,
            total,
        );
        assert!(
            matches!(result, Err(AttachmentError::Undecryptable)),
            "a segment moved from its position must not open"
        );
    }

    #[test]
    fn a_truncated_stream_is_refused_rather_than_played_short() {
        // Rule 7 at its smallest scale. Cutting the tail off leaves every
        // remaining segment individually valid, so the total in the AAD is
        // what catches it -- at the *first* segment read, not the last.
        let (sealed, _) = segmented(SEGMENT_LEN * 3);
        let result = decrypt_segment(
            segment(&sealed.ciphertext, 0),
            sealed.key.as_slice(),
            &sealed.nonce,
            0,
            // A reader lied to about how long the file is.
            2,
        );
        assert!(
            matches!(result, Err(AttachmentError::Undecryptable)),
            "a stream cut short must refuse, not play a shortened file"
        );
    }

    #[test]
    fn an_altered_segment_is_refused() {
        let (mut sealed, _) = segmented(SEGMENT_LEN);
        sealed.ciphertext[10] ^= 0xff;
        let result = decrypt_segment(
            segment(&sealed.ciphertext, 0),
            sealed.key.as_slice(),
            &sealed.nonce,
            0,
            1,
        );
        assert!(matches!(result, Err(AttachmentError::Undecryptable)));
    }

    #[test]
    fn no_two_segments_share_a_nonce() {
        // The catastrophic failure mode for GCM. Checked directly rather than
        // inferred from the round trip passing.
        let base = [7u8; NONCE_LEN];
        let mut seen = std::collections::HashSet::new();
        for index in 0..10_000u64 {
            assert!(
                seen.insert(segment_nonce(&base, index)),
                "segment {index} reused a nonce"
            );
        }
    }

    #[test]
    fn two_files_do_not_share_segment_nonces() {
        // Different random bases, so segment 0 of one file and segment 0 of
        // another are not encrypted under the same nonce.
        let (a, _) = segmented(SEGMENT_LEN);
        let (b, _) = segmented(SEGMENT_LEN);
        assert_ne!(a.nonce, b.nonce, "each file gets a fresh base nonce");
    }

    #[test]
    fn an_empty_file_is_one_segment_not_none() {
        // Otherwise "no segments at all" would be a valid encoding, and a
        // truncation to nothing would look exactly like an empty file.
        let (sealed, _) = segmented(0);
        assert_eq!(segment_count(0), 1);
        let opened = decrypt_segment(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            0,
            1,
        )
        .expect("an empty file still opens");
        assert!(opened.is_empty());
    }

    #[test]
    fn a_segment_count_covers_exact_multiples() {
        assert_eq!(segment_count(SEGMENT_LEN as u64), 1);
        assert_eq!(segment_count(SEGMENT_LEN as u64 + 1), 2);
        assert_eq!(segment_count((SEGMENT_LEN * 4) as u64), 4);
    }

    #[test]
    fn a_file_round_trips() {
        let plaintext = b"the contents of a file".to_vec();
        let sealed = encrypt(&plaintext).unwrap();
        let opened = decrypt(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            &sealed.sha256,
        )
        .unwrap();
        assert_eq!(&opened[..], &plaintext[..]);
    }

    #[test]
    fn the_ciphertext_does_not_contain_the_plaintext() {
        // The whole point: what lands in the bucket is opaque.
        let plaintext = b"the quick brown fox jumps over the lazy dog".to_vec();
        let sealed = encrypt(&plaintext).unwrap();
        assert!(
            !sealed
                .ciphertext
                .windows(plaintext.len())
                .any(|w| w == plaintext.as_slice()),
            "plaintext found in the ciphertext"
        );
    }

    #[test]
    fn every_file_gets_its_own_key_and_nonce() {
        // GCM fails catastrophically on nonce reuse, so this is not a nicety.
        let a = encrypt(b"same contents").unwrap();
        let b = encrypt(b"same contents").unwrap();
        assert_ne!(a.key.as_slice(), b.key.as_slice());
        assert_ne!(a.nonce, b.nonce);
        // And identical plaintexts therefore produce different ciphertexts.
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn a_tampered_ciphertext_is_refused() {
        // GCM authenticates; a flipped bit must not decrypt to a "mostly right"
        // file.
        let sealed = encrypt(b"important").unwrap();
        let mut tampered = sealed.ciphertext.clone();
        tampered[0] ^= 0x01;
        assert!(matches!(
            decrypt(
                &tampered,
                sealed.key.as_slice(),
                &sealed.nonce,
                &sealed.sha256
            ),
            Err(AttachmentError::Undecryptable)
        ));
    }

    #[test]
    fn a_truncated_ciphertext_is_refused() {
        let sealed = encrypt(b"important").unwrap();
        let truncated = &sealed.ciphertext[..sealed.ciphertext.len() - 1];
        assert!(
            decrypt(
                truncated,
                sealed.key.as_slice(),
                &sealed.nonce,
                &sealed.sha256
            )
            .is_err()
        );
    }

    #[test]
    fn the_wrong_key_is_refused() {
        let sealed = encrypt(b"important").unwrap();
        let wrong = [0u8; KEY_LEN];
        assert!(matches!(
            decrypt(&sealed.ciphertext, &wrong, &sealed.nonce, &sealed.sha256),
            Err(AttachmentError::Undecryptable)
        ));
    }

    #[test]
    fn a_hash_mismatch_is_distinct_from_a_decryption_failure() {
        // Authentication says the bytes are what the sender uploaded. The hash
        // says they are what the sender *described*. Those are different
        // claims, and conflating them would hide a real bug.
        let sealed = encrypt(b"important").unwrap();
        let wrong_hash = [0u8; 32];
        assert!(matches!(
            decrypt(
                &sealed.ciphertext,
                sealed.key.as_slice(),
                &sealed.nonce,
                &wrong_hash
            ),
            Err(AttachmentError::HashMismatch)
        ));
    }

    #[test]
    fn key_and_nonce_lengths_are_checked() {
        let sealed = encrypt(b"x").unwrap();
        assert!(matches!(
            decrypt(
                &sealed.ciphertext,
                &[0u8; 16],
                &sealed.nonce,
                &sealed.sha256
            ),
            Err(AttachmentError::WrongLength { expected: 32, .. })
        ));
        assert!(matches!(
            decrypt(
                &sealed.ciphertext,
                sealed.key.as_slice(),
                &[0u8; 8],
                &sealed.sha256
            ),
            Err(AttachmentError::WrongLength { expected: 12, .. })
        ));
    }

    #[test]
    fn an_empty_file_round_trips() {
        let sealed = encrypt(b"").unwrap();
        assert_eq!(sealed.size, 0);
        let opened = decrypt(
            &sealed.ciphertext,
            sealed.key.as_slice(),
            &sealed.nonce,
            &sealed.sha256,
        )
        .unwrap();
        assert!(opened.is_empty());
    }
}
