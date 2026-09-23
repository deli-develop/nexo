//! The relay: an HTTP `CONNECT` proxy that forwards to Nexo and nowhere else.
//!
//! `docs/RELAY.md` is the design and `docs/STATUS.md` says how much of it is
//! built. This is the volunteer's half; a blocked user's WebView is pointed at
//! it as its proxy.
//!
//! # What it sees
//!
//! The WebView asks `CONNECT api.delidev.net:443`. The relay dials that host,
//! answers `200`, and copies bytes both ways. TLS runs end to end between the
//! WebView and the server, so the relay sees a host name, a port and a byte
//! count — never a token, a request or a message. Rule 4 holds on the
//! volunteer's machine as it does on the server.
//!
//! It logs no client address. The people using a relay are the ones a log
//! would put at risk.
//!
//! # What it refuses
//!
//! - **Every host but Nexo's.** [`NEXO_HOSTS`] is the CSP's `connect-src`, and
//!   a test holds the two lists together: a host the page may reach but the
//!   relay refuses works at home and fails for exactly the people this is for.
//!   Anything else is `403` and nothing is dialled. Without that, the
//!   volunteer's address would be an open proxy, and whatever went through it
//!   would look like theirs.
//! - **Every method but `CONNECT`.** A relay that fetched URLs itself would see
//!   what it fetched.
//! - **A request head that is slow or large**: [`HEAD_TIMEOUT`], [`HEAD_LIMIT`].
//! - **More than [`MAX_TUNNELS`] at once**, with `503`. A volunteer's machine is
//!   somebody's computer, not a server.
//!
//! # Being reachable
//!
//! It listens on every interface, IPv6 and IPv4, on one port, because a relay
//! only this machine can reach is not one. Behind a home router that is still
//! not enough: the volunteer forwards the port, or hands out an IPv6 address
//! the router lets through. The outbound-only shape `RELAY.md` prefers needs a
//! broker that has not been decided on.
//!
//! # Lifetime
//!
//! [`Relay`] is managed from startup and holds at most one running relay. Each
//! listener's tunnels are tasks in a [`JoinSet`] owned by its accept loop, so
//! aborting the loops drops the sets and the sets abort every tunnel: stopping
//! ends forwarding, not only accepting.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::timeout;

/// Where a relay may forward: every host in the CSP's `connect-src` in
/// `tauri.conf.json`. `https` and `wss` are both 443.
const NEXO_HOSTS: &[(&str, u16)] = &[
    ("api.delidev.net", 443),
    ("fsn1.your-objectstorage.com", 443),
];

/// Every interface, IPv6 first: where a socket on `::` is dual-stack, it
/// already covers IPv4 and the second bind is refused, which is fine.
const EVERY_INTERFACE: &[IpAddr] = &[
    IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    IpAddr::V4(Ipv4Addr::UNSPECIFIED),
];

/// A `CONNECT` head is one line and a `Host:`. This is generous.
const HEAD_LIMIT: usize = 8 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// A WebView keeps a handful of tunnels per person: the API, the live socket,
/// the bucket. This is room for a few dozen people, and a ceiling on handles.
const MAX_TUNNELS: usize = 128;

/// What the page is told about a running relay.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    /// The port, on every interface. Which address to hand out is the
    /// volunteer's to know: behind a router this machine cannot see it.
    pub port: u16,
}

/// At most one running relay. `None` inside means stopped.
pub struct Relay {
    interfaces: &'static [IpAddr],
    rules: Arc<Rules>,
    running: Mutex<Option<Running>>,
}

struct Rules {
    allowed: Vec<(String, u16)>,
    tunnels: Arc<Semaphore>,
}

struct Running {
    port: u16,
    accept_loops: Vec<JoinHandle<()>>,
}

impl Default for Relay {
    fn default() -> Self {
        Self::new(EVERY_INTERFACE, NEXO_HOSTS, MAX_TUNNELS)
    }
}

impl Relay {
    fn new(interfaces: &'static [IpAddr], allowed: &[(&str, u16)], max_tunnels: usize) -> Self {
        Self {
            interfaces,
            rules: Arc::new(Rules {
                allowed: allowed
                    .iter()
                    .map(|&(host, port)| (host.to_ascii_lowercase(), port))
                    .collect(),
                tunnels: Arc::new(Semaphore::new(max_tunnels)),
            }),
            running: Mutex::new(None),
        }
    }

