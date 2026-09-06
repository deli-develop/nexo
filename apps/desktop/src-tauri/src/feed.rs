//! Feed and profile commands (§6.2, §6.3, G2).
//!
//! **Nothing here is end-to-end encrypted**, and unlike every other command
//! module that is not a caveat but the subject. §4.4 requires the product to
//! say so in plain language rather than let the app's overall reputation for
//! encryption quietly cover a feed it cannot cover; `FeedNotice` says it in the
//! composer, and `PrivacyTable` says it on the Security tab.
//!
//! What still applies from rule 2 is that images are moved by Rust, not the
//! WebView. `pick_and_upload_image` takes a **path** and returns a key: the
//! bytes are read and PUT here, so a 4 MB banner never crosses the IPC bridge
//! and the WebView never holds a presigned URL it could send somewhere else.

use nexo_client::Transport;
use nexo_client::feed::{Comment, FeedApi, NewPost, ProfileEdit, ProfileLink, VoteResult};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::client::ClientState;

/// Feed commands.
pub use nexo_client::feed::{FeedPage, MyProfile, Post, Profile, ReactionCount};

/// An error the UI can act on.
#[derive(Debug, Serialize)]
pub struct FeedErrorView {
    pub kind: &'static str,
    pub message: String,
}

fn failure(kind: &'static str, message: impl Into<String>) -> FeedErrorView {
    FeedErrorView {
        kind,
        message: message.into(),
    }
}

impl From<nexo_client::transport::TransportError> for FeedErrorView {
    fn from(error: nexo_client::transport::TransportError) -> Self {
        use nexo_client::transport::TransportError;
        // The detail goes to the log, the summary to the user. A transport
        // error can carry a URL with a query string in it.
        tracing::warn!(%error, "feed call failed");
        match error {
            TransportError::Unreachable(_) => {
                failure("unreachable", "Can't reach the server. Try again shortly.")
            }
            TransportError::InvalidCredentials => {
                failure("signed_out", "Your session expired. Sign in again.")
            }
            // The server's refusals here are written for people -- "A post is
            // up to 2000 characters." -- so passing them through is more useful
            // than replacing them with something generic.
            TransportError::Rejected(detail) => failure("rejected", detail),
            // A thing that is not there is not a malfunction. This used to
            // fall into the arm below and reach the page as
            // `kind: "internal"`, "Something went wrong. Try again." -- so a
            // handle that does not exist and a client that is broken were the
            // same answer, and nothing could tell them apart or say the
            // truthful thing about either.
            TransportError::NotFound => failure("not_found", "That isn't there any more."),
            _ => failure("internal", "Something went wrong. Try again."),
        }
    }
}

/// Runs work against the signed-in client on a blocking thread.
///
/// Same shape as `conversations::with_client`, and separate for the same reason
/// the modules are separate: this one never touches MLS state, and sharing a
/// helper would invite sharing more than the helper.
async fn with_client<T, F>(state: &ClientState, work: F) -> Result<T, FeedErrorView>
where
    T: Send + 'static,
    F: FnOnce(&crate::client::LoggedIn) -> Result<T, FeedErrorView> + Send + 'static,
{
    let handle = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = handle.lock().map_err(|_| {
            failure(
                "internal",
                "The client state was poisoned by an earlier failure. Restart the app.",
            )
        })?;
        let client = guard
            .as_ref()
            .ok_or_else(|| failure("signed_out", "You are not signed in."))?;
        let outcome = work(client);

        // An access token ages on the clock, so the transport may have traded
        // the refresh token for a new pair mid-call. Writing the new one down
        // is not optional: the next launch replays whatever is stored, and a
        // spent refresh token is what the server reads as theft -- it revokes
        // every session for the account.
        if let Some(rotated) = client.transport.take_rotated_refresh_token()
            && let Err(error) = client.store.set_refresh_token(&rotated)
        {
            tracing::error!(%error, "could not persist a rotated refresh token");
        }

        outcome
    })
    .await
    .map_err(|e| {
        tracing::error!(%e, "a feed task panicked");
        failure("internal", "Something went wrong. Try again.")
    })?
}

