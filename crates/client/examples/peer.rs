//! A headless second client, for driving the desktop app against a real peer.
//!
//! The GUI is one process with one account, and the single-instance plugin
//! means a second window is not an option. So the other side of a conversation
//! runs here: it registers or signs in, keeps its store between invocations,
//! and does one thing per run.
//!
//! Development only, against a local server:
//!
//! ```text
//! $env:NEXO_API_BASE = "http://127.0.0.1:8080"
//! cargo run -p nexo-client --features http --example peer -- bob login a-development-password
//! cargo run -p nexo-client --features http --example peer -- bob send <conversation-id> "hello"
//! ```
//!
//! State lives under `%TEMP%\nexo-peer\<handle>`: the SQLCipher store, and a
//! DPAPI-wrapped store key beside it. Nothing here is a second implementation
//! of anything — it is `nexo_client` used the way the Tauri shell uses it.

use std::path::PathBuf;

use nexo_client::conversations::{self, Context};
use nexo_client::transport::Transport;
use nexo_client::{HttpTransport, session};
use nexo_crypto::identity::IdentityKeypair;
use nexo_crypto::mls::credential_for;
use nexo_platform::dpapi::DpapiStore;
use nexo_protocol::{ConversationId, DeviceId};
use nexo_store::EncryptedStore;
use openmls::prelude::CredentialWithKey;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;

fn home(handle: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("nexo-peer").join(handle);
    std::fs::create_dir_all(&dir).expect("create the peer's directory");
    dir
}

struct Peer {
    transport: HttpTransport,
    provider: OpenMlsRustCrypto,
    store: EncryptedStore,
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

impl Peer {
    /// Signs in, registering first if the handle is free.
    fn open(handle: &str, password: &str) -> Self {
        let dir = home(handle);
        let db = dir.join("store.db");
        let keystore = DpapiStore::with_dir(&dir);
        let transport = HttpTransport::new();

        // Register or sign in, whichever the server allows. A handle that is
        // taken is the normal case on every run after the first.
        let session = match session::login(&transport, &keystore, &db, handle, password) {
            Ok(s) => s,
            Err(_) => session::register(&transport, &keystore, &db, handle, handle, password)
                .expect("register the peer"),
        };
        transport.set_access_token(&session.access_token);
        transport.set_refresh_token(&session.refresh_token);

        let store =
            EncryptedStore::open(&db, &nexo_store::key::load_or_create(&keystore).unwrap().0)
                .expect("open the peer's store");

        let (secret, _public) = store.identity().unwrap().expect("an identity was stored");
        let identity = IdentityKeypair::from_secret_bytes(&secret).unwrap();
        let device_id: DeviceId = session.account.device_id.parse().unwrap();
        let (credential, signer) = credential_for(device_id, &identity);

        let provider = nexo_client::mls_state::load(&store).expect("load MLS state");
        signer.store(provider.storage()).expect("store the signer");

        Self {
            transport,
            provider,
            store,
            signer,
            credential,
        }
    }

    fn ctx(&self) -> Context<'_, HttpTransport> {
        Context {
            transport: &self.transport,
            provider: &self.provider,
            store: &self.store,
            signer: &self.signer,
            credential: self.credential.clone(),
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [handle, command, rest @ ..] = args.as_slice() else {
        eprintln!("usage: peer <handle> <login|start|group|send|sync|list> [args...]");
        std::process::exit(2);
    };

    let password = if command == "login" {
        rest.first()
            .cloned()
            .unwrap_or_else(|| "a-development-password".into())
    } else {
        "a-development-password".into()
    };

    let peer = Peer::open(handle, &password);
    let ctx = peer.ctx();

    match command.as_str() {
        "login" => {
            // Without key packages nobody can invite this account.
            conversations::publish_key_packages(&ctx, 10).expect("publish key packages");
            println!("signed in as {handle}, 10 key packages published");
        }
        "start" => {
            let other = &rest[0];
            let id = conversations::start_with(&ctx, other).expect("start a conversation");
            println!("{id}");
        }
        "group" => {
            let members: Vec<&str> = rest.iter().map(String::as_str).collect();
            let (title, handles) = members
                .split_first()
                .expect("a title and at least one handle");
            let handles: Vec<String> = handles.iter().map(|h| (*h).to_string()).collect();
            let id = conversations::start_group_with(&ctx, &handles, title).expect("start a group");
            println!("{id}");
        }
        "add" => {
            let id: ConversationId = rest[0].parse().expect("a conversation id");
            conversations::add_to(&ctx, id, &rest[1]).expect("add a member");
            println!("added {} to {id}", rest[1]);
        }
        "photo" => {
            // A big, incompressible JPEG, so opening it on the other side is a
            // download worth measuring rather than an instant one.
            let id: ConversationId = rest[0].parse().expect("a conversation id");
            let bytes: usize = rest
                .get(1)
                .and_then(|n| n.parse().ok())
                .unwrap_or(3_000_000);
            let mut contents = vec![0xFF, 0xD8, 0xFF, 0xE0];
            let mut seed: u32 = 0x9E37_79B9;
            while contents.len() < bytes {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                contents.extend_from_slice(&seed.to_le_bytes());
            }
            conversations::send_attachment(&ctx, id, "big.jpg", "image/jpeg", &contents, None, None)
                .expect("send an attachment");
            println!("sent {} bytes", contents.len());
        }
        "send" => {
            let id: ConversationId = rest[0].parse().expect("a conversation id");
            conversations::send_message(&ctx, id, &rest[1]).expect("send");
            println!("sent");
        }
        "sync" => {
            // Discover first: a conversation this peer was invited to is not
            // in its store until the server is asked about it.
            let found = conversations::discover(&ctx).expect("discover");
            let mut total = 0;
            for c in peer.store.conversations().expect("conversations") {
                let id: ConversationId = c.id.parse().expect("a stored conversation id");
                match conversations::sync(&ctx, id) {
                    Ok(o) => {
                        total += o.messages;
                        println!(
                            "{id}: {} new, {} skipped, {} failed",
                            o.messages, o.skipped, o.failed
                        );
                    }
                    Err(e) => println!("{id}: sync failed: {e}"),
                }
            }
            println!("discovered {found}, {total} new messages");
        }
        "list" => {
            for c in peer.store.conversations().expect("conversations") {
                println!(
                    "--- {} [{}] {:?}",
                    c.id,
                    c.kind.unwrap_or_default(),
                    c.title
                );
                for m in peer.store.messages(&c.id).expect("messages") {
                    let who = match &m.sender_device_id {
                        Some(d) => format!("them({d})"),
                        None => "me".into(),
                    };
                    println!("    {who}: {}", m.body);
                }
            }
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    }
}