    /// The running relay, or a new one on `port`; `0` picks a free one.
    ///
    /// Binds before answering, so a taken port is an error here rather than a
    /// log line after a success, and the port answered is the one bound.
    pub async fn start(&self, port: u16) -> Result<RelayInfo, String> {
        if let Some(info) = self.status() {
            return Ok(info);
        }
        let (port, listeners) = bind(self.interfaces, port).await?;
        let accept_loops: Vec<_> = listeners
            .into_iter()
            .map(|listener| tauri::async_runtime::spawn(accept_loop(listener, self.rules.clone())))
            .collect();

        let mut running = self.lock();
        // Two starts can both get past the check above. The first one here
        // wins; the other's listeners close with their loops.
        if let Some(winner) = running.as_ref() {
            accept_loops.iter().for_each(JoinHandle::abort);
            return Ok(RelayInfo { port: winner.port });
        }
        *running = Some(Running { port, accept_loops });
        tracing::info!(port, "relay started");
        Ok(RelayInfo { port })
    }

    /// Closes the listeners and every tunnel through them. `false` when none
    /// was running.
    pub fn stop(&self) -> bool {
        let Some(running) = self.lock().take() else {
            return false;
        };
        running.accept_loops.iter().for_each(JoinHandle::abort);
        tracing::info!(port = running.port, "relay stopped");
        true
    }

    pub fn status(&self) -> Option<RelayInfo> {
        self.lock()
            .as_ref()
            .map(|running| RelayInfo { port: running.port })
    }

    /// Nothing is written under this lock that a panic could leave half done,
    /// so a poisoned one is still a good one.
    fn lock(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// One port on every interface given. The first bind picks the port when asked
/// for `0`, and the rest follow it. An interface that refuses — no IPv6, or a
/// dual-stack socket already covering IPv4 — is skipped, as long as one works.
async fn bind(interfaces: &[IpAddr], mut port: u16) -> Result<(u16, Vec<TcpListener>), String> {
    let mut listeners = Vec::new();
    let mut refused = None;
    for &ip in interfaces {
        match TcpListener::bind((ip, port)).await {
            Ok(listener) => {
                port = listener
                    .local_addr()
                    .map_err(|e| format!("Could not read the relay's address: {e}"))?
                    .port();
                listeners.push(listener);
            }
            Err(e) => {
                refused.get_or_insert(e);
            }
        }
    }
    match refused {
        Some(e) if listeners.is_empty() => {
            Err(format!("Could not open the relay on port {port}: {e}"))
        }
        _ => Ok((port, listeners)),
    }
}

/// Accepts until aborted, and owns every tunnel it starts.
async fn accept_loop(listener: TcpListener, rules: Arc<Rules>) {
    let mut tunnels = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((client, _)) => {
                    let rules = rules.clone();
                    tunnels.spawn(async move {
                        if let Err(e) = tunnel(client, &rules).await {
                            tracing::debug!(%e, "relay tunnel ended");
                        }
                    });
                }
                // Usually the process out of handles. Pausing keeps that
                // from turning into a busy loop.
                Err(e) => {
                    tracing::warn!(%e, "relay accept failed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            // Reap finished tunnels, or the set only ever grows.
            Some(_) = tunnels.join_next(), if !tunnels.is_empty() => {}
        }
    }
}

/// Why a request was not tunnelled. Each is answered, then the connection
/// closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    BadRequest,
    Forbidden,
    MethodNotAllowed,
    Timeout,
    BadGateway,
    Busy,
}

impl Refusal {
    fn status(self) -> &'static str {
        match self {
            Self::BadRequest => "400 Bad Request",
            Self::Forbidden => "403 Forbidden",
            Self::MethodNotAllowed => "405 Method Not Allowed",
            Self::Timeout => "408 Request Timeout",
            Self::BadGateway => "502 Bad Gateway",
            Self::Busy => "503 Service Unavailable",
        }
    }
}