/// A page of the feed, newest first.
///
/// `following` narrows it to accounts the caller follows. It narrows what is
/// shown and never widens what may be seen: the server applies the same block
/// list either way, so every post this can return is one the unfiltered feed
/// would have returned to the same caller.
#[tauri::command]
pub async fn feed(
    state: State<'_, ClientState>,
    before: Option<i64>,
    sort: Option<String>,
    following: Option<bool>,
) -> Result<FeedPage, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client
            .transport
            .feed(before, None, sort.as_deref(), following.unwrap_or(false))?)
    })
    .await
}

/// Follows an account, or stops following it.
#[tauri::command]
pub async fn set_following(
    state: State<'_, ClientState>,
    handle: String,
    follow: bool,
) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.set_following(&handle, follow)?)
    })
    .await
}

/// Whether an account is followed, and how many follow it.
#[tauri::command]
pub async fn follow_state(
    state: State<'_, ClientState>,
    handle: String,
) -> Result<nexo_client::feed::FollowState, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.follow_state(&handle)?)
    })
    .await
}

/// One person's posts, for the Posts tab.
#[tauri::command]
pub async fn posts_by(
    state: State<'_, ClientState>,
    handle: String,
    before: Option<i64>,
) -> Result<FeedPage, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.posts_by(&handle, before, None)?)
    })
    .await
}

/// Writes a post.
#[tauri::command]
pub async fn create_post(
    state: State<'_, ClientState>,
    body: String,
    media_keys: Vec<String>,
    title: Option<String>,
    kind: Option<String>,
    link_url: Option<String>,
) -> Result<Post, FeedErrorView> {
    with_client(&state, move |client| {
        let trimmed = body.trim();
        let kind = kind.unwrap_or_else(|| "text".to_string());
        if !matches!(kind.as_str(), "text" | "link" | "image") {
            return Err(failure(
                "invalid_request",
                "A post is text, a link, or an image.",
            ));
        }

        let title = title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        if title.as_deref().is_some_and(|t| t.chars().count() > 300) {
            return Err(failure(
                "invalid_request",
                "A title is up to 300 characters.",
            ));
        }

        let link_url = link_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(str::to_string);

        // The same checks the server makes, so the sentence arrives before the
        // round trip rather than after it.
        match kind.as_str() {
            "link" => {
                let Some(url) = link_url.as_deref() else {
                    return Err(failure("invalid_request", "A link post needs a link."));
                };
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(failure(
                        "invalid_request",
                        "A link must start with http:// or https://.",
                    ));
                }
            }
            "image" if media_keys.is_empty() => {
                return Err(failure("invalid_request", "An image post needs an image."));
            }
            _ => {}
        }

        if kind == "text" && trimmed.is_empty() && media_keys.is_empty() && title.is_none() {
            return Err(failure("invalid_request", "Write something first."));
        }
        // Characters, not bytes, and the same limit the server applies -- so
        // the message arrives before the round trip rather than after it.
        if trimmed.chars().count() > 2000 {
            return Err(failure(
                "invalid_request",
                "A post is up to 2000 characters.",
            ));
        }
        if media_keys.len() > 4 {
            return Err(failure("invalid_request", "Up to 4 images."));
        }
        Ok(client.transport.create_post(&NewPost {
            title,
            kind,
            link_url,
            body: trimmed.to_string(),
            media_keys,
        })?)
    })
    .await
}

/// Deletes one of your own posts.
#[tauri::command]
pub async fn delete_post(state: State<'_, ClientState>, id: i64) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.delete_post(id)?)
    })
    .await
}

/// Votes on a post. `1`, `-1`, or `0` to take a vote back.
#[tauri::command]
pub async fn vote(
    state: State<'_, ClientState>,
    id: i64,
    value: i16,
) -> Result<VoteResult, FeedErrorView> {
    with_client(&state, move |client| {
        if !matches!(value, -1..=1) {
            return Err(failure("invalid_request", "A vote is up, down, or none."));
        }
        Ok(client.transport.vote(id, value)?)
    })
    .await
}

/// The whole comment thread for a post, oldest first.
///
/// Flat on the wire; the tree is rebuilt from `parent_id` where it is drawn.
#[tauri::command]
pub async fn comments(
    state: State<'_, ClientState>,
    post_id: i64,
) -> Result<Vec<Comment>, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.comments(post_id)?)
    })
    .await
}

