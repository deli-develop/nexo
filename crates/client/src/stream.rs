//! The live socket.
//!
//! `apps/server/src/stream` has had a `/v1/stream` WebSocket since M4, relaying
//! typing, presence, receipts and envelope notices. **Nothing has ever
//! connected to it.** The client is request/response over `ureq`, and the
//! comment in `lib/conversations.ts` about the socket "changing how fast this
//! happens, not whether it works" was describing a socket that did not exist.
//! This is that socket.
//!
//! # It is still not the source of truth
//!
//! The server's own module says so, and this client keeps to it: every envelope
//! also lands in the database, every client keeps a cursor, and
//! `conversations::sync` repairs anything the socket missed. So a dropped
//! connection is not an error state to recover from — it is the ordinary case,
//! and the poll that was here before continues underneath. What the socket buys
//! is *promptness*, and it is allowed to fail at that.
//!
//! That is why nothing here retries aggressively or reports failure to the
//! user. A socket that cannot connect leaves an app that behaves exactly as it
//! did before this file existed.
//!
//! # Blocking, like the rest of this crate
//!
//! `tungstenite` rather than `tokio-tungstenite`: Argon2id and SQLCipher block
//! regardless, so a runtime would buy a function colour and no concurrency.
//! One thread owns the socket; the shell reads events off a channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nexo_protocol::{ClientEvent, ServerEvent};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, Utf8Bytes};

/// How long to wait before reconnecting, and how long that wait may grow to.
///
/// Backoff exists to be kind to a server that is down, not to be clever: the
/// poll underneath is already keeping the app correct, so there is nothing to
/// win by hammering. It resets on a connection that lasted, so a flaky network
/// does not slide into minute-long gaps after it recovers.
const RECONNECT_MIN: Duration = Duration::from_secs(2);
const RECONNECT_MAX: Duration = Duration::from_secs(60);

/// How often to send a ping when nothing else is going out.
///
/// Shorter than any idle timeout a proxy is likely to impose. A socket that a
/// middlebox silently dropped looks exactly like a quiet conversation, and this
/// is what tells the difference.
const PING_EVERY: Duration = Duration::from_secs(30);

/// A live connection to the server's stream, or the attempt at one.
///
/// Dropping this asks the thread to stop; it will not stop instantly, because
/// it may be blocked reading, and that is fine — it holds nothing that matters
/// and the socket closes when the process does either way.
pub struct Stream {
    events: Receiver<ServerEvent>,
    outgoing: Arc<Mutex<Option<Sender<ClientEvent>>>>,
    running: Arc<AtomicBool>,
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

impl Stream {
    /// Opens a connection and starts reading it on a thread.
    ///
    /// Returns immediately. Whether the socket ever connects is not reported:
    /// see the module comment — a socket that never connects leaves the app
    /// working as it did before.
    ///
    /// `token` is the access token, sent as an ordinary `Authorization` header.
    /// A browser could not do that on a WebSocket and would have to put the
    /// token in the URL, where it lands in every proxy log on the way; this is
    /// a Rust client, so it does not have to make that trade.
    #[must_use]
    pub fn connect(base_url: &str, token: &str) -> Self {
        let (event_tx, event_rx) = channel::<ServerEvent>();
        let outgoing: Arc<Mutex<Option<Sender<ClientEvent>>>> = Arc::new(Mutex::new(None));
        let running = Arc::new(AtomicBool::new(true));

        let url = socket_url(base_url);
        let token = token.to_string();
        let thread_outgoing = Arc::clone(&outgoing);
        let thread_running = Arc::clone(&running);

        std::thread::Builder::new()
            .name("nexo-stream".into())
            .spawn(move || {
                run(&url, &token, &event_tx, &thread_outgoing, &thread_running);
            })
            // A thread that could not be spawned leaves `outgoing` empty and
            // the receiver silent, which is the same state as a socket that
            // never connected -- already a supported case.
            .ok();

        Self {
            events: event_rx,
            outgoing,
            running,
        }
    }

    /// Events that have arrived since the last call. Never blocks.
    pub fn drain(&self) -> Vec<ServerEvent> {
        self.events.try_iter().collect()
    }

    /// Sends an event, if there is a connection to send it on.
    ///
    /// Returns whether it went. A `false` is not an error worth surfacing: the
    /// only thing sent this way is a typing notice, and a typing notice that
    /// did not arrive is invisible rather than wrong.
    pub fn send(&self, event: ClientEvent) -> bool {
        let guard = match self.outgoing.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        match guard.as_ref() {
            Some(sender) => sender.send(event).is_ok(),
            None => false,
        }
    }
}

/// `http://host` becomes `ws://host/v1/stream`, and `https` becomes `wss`.
///
/// Only the scheme is rewritten. A base URL that is already `ws` is left alone,
/// so a caller that knows what it wants is not second-guessed.
fn socket_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    let swapped = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    };
    format!("{swapped}/v1/stream")
}

/// Connects, reads until it fails, waits, and does it again.
fn run(
    url: &str,
    token: &str,
    events: &Sender<ServerEvent>,
    outgoing: &Arc<Mutex<Option<Sender<ClientEvent>>>>,
    running: &Arc<AtomicBool>,
) {
    let mut backoff = RECONNECT_MIN;

    while running.load(Ordering::Relaxed) {
        match session(url, token, events, outgoing, running) {
            // A session that ran for a while and then ended is a network
            // event, not a misconfiguration: start over from the short wait.
            SessionEnd::Lasted => backoff = RECONNECT_MIN,
            SessionEnd::Failed => {
                backoff = (backoff * 2).min(RECONNECT_MAX);
            }
            SessionEnd::Stopped => return,
        }

        // Slept in slices so a shutdown is noticed within a second rather than
        // after a minute of backoff.
        let mut left = backoff;
        while left > Duration::ZERO && running.load(Ordering::Relaxed) {
            let slice = left.min(Duration::from_secs(1));
            std::thread::sleep(slice);
            left -= slice;
        }
    }
}