/// One connection: read the `CONNECT`, check it, dial, answer `200`, and copy
/// both ways until either side closes.
async fn tunnel(mut client: TcpStream, rules: &Rules) -> io::Result<()> {
    let Ok(_permit) = rules.tunnels.clone().try_acquire_owned() else {
        return refuse(&mut client, Refusal::Busy).await;
    };
    let (buf, end) = match timeout(HEAD_TIMEOUT, read_head(&mut client)).await {
        Ok(Ok(Some(head))) => head,
        Ok(Ok(None)) => return refuse(&mut client, Refusal::BadRequest).await,
        Ok(Err(e)) => return Err(e),
        Err(_) => return refuse(&mut client, Refusal::Timeout).await,
    };
    let (host, port) = match parse_connect(&buf[..end]) {
        Ok(target) => target,
        Err(why) => return refuse(&mut client, why).await,
    };
    if !rules.allowed.iter().any(|(h, p)| *h == host && *p == port) {
        return refuse(&mut client, Refusal::Forbidden).await;
    }
    let mut server = match timeout(DIAL_TIMEOUT, TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(server)) => server,
        _ => return refuse(&mut client, Refusal::BadGateway).await,
    };
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await?;
    // Whatever arrived behind the head is the start of the tunnel.
    server.write_all(&buf[end..]).await?;
    tokio::io::copy_bidirectional(&mut client, &mut server).await?;
    Ok(())
}

/// Reads up to and including the blank line that ends a request head, and
/// answers the buffer with where the head ends — anything after it is tunnel.
/// `None` when the head outgrows [`HEAD_LIMIT`] or the client closes first.
async fn read_head(client: &mut TcpStream) -> io::Result<Option<(Vec<u8>, usize)>> {
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 1024];
    loop {
        let n = client.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        // The terminator can straddle two reads.
        let from = buf.len().saturating_sub(3);
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf[from..].windows(4).position(|w| w == b"\r\n\r\n") {
            return Ok(Some((buf, from + at + 4)));
        }
        if buf.len() > HEAD_LIMIT {
            return Ok(None);
        }
    }
}

/// `CONNECT host:port HTTP/1.x` to a lowercase host and a port. The headers
/// after the request line are not needed and not read.
fn parse_connect(head: &[u8]) -> Result<(String, u16), Refusal> {
    let head = std::str::from_utf8(head).map_err(|_| Refusal::BadRequest)?;
    let line = head.lines().next().ok_or(Refusal::BadRequest)?;
    let mut parts = line.split(' ');
    let (Some(method), Some(authority), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Refusal::BadRequest);
    };
    if !version.starts_with("HTTP/1.") {
        return Err(Refusal::BadRequest);
    }
    if method != "CONNECT" {
        return Err(Refusal::MethodNotAllowed);
    }
    let (host, port) = authority.rsplit_once(':').ok_or(Refusal::BadRequest)?;
    let port = port.parse().map_err(|_| Refusal::BadRequest)?;
    Ok((host.to_ascii_lowercase(), port))
}