/// Adds a comment, or a reply when `parent_id` is set.
#[tauri::command]
pub async fn add_comment(
    state: State<'_, ClientState>,
    post_id: i64,
    body: String,
    parent_id: Option<i64>,
) -> Result<Comment, FeedErrorView> {
    with_client(&state, move |client| {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Err(failure("invalid_request", "Write something first."));
        }
        if trimmed.chars().count() > 2000 {
            return Err(failure(
                "invalid_request",
                "A comment is up to 2000 characters.",
            ));
        }
        Ok(client.transport.add_comment(post_id, trimmed, parent_id)?)
    })
    .await
}

/// Deletes one of your own comments.
#[tauri::command]
pub async fn delete_comment(state: State<'_, ClientState>, id: i64) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.delete_comment(id)?)
    })
    .await
}

/// Adds or removes one reaction.
#[tauri::command]
pub async fn react(
    state: State<'_, ClientState>,
    id: i64,
    emoji: String,
    on: bool,
) -> Result<Vec<ReactionCount>, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.react(id, &emoji, on)?)
    })
    .await
}

/// Pins one of your own posts to the top of your profile.
///
/// Three at a time, checked on the server: a cap enforced only in the UI is a
/// cap a second client does not have.
#[tauri::command]
pub async fn pin_post(state: State<'_, ClientState>, id: i64) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| Ok(client.transport.pin_post(id)?)).await
}

/// Unpins one of your own posts.
#[tauri::command]
pub async fn unpin_post(state: State<'_, ClientState>, id: i64) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| Ok(client.transport.unpin_post(id)?)).await
}

/// Everyone this account is blocking.
#[tauri::command]
pub async fn blocks(
    state: State<'_, ClientState>,
) -> Result<Vec<nexo_client::feed::Block>, FeedErrorView> {
    with_client(&state, |client| Ok(client.transport.blocks()?)).await
}

/// Blocks somebody.
///
/// The effects are the server's -- their posts leave the feed, and neither of
/// you can open a conversation with the other. Nothing here hides anything
/// locally, because a block the client applied would be a promise the product
/// cannot keep.
#[tauri::command]
pub async fn block(state: State<'_, ClientState>, handle: String) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| Ok(client.transport.block(&handle)?)).await
}

/// Unblocks somebody.
#[tauri::command]
pub async fn unblock(state: State<'_, ClientState>, handle: String) -> Result<(), FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.unblock(&handle)?)
    })
    .await
}

/// Somebody's public profile.
#[tauri::command]
pub async fn profile(
    state: State<'_, ClientState>,
    handle: String,
) -> Result<Profile, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.profile(&handle)?)
    })
    .await
}

/// Your own profile, with nothing hidden.
#[tauri::command]
pub async fn my_profile(state: State<'_, ClientState>) -> Result<MyProfile, FeedErrorView> {
    with_client(&state, |client| {
        let mine = client.transport.my_profile()?;

        // Write the display name back into the account row, which is the only
        // thing that ever corrects it.
        //
        // `session::login` keeps whatever name the store already had, because
        // the login response carries none and defaulting to the handle would
        // rename the account on every sign-in. On a store with no account row
        // yet that fallback *is* the handle, and nothing afterwards replaced
        // it: the rail and the message header read "@handle" while the profile
        // page -- which asks the server -- read the real name, and editing the
        // profile did not reconcile them either. This is the fetch that knows
        // both, so it is the one that settles it.
        // Best effort: this is a cached copy of something the server just
        // told us, so failing to write it is not a reason to fail the read.
        if let Ok(Some(account)) = client.store.account()
            && account.display_name != mine.profile.display_name
            && let Err(e) = client.store.set_account(
                account.user_id,
                &account.handle,
                &mine.profile.display_name,
                &account.device_id,
            )
        {
            tracing::warn!(%e, "could not cache the display name");
        }

        Ok(mine)
    })
    .await
}

/// What the Edit Profile form sends.
#[derive(Debug, Deserialize)]
pub struct ProfileEditRequest {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub location: Option<String>,
    pub links: Option<Vec<LinkInput>>,
    pub avatar_key: Option<String>,
    pub banner_key: Option<String>,
}

