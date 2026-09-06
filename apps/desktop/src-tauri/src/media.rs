//! Serving decrypted media to the WebView, one range at a time.
//!
//! # Why a URI scheme rather than another IPC command
//!
//! A `<video>` element does not ask a command for bytes; it asks a URL, and it
//! asks for *ranges* of one — that is what seeking is. The old path handed it a
//! `data:` URL, which means the entire file has to be fetched, decrypted, and
//! base64'd into the page before the first frame appears. For a 12 MB clip that
//! is a pause; for anything larger it was simply refused
//! (`MAX_INLINE_IMAGE_BYTES`).
//!
//! This module answers those range requests instead. A request for bytes
//! 4 MB–5 MB turns into two or three segment fetches and decryptions, and
//! nothing else moves. That is what `encrypt_segmented` was for.
//!
//! # What crosses the boundary
//!
//! Plaintext bytes, and only the ones asked for. No key, no nonce, no S3 key
//! (rule 2) — the URL names an envelope id, which is the same handle the page
//! already uses to ask for an attachment to be saved. A page that constructs a
//! URL for an envelope it cannot otherwise see learns nothing it could not
//! learn by asking to save it.
//!
//! # Failing closed
//!
//! Every segment is authenticated with its own index and the total count, so a
//! reordered or truncated stream fails to decrypt rather than producing short
//! or shuffled bytes. This module turns that into a 404 with no body: a player
//! that gets no bytes stops, which is the honest outcome. There is no partial
//! rendering of a stream that did not authenticate (rule 7).

use nexo_client::conversations;
use tauri::http;
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

use crate::client::ClientState;

/// The scheme the page points a player at.
///
/// Tauri serves this as `http://nexo-media.localhost/<envelope id>` on Windows,
/// which is why `tauri.conf.json` names that host in `media-src` rather than
/// the bare scheme.
pub const SCHEME: &str = "nexo-media";

/// Registers the handler on the builder.
///
/// Asynchronous rather than the blocking variant on purpose: the work behind
/// one range is a network fetch and a decryption, and doing that on the thread
/// the WebView is waiting on would stall the whole page — including the parts
/// of it that are not this video.
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(
        SCHEME,
        move |ctx: UriSchemeContext<'_, R>, request, responder: UriSchemeResponder| {
            let app = ctx.app_handle().clone();
            let uri = request.uri().to_string();
            let range = request
                .headers()
                .get("Range")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);

            // Off the WebView's thread. `spawn_blocking` because everything
            // below it is the blocking client: ureq, SQLCipher, AES.
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(serve(&app, &uri, range.as_deref()));
            });
        },
    )
}