async fn refuse(client: &mut TcpStream, why: Refusal) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        why.status()
    );
    client.write_all(response.as_bytes()).await?;
    client.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::time::Instant;

    const LOOPBACK: &[IpAddr] = &[IpAddr::V4(Ipv4Addr::LOCALHOST)];

    /// Everything on Tauri's runtime, like the commands: a socket belongs to
    /// the runtime that opened it.
    fn run<F: std::future::Future>(test: F) -> F::Output {
        tauri::async_runtime::block_on(test)
    }

    /// Loopback only, so running the tests asks the firewall for nothing.
    fn relay_to(allowed: SocketAddr, max_tunnels: usize) -> Relay {
        Relay::new(LOOPBACK, &[("127.0.0.1", allowed.port())], max_tunnels)
    }

    /// A server that answers every connection with what it was sent.
    async fn echo_server() -> SocketAddr {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tauri::async_runtime::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tauri::async_runtime::spawn(async move {
                    let (mut rd, mut wr) = stream.split();
                    let _ = tokio::io::copy(&mut rd, &mut wr).await;
                });
            }
        });
        addr
    }

    /// Sends `request` to the relay and answers the connection, the status
    /// line it got back, and whatever arrived behind the head in the same read.
    async fn ask(relay_port: u16, request: &[u8]) -> (TcpStream, String, Vec<u8>) {
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, relay_port))
            .await
            .unwrap();
        client.write_all(request).await.unwrap();
        let (buf, end) = read_head(&mut client).await.unwrap().expect("no answer");
        let head = String::from_utf8(buf[..end].to_vec()).unwrap();
        (
            client,
            head.lines().next().unwrap().to_owned(),
            buf[end..].to_vec(),
        )
    }

    fn connect_to(target: SocketAddr) -> Vec<u8> {
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").into_bytes()
    }

    #[test]
    fn the_page_reads_the_port_as_camel_case() {
        assert_eq!(
            serde_json::to_value(RelayInfo { port: 41731 }).unwrap(),
            serde_json::json!({ "port": 41731 }),
        );
    }

    #[test]
    fn the_relay_forwards_to_exactly_the_hosts_the_csp_allows() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = conf["app"]["security"]["csp"].as_str().unwrap();
        let connect_src = csp
            .split(';')
            .map(str::trim)
            .find_map(|directive| directive.strip_prefix("connect-src "))
            .unwrap();
        let mut from_csp: Vec<&str> = connect_src
            .split_whitespace()
            .filter_map(|source| {
                source
                    .strip_prefix("https://")
                    .or_else(|| source.strip_prefix("wss://"))
            })
            .filter(|host| !host.ends_with(".localhost"))
            .collect();
        from_csp.sort_unstable();
        from_csp.dedup();

        let mut relayed: Vec<&str> = NEXO_HOSTS.iter().map(|&(host, _)| host).collect();
        relayed.sort_unstable();
        assert_eq!(relayed, from_csp);
        assert!(NEXO_HOSTS.iter().all(|&(_, port)| port == 443));
    }

    #[test]
    fn a_connect_line_is_read_and_anything_else_is_refused() {
        assert_eq!(
            parse_connect(b"CONNECT API.delidev.net:443 HTTP/1.1\r\nHost: x\r\n\r\n"),
            Ok(("api.delidev.net".to_owned(), 443)),
        );
        assert_eq!(
            parse_connect(b"GET http://api.delidev.net/ HTTP/1.1\r\n\r\n"),
            Err(Refusal::MethodNotAllowed),
        );
        for garbage in [
            &b"hello\r\n\r\n"[..],
            b"CONNECT api.delidev.net HTTP/1.1\r\n\r\n",
            b"CONNECT api.delidev.net:https HTTP/1.1\r\n\r\n",
            b"CONNECT api.delidev.net:443 SPDY/3\r\n\r\n",
            b"CONNECT  api.delidev.net:443 HTTP/1.1\r\n\r\n",
            b"\xff\xfe\r\n\r\n",
        ] {
            assert_eq!(
                parse_connect(garbage),
                Err(Refusal::BadRequest),
                "{garbage:?}"
            );
        }
    }

    #[test]
    fn port_zero_answers_the_port_it_was_given() {
        run(async {
            let relay = relay_to(echo_server().await, 8);
            let info = relay.start(0).await.unwrap();
            assert_ne!(info.port, 0);
            assert_eq!(relay.status(), Some(info));
            relay.stop();
        });
    }

    #[test]
    fn starting_twice_answers_the_same_relay() {
        run(async {
            let relay = relay_to(echo_server().await, 8);
            let first = relay.start(0).await.unwrap();
            assert_eq!(relay.start(0).await.unwrap(), first);
            relay.stop();
        });
    }

    #[test]
    fn a_taken_port_is_an_error_not_a_success() {
        run(async {
            let squatter = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let relay = relay_to(echo_server().await, 8);
            assert!(
                relay
                    .start(squatter.local_addr().unwrap().port())
                    .await
                    .is_err()
            );
            assert_eq!(relay.status(), None);
        });
    }

    #[test]
    fn an_allowed_host_is_tunnelled_both_ways() {
        run(async {
            let server = echo_server().await;
            let relay = relay_to(server, 8);
            let port = relay.start(0).await.unwrap().port;

            let (mut client, status, _) = ask(port, &connect_to(server)).await;
            assert_eq!(status, "HTTP/1.1 200 Connection Established");
            client.write_all(b"opaque bytes").await.unwrap();
            let mut back = [0u8; 12];
            client.read_exact(&mut back).await.unwrap();
            assert_eq!(&back, b"opaque bytes");
            relay.stop();
        });
    }

    #[test]
    fn bytes_sent_behind_the_head_are_not_lost() {
        run(async {
            let server = echo_server().await;
            let relay = relay_to(server, 8);
            let port = relay.start(0).await.unwrap().port;

            let mut request = connect_to(server);
            request.extend_from_slice(b"early");
            let (mut client, status, mut back) = ask(port, &request).await;
            assert!(status.contains("200"), "{status}");
            while back.len() < 5 {
                let mut more = [0u8; 5];
                let n = client.read(&mut more).await.unwrap();
                assert_ne!(n, 0, "the tunnel closed before the echo");
                back.extend_from_slice(&more[..n]);
            }
            assert_eq!(back, b"early");
            relay.stop();
        });
    }

    #[test]
    fn any_other_host_is_refused_without_being_dialled() {
        run(async {
            let relay = relay_to(echo_server().await, 8);
            let port = relay.start(0).await.unwrap().port;
            let bystander = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();

            let (_, status, _) = ask(port, &connect_to(bystander.local_addr().unwrap())).await;
            assert_eq!(status, "HTTP/1.1 403 Forbidden");
            let (_, status, _) = ask(port, b"CONNECT example.com:443 HTTP/1.1\r\n\r\n").await;
            assert_eq!(status, "HTTP/1.1 403 Forbidden");
            assert!(
                timeout(Duration::from_millis(300), bystander.accept())
                    .await
                    .is_err(),
                "a refused host was dialled anyway",
            );
            relay.stop();
        });
    }

    #[test]
    fn a_plain_request_is_not_fetched() {
        run(async {
            let server = echo_server().await;
            let relay = relay_to(server, 8);
            let port = relay.start(0).await.unwrap().port;
            let request = format!("GET http://{server}/ HTTP/1.1\r\nHost: {server}\r\n\r\n");
            let (_, status, _) = ask(port, request.as_bytes()).await;
            assert_eq!(status, "HTTP/1.1 405 Method Not Allowed");
            relay.stop();
        });
    }

    #[test]
    fn an_oversized_head_is_refused() {
        run(async {
            let relay = relay_to(echo_server().await, 8);
            let port = relay.start(0).await.unwrap().port;
            // Exactly one byte over, so the relay has read all of it before it
            // answers: closing with input unread is a reset, and a reset can
            // overtake the answer.
            let (_, status, _) = ask(port, &vec![b'a'; HEAD_LIMIT + 1]).await;
            assert_eq!(status, "HTTP/1.1 400 Bad Request");
            relay.stop();
        });
    }

    #[test]
    fn an_allowed_host_that_does_not_answer_is_a_bad_gateway() {
        run(async {
            let gone = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .unwrap()
                .local_addr()
                .unwrap();
            let relay = relay_to(gone, 8);
            let port = relay.start(0).await.unwrap().port;
            let (_, status, _) = ask(port, &connect_to(gone)).await;
            assert_eq!(status, "HTTP/1.1 502 Bad Gateway");
            relay.stop();
        });
    }

    #[test]
    fn past_the_ceiling_a_tunnel_is_refused_as_busy() {
        run(async {
            let server = echo_server().await;
            let relay = relay_to(server, 1);
            let port = relay.start(0).await.unwrap().port;
            let (_held, status, _) = ask(port, &connect_to(server)).await;
            assert!(status.contains("200"), "{status}");
            let (_, status, _) = ask(port, &connect_to(server)).await;
            assert_eq!(status, "HTTP/1.1 503 Service Unavailable");
            relay.stop();
        });
    }

    #[test]
    fn stopping_closes_the_listener_and_every_tunnel() {
        run(async {
            let server = echo_server().await;
            let relay = relay_to(server, 8);
            let port = relay.start(0).await.unwrap().port;
            let (mut client, status, _) = ask(port, &connect_to(server)).await;
            assert!(status.contains("200"), "{status}");

            assert!(relay.stop());
            assert_eq!(relay.status(), None);
            assert!(!relay.stop(), "a second stop has nothing to stop");

            // The tunnel ends: EOF or a reset, not a hang.
            let read = timeout(Duration::from_secs(5), client.read(&mut [0u8; 1]))
                .await
                .expect("the tunnel outlived the relay");
            assert!(matches!(read, Ok(0) | Err(_)));

            // And the port stops answering. The abort lands asynchronously,
            // and a refused connect on Windows loopback takes a while, so
            // this waits rather than asserting at once.
            let deadline = Instant::now() + Duration::from_secs(10);
            while TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .is_ok()
            {
                assert!(Instant::now() < deadline, "the listener outlived the relay");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
    }
}