enum SessionEnd {
    /// Connected and read for a while.
    Lasted,
    /// Never connected, or failed at once.
    Failed,
    /// Asked to stop.
    Stopped,
}

fn session(
    url: &str,
    token: &str,
    events: &Sender<ServerEvent>,
    outgoing: &Arc<Mutex<Option<Sender<ClientEvent>>>>,
    running: &Arc<AtomicBool>,
) -> SessionEnd {
    let Ok(mut request) = url.into_client_request() else {
        return SessionEnd::Failed;
    };
    let Ok(value) = format!("Bearer {token}").parse() else {
        return SessionEnd::Failed;
    };
    request.headers_mut().insert("authorization", value);

    let Ok((mut socket, _response)) = tungstenite::connect(request) else {
        return SessionEnd::Failed;
    };

    // Non-blocking reads, so one thread can both read the socket and drain the
    // outgoing queue without a second thread and a shared socket behind a lock.
    if let Some(stream) = tcp_stream(&socket)
        && stream
            .set_read_timeout(Some(Duration::from_millis(250)))
            .is_err()
    {
        return SessionEnd::Failed;
    }

    let (out_tx, out_rx) = channel::<ClientEvent>();
    if let Ok(mut slot) = outgoing.lock() {
        *slot = Some(out_tx);
    }

    let mut last_ping = std::time::Instant::now();
    let mut read_anything = false;

    loop {
        if !running.load(Ordering::Relaxed) {
            let _ = socket.close(None);
            return SessionEnd::Stopped;
        }

        // Anything the app wants to say. Drained first so a typing notice is
        // not held behind a read timeout.
        for event in out_rx.try_iter() {
            let Ok(json) = serde_json::to_string(&event) else {
                continue;
            };
            if socket.send(Message::Text(Utf8Bytes::from(json))).is_err() {
                return end(outgoing, read_anything);
            }
        }

        if last_ping.elapsed() >= PING_EVERY {
            last_ping = std::time::Instant::now();
            if socket.send(Message::Ping(Vec::new().into())).is_err() {
                return end(outgoing, read_anything);
            }
        }

        match socket.read() {
            Ok(Message::Text(text)) => {
                read_anything = true;
                // A frame this build cannot parse is skipped, not fatal: the
                // server may be newer, and `ServerEvent` is the kind of type
                // that grows. Dropping one event costs promptness, and the
                // sync underneath still has the message.
                if let Ok(event) = serde_json::from_str::<ServerEvent>(&text)
                    && events.send(event).is_err()
                {
                    // Nobody is listening any more: the Stream was dropped.
                    return end(outgoing, read_anything);
                }
            }
            Ok(Message::Close(_)) => return end(outgoing, read_anything),
            Ok(_) => read_anything = true,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                // The read timeout, which is how this loop gets to do anything
                // else. Not an error.
            }
            Err(_) => return end(outgoing, read_anything),
        }
    }
}

/// Clears the outgoing channel and reports how the session went.
fn end(outgoing: &Arc<Mutex<Option<Sender<ClientEvent>>>>, read_anything: bool) -> SessionEnd {
    if let Ok(mut slot) = outgoing.lock() {
        *slot = None;
    }
    if read_anything {
        SessionEnd::Lasted
    } else {
        SessionEnd::Failed
    }
}

/// The underlying TCP stream, plain or through TLS, for setting a read timeout.
///
/// Concrete rather than generic: `tungstenite::connect` returns exactly this
/// type, and a generic version would need a `'static` bound to look inside,
/// which buys nothing when there is one caller and one shape.
fn tcp_stream(
    socket: &tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>,
) -> Option<&std::net::TcpStream> {
    use tungstenite::stream::MaybeTlsStream;
    match socket.get_ref() {
        MaybeTlsStream::Plain(tcp) => Some(tcp),
        MaybeTlsStream::Rustls(tls) => Some(tls.get_ref()),
        // `MaybeTlsStream` is non-exhaustive: a build with another TLS backend
        // simply does not get a read timeout, and the loop below still works --
        // it just blocks until a frame arrives instead of ticking.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_becomes_a_socket_url() {
        assert_eq!(
            socket_url("http://127.0.0.1:8080"),
            "ws://127.0.0.1:8080/v1/stream"
        );
        assert_eq!(
            socket_url("https://api.delidev.net"),
            "wss://api.delidev.net/v1/stream"
        );
    }

    #[test]
    fn a_trailing_slash_does_not_double_up() {
        assert_eq!(
            socket_url("https://api.delidev.net/"),
            "wss://api.delidev.net/v1/stream"
        );
    }

    #[test]
    fn a_socket_url_is_left_as_it_was() {
        // A caller that already knows the scheme it wants is not corrected.
        assert_eq!(
            socket_url("wss://api.delidev.net"),
            "wss://api.delidev.net/v1/stream"
        );
    }

    #[test]
    fn sending_without_a_connection_says_so_rather_than_failing() {
        // The state the app is in whenever the socket is down, which is a state
        // it has to keep working in: a typing notice that did not go is
        // invisible, not wrong.
        let stream = Stream {
            events: channel().1,
            outgoing: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(true)),
        };
        assert!(!stream.send(ClientEvent::Ping));
        assert!(stream.drain().is_empty());
    }
}
