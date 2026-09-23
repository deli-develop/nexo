//! The relay listener behind `start_relay`, `stop_relay` and `relay_status`.
//!
//! `docs/RELAY.md` is the design, and `docs/STATUS.md` says how much of it this
//! is. Not much yet.
//!
//! # What it does
//!
//! Listens on `127.0.0.1:<port>` and, for each connection, dials one target and
//! copies bytes both ways until either side closes. It reads nothing it
//! forwards.
//!
//! # What it does not do yet
//!
//! Carry traffic anywhere useful. [`FORWARD_TO`] is a placeholder no socket can
//! dial, and a loopback listener is reachable from this machine only. Both wait
//! on how a blocked user is meant to reach a relay, which `RELAY.md` lists as an
//! open question rather than a detail.
//!
//! # Lifetime
//!
//! [`Relay`] is managed from startup and holds at most one running listener.
//! Every forwarded connection is a task in a [`JoinSet`] owned by the accept
//! loop, so aborting the loop drops the set and the set aborts every
//! connection: stopping ends forwarding, not only accepting.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;

/// Where each connection is forwarded. A placeholder, and not a dialable one:
/// `TcpStream::connect` wants `host:port`, so every forward fails until the
/// target is decided (see the module header).
const FORWARD_TO: &str = "wss://relay.example.com";

/// What the page is told about a running relay.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayInfo {
    pub ws_url: String,
}

impl RelayInfo {
    fn at(addr: SocketAddr) -> Self {
        Self {
            ws_url: format!("ws://{addr}"),
        }
    }
}

/// At most one running relay. `None` inside means stopped.
pub struct Relay {
    target: Arc<str>,
    running: Mutex<Option<Running>>,
}

struct Running {
    addr: SocketAddr,
    accept_loop: JoinHandle<()>,
}

impl Default for Relay {
    fn default() -> Self {
        Self::forwarding_to(FORWARD_TO)
    }
}

impl Relay {
    fn forwarding_to(target: &str) -> Self {
        Self {
            target: target.into(),
            running: Mutex::new(None),
        }
    }

    /// The running relay, or a new one on `127.0.0.1:<port>`; `0` picks a
    /// free port.
    ///
    /// Binds before answering, so a taken port is an error here rather than a
    /// log line after a success, and the address answered is the one bound.
    pub async fn start(&self, port: u16) -> Result<RelayInfo, String> {
        if let Some(info) = self.status() {
            return Ok(info);
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|e| format!("Could not open the relay on port {port}: {e}"))?;
        let addr = listener
            .local_addr()
            .map_err(|e| format!("Could not read the relay's address: {e}"))?;
        let accept_loop = tauri::async_runtime::spawn(accept_loop(listener, self.target.clone()));

        let mut running = self.lock();
        // Two starts can both get past the check above. The first one here
        // wins; the other's listener closes with its loop.
        if let Some(winner) = running.as_ref() {
            accept_loop.abort();
            return Ok(RelayInfo::at(winner.addr));
        }
        *running = Some(Running { addr, accept_loop });
        tracing::info!(relay_addr = %addr, "relay started");
        Ok(RelayInfo::at(addr))
    }

    /// Closes the listener and every connection it forwarded. `false` when
    /// none was running.
    pub fn stop(&self) -> bool {
        let Some(running) = self.lock().take() else {
            return false;
        };
        running.accept_loop.abort();
        tracing::info!(relay_addr = %running.addr, "relay stopped");
        true
    }

    pub fn status(&self) -> Option<RelayInfo> {
        self.lock()
            .as_ref()
            .map(|running| RelayInfo::at(running.addr))
    }

    /// Nothing is written under this lock that a panic could leave half done,
    /// so a poisoned one is still a good one.
    fn lock(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Accepts until aborted, and owns every connection it starts.
async fn accept_loop(listener: TcpListener, target: Arc<str>) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((client, peer)) => {
                    let target = target.clone();
                    connections.spawn(async move {
                        if let Err(e) = forward(client, &target).await {
                            tracing::warn!(%peer, %e, "relay forward failed");
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
            // Reap finished connections, or the set only ever grows.
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
}

/// One connection: dial the target, then copy both ways until either side
/// closes. Each direction's end is passed on as a shutdown of the other.
async fn forward(mut client: TcpStream, target: &str) -> std::io::Result<()> {
    let mut server = TcpStream::connect(target).await?;
    tokio::io::copy_bidirectional(&mut client, &mut server).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Everything on Tauri's runtime, like the commands: a socket belongs to
    /// the runtime that opened it.
    fn run<F: std::future::Future>(test: F) -> F::Output {
        tauri::async_runtime::block_on(test)
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

    fn port_of(info: &RelayInfo) -> u16 {
        info.ws_url.rsplit(':').next().unwrap().parse().unwrap()
    }

    #[test]
    fn the_page_reads_ws_url_as_camel_case() {
        let info = RelayInfo::at("127.0.0.1:41731".parse().unwrap());
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "wsUrl": "ws://127.0.0.1:41731" }),
        );
    }

    #[test]
    fn port_zero_answers_the_port_it_was_given() {
        run(async {
            let relay = Relay::default();
            let info = relay.start(0).await.unwrap();
            assert_ne!(port_of(&info), 0);
            assert_eq!(relay.status(), Some(info));
            relay.stop();
        });
    }

    #[test]
    fn starting_twice_answers_the_same_relay() {
        run(async {
            let relay = Relay::default();
            let first = relay.start(0).await.unwrap();
            let second = relay.start(0).await.unwrap();
            assert_eq!(first, second);
            relay.stop();
        });
    }

    #[test]
    fn a_taken_port_is_an_error_not_a_success() {
        run(async {
            let squatter = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let port = squatter.local_addr().unwrap().port();
            let relay = Relay::default();
            assert!(relay.start(port).await.is_err());
            assert_eq!(relay.status(), None);
        });
    }

    #[test]
    fn forwards_bytes_both_ways() {
        run(async {
            let relay = Relay::forwarding_to(&echo_server().await.to_string());
            let info = relay.start(0).await.unwrap();
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port_of(&info)))
                .await
                .unwrap();
            client.write_all(b"opaque envelope").await.unwrap();
            let mut back = [0u8; 15];
            client.read_exact(&mut back).await.unwrap();
            assert_eq!(&back, b"opaque envelope");
            relay.stop();
        });
    }

    #[test]
    fn stopping_closes_the_listener_and_what_it_forwarded() {
        run(async {
            let relay = Relay::forwarding_to(&echo_server().await.to_string());
            let port = port_of(&relay.start(0).await.unwrap());
            let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                .await
                .unwrap();
            client.write_all(b"x").await.unwrap();
            client.read_exact(&mut [0u8; 1]).await.unwrap();

            assert!(relay.stop());
            assert_eq!(relay.status(), None);
            assert!(!relay.stop(), "a second stop has nothing to stop");

            // The forwarded connection ends: EOF or a reset, not a hang.
            let mut rest = [0u8; 1];
            let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut rest))
                .await
                .expect("the forwarded connection outlived the relay");
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
