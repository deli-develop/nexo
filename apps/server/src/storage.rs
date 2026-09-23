//! Hetzner Object Storage.
//!
//! Two buckets, two credential pairs, and types that will not let you mix them
//! up (docs/OPS.md Phase 8):
//!
//! | Bucket | Contents | Readable by the server |
//! |---|---|---|
//! | `nexo-media` | feed and profile images | yes, by design |
//! | `nexo-enc` | encrypted attachments | no, opaque ciphertext |
//!
//! The whole reason there are two buckets is that the credential handling
//! public media must never be able to reach encrypted blobs. One shared key
//! throws that away and leaves you with two buckets and a single blast radius.
//! `Bucket<Media>` and `Bucket<Encrypted>` are distinct types carrying distinct
//! credentials, and an `ObjectKey<Media>` will not compile against the
//! encrypted bucket, so the separation is a property of the code rather than a
//! rule someone has to remember. [`Storage::verify_isolation`] then checks that
//! the *credentials* really are separate too, which no type can prove.
//!
//! The server only signs. Since the page became the client (REWORK wave 7),
//! every upload and download is a presigned request made by the browser
//! itself, so each bucket needs a CORS rule naming the same origins as
//! `NEXO_CORS_ORIGINS` — without one the browser refuses the request before it
//! is sent (docs/OPS.md Phase 8). Encryption stays in the client: what reaches
//! `nexo-enc` is already ciphertext.

use std::marker::PhantomData;

use anyhow::{Context, bail};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use nexo_protocol::ConversationId;
use uuid::Uuid;

/// Hetzner's regions are the same short names as its cloud locations. Used only
/// for the SigV4 signature; the endpoint is what actually routes.
const DEFAULT_REGION: &str = "fsn1";

/// Refuse to read an object larger than this into memory.
///
/// M6's target is a 20 MB attachment, so this is headroom rather than a product
/// limit. It exists because `get` buffers, and an unbounded buffer driven by a
/// remote object is a denial of service waiting to be found.
const MAX_OBJECT_BYTES: i64 = 32 * 1024 * 1024;

/// Marks the bucket holding server-readable feed and profile images.
#[derive(Debug, Clone, Copy)]
pub struct Media;

/// Marks the bucket holding encrypted attachments the server cannot read.
#[derive(Debug, Clone, Copy)]
pub struct Encrypted;

/// A key in one specific bucket. The type parameter is what stops a media key
/// from being handed to the encrypted bucket, or the reverse.
///
/// `PhantomData<fn() -> K>` rather than `PhantomData<K>` so that `K` is not
/// held by value: the marker is a label, and the key neither owns nor drops
/// one.
#[derive(Debug, Clone)]
pub struct ObjectKey<K> {
    key: String,
    kind: PhantomData<fn() -> K>,
}

// Written out rather than derived. `#[derive(PartialEq)]` bounds the impl on
// `K: PartialEq` even when no field holds a `K`, which would mean two keys
// could only be compared if the *marker* were comparable. Two keys are equal
// when their strings are; the marker never enters into it.
impl<K> PartialEq for ObjectKey<K> {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl<K> Eq for ObjectKey<K> {}

impl<K> ObjectKey<K> {
    /// The key as stored in Postgres and sent to S3.
    pub fn as_str(&self) -> &str {
        &self.key
    }
}

impl ObjectKey<Media> {
    /// A fresh key under `media/{user_id}/{uuid}`.
    pub fn new(user_id: Uuid) -> Self {
        Self {
            key: format!("media/{user_id}/{}", Uuid::new_v4()),
            kind: PhantomData,
        }
    }

    /// Rebuilds a key read back out of the database.
    ///
    /// The prefix is checked rather than trusted: a key is a path, and a value
    /// that reached the database through some future bug should not be able to
    /// address arbitrary objects.
    pub fn from_stored(key: &str) -> anyhow::Result<Self> {
        validate(key, "media/")?;
        Ok(Self {
            key: key.to_string(),
            kind: PhantomData,
        })
    }
}

impl ObjectKey<Encrypted> {
    /// A fresh key under `enc/{conversation_id}/{uuid}`.
    pub fn new(conversation_id: ConversationId) -> Self {
        Self {
            key: format!("enc/{conversation_id}/{}", Uuid::new_v4()),
            kind: PhantomData,
        }
    }

