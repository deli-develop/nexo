//! Connecting through a relay: the blocked user's half of `relay.rs`.
//!
//! A WebView's proxy is fixed when the WebView is made, so the address lives
//! here, in a file the shell reads before it builds the window. The page asks
//! to change it and the app restarts; a running WebView cannot be switched
//! over.
//!
//! # What goes through it
//!
//! Everything the page fetches — the API, the live socket, the bucket — as
//! `CONNECT` tunnels. TLS runs from the WebView to the server, so the relay
//! sees which of Nexo's hosts and how much, never what. What the shell fetches
//! for itself (the updater, link previews) does not go through it.
//!
//! # What it does not hide
//!
//! The first leg is plain TCP to the relay, and the TLS handshake inside it
//! names the host. Somebody watching this machine's connection can still see
//! that it reaches Nexo. What a relay changes is where the connection goes,
//! which is what a block on the server's address looks at.
//!
//! # The file
//!
//! `via-relay` in the app's config directory: one line, `host:port`. Absent
//! means direct. A file that no longer parses is ignored rather than trusted,
//! and the app starts direct.

use std::fs;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, Url};

const FILE: &str = "via-relay";

const FORMAT: &str = "Give the relay as address:port, for example relay.example.org:41731.";

/// A relay address as somebody typed it, checked and lowercased: `host:port`,
/// where the host is a name, an IPv4 address or a bracketed IPv6 one.
pub fn parse(input: &str) -> Result<String, String> {
    let input = input.trim();
    let (host, port) = input.rsplit_once(':').ok_or(FORMAT)?;
    let port: u16 = port
        .parse()
        .ok()
        .filter(|&port| port != 0)
        .ok_or("The port is a number from 1 to 65535.")?;
    // Tauri hands the WebView `Url::port()`, which is empty for http's own
    // port, and a proxy with no port is no proxy.
    if port == 80 {
        return Err("Port 80 can't be used for a relay here. Ask for it on another port.".into());
    }
    let host_is_valid = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(v6) => v6.parse::<Ipv6Addr>().is_ok(),
        None => host.parse::<Ipv4Addr>().is_ok() || is_hostname(host),
    };
    if !host_is_valid {
        return Err(FORMAT.into());
    }
    Ok(format!("{}:{port}", host.to_ascii_lowercase()))
}

fn is_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// The proxy the main window is built with, or `None` to go direct.
pub fn proxy_url<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
    let address = current(app)?;
    Url::parse(&format!("http://{address}")).ok()
}

/// The saved relay, or `None`.
pub fn current<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    read(&file(app)?)
}

/// Saves the relay to connect through, or forgets it when `None`. Takes effect
/// at the next start.
pub fn save<R: Runtime>(app: &AppHandle<R>, address: Option<&str>) -> Result<(), String> {
    let address = address.map(parse).transpose()?;
    let path = file(app).ok_or("There is nowhere on this device to keep the setting.")?;
    write(&path, address.as_deref()).map_err(|e| format!("Could not save the relay: {e}"))
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

fn read(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    match parse(&text) {
        Ok(address) => Some(address),
        Err(_) => {
            tracing::warn!("the saved relay address does not parse; starting direct");
            None
        }
    }
}

fn write(path: &Path, address: Option<&str>) -> io::Result<()> {
    match address {
        Some(address) => {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir)?;
            }
            fs::write(path, address)
        }
        None => match fs::remove_file(path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_an_ipv4_and_a_bracketed_ipv6_address_are_relays() {
        assert_eq!(
            parse(" Relay.Example.org:41731 ").unwrap(),
            "relay.example.org:41731"
        );
        assert_eq!(parse("203.0.113.5:41731").unwrap(), "203.0.113.5:41731");
        assert_eq!(parse("[2001:db8::1]:41731").unwrap(), "[2001:db8::1]:41731");
    }

    #[test]
    fn anything_that_is_not_host_and_port_is_refused() {
        for input in [
            "",
            "relay.example.org",
            ":41731",
            "relay.example.org:",
            "relay.example.org:0",
            "relay.example.org:65536",
            "relay.example.org:port",
            "http://relay.example.org:41731",
            "user@relay.example.org:41731",
            "relay.example.org:41731/path",
            "relay example.org:41731",
            "-relay.example.org:41731",
            "relay..example.org:41731",
            "2001:db8::1:41731",
            "[not-v6]:41731",
        ] {
            assert!(parse(input).is_err(), "{input:?} was accepted");
        }
    }

    #[test]
    fn port_80_is_refused_because_the_webview_would_lose_it() {
        assert!(parse("relay.example.org:80").is_err());
        // What the refusal is about: the URL drops a default port.
        let url = Url::parse("http://relay.example.org:80").unwrap();
        assert_eq!(url.port(), None);
    }

    #[test]
    fn a_saved_relay_is_read_back_and_forgetting_it_removes_the_file() {
        let dir = std::env::temp_dir().join(format!("nexo-via-relay-{}", std::process::id()));
        let path = dir.join(FILE);

        assert_eq!(read(&path), None, "no file is direct");
        write(&path, Some("relay.example.org:41731")).unwrap();
        assert_eq!(read(&path).as_deref(), Some("relay.example.org:41731"));

        fs::write(&path, "not a relay").unwrap();
        assert_eq!(
            read(&path),
            None,
            "a file that does not parse is not trusted"
        );

        write(&path, None).unwrap();
        assert!(!path.exists());
        write(&path, None).expect("forgetting twice is not an error");

        let _ = fs::remove_dir_all(dir);
    }
}