/// One link from the form.
#[derive(Debug, Deserialize)]
pub struct LinkInput {
    pub label: String,
    pub url: String,
}

/// Edits your own profile.
#[tauri::command]
pub async fn update_profile(
    state: State<'_, ClientState>,
    edit: ProfileEditRequest,
) -> Result<MyProfile, FeedErrorView> {
    with_client(&state, move |client| {
        if let Some(links) = &edit.links {
            for link in links {
                // Checked here as well as at the server and in the column. A
                // `javascript:` URL that reached a profile page would run in
                // the WebView, which is where the IPC bridge lives -- so the
                // check belongs at every layer that could be the last one.
                let lower = link.url.trim().to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                    return Err(failure(
                        "invalid_request",
                        "Links must start with http:// or https://.",
                    ));
                }
            }
        }

        let edit = ProfileEdit {
            display_name: edit.display_name,
            bio: edit.bio,
            location: edit.location,
            links: edit.links.map(|links| {
                links
                    .into_iter()
                    .map(|l| ProfileLink {
                        label: l.label,
                        url: l.url,
                    })
                    .collect()
            }),
            avatar_key: edit.avatar_key,
            banner_key: edit.banner_key,
        };
        Ok(client.transport.update_profile(&edit)?)
    })
    .await
}

/// Sets who may see which profile fields (G2).
#[tauri::command]
pub async fn update_visibility(
    state: State<'_, ClientState>,
    visibility: std::collections::BTreeMap<String, String>,
) -> Result<MyProfile, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.update_visibility(&visibility)?)
    })
    .await
}

/// The largest image this app will upload.
///
/// §6.3 puts a banner at 4 MB. The same ceiling for every image: an avatar
/// larger than a banner is a mistake rather than a use case.
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// Uploads an image the user picked, and returns its object key.
///
/// The **path** crosses the bridge, never the bytes and never the presigned
/// URL. A presigned PUT is a bearer credential for one object; handing it to
/// the WebView would put a writable URL somewhere a script could reach it, for
/// no benefit — the bytes are on disk, where Rust can read them.
#[tauri::command]
pub async fn upload_image(
    state: State<'_, ClientState>,
    path: String,
) -> Result<String, FeedErrorView> {
    with_client(&state, move |client| {
        let path = std::path::PathBuf::from(&path);
        let bytes = std::fs::read(&path).map_err(|e| {
            failure(
                "unreadable_file",
                format!("That image could not be read: {e}"),
            )
        })?;
        if bytes.is_empty() {
            return Err(failure("invalid_request", "That file is empty."));
        }
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(failure(
                "too_large",
                format!(
                    "Images are limited to {} MB.",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                ),
            ));
        }
        // The bytes are checked against their own magic number rather than
        // trusted from the extension: this object is served to other people's
        // browsers, and an HTML file named `.png` is a stored XSS on whatever
        // origin serves it.
        if !looks_like_an_image(&bytes) {
            return Err(failure(
                "invalid_request",
                "That doesn't look like a PNG, JPEG, GIF, or WebP.",
            ));
        }

        let (url, key) = client.transport.media_upload_url(bytes.len() as u64)?;
        use nexo_client::transport::Transport as _;
        client.transport.put_object(&url, bytes)?;
        Ok(key)
    })
    .await
}

/// A picked file, handed to the page as a `data:` URL so it can be cropped.
///
/// The page cannot open a local path: `convertFileSrc` needs the asset
/// protocol, which is not enabled, and enabling it would mean granting the
/// WebView a way to read files by path — the same grant the filesystem
/// capability was removed for. Rust reads the one file the user picked and
/// hands over its bytes, which keeps the picker the only thing that chooses
/// what is readable.
#[tauri::command]
pub async fn read_image_for_crop(path: String) -> Result<String, FeedErrorView> {
    let bytes = std::fs::read(&path).map_err(|e| FeedErrorView {
        kind: "unreadable_file",
        message: format!("That image could not be read: {e}"),
    })?;

    if bytes.len() > MAX_INLINE_IMAGE_BYTES {
        return Err(FeedErrorView {
            kind: "too_large",
            message: "That image is too large to open.".into(),
        });
    }
    // Sniffed, never taken from the extension. This goes into the page.
    let mime = sniff_mime(&bytes);
    // Named rather than "anything the sniffer recognised". It used to be the
    // latter, which let a video into the cropper -- and a cropper holding a
    // video shows one frame of nothing and crops it.
    if !mime.starts_with("image/") {
        return Err(FeedErrorView {
            kind: "not_an_image",
            message: "That file is not an image.".into(),
        });
    }

    Ok(data_url(mime, &bytes))
}