    /// Rebuilds a key read back out of the database. See
    /// [`ObjectKey::<Media>::from_stored`].
    pub fn from_stored(key: &str) -> anyhow::Result<Self> {
        validate(key, "enc/")?;
        Ok(Self {
            key: key.to_string(),
            kind: PhantomData,
        })
    }
}

fn validate(key: &str, prefix: &str) -> anyhow::Result<()> {
    if !key.starts_with(prefix) {
        bail!("object key does not start with `{prefix}`");
    }
    // `..` cannot escape a bucket the way it escapes a filesystem, but a key
    // containing one is not a key this code produced, so it is a bug worth
    // failing on rather than a request worth serving.
    if key.contains("..") {
        bail!("object key contains `..`");
    }
    Ok(())
}

/// One bucket, and the credentials that reach it.
#[derive(Debug, Clone)]
pub struct Bucket<K> {
    client: Client,
    name: String,
    kind: PhantomData<fn() -> K>,
}

impl<K> Bucket<K> {
    /// The bucket name. Safe to log: it is not a secret (docs/TUTORIAL.md 9).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Stores an object.
    ///
    /// `content_type` is `None` for encrypted objects on purpose: the server is
    /// not supposed to know what a ciphertext blob contains, and a MIME type
    /// beside the object is metadata that 4.2 keeps *inside* the ciphertext.
    pub async fn put(
        &self,
        key: &ObjectKey<K>,
        body: Vec<u8>,
        content_type: Option<&str>,
    ) -> anyhow::Result<()> {
        let mut request = self
            .client
            .put_object()
            .bucket(&self.name)
            .key(key.as_str())
            .body(ByteStream::from(body));

        if let Some(content_type) = content_type {
            request = request.content_type(content_type);
        }

        request
            .send()
            .await
            .with_context(|| format!("PUT {}/{}", self.name, key.as_str()))?;
        Ok(())
    }

    /// Reads an object back, refusing anything over [`MAX_OBJECT_BYTES`].
    pub async fn get(&self, key: &ObjectKey<K>) -> anyhow::Result<Vec<u8>> {
        let response = self
            .client
            .get_object()
            .bucket(&self.name)
            .key(key.as_str())
            .send()
            .await
            .with_context(|| format!("GET {}/{}", self.name, key.as_str()))?;

        // Checked before collecting, so an oversized object is refused rather
        // than buffered and then complained about.
        if let Some(length) = response.content_length()
            && length > MAX_OBJECT_BYTES
        {
            bail!(
                "object {}/{} is {length} bytes, over the {MAX_OBJECT_BYTES} byte limit",
                self.name,
                key.as_str()
            );
        }

        let bytes = response
            .body
            .collect()
            .await
            .with_context(|| format!("reading body of {}/{}", self.name, key.as_str()))?;
        Ok(bytes.into_bytes().to_vec())
    }

    /// Removes an object. Succeeds when the object was already absent, which is
    /// what makes a retried delete safe.
    pub async fn delete(&self, key: &ObjectKey<K>) -> anyhow::Result<()> {
        self.client
            .delete_object()
            .bucket(&self.name)
            .key(key.as_str())
            .send()
            .await
            .with_context(|| format!("DELETE {}/{}", self.name, key.as_str()))?;
        Ok(())
    }

    /// Confirms the bucket exists and these credentials reach it.
    pub async fn check(&self) -> anyhow::Result<()> {
        self.client
            .head_bucket()
            .bucket(&self.name)
            .send()
            .await
            .with_context(|| format!("HEAD bucket {}", self.name))?;
        Ok(())
    }
}

/// Both buckets.
#[derive(Debug, Clone)]
pub struct Storage {
    media: Bucket<Media>,
    encrypted: Bucket<Encrypted>,
}

/// Every variable that must be present for object storage to be configured.
const REQUIRED_VARS: [&str; 7] = [
    "NEXO_S3_ENDPOINT",
    "NEXO_S3_MEDIA_BUCKET",
    "NEXO_S3_MEDIA_ACCESS_KEY",
    "NEXO_S3_MEDIA_SECRET_KEY",
    "NEXO_S3_ENC_BUCKET",
    "NEXO_S3_ENC_ACCESS_KEY",
    "NEXO_S3_ENC_SECRET_KEY",
];

impl Storage {
    /// Builds both clients from the environment, or returns `None` when object
    /// storage is not configured.
    ///
    /// `None` rather than an error because object storage is M6: the server
    /// runs perfectly well without it until then. Half-configured *is* an
    /// error, though. Silently falling back to "not configured" because one
    /// variable is misspelled is exactly the failure that gets discovered in
    /// production.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let is_set = |name: &&str| std::env::var(name).is_ok_and(|v| !v.trim().is_empty());
        let missing: Vec<&str> = REQUIRED_VARS
            .iter()
            .filter(|name| !is_set(name))
            .copied()
            .collect();

        if missing.len() == REQUIRED_VARS.len() {
            return Ok(None);
        }
        if !missing.is_empty() {
            bail!(
                "object storage is partly configured: {} of {} variables set, \
                 missing {}. Set all of them or none.",
                REQUIRED_VARS.len() - missing.len(),
                REQUIRED_VARS.len(),
                missing.join(", ")
            );
        }

        let endpoint = std::env::var("NEXO_S3_ENDPOINT")?;
        let region = std::env::var("NEXO_S3_REGION").unwrap_or_else(|_| DEFAULT_REGION.to_string());