/// Builds one response, whole or partial.
fn serve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    uri: &str,
    range: Option<&str>,
) -> http::Response<Vec<u8>> {
    let Some(envelope_id) = envelope_id_from(uri) else {
        return refuse(400);
    };

    let state = app.state::<ClientState>();

    // Everything the lock is needed for, taken in one short pass.
    //
    // A range request is a download, and a playing video makes one every few
    // seconds. Holding the client lock across them made the whole app stutter
    // for as long as something was playing, because that lock is also the
    // store's and the MLS provider's. The payload and a handle on the shared
    // transport are all this needs; both are cheap to take and the rest of the
    // work happens with the lock released.
    let taken = {
        let Ok(guard) = state.0.lock() else {
            return refuse(500);
        };
        let Some(client) = guard.as_ref() else {
            // Signed out, or locked. Not an error worth a body: the page is
            // about to be told the same thing by every other call it makes.
            return refuse(404);
        };
        let payload = conversations::attachment_payload(&client.store, envelope_id).ok();
        let info = conversations::stream_info(&client.context(), envelope_id)
            .ok()
            .flatten();
        (client.transport.clone(), payload, info)
    };
    let (transport, payload, info) = taken;
    let Some(payload) = payload else {
        return refuse(404);
    };

    // Not every video is a stream, and the ones that are not still have to
    // play.
    //
    // `stream_info` answers only for the segmented encoding. Everything sealed
    // whole -- which is every attachment sent before `encrypt_segmented`
    // existed, because `Payload::Attachment::segmented` defaults to false so
    // older messages stay byte-identical -- came back `None` here and turned
    // into a 404. Meanwhile `lib/media.ts` picks the player from the declared
    // MIME alone, so a `video/*` attachment got a `<video>` pointed at this
    // scheme whatever its encoding: the element asked, was refused, and drew a
    // dead player at 0:00. Nothing in the page could see why.
    //
    // So fall back to the whole file. It is fetched and decrypted in one go --
    // that is what sealing it whole means, and there is no way to open a range
    // of it -- but the ranges a player asks for are still answered out of the
    // buffer, so seeking works and the element behaves the same either way.
    let Some(info) = info else {
        return serve_whole(&state, &transport, &payload, range);
    };

    let segment_len = nexo_crypto::attachment::SEGMENT_LEN as u64;
    let (from, to) = match range.and_then(|r| parse_range(r, info.size)) {
        Some(pair) => pair,
        // No `Range`, or one that made no sense against a file this size. A
        // player opening a source sends no range on its first request, and the
        // honest answer is the whole file rather than an error.
        None => (0, info.size.saturating_sub(1)),
    };

    let first = from / segment_len;
    let last = to / segment_len;
    let mut body = Vec::with_capacity((to - from + 1) as usize);
    for index in first..=last {
        let Ok(segment) = conversations::attachment_segment_with(&*transport, &payload, index)
        else {
            // Authentication failed, or the fetch did. Either way the stream is
            // not trustworthy and nothing partial is served (rule 7).
            return refuse(404);
        };
        // Where this segment sits in the plaintext, clipped to what was asked.
        let base = index * segment_len;
        let start = from.saturating_sub(base).min(segment.len() as u64) as usize;
        let stop = (to.saturating_sub(base) + 1).min(segment.len() as u64) as usize;
        body.extend_from_slice(segment.get(start..stop).unwrap_or_default());
    }

    // The same duty `with_client` carries, for the same reason: a fetch above
    // may have traded the refresh token for a new pair, and a spent one replayed
    // at the next launch is what the server reads as theft -- it revokes every
    // session for the account. A range request is an ordinary authenticated
    // call and is no exception.
    persist_rotated(&state, &transport);

    let partial = range.is_some();
    let mut response = http::Response::builder()
        .status(if partial { 206 } else { 200 })
        .header("Content-Type", playable_type(&info.mime))
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len().to_string())
        // Nothing here is cacheable by anything that outlives the window: the
        // bytes are plaintext of an encrypted file.
        .header("Cache-Control", "no-store");
    if partial {
        response = response.header("Content-Range", format!("bytes {from}-{to}/{}", info.size));
    }
    response.body(body).unwrap_or_else(|_| refuse(500))
}

/// Serves an attachment that was sealed whole, answering ranges from memory.
///
/// The counterpart to the segmented path above, and the reason a video sent
/// before segmented encoding existed still plays. The whole file is opened --
/// a file sealed under one tag cannot be opened in parts, which is the point
/// of the two encodings -- and the range the player asked for is cut out of
/// the result.
///
/// The type is sniffed from the bytes rather than trusted from the sender, the
/// same rule the rest of this process follows: what the page may be handed is
/// decided here, not by a MIME string somebody else wrote.
fn serve_whole(
    state: &ClientState,
    transport: &nexo_client::HttpTransport,
    payload: &nexo_protocol::Payload,
    range: Option<&str>,
) -> http::Response<Vec<u8>> {
    let Ok(contents) = conversations::fetch_attachment_with(transport, payload) else {
        return refuse(404);
    };

    let mime = crate::feed::sniff_mime(&contents);
    if !crate::feed::is_playable(mime) {
        return refuse(404);
    }

    persist_rotated(state, transport);

    let size = contents.len() as u64;
    let (from, to) = match range.and_then(|r| parse_range(r, size)) {
        Some(pair) => pair,
        None => (0, size.saturating_sub(1)),
    };
    let body = contents
        .get(from as usize..=(to as usize).min(contents.len().saturating_sub(1)))
        .unwrap_or_default()
        .to_vec();

    let partial = range.is_some();
    let mut response = http::Response::builder()
        .status(if partial { 206 } else { 200 })
        .header("Content-Type", playable_type(mime))
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body.len().to_string())
        .header("Cache-Control", "no-store");
    if partial {
        response = response.header("Content-Range", format!("bytes {from}-{to}/{size}"));
    }
    response.body(body).unwrap_or_else(|_| refuse(500))
}

/// Writes down a refresh token the transport rotated mid-call.
///
/// The duty every authenticated call carries: a rotated token that never
/// reaches the store means the next launch replays a spent one, which the
/// server reads as theft and answers by revoking every session for the
/// account. Takes the client lock for the length of one row write, which is
/// why the download above does not hold it.
fn persist_rotated(state: &ClientState, transport: &nexo_client::HttpTransport) {
    let Some(rotated) = transport.take_rotated_refresh_token() else {
        return;
    };
    let Ok(guard) = state.0.lock() else { return };
    let Some(client) = guard.as_ref() else { return };
    if let Err(error) = client.store.set_refresh_token(&rotated) {
        tracing::error!(%error, "could not persist a refresh token rotated while streaming");
    }
}