/// Uploads an image the page produced, rather than one on disk.
///
/// The cropper re-encodes to PNG or JPEG on a canvas, so the bytes that should
/// be stored exist only in the page. They come back base64 and are checked
/// exactly as a file from disk is — the page is not a trusted source, and a
/// canvas is no guarantee about what it drew.
#[tauri::command]
pub async fn upload_image_bytes(
    state: State<'_, ClientState>,
    data: String,
) -> Result<String, FeedErrorView> {
    use base64::Engine as _;

    with_client(&state, move |client| {
        // A `data:` URL, as the canvas produced it.
        let encoded = data
            .split_once(";base64,")
            .map(|(_, rest)| rest)
            .unwrap_or(&data);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| failure("invalid_request", "That image could not be decoded."))?;

        if bytes.is_empty() {
            return Err(failure("invalid_request", "That image is empty."));
        }
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(failure(
                "too_large",
                format!(
                    "Images are limited to {} MB.",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                ),
            ));
        }
        // A picture or a video, said in those words. "Not octet-stream" meant
        // the same thing only for as long as those were the sole things the
        // sniffer knew; now that it knows sound, the test has to be the claim.
        if !is_renderable(sniff_mime(&bytes)) {
            return Err(failure("not_an_image", "That is not an image."));
        }

        let (url, key) = client.transport.media_upload_url(bytes.len() as u64)?;
        client.transport.put_object(&url, bytes)?;
        Ok(key)
    })
    .await
}

/// A time-limited URL for rendering a feed or profile image.
///
/// Kept for callers outside the WebView. The page itself cannot use this: the
/// CSP allows no remote image host, so use [`image_data_url`].
#[tauri::command]
pub async fn image_url(
    state: State<'_, ClientState>,
    key: String,
) -> Result<String, FeedErrorView> {
    with_client(&state, move |client| {
        Ok(client.transport.media_download_url(&key)?)
    })
    .await
}

/// The largest image this app will inline into the page.
///
/// A `data:` URL is base64, so it costs a third more than the bytes and lives
/// in the WebView's memory as a string. Feed and profile images are small; a
/// ceiling keeps a pathological one from wedging the renderer.
pub(crate) const MAX_INLINE_IMAGE_BYTES: usize = 12 * 1024 * 1024;

/// A feed or profile image, as a `data:` URL the page can actually render.
///
/// The CSP is `img-src 'self' asset: data: blob:` — deliberately no remote
/// host, so a presigned object-storage URL is blocked before a byte is
/// fetched. Rust downloads it instead and hands over the bytes inline, which
/// is the only route the policy leaves open and keeps the bucket unreachable
/// from anything that ever runs script in the page.
#[tauri::command]
pub async fn image_data_url(
    state: State<'_, ClientState>,
    key: String,
) -> Result<String, FeedErrorView> {
    with_client(&state, move |client| {
        let url = client.transport.media_download_url(&key)?;
        let bytes = client.transport.get_object(&url)?;

        if bytes.len() > MAX_INLINE_IMAGE_BYTES {
            return Err(FeedErrorView {
                kind: "too_large",
                message: "That image is too large to display.".into(),
            });
        }
        // The same check the upload path makes. A bucket object is not
        // trusted just because we asked for it: an object that is really HTML
        // or SVG must never reach the page as an image.
        if !looks_like_an_image(&bytes) {
            return Err(FeedErrorView {
                kind: "not_an_image",
                message: "That file is not an image.".into(),
            });
        }

        Ok(data_url(sniff_mime(&bytes), &bytes))
    })
    .await
}