        Ok(Some(Self {
            media: Bucket {
                client: client(
                    &endpoint,
                    &region,
                    std::env::var("NEXO_S3_MEDIA_ACCESS_KEY")?,
                    std::env::var("NEXO_S3_MEDIA_SECRET_KEY")?,
                ),
                name: std::env::var("NEXO_S3_MEDIA_BUCKET")?,
                kind: PhantomData,
            },
            encrypted: Bucket {
                client: client(
                    &endpoint,
                    &region,
                    std::env::var("NEXO_S3_ENC_ACCESS_KEY")?,
                    std::env::var("NEXO_S3_ENC_SECRET_KEY")?,
                ),
                name: std::env::var("NEXO_S3_ENC_BUCKET")?,
                kind: PhantomData,
            },
        }))
    }

    /// The underlying S3 client for one of the two buckets.
    ///
    /// Presigning needs the client itself, not the wrapper — and it is the one
    /// operation where the type-level separation genuinely cannot help, because
    /// a presigned URL names its bucket as a string. The caller passes a bool
    /// rather than a key, so the choice is made once at the call site and is
    /// visible there.
    pub fn client_for(&self, encrypted: bool) -> &Client {
        if encrypted {
            &self.encrypted.client
        } else {
            &self.media.client
        }
    }

    /// Feed and profile images. Server-readable by design.
    pub fn media(&self) -> &Bucket<Media> {
        &self.media
    }

    /// Encrypted attachments. Ciphertext the server cannot read.
    pub fn encrypted(&self) -> &Bucket<Encrypted> {
        &self.encrypted
    }

    /// Checks that the media credentials genuinely cannot reach the encrypted
    /// bucket.
    ///
    /// The type system separates the two buckets in *this* code. It cannot
    /// prove anything about what was pasted into the environment, and pasting
    /// one credential pair twice is an easy mistake that leaves the code
    /// looking correct and the deployment not. So: address the encrypted bucket
    /// with the media client, and require a refusal.
    ///
    /// Path-style addressing is what makes this answerable at all. The bucket
    /// is a parameter rather than part of the hostname, so one client can name
    /// any bucket and the server decides whether it may.
    pub async fn verify_isolation(&self) -> anyhow::Result<()> {
        let reached = self
            .media
            .client
            .head_bucket()
            .bucket(&self.encrypted.name)
            .send()
            .await;

        match reached {
            Err(_) => Ok(()),
            Ok(_) => bail!(
                "the media credentials can reach `{}`, so the two-bucket split \
                 is currently decorative.\n\
                 \n\
                 Two separate credential pairs are NOT enough on Hetzner. Keys \
                 are project-wide by default: every key can read and write \
                 every bucket in the same project. Restricting one to a single \
                 bucket takes a bucket policy on `{}` that allowlists only the \
                 encrypted key -- or the two buckets in separate projects. \
                 See docs/OPS.md Phase 8.",
                self.encrypted.name,
                self.encrypted.name
            ),
        }
    }
}

/// One S3 client, configured entirely from values we were handed.
///
/// Everything is explicit: region, endpoint, credentials, path-style
/// addressing. Nothing is discovered. In particular there is no credential
/// provider chain, so this process never asks a cloud metadata service who it
/// is. An SSRF against a server that does is how one set of credentials becomes
/// someone else's.
fn client(endpoint: &str, region: &str, access_key: String, secret_key: String) -> Client {
    let credentials = Credentials::new(
        access_key, secret_key, None, // no session token: these are static keys, not STS
        None, // no expiry
        "nexo-env",
    );

    let config = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(region.to_string()))
        .endpoint_url(endpoint)
        .credentials_provider(credentials)
        // Hetzner shares one hostname per region across every bucket, so the
        // bucket has to travel in the path rather than in the hostname.
        .force_path_style(true)
        .build();

    Client::from_conf(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_keys_are_namespaced_by_user() {
        let user = Uuid::new_v4();
        let key = ObjectKey::<Media>::new(user);
        assert!(key.as_str().starts_with(&format!("media/{user}/")));
    }

    #[test]
    fn encrypted_keys_are_namespaced_by_conversation() {
        let conversation = Uuid::new_v4();
        let key = ObjectKey::<Encrypted>::new(conversation);
        assert!(key.as_str().starts_with(&format!("enc/{conversation}/")));
    }

    #[test]
    fn keys_are_unique_per_call() {
        let user = Uuid::new_v4();
        assert_ne!(ObjectKey::<Media>::new(user), ObjectKey::<Media>::new(user));
    }

    #[test]
    fn a_stored_key_must_match_its_bucket() {
        let media = ObjectKey::<Media>::new(Uuid::new_v4());
        // The encrypted bucket refuses a media key, which is the property the
        // two-bucket split depends on.
        assert!(ObjectKey::<Encrypted>::from_stored(media.as_str()).is_err());
        assert!(ObjectKey::<Media>::from_stored(media.as_str()).is_ok());
    }

    #[test]
    fn traversal_in_a_stored_key_is_refused() {
        assert!(ObjectKey::<Media>::from_stored("media/../enc/secret").is_err());
    }
}