/// The envelope id out of `.../<id>`.
///
/// Anything else is refused rather than guessed at. The page builds these URLs
/// itself, so a malformed one is a bug in it, not something to recover from.
fn envelope_id_from(uri: &str) -> Option<i64> {
    let path = uri.split('?').next().unwrap_or(uri);
    path.rsplit('/').next()?.parse::<i64>().ok()
}

/// Parses a single `bytes=` range against a known length.
///
/// Only the forms a media element actually sends: `bytes=N-`, `bytes=N-M`, and
/// the suffix form `bytes=-N`. Multi-range requests are not answered — no
/// player needs them for playback, and a partial implementation of one is worse
/// than not offering it.
fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?.trim();
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let last = size - 1;

    let (from, to) = if start.is_empty() {
        // `bytes=-N`: the final N bytes.
        let n: u64 = end.parse().ok()?;
        if n == 0 {
            return None;
        }
        (size.saturating_sub(n), last)
    } else {
        let from: u64 = start.parse().ok()?;
        let to = if end.is_empty() {
            last
        } else {
            end.parse::<u64>().ok()?.min(last)
        };
        (from, to)
    };

    if from > to || from > last {
        return None;
    }
    Some((from, to))
}

/// The type this response is served as.
///
/// From the sender's declared MIME only when it is one a player should be
/// handed; anything else becomes a type that renders as nothing. The bytes
/// themselves are not sniffed here because only the first segment would be
/// available to sniff, and a range request in the middle of a file has no
/// header to look at.
fn playable_type(mime: &str) -> &'static str {
    match mime {
        "video/mp4" => "video/mp4",
        "video/webm" => "video/webm",
        "video/quicktime" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

/// A refusal with no body.
fn refuse(status: u16) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Length", "0")
        .body(Vec::new())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_open_ended_range_runs_to_the_end() {
        assert_eq!(parse_range("bytes=0-", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
    }

    #[test]
    fn a_closed_range_is_taken_as_given() {
        assert_eq!(parse_range("bytes=10-19", 1000), Some((10, 19)));
    }

    #[test]
    fn a_range_past_the_end_is_clamped_not_refused() {
        // Players routinely ask for more than exists at the tail of a file.
        assert_eq!(parse_range("bytes=990-2000", 1000), Some((990, 999)));
    }

    #[test]
    fn a_suffix_range_counts_back_from_the_end() {
        // How a player finds an MP4 index that sits at the end of the file.
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        // Longer than the file: the whole file, not an error.
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
    }

    #[test]
    fn a_start_past_the_end_is_refused() {
        assert_eq!(parse_range("bytes=1000-1100", 1000), None);
    }

    #[test]
    fn a_backwards_range_is_refused() {
        assert_eq!(parse_range("bytes=500-100", 1000), None);
    }

    #[test]
    fn multi_ranges_are_refused_rather_than_half_answered() {
        assert_eq!(parse_range("bytes=0-99,200-299", 1000), None);
    }

    #[test]
    fn nonsense_is_refused() {
        assert_eq!(parse_range("bytes=abc-def", 1000), None);
        assert_eq!(parse_range("items=0-10", 1000), None);
        assert_eq!(parse_range("bytes=", 1000), None);
        assert_eq!(parse_range("bytes=0-0", 0), None);
    }

    #[test]
    fn an_envelope_id_is_read_off_the_path() {
        assert_eq!(envelope_id_from("http://nexo-media.localhost/42"), Some(42));
        assert_eq!(
            envelope_id_from("http://nexo-media.localhost/42?t=1"),
            Some(42)
        );
        assert_eq!(envelope_id_from("http://nexo-media.localhost/"), None);
        assert_eq!(envelope_id_from("http://nexo-media.localhost/abc"), None);
    }

    #[test]
    fn only_playable_types_are_served_as_themselves() {
        assert_eq!(playable_type("video/mp4"), "video/mp4");
        // Anything a player should not be handed renders as nothing rather
        // than being served under a type the page might act on.
        assert_eq!(playable_type("text/html"), "application/octet-stream");
        assert_eq!(playable_type("image/svg+xml"), "application/octet-stream");
    }
}