/// A `data:` URL from bytes already known to be an image.
pub(crate) fn data_url(mime: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// The content type from the bytes themselves, never from a supplied name.
pub(crate) fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        "image/png"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        // Same container as WebP above, different payload. The two are told
        // apart by the four bytes at 8, which is the only place they differ.
        "audio/wav"
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        // ISO base media: MP4 and everything wearing its box structure. The
        // brand at 8..12 is what says whether there are pictures in it -- the
        // M4A family is the same boxes carrying only sound, and calling one of
        // those a video gives the page a player with a black rectangle where
        // the picture would be.
        match &bytes[8..12] {
            b"M4A " | b"M4B " | b"M4P " => "audio/mp4",
            _ => "video/mp4",
        }
    } else if bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        // EBML, which in practice means WebM or Matroska. It carries sound on
        // its own too, but nothing in the header says so without parsing the
        // tracks, so it stays a video and the page gets a player either way.
        "video/webm"
    } else if bytes.starts_with(b"fLaC") {
        "audio/flac"
    } else if bytes.starts_with(b"OggS") {
        // Vorbis or Opus inside; both play, and which one is a matter for the
        // decoder rather than for this.
        "audio/ogg"
    } else if bytes.starts_with(b"ID3") || is_mp3_frame(bytes) {
        "audio/mpeg"
    } else {
        "application/octet-stream"
    }
}

/// Whether these bytes open with an MP3 frame header.
///
/// Only the four combinations a real encoder emits, rather than the loose
/// "eleven set bits" test. Loose is wrong here: this function decides what the
/// page is told a file is, and `FF Ex` matches plenty of things that are not
/// audio at all. An MP3 with no ID3 tag and an unusual bitrate falls through to
/// `application/octet-stream` and is offered as a file, which is a worse guess
/// but not a wrong claim.
fn is_mp3_frame(bytes: &[u8]) -> bool {
    matches!(bytes.first().copied(), Some(0xFF))
        && matches!(bytes.get(1).copied(), Some(0xFB | 0xFA | 0xF3 | 0xF2))
}

/// Whether these bytes are something the page may be handed to render.
///
/// The sender's declared type is not evidence -- this is decided from the bytes
/// -- and anything that is not a picture or a video is refused rather than
/// inlined. An HTML file arriving as an "image" is the case this exists for.
pub(crate) fn is_renderable(mime: &str) -> bool {
    mime.starts_with("image/") || mime.starts_with("video/")
}

/// Whether these bytes are something a *conversation* may hand to the page.
///
/// Wider than [`is_renderable`] by exactly one thing: sound. A conversation
/// carries whatever somebody sends, and a voice message that arrives as a file
/// row to be saved and opened elsewhere is a voice message the app failed to
/// play. A story is a picture or a video and nothing else, and a profile
/// picture is a picture, so both keep the narrower test -- widening one of
/// these by widening the other is how a rule stops meaning what it says.
pub(crate) fn is_playable(mime: &str) -> bool {
    is_renderable(mime) || mime.starts_with("audio/")
}

/// Whether these bytes begin like an image format the app accepts.
///
/// Not a full parse — it cannot prove the file is well-formed, and it is not
/// trying to. It refuses the specific thing that matters: a file that is
/// actually HTML, SVG, or a script, uploaded under an image's name, and later
/// served to somebody's browser.
fn looks_like_an_image(bytes: &[u8]) -> bool {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const GIF87: &[u8] = b"GIF87a";
    const GIF89: &[u8] = b"GIF89a";

    if bytes.starts_with(PNG) || bytes.starts_with(GIF87) || bytes.starts_with(GIF89) {
        return true;
    }
    // JPEG: SOI marker.
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true;
    }
    // WebP is RIFF with a WEBP fourcc four bytes later.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_image_headers_are_accepted() {
        assert!(looks_like_an_image(&[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0
        ]));
        assert!(looks_like_an_image(b"GIF89a...."));
        assert!(looks_like_an_image(b"GIF87a...."));
        assert!(looks_like_an_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]));
        assert!(looks_like_an_image(b"RIFF\0\0\0\0WEBPVP8 "));
    }

    #[test]
    fn markup_wearing_an_image_name_is_refused() {
        // The reason this check exists. These are served to other people's
        // browsers, and an HTML or SVG file named `.png` is stored XSS.
        for hostile in [
            &b"<html><script>alert(1)</script>"[..],
            &b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>"[..],
            &b"<!DOCTYPE html>"[..],
            &b"MZ\x90\x00"[..], // a Windows executable
            &b"#!/bin/sh"[..],
            &b""[..],
            &b"RIFF\0\0\0\0AVI "[..], // RIFF, but not WebP
        ] {
            assert!(
                !looks_like_an_image(hostile),
                "should be refused: {:?}",
                String::from_utf8_lossy(&hostile[..hostile.len().min(20)])
            );
        }
    }

    #[test]
    fn a_truncated_header_does_not_panic() {
        // Every prefix of every accepted header, to prove no slice indexes
        // past the end.
        for header in [
            &b"\x89PNG\r\n\x1a\n"[..],
            &b"RIFF\0\0\0\0WEBP"[..],
            &b"GIF89a"[..],
            &b"\xFF\xD8\xFF"[..],
        ] {
            for n in 0..header.len() {
                let _ = looks_like_an_image(&header[..n]);
            }
        }
    }

    #[test]
    fn the_image_ceiling_matches_the_brief() {
        // §6.3: a banner is at most 4 MB.
        const { assert!(MAX_IMAGE_BYTES == 4 * 1024 * 1024) };
    }

    #[test]
    fn sound_is_recognised_by_its_header() {
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WAVEfmt "), "audio/wav");
        assert_eq!(sniff_mime(b"fLaC\0\0\0\x22"), "audio/flac");
        assert_eq!(sniff_mime(b"OggS\0\x02\0\0"), "audio/ogg");
        assert_eq!(sniff_mime(b"ID3\x03\0\0\0"), "audio/mpeg");
        assert_eq!(sniff_mime(&[0xFF, 0xFB, 0x90, 0x00]), "audio/mpeg");
        assert_eq!(sniff_mime(b"\0\0\0\x20ftypM4A \0\0\0\0"), "audio/mp4");
    }

    #[test]
    fn a_header_that_is_exactly_twelve_bytes_still_counts() {
        // The guard says `>= 12` because the slice it protects is `8..12`.
        // With `> 12` a file that is exactly its own header fell through to
        // "unknown", which is a wrong answer rather than a cautious one --
        // and `looks_like_an_image` below had it right all along.
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBP"), "image/webp");
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WAVE"), "audio/wav");
    }

    #[test]
    fn the_two_riff_formats_are_told_apart() {
        // WebP and WAV share a container and differ in four bytes. Getting
        // this backwards hands the page a picture element full of sound.
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(sniff_mime(b"RIFF\0\0\0\0WAVEfmt "), "audio/wav");
        // Neither: an AVI is a video this cannot play, and guessing would be
        // worse than offering it as a file.
        assert_eq!(
            sniff_mime(b"RIFF\0\0\0\0AVI LIST"),
            "application/octet-stream"
        );
    }

    #[test]
    fn an_m4a_is_not_called_a_video() {
        // Same boxes as an MP4. Calling it one gives the page a player with a
        // black rectangle where the picture would be.
        assert_eq!(sniff_mime(b"\0\0\0\x20ftypM4A \0\0\0\0"), "audio/mp4");
        assert_eq!(sniff_mime(b"\0\0\0\x20ftypisom\0\0\0\0"), "video/mp4");
        assert_eq!(sniff_mime(b"\0\0\0\x20ftypmp42\0\0\0\0"), "video/mp4");
    }

    #[test]
    fn a_story_still_refuses_sound() {
        // The sniffer knowing about audio must not quietly widen what a story
        // or a profile picture may be. `is_renderable` is what those ask.
        assert!(!is_renderable("audio/wav"));
        assert!(!is_renderable("application/octet-stream"));
        assert!(is_renderable("image/png"));
        assert!(is_renderable("video/mp4"));
        // A conversation asks the wider question, and gets a different answer.
        assert!(is_playable("audio/wav"));
        assert!(is_playable("image/png"));
        assert!(!is_playable("application/octet-stream"));
    }

    #[test]
    fn a_truncated_sound_header_does_not_panic() {
        for header in [
            &b"RIFF\0\0\0\0WAVE"[..],
            &b"fLaC"[..],
            &b"OggS"[..],
            &b"ID3"[..],
            &b"\0\0\0\x20ftypM4A "[..],
            &[0xFF, 0xFB][..],
        ] {
            for n in 0..=header.len() {
                let _ = sniff_mime(&header[..n]);
            }
        }
    }
}
