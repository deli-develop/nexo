//! The client's encrypted local store.
//!
//! One SQLCipher database at `%APPDATA%\Nexo\store.db`, holding messages, MLS
//! group state, contacts and cached profiles (brief 4.3). The whole file is
//! encrypted; there is no plaintext index, no plaintext preview column, and no
//! "just this bit in the clear for speed".
//!
//! The key exists in two places and no others: in memory inside a
//! [`Zeroizing`](zeroize::Zeroizing) buffer, and on disk wrapped by the OS
//! keystore. See [`key`].
//!
//! # What this crate deliberately does not do
//!
//! It does not decide *what* to store. Schema for messages and MLS state
//! arrives with M3 and M4; this is the encrypted container and the proof that
//! it is one. Building the container first, and testing that it is genuinely
//! opaque, is what makes the later schema work uninteresting.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension as _};
use zeroize::Zeroizing;

pub mod key;

pub use key::KeyError;

/// A stored identity keypair: the secret (zeroized on drop) and the public half.
pub type StoredIdentity = (Zeroizing<Vec<u8>>, Vec<u8>);

/// The schema version this build writes and expects.
///
/// One constant, so a migration and the test that checks it cannot disagree.
pub const SCHEMA_VERSION: i64 = 19;

/// The file name the store always uses, under the app data directory.
pub const STORE_FILE_NAME: &str = "store.db";

/// Errors from opening or using the store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Getting the key failed.
    #[error(transparent)]
    Key(#[from] KeyError),
    /// SQLite or SQLCipher refused.
    #[error("the local store failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// The file exists but the key does not open it.
    ///
    /// Almost always means the keyring was erased or the file was copied from
    /// another machine or Windows account — not corruption, and worth saying
    /// so, because the remedies are completely different.
    #[error(
        "`{path}` cannot be opened with this machine's key. The keyring was \
         probably erased, or the file came from another account. It is not \
         recoverable without the original key."
    )]
    WrongKey {
        /// Which file.
        path: PathBuf,
    },
    /// The directory could not be created.
    #[error("could not create the store directory: {0}")]
    Io(#[from] std::io::Error),
}

/// An open, encrypted store.
pub struct EncryptedStore {
    connection: Connection,
    path: PathBuf,
}

/// Written out rather than derived, so that no future field can be printed into
/// a log by accident. The path is the only thing here that is safe to show.
impl std::fmt::Debug for EncryptedStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl EncryptedStore {
    /// Opens the store at `path`, creating and keying it on first run.
    ///
    /// `key` is the raw 32 bytes from [`key::load_or_create`].
    pub fn open(path: impl AsRef<Path>, key: &[u8]) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(&path)?;

        // `PRAGMA key` must be the first statement on the connection: SQLCipher
        // reads the header to decide the page cipher, and anything that touches
        // a page before the key is set gets the wrong answer.
        let literal = key::as_pragma_literal(key);
        connection.pragma_update(None, "key", &*literal as &str)?;

        // The first actual read is what proves the key is right. SQLCipher
        // accepts any key at PRAGMA time and only fails when it tries to
        // decrypt a page, so without this the error surfaces later and looks
        // like corruption.
        let usable = connection
            .query_row("SELECT count(*) FROM sqlite_master", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_ok();
        if !usable {
            return Err(StoreError::WrongKey { path });
        }

        // Foreign keys are off by default in SQLite, which quietly turns every
        // REFERENCES clause into a comment.
        connection.pragma_update(None, "foreign_keys", "ON")?;
        // WAL survives a crash mid-write without taking the database with it.
        connection.pragma_update(None, "journal_mode", "WAL")?;

        let store = Self { connection, path };
        store.migrate()?;
        Ok(store)
    }

    /// Applies the local schema.
    ///
    /// Versioned with `user_version` rather than a migrations table: this
    /// database belongs to one process on one machine, so there is no
    /// concurrent migrator to coordinate with and nothing to gain from the
    /// heavier machinery the server uses.
    fn migrate(&self) -> Result<(), StoreError> {
        let version: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 1 {
            self.connection.execute_batch(
                "BEGIN;
                 -- Deliberately minimal. Message and MLS tables arrive with M3
                 -- and M4; this establishes the file and its versioning so
                 -- those are ordinary migrations rather than a first one.
                 CREATE TABLE IF NOT EXISTS account (
                     id            INTEGER PRIMARY KEY CHECK (id = 1),
                     user_id       INTEGER NOT NULL,
                     handle        TEXT    NOT NULL,
                     display_name  TEXT    NOT NULL,
                     device_id     TEXT    NOT NULL
                 );

                 -- The Ed25519 identity secret (brief 4.1). It lives here
                 -- rather than in the OS keystore because the keystore holds
                 -- exactly one thing -- the key to this file -- and nesting a
                 -- second secret behind the same DPAPI blob would gain nothing
                 -- while giving the keyring two jobs.
                 CREATE TABLE IF NOT EXISTS identity (
                     id          INTEGER PRIMARY KEY CHECK (id = 1),
                     secret_key  BLOB NOT NULL,
                     public_key  BLOB NOT NULL,
                     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                 );
                 -- The whole of the MLS storage, as one blob. See
                 -- nexo_client::mls_state for why it is one blob and not a
                 -- StorageProvider.
                 CREATE TABLE IF NOT EXISTS mls_state (
                     id    INTEGER PRIMARY KEY CHECK (id = 1),
                     blob  BLOB NOT NULL
                 );

                 -- Locally decrypted messages. This is the *plaintext* history,
                 -- which is why it may only ever exist inside this encrypted
                 -- file (4.3).
                 CREATE TABLE IF NOT EXISTS messages (
                     envelope_id      INTEGER PRIMARY KEY,
                     conversation_id  TEXT NOT NULL,
                     sender_device_id TEXT,
                     body             TEXT NOT NULL,
                     sent_at_ms       INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS messages_conversation_idx
                     ON messages (conversation_id, envelope_id);

                 -- One row per conversation this device is in, with the sync
                 -- cursor. `last_envelope_id` is what makes a reconnect cheap
                 -- and what makes a missed WebSocket event survivable.
                 CREATE TABLE IF NOT EXISTS conversations (
                     id                TEXT PRIMARY KEY,
                     last_envelope_id  INTEGER NOT NULL DEFAULT 0
                 );

                 -- The refresh token, so a restart can get a new access token
                 -- without asking for the password again.
                 --
                 -- It sits beside the identity private key, in the same
                 -- SQLCipher file under the same DPAPI-wrapped key. Anyone who
                 -- can read this row can already read that key, which is the
                 -- far more valuable secret -- so withholding the token buys
                 -- nothing and costs the user their session on every restart.
                 CREATE TABLE IF NOT EXISTS refresh_token (
                     id     INTEGER PRIMARY KEY CHECK (id = 1),
                     token  TEXT NOT NULL
                 );

                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        }

        if version < 2 {
            // A human-readable name for the conversation. Set when this device
            // starts one, because that is the only moment it knows who it
            // invited; a conversation joined from a Welcome has no title until
            // M7's profile fetch, and the UI says so rather than inventing one.
            self.connection.execute_batch(
                "BEGIN;
                 ALTER TABLE conversations ADD COLUMN title TEXT;
                 PRAGMA user_version = 2;
                 COMMIT;",
            )?;
        }

        if version < 3 {
            // The full payload of a message that carries a file: the S3 key,
            // the AES key, the nonce, the hash, the name and type.
            //
            // It has to be persisted, and this is the only place it may live.
            // MLS refuses a replayed message by design -- that is the whole
            // point of a ratchet -- so the payload cannot be recovered by
            // decrypting the envelope a second time. Either it is written down
            // when it first arrives, or the file is unreachable forever.
            //
            // That it holds a decryption key is exactly why it belongs in this
            // file and nowhere else (4.3). The `body` column beside it is only
            // the preview shown in the list.
            self.connection.execute_batch(
                "BEGIN;
                 ALTER TABLE messages ADD COLUMN payload TEXT;
                 PRAGMA user_version = 3;
                 COMMIT;",
            )?;
        }

        if version < 4 {
            // The offline queue (M8).
            //
            // It holds **ciphertext**, not the message someone typed, and that
            // is forced rather than chosen. MLS ratchets forward on every
            // encryption: the ciphertext for a message exists exactly once,
            // and re-encrypting on retry would consume a second generation and
            // desynchronise this device from the group. So a queued message is
            // encrypted at the moment it is written, and every later attempt
            // sends those same bytes.
            //
            // `client_msg_id` is what makes the retry safe. A client cannot
            // tell a request that never arrived from a reply that was lost, so
            // it must retry; the server matches on this id and returns the
            // envelope the first attempt created instead of writing a second.
            //
            // `body` is the preview shown while the message is pending. It is
            // plaintext, which is why it may only live in this encrypted file.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS outbox (
                     -- Insertion order, explicitly. Not the implicit rowid:
                     -- two messages written in the same millisecond have to
                     -- keep their order, and ordering by a timestamp alone
                     -- would leave that to chance.
                     seq             INTEGER PRIMARY KEY AUTOINCREMENT,
                     client_msg_id   TEXT NOT NULL UNIQUE,
                     conversation_id TEXT NOT NULL,
                     ciphertext      TEXT NOT NULL,
                     epoch           INTEGER NOT NULL,
                     is_commit       INTEGER NOT NULL DEFAULT 0,
                     body            TEXT NOT NULL,
                     payload         TEXT,
                     queued_at_ms    INTEGER NOT NULL,
                     attempts        INTEGER NOT NULL DEFAULT 0,
                     last_error      TEXT
                 );
                 PRAGMA user_version = 4;
                 COMMIT;",
            )?;
        }

        if version < 5 {
            // What kind of conversation this is, and who is in it.
            //
            // Both come from the server's membership list, which is routing
            // metadata it already holds and already acts on. Kept here so the
            // UI can tell a DM from a group without a request -- and so it
            // stops treating every conversation as a DM, which is what it did
            // when the only answer available was a guess.
            //
            // `members` is a JSON array of handles. A child table would be the
            // tidier shape, but these are read together, written together, and
            // never queried individually.
            self.connection.execute_batch(
                "BEGIN;
                 ALTER TABLE conversations ADD COLUMN kind TEXT;
                 ALTER TABLE conversations ADD COLUMN members TEXT;
                 PRAGMA user_version = 5;
                 COMMIT;",
            )?;
        }

        if version < 6 {
            // The payload describing a conversation's picture: where the
            // ciphertext is, and the key that opens it.
            //
            // It holds a decryption key, which is exactly why it belongs in
            // this file and nowhere else -- the same rule as a message's
            // attachment payload. Kept per conversation rather than per
            // message because the newest one is the current picture and the
            // ones before it are of no interest.
            self.connection.execute_batch(
                "BEGIN;
                 ALTER TABLE conversations ADD COLUMN avatar_payload TEXT;
                 PRAGMA user_version = 6;
                 COMMIT;",
            )?;
        }
        if version < 7 {
            // Conversations this device has been told to forget.
            //
            // Removing a conversation used to last until the next sync.
            // `discover` asks the server what we are a member of and creates a
            // local row for anything it does not recognise -- and after a
            // delete, it does not recognise the one just deleted. The chat came
            // back within seconds, empty, which is the opposite of what the
            // button said.
            //
            // A tombstone says "gone, as of this envelope". The conversation
            // stays gone while the server's newest envelope is still that one,
            // and comes back the moment a newer one exists -- which is exactly
            // the promise the confirmation makes: everyone else keeps their
            // copy, and if they write again the conversation returns with the
            // new message in it.
            //
            // Not a column on `conversations`, because the row itself is what
            // gets deleted.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS forgotten_conversations (
                     id TEXT PRIMARY KEY,
                     through_envelope_id INTEGER NOT NULL
                 );
                 PRAGMA user_version = 7;
                 COMMIT;",
            )?;
        }

        if version < 8 {
            // Who is in each conversation, and what key they sign with.
            //
            // The table that makes a key change *noticeable*. Without it the
            // safety number is computed on demand from the live group and
            // compared against nothing, so the verification ceremony is
            // one-shot: someone who compared digits in week one is never told
            // when the answer changes in week two -- which is exactly the
            // key-substituting server that THREAT-MODEL 4 is about.
            //
            // `verified_key` holds the key that was verified rather than a
            // boolean. A flag cannot survive the thing it refers to changing;
            // storing the key means "verified" always answers *which* key, and
            // a later comparison is meaningful rather than a guess.
            //
            // Keyed by device, not by handle: MLS names devices, and a person
            // who reinstalls is a new device with a new key. That is the case
            // this table exists to notice.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS conversation_peers (
                     conversation_id TEXT NOT NULL,
                     device_id       TEXT NOT NULL,
                     identity_key    BLOB NOT NULL,
                     first_seen_ms   INTEGER NOT NULL,
                     -- The key the user confirmed out of band, if they ever did.
                     verified_key    BLOB,
                     -- When the key last changed under a device we already knew.
                     -- Cleared by acknowledging, not by the change going stale.
                     changed_at_ms   INTEGER,
                     PRIMARY KEY (conversation_id, device_id)
                 );
                 PRAGMA user_version = 8;
                 COMMIT;",
            )?;
        }

        if version < 9 {
            // Full-text search over message bodies (BRIEF 6.1).
            //
            // Inside the encrypted file, which is the whole point: the search
            // term never leaves the machine and the index is as protected as
            // the messages it indexes. A server-side search would need the
            // plaintext, and there is none to give it.
            //
            // `content=` makes this an external-content table -- the index
            // stores no copy of the body, only the terms. One copy of the
            // plaintext, in `messages`, where it already was.
            //
            // The triggers are what keep it true. An FTS table that drifts from
            // its source silently returns results that do not exist and misses
            // ones that do, which is worse than no search.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                     body,
                     content='messages',
                     content_rowid='envelope_id'
                 );

                 -- Everything already stored. A search that only found messages
                 -- sent after the upgrade would look broken.
                 INSERT INTO messages_fts (rowid, body)
                     SELECT envelope_id, body FROM messages;

                 CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
                     INSERT INTO messages_fts (rowid, body) VALUES (new.envelope_id, new.body);
                 END;

                 -- 'delete' rows are how an external-content table is told to
                 -- forget: the old terms have to be withdrawn explicitly.
                 CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
                     INSERT INTO messages_fts (messages_fts, rowid, body)
                         VALUES ('delete', old.envelope_id, old.body);
                 END;

                 CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
                     INSERT INTO messages_fts (messages_fts, rowid, body)
                         VALUES ('delete', old.envelope_id, old.body);
                     INSERT INTO messages_fts (rowid, body) VALUES (new.envelope_id, new.body);
                 END;

                 PRAGMA user_version = 9;
                 COMMIT;",
            )?;
        }

        if version < 10 {
            // The Meet&Greet map, cached so the tab opens on something.
            //
            // The pin list is not a feed and must never become one: it is
            // fetched when the tab is opened and when somebody pulls, never on
            // a timer and never through the sync agent, which belongs to
            // messages. What this table buys is the first paint -- reopening
            // draws yesterday's map immediately and replaces it when the fetch
            // lands, instead of showing an empty world for a round trip.
            //
            // `char_config` is stored as the JSON text it arrived as. This
            // crate has no more business parsing a hairstyle than the server
            // does; the renderer is the only thing that reads it.
            //
            // It is a cache, so it is disposable: `fetched_at_ms` is what tells
            // a reader how stale the map is, and clearing the table loses
            // nothing that a fetch will not bring back.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS meet_pins (
                     handle        TEXT PRIMARY KEY,
                     display_name  TEXT NOT NULL,
                     lat           REAL NOT NULL,
                     lon           REAL NOT NULL,
                     headline      TEXT,
                     char_config   TEXT NOT NULL,
                     updated_at_ms INTEGER NOT NULL,
                     fetched_at_ms INTEGER NOT NULL
                 );
                 PRAGMA user_version = 10;
                 COMMIT;",
            )?;
        }

        if version < 11 {
            // A name for a message, chosen by whoever sent it.
            //
            // Everything a person can later do *to* a message -- react to it,
            // edit it, take it back -- has to say which one, and the envelope
            // id cannot answer: the server assigns it, so a message still in
            // the outbox has none, and that is precisely the window in which
            // somebody wants to take a message back. This column holds the id
            // that travels inside the ciphertext instead (`Payload::id`).
            //
            // Nullable, and it stays nullable. Every message already in this
            // database was sent before names existed; giving them all a
            // placeholder would make them all the same message as far as any
            // reference is concerned. The partial unique index enforces the
            // rule that matters -- two messages must not answer to one name --
            // without pretending the old ones have one.
            //
            // The outbox carries it too, so a queued message can be named
            // before the server has ever seen it.
            self.add_column("messages", "client_id", "TEXT")?;
            self.add_column("outbox", "client_id", "TEXT")?;
            self.connection.execute_batch(
                "BEGIN;
                 CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id_idx
                     ON messages (client_id) WHERE client_id IS NOT NULL;
                 PRAGMA user_version = 11;
                 COMMIT;",
            )?;
        }

        if version < 12 {
            // Pinned messages, and they are pinned **on this device only**.
            //
            // Sharing them was the first design and it was wrong. The cap is
            // what breaks: the feed can hold `MAX_PINNED = 3` because it counts
            // inside one transaction against one database, and a conversation
            // has no such place -- the server may not read the payload, so it
            // cannot count. Two people pinning three each make six, with no
            // rule saying which three win. `Rename` gets away with "the later
            // one wins" because it settles a single value; a bounded *set* has
            // no such answer.
            //
            // And a shared pin outlives whoever made it. Somebody removed from
            // a group could never unpin theirs, and nobody else would be
            // allowed to.
            //
            // Keyed by `envelope_id`, not by the payload's name: this table
            // never leaves the machine, and a message still in the outbox has
            // nothing worth pinning yet.
            //
            // The seam stays open. `Payload` is `#[non_exhaustive]`, so a
            // shared variant later is purely additive -- and an older build
            // meeting it now says "this needs a newer version of Nexo" rather
            // than drawing JSON, which is what wave 1 bought.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS pinned_messages (
                     conversation_id TEXT    NOT NULL,
                     envelope_id     INTEGER NOT NULL,
                     pinned_at_ms    INTEGER NOT NULL,
                     PRIMARY KEY (conversation_id, envelope_id)
                 );
                 PRAGMA user_version = 12;
                 COMMIT;",
            )?;
        }

        if version < 13 {
            // Reactions, keyed by the name inside the ciphertext.
            //
            // Two choices here are deliberate and neither is obvious.
            //
            // **`reactor_device_id` is NOT NULL and carries the real device id
            // even for our own reactions** — against the convention in
            // `messages`, where NULL means "ours". SQLite permits NULL in a
            // primary-key column of a rowid table and treats every NULL as
            // distinct, so `ON CONFLICT DO NOTHING` would quietly fail to
            // match on our own rows and a second tap of the same emoji would
            // insert a second one. "Mine" is decided against `account()`
            // instead, which costs a lookup and cannot silently duplicate.
            //
            // **No foreign key to `messages`.** `PRAGMA foreign_keys = ON` is
            // set, so a declared reference would be enforced — and would
            // refuse a reaction whose target this installation never received,
            // which happens whenever somebody reacts to a message that arrived
            // before this device joined. An orphaned reaction costs a row and
            // lights up if the message turns up later.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS message_reactions (
                     message_client_id TEXT    NOT NULL,
                     conversation_id   TEXT    NOT NULL,
                     reactor_device_id TEXT    NOT NULL,
                     emoji             TEXT    NOT NULL,
                     reacted_at_ms     INTEGER NOT NULL,
                     PRIMARY KEY (message_client_id, reactor_device_id, emoji)
                 );
                 CREATE INDEX IF NOT EXISTS message_reactions_conversation_idx
                     ON message_reactions (conversation_id);
                 PRAGMA user_version = 13;
                 COMMIT;",
            )?;
        }

        if version < 14 {
            // Taking a message back, and changing one.
            //
            // A retracted message is **emptied, not deleted**, and the
            // difference matters twice. `envelope_id` is the sync cursor's key
            // and the FTS rowid, so a hole in the sequence is indistinguishable
            // from a message that never arrived — the next sync would try to
            // fetch it again. And the row is what the conversation is ordered
            // by: removing it would silently close the gap where something
            // used to be, which is not what "taken back" looks like to the
            // people who saw it.
            //
            // Emptying `body` is what withdraws the terms from the search
            // index: the existing UPDATE trigger does it, so nothing here has
            // to know that FTS exists.
            //
            // `edited_at_ms` is the sender's clock and is shown, not judged.
            // What decides whether a change is in time is the pair of server
            // timestamps -- see `nexo_protocol::window`.
            self.add_column("messages", "retracted_at_ms", "INTEGER")?;
            self.add_column("messages", "edited_at_ms", "INTEGER")?;
            self.connection.execute_batch("PRAGMA user_version = 14;")?;
        }

        if version < 15 {
            // Stories, and the keys that open them.
            //
            // This table is the layer that actually makes a story disappear.
            // The server refuses to serve an expired one and the object store
            // eventually drops the bytes, but **the key lives here**, and
            // ciphertext without its key is nothing. So every read purges what
            // has expired rather than filtering it: filtering would leave the
            // key on the disk of somebody who was promised it would go.
            //
            // The rate limiter tidies up the same way -- as a side effect of
            // being asked something, never on a timer. There is no background
            // work in this app either.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS stories (
                     id            INTEGER PRIMARY KEY,
                     author_handle TEXT    NOT NULL,
                     author_device_id TEXT NOT NULL DEFAULT '',
                     s3_key        TEXT    NOT NULL,
                     enc_key       TEXT    NOT NULL,
                     nonce         TEXT    NOT NULL,
                     sha256        TEXT    NOT NULL,
                     mime          TEXT    NOT NULL,
                     size          INTEGER NOT NULL,
                     created_at_ms INTEGER NOT NULL,
                     expires_at_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS stories_expiry_idx
                     ON stories (expires_at_ms);
                 PRAGMA user_version = 15;
                 COMMIT;",
            )?;
        }

        if version < 16 {
            // What a reply answers.
            //
            // A column rather than a payload the reader decodes, because this
            // is asked once per drawn bubble: the thread resolves every quote
            // it is about to show, and decoding a JSON payload per message to
            // find one UUID would put a parse in that loop. `client_id` is
            // already indexed for the same reason.
            //
            // Deliberately **not** a foreign key. The message being answered
            // may never have reached this device -- somebody joined the
            // conversation late, or the sync that carried it failed -- and a
            // constraint would turn that into a refused insert, losing a reply
            // that was perfectly readable. The unresolved case is drawn as
            // itself instead.
            self.add_column("messages", "reply_to", "TEXT")?;
            self.connection.execute_batch(
                "BEGIN;
                 CREATE INDEX IF NOT EXISTS messages_reply_to_idx
                     ON messages (reply_to) WHERE reply_to IS NOT NULL;
                 PRAGMA user_version = 16;
                 COMMIT;",
            )?;
        }

        if version < 17 {
            // View-once media, and the keys that open it exactly once.
            //
            // The key lives **here and nowhere else** -- deliberately not in
            // `messages.payload`, where every other attachment keeps its own.
            // That column persists for the life of the message, so a key in it
            // could be read again by anything that could read it once, and
            // "destroyed when you open it" would be a sentence with nothing
            // behind it. Opening nulls the three key columns in place; the
            // ciphertext in the bucket is meaningless afterwards.
            //
            // The row survives that, with `opened_at_ms` set. It has to: the
            // bubble still has to say what used to be there, and a missing row
            // would be indistinguishable from a message that was never
            // view-once at all.
            //
            // Same shape as `stories`, for the same reason -- a key that has to
            // be able to disappear cannot live beside data that must not.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS view_once (
                     client_id       TEXT PRIMARY KEY,
                     conversation_id TEXT    NOT NULL,
                     s3_key          TEXT    NOT NULL,
                     enc_key         TEXT,
                     nonce           TEXT,
                     sha256          TEXT,
                     mime            TEXT    NOT NULL,
                     size            INTEGER NOT NULL,
                     received_at_ms  INTEGER NOT NULL,
                     opened_at_ms    INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS view_once_conversation_idx
                     ON view_once (conversation_id);
                 PRAGMA user_version = 17;
                 COMMIT;",
            )?;
        }

        if version < 18 {
            // Folders, and which conversations are in them.
            //
            // **Local, and only local.** Nothing about this reaches the server:
            // how somebody files their own conversations is not routing
            // metadata, and sending it would hand over a reading of who matters
            // to them that the server has no use for and no business holding.
            // That also makes this the cheapest feature in the app to be sure
            // about -- it changes the threat model not at all.
            //
            // A membership row rather than a column on `conversations`, because
            // a conversation can sit in more than one folder. The primary key
            // is the pair, so filing something twice is a no-op instead of a
            // duplicate.
            //
            // `ON DELETE CASCADE` is spelled out even though nothing deletes a
            // folder yet: without it, removing one would leave rows pointing at
            // an id that is gone, and the list would quietly filter to nothing.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS folders (
                     id         INTEGER PRIMARY KEY,
                     name       TEXT    NOT NULL,
                     position   INTEGER NOT NULL DEFAULT 0,
                     created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS folder_members (
                     folder_id       INTEGER NOT NULL
                         REFERENCES folders (id) ON DELETE CASCADE,
                     conversation_id TEXT    NOT NULL,
                     PRIMARY KEY (folder_id, conversation_id)
                 );
                 CREATE INDEX IF NOT EXISTS folder_members_conversation_idx
                     ON folder_members (conversation_id);
                 PRAGMA user_version = 18;
                 COMMIT;",
            )?;
        }

        if version < 19 {
            // Unsent messages.
            //
            // **Here rather than in the WebView**, and that is the whole design
            // decision. The app store's own header says nothing persisted in
            // the page is a secret; a half-written message plainly is one. It
            // is the same words the message would have carried had it been
            // sent, so it gets the same protection the sent ones get -- which
            // means SQLCipher, not `localStorage`.
            //
            // One row per conversation, replaced in place. There is no history
            // of drafts and there should not be: a draft is what you would
            // send now, and keeping the versions of it somebody typed and
            // deleted would be keeping the sentences they thought better of.
            //
            // Deleted when emptied rather than stored blank, so an abandoned
            // draft leaves nothing behind at all.
            self.connection.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS drafts (
                     conversation_id TEXT PRIMARY KEY,
                     body            TEXT NOT NULL,
                     updated_at_ms   INTEGER NOT NULL
                 );
                 PRAGMA user_version = 19;
                 COMMIT;",
            )?;
        }
        Ok(())
    }

    /// Whether a column already exists.
    ///
    /// SQLite has no `ADD COLUMN IF NOT EXISTS`, and every other step in the
    /// ladder is written to be safe to re-run. This gives the `ALTER`s the same
    /// property: a database that already has the column is left alone instead
    /// of failing the whole migration with `duplicate column name`.
    fn has_column(&self, table: &str, column: &str) -> Result<bool, StoreError> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Adds a column unless it is already there.
    fn add_column(&self, table: &str, column: &str, decl: &str) -> Result<(), StoreError> {
        if !self.has_column(table, column)? {
            self.connection
                .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
        }
        Ok(())
    }

    /// The schema version currently applied.
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    /// Where this store lives.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The underlying connection, for the modules that own their own tables.
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Records the signed-in account, replacing whatever was there.
    ///
    /// One row, enforced by the `CHECK (id = 1)`: v0.1 is one account per
    /// installation, and a schema that cannot represent two is better than a
    /// rule that says there should not be.
    pub fn set_account(
        &self,
        user_id: i64,
        handle: &str,
        display_name: &str,
        device_id: &str,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO account (id, user_id, handle, display_name, device_id)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET
                 user_id = excluded.user_id,
                 handle = excluded.handle,
                 display_name = excluded.display_name,
                 device_id = excluded.device_id",
            rusqlite::params![user_id, handle, display_name, device_id],
        )?;
        Ok(())
    }

    /// The signed-in account, if the store has one.
    pub fn account(&self) -> Result<Option<Account>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT user_id, handle, display_name, device_id FROM account WHERE id = 1")?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(Account {
            user_id: row.get(0)?,
            handle: row.get(1)?,
            display_name: row.get(2)?,
            device_id: row.get(3)?,
        }))
    }
}

impl EncryptedStore {
    /// Stores this device's identity keypair, replacing any existing one.
    ///
    /// Replacing is a serious act: the old key *is* the account's cryptographic
    /// identity, and every contact who verified a safety number against it will
    /// see a mismatch. Callers should be registering or deliberately re-keying,
    /// never doing this speculatively.
    pub fn set_identity(&self, secret: &[u8], public: &[u8]) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO identity (id, secret_key, public_key)
             VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET
                 secret_key = excluded.secret_key,
                 public_key = excluded.public_key",
            rusqlite::params![secret, public],
        )?;
        Ok(())
    }

    /// This device's identity keypair, if one has been generated.
    ///
    /// The secret comes back [`Zeroizing`] so it is wiped when the caller drops
    /// it — the row is inside an encrypted file, but the copy in memory is not.
    pub fn identity(&self) -> Result<Option<StoredIdentity>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT secret_key, public_key FROM identity WHERE id = 1")?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let secret: Vec<u8> = row.get(0)?;
        let public: Vec<u8> = row.get(1)?;
        Ok(Some((Zeroizing::new(secret), public)))
    }
}

impl EncryptedStore {
    /// Stores the refresh token, replacing any previous one.
    ///
    /// Rotation means the previous token is already dead, so overwriting is
    /// always right and keeping history would only leave dead credentials on
    /// disk.
    pub fn set_refresh_token(&self, token: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO refresh_token (id, token) VALUES (1, ?1)
             ON CONFLICT (id) DO UPDATE SET token = excluded.token",
            rusqlite::params![token],
        )?;
        Ok(())
    }

    /// The stored refresh token, if there is one.
    pub fn refresh_token(&self) -> Result<Option<Zeroizing<String>>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT token FROM refresh_token WHERE id = 1")?;
        let mut rows = statement.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(Zeroizing::new(row.get(0)?))),
            None => Ok(None),
        }
    }

    /// Forgets the refresh token, without touching anything else.
    ///
    /// Used when the server rejects it: a dead token kept on disk is a dead
    /// token that gets retried on every launch.
    pub fn clear_refresh_token(&self) -> Result<(), StoreError> {
        self.connection
            .execute("DELETE FROM refresh_token WHERE id = 1", [])?;
        Ok(())
    }

    /// Replaces the stored MLS state.
    pub fn set_mls_state(&self, blob: &[u8]) -> Result<(), StoreError> {
        Self::set_mls_state_on(&self.connection, blob)
    }

    fn set_mls_state_on(conn: &rusqlite::Connection, blob: &[u8]) -> Result<(), StoreError> {
        conn.execute(
            "INSERT INTO mls_state (id, blob) VALUES (1, ?1)
             ON CONFLICT (id) DO UPDATE SET blob = excluded.blob",
            rusqlite::params![blob],
        )?;
        Ok(())
    }

    /// The stored MLS state, if there is any.
    pub fn mls_state(&self) -> Result<Option<Vec<u8>>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT blob FROM mls_state WHERE id = 1")?;
        let mut rows = statement.query([])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// Records a decrypted message with nothing but a body.
    ///
    /// Keyed by the server's envelope id, so replaying a sync cannot duplicate
    /// anything -- which matters, because a reconnect replays by design.
    ///
    /// The short form, for a message that carries no file and answers to no
    /// name. Anything else goes through [`EncryptedStore::insert`].
    pub fn insert_message(
        &self,
        envelope_id: i64,
        conversation_id: &str,
        sender_device_id: Option<&str>,
        body: &str,
        sent_at_ms: i64,
    ) -> Result<(), StoreError> {
        self.insert(&NewMessage {
            envelope_id,
            conversation_id,
            sender_device_id,
            body,
            payload: None,
            sent_at_ms,
            client_id: None,
            reply_to: None,
        })
    }

    /// Records a message, all of it.
    ///
    /// `payload` is only set for a message that carries something the preview
    /// cannot represent -- a file, or a shape this build could not read. See
    /// the v3 and v11 migrations for why both have to be written down at
    /// arrival rather than recovered later: MLS will not decrypt that envelope
    /// a second time.
    pub fn insert(&self, message: &NewMessage<'_>) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO messages
                 (envelope_id, conversation_id, sender_device_id, body, payload,
                  sent_at_ms, client_id, reply_to)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (envelope_id) DO NOTHING",
            rusqlite::params![
                message.envelope_id,
                message.conversation_id,
                message.sender_device_id,
                message.body,
                message.payload,
                message.sent_at_ms,
                message.client_id,
                message.reply_to
            ],
        )?;
        Ok(())
    }

    /// Queues a message and saves the MLS state that produced it, atomically.
    ///
    /// These two writes must not be separable. Encrypting advances the ratchet,
    /// so the ciphertext in the outbox belongs to generation *N* while the
    /// state on disk still describes *N-1* until it is saved. A crash in the
    /// gap leaves a queued message at *N* and a ratchet that will hand out *N*
    /// again to the next one -- RFC 9420 6.3.1 names this exactly: "If this
    /// persistent state is lost or corrupted, a client might reuse a generation
    /// that has already been used, causing reuse of a key/nonce pair."
    ///
    /// The four-byte reuse guard the same section mandates makes an actual
    /// nonce collision a 2^-32 event rather than a certainty, which is why this
    /// was a latent bug and not a live one. It is still one `BEGIN`.
    ///
    /// `unchecked_transaction` rather than `transaction`: the latter needs
    /// `&mut Connection` and everything here holds `&self`, which is what lets
    /// the store be shared. The "unchecked" part is that it cannot statically
    /// prevent a nested transaction; there are none in this file.
    pub fn enqueue_with_mls_state(
        &self,
        item: &OutboxItem,
        mls_state: &[u8],
    ) -> Result<(), StoreError> {
        let tx = self.connection.unchecked_transaction()?;
        Self::enqueue_on(&tx, item)?;
        Self::set_mls_state_on(&tx, mls_state)?;
        tx.commit()?;
        Ok(())
    }

    /// Queues an already-encrypted message for sending.
    ///
    /// For callers with no ratchet state to persist alongside it. A message
    /// that was just encrypted wants [`EncryptedStore::enqueue_with_mls_state`]
    /// instead, so the two land together.
    pub fn enqueue(&self, item: &OutboxItem) -> Result<(), StoreError> {
        Self::enqueue_on(&self.connection, item)
    }

    /// The insert itself, against whichever handle the caller has -- the
    /// connection, or a transaction on it.
    fn enqueue_on(conn: &rusqlite::Connection, item: &OutboxItem) -> Result<(), StoreError> {
        conn.execute(
            "INSERT INTO outbox
                 (client_msg_id, conversation_id, ciphertext, epoch, is_commit,
                  body, payload, queued_at_ms, client_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (client_msg_id) DO NOTHING",
            rusqlite::params![
                item.client_msg_id,
                item.conversation_id,
                item.ciphertext,
                item.epoch,
                item.is_commit,
                item.body,
                item.payload,
                item.queued_at_ms,
                item.client_id
            ],
        )?;
        Ok(())
    }

    /// Everything waiting to be sent, oldest first.
    pub fn outbox(&self) -> Result<Vec<OutboxItem>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT client_msg_id, conversation_id, ciphertext, epoch, is_commit,
                    body, payload, queued_at_ms, attempts, last_error, client_id
             FROM outbox ORDER BY seq",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(OutboxItem {
                client_msg_id: row.get(0)?,
                conversation_id: row.get(1)?,
                ciphertext: row.get(2)?,
                epoch: row.get(3)?,
                is_commit: row.get(4)?,
                body: row.get(5)?,
                payload: row.get(6)?,
                queued_at_ms: row.get(7)?,
                attempts: row.get(8)?,
                last_error: row.get(9)?,
                client_id: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// How many messages are waiting.
    pub fn outbox_len(&self) -> Result<i64, StoreError> {
        Ok(self
            .connection
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?)
    }

    /// Removes a message that was accepted by the server.
    pub fn dequeue(&self, client_msg_id: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "DELETE FROM outbox WHERE client_msg_id = ?1",
            [client_msg_id],
        )?;
        Ok(())
    }

    /// Records a failed attempt, so the UI can say why and how often.
    ///
    /// Nothing is dropped after N attempts. A message the user believes they
    /// sent must not disappear because a server was unreachable for a while;
    /// it stays queued, visibly, until it is sent or the user deletes it.
    pub fn record_attempt(&self, client_msg_id: &str, error: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE outbox
             SET attempts = attempts + 1, last_error = ?2
             WHERE client_msg_id = ?1",
            rusqlite::params![client_msg_id, error],
        )?;
        Ok(())
    }

    /// The stored payload for one message, if it has one.
    pub fn message_payload(&self, envelope_id: i64) -> Result<Option<String>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT payload FROM messages WHERE envelope_id = ?1",
                [envelope_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Messages in a conversation, oldest first.
    pub fn messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>, StoreError> {
        // The pin is joined in rather than fetched separately: a second query
        // and a merge in the caller would be one more place for the two to
        // disagree about what is pinned.
        let mut statement = self.connection.prepare(
            "SELECT m.envelope_id, m.sender_device_id, m.body, m.payload, m.sent_at_ms,
                    m.client_id, m.retracted_at_ms, m.edited_at_ms, m.reply_to,
                    p.envelope_id IS NOT NULL AS pinned
             FROM messages m
             LEFT JOIN pinned_messages p
                 ON p.conversation_id = m.conversation_id
                AND p.envelope_id = m.envelope_id
             WHERE m.conversation_id = ?1
             ORDER BY m.envelope_id",
        )?;
        let rows = statement.query_map([conversation_id], |row| {
            Ok(StoredMessage {
                envelope_id: row.get(0)?,
                sender_device_id: row.get(1)?,
                body: row.get(2)?,
                payload: row.get(3)?,
                sent_at_ms: row.get(4)?,
                client_id: row.get(5)?,
                retracted_at_ms: row.get(6)?,
                edited_at_ms: row.get(7)?,
                reply_to: row.get(8)?,
                pinned: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Remember a story and the key that opens it.
    ///
    /// Keyed by the server's id, so the same story arriving down two
    /// conversations is one row rather than two.
    pub fn insert_story(&self, story: &StoredStory) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO stories
                 (id, author_handle, author_device_id, s3_key, enc_key, nonce,
                  sha256, mime, size, created_at_ms, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT (id) DO NOTHING",
            rusqlite::params![
                story.id,
                story.author_handle,
                story.author_device_id,
                story.s3_key,
                story.enc_key,
                story.nonce,
                story.sha256,
                story.mime,
                story.size,
                story.created_at_ms,
                story.expires_at_ms,
            ],
        )?;
        Ok(())
    }

    /// Live stories, and — as a side effect — the end of the expired ones.
    ///
    /// The purge is the point, not housekeeping. Filtering expired stories out
    /// of a read would leave their keys on disk, and a key is the whole of what
    /// somebody was promised would go: the ciphertext is meaningless without
    /// it. Doing it here means it happens whenever anybody looks, offline
    /// included, with no scheduled work anywhere.
    pub fn live_stories(&self, now_ms: i64) -> Result<Vec<StoredStory>, StoreError> {
        self.connection
            .execute("DELETE FROM stories WHERE expires_at_ms <= ?1", [now_ms])?;

        let mut statement = self.connection.prepare(
            "SELECT id, author_handle, author_device_id, s3_key, enc_key, nonce,
                    sha256, mime, size, created_at_ms, expires_at_ms
             FROM stories
             ORDER BY created_at_ms DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(StoredStory {
                id: row.get(0)?,
                author_handle: row.get(1)?,
                author_device_id: row.get(2)?,
                s3_key: row.get(3)?,
                enc_key: row.get(4)?,
                nonce: row.get(5)?,
                sha256: row.get(6)?,
                mime: row.get(7)?,
                size: row.get(8)?,
                created_at_ms: row.get(9)?,
                expires_at_ms: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The unsent message for a conversation, if there is one.
    pub fn draft(&self, conversation_id: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT body FROM drafts WHERE conversation_id = ?1",
                [conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Every conversation that has one, so the list can mark them in one read.
    pub fn conversations_with_drafts(&self) -> Result<Vec<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT conversation_id FROM drafts")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Saves what somebody has typed but not sent.
    ///
    /// An empty body deletes the row rather than storing a blank one: a draft
    /// somebody cleared is a draft that should leave nothing behind, and a
    /// conversation with an empty draft would still be marked as having one.
    pub fn set_draft(
        &self,
        conversation_id: &str,
        body: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        if body.trim().is_empty() {
            self.connection.execute(
                "DELETE FROM drafts WHERE conversation_id = ?1",
                [conversation_id],
            )?;
            return Ok(());
        }
        self.connection.execute(
            "INSERT INTO drafts (conversation_id, body, updated_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (conversation_id) DO UPDATE
                 SET body = excluded.body, updated_at_ms = excluded.updated_at_ms",
            rusqlite::params![conversation_id, body, now_ms],
        )?;
        Ok(())
    }

    /// A folder somebody made, and what is in it.
    ///
    /// Local by construction — see the schema-18 migration.
    pub fn create_folder(&self, name: &str, now_ms: i64) -> Result<i64, StoreError> {
        // Appended rather than inserted: a new folder goes at the end of the
        // rail, where somebody expects to find the thing they just made.
        let position: i64 = self
            .connection
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM folders",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        self.connection.execute(
            "INSERT INTO folders (name, position, created_at_ms) VALUES (?1, ?2, ?3)",
            rusqlite::params![name, position, now_ms],
        )?;
        Ok(self.connection.last_insert_rowid())
    }

    /// Renames a folder. A name is the whole of what a folder is to a person.
    pub fn rename_folder(&self, id: i64, name: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE folders SET name = ?2 WHERE id = ?1",
            rusqlite::params![id, name],
        )?;
        Ok(())
    }

    /// Removes a folder. Its memberships go with it, never its conversations.
    pub fn delete_folder(&self, id: i64) -> Result<(), StoreError> {
        // Deleted explicitly rather than left to the cascade: SQLite enforces
        // `ON DELETE CASCADE` only with `PRAGMA foreign_keys` on, and whether
        // that is set is not this statement's business to depend on.
        self.connection
            .execute("DELETE FROM folder_members WHERE folder_id = ?1", [id])?;
        self.connection
            .execute("DELETE FROM folders WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Puts a conversation in a folder, or takes it out.
    ///
    /// Filing something already filed is a no-op rather than an error: the
    /// caller wanted it in the folder, and it is.
    pub fn set_folder_member(
        &self,
        folder_id: i64,
        conversation_id: &str,
        member: bool,
    ) -> Result<(), StoreError> {
        if member {
            self.connection.execute(
                "INSERT INTO folder_members (folder_id, conversation_id)
                 VALUES (?1, ?2)
                 ON CONFLICT (folder_id, conversation_id) DO NOTHING",
                rusqlite::params![folder_id, conversation_id],
            )?;
        } else {
            self.connection.execute(
                "DELETE FROM folder_members WHERE folder_id = ?1 AND conversation_id = ?2",
                rusqlite::params![folder_id, conversation_id],
            )?;
        }
        Ok(())
    }

    /// Every folder, in rail order, with what each one holds.
    pub fn folders(&self) -> Result<Vec<StoredFolder>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, name FROM folders ORDER BY position, id")?;
        let rows: Vec<(i64, String)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        let mut folders = Vec::with_capacity(rows.len());
        for (id, name) in rows {
            let mut members = self
                .connection
                .prepare("SELECT conversation_id FROM folder_members WHERE folder_id = ?1")?;
            let conversations = members
                .query_map([id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            folders.push(StoredFolder {
                id,
                name,
                conversations,
            });
        }
        Ok(folders)
    }

    /// Remembers a view-once message and the key that opens it.
    ///
    /// `enc_key` is `None` for our own sends: we have the original on disk, and
    /// keeping a key that lets the sender reopen what the recipient cannot
    /// would make the bubble's wording untrue on one side of the conversation.
    pub fn insert_view_once(&self, item: &StoredViewOnce) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO view_once
                 (client_id, conversation_id, s3_key, enc_key, nonce, sha256,
                  mime, size, received_at_ms, opened_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (client_id) DO NOTHING",
            rusqlite::params![
                item.client_id,
                item.conversation_id,
                item.s3_key,
                item.enc_key,
                item.nonce,
                item.sha256,
                item.mime,
                item.size,
                item.received_at_ms,
                item.opened_at_ms,
            ],
        )?;
        Ok(())
    }

    /// One view-once message, if this device knows of it.
    pub fn view_once(&self, client_id: &str) -> Result<Option<StoredViewOnce>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT client_id, conversation_id, s3_key, enc_key, nonce, sha256,
                        mime, size, received_at_ms, opened_at_ms
                 FROM view_once WHERE client_id = ?1",
                [client_id],
                |row| {
                    Ok(StoredViewOnce {
                        client_id: row.get(0)?,
                        conversation_id: row.get(1)?,
                        s3_key: row.get(2)?,
                        enc_key: row.get(3)?,
                        nonce: row.get(4)?,
                        sha256: row.get(5)?,
                        mime: row.get(6)?,
                        size: row.get(7)?,
                        received_at_ms: row.get(8)?,
                        opened_at_ms: row.get(9)?,
                    })
                },
            )
            .optional()?)
    }

    /// Every view-once message in a conversation, so the thread can draw them
    /// without asking once per bubble.
    pub fn view_once_in(&self, conversation_id: &str) -> Result<Vec<StoredViewOnce>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT client_id, conversation_id, s3_key, enc_key, nonce, sha256,
                    mime, size, received_at_ms, opened_at_ms
             FROM view_once WHERE conversation_id = ?1",
        )?;
        let rows = statement.query_map([conversation_id], |row| {
            Ok(StoredViewOnce {
                client_id: row.get(0)?,
                conversation_id: row.get(1)?,
                s3_key: row.get(2)?,
                enc_key: row.get(3)?,
                nonce: row.get(4)?,
                sha256: row.get(5)?,
                mime: row.get(6)?,
                size: row.get(7)?,
                received_at_ms: row.get(8)?,
                opened_at_ms: row.get(9)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Destroys the key that opens a view-once message.
    ///
    /// **This is the feature, not bookkeeping around it.** After this the
    /// object in the bucket cannot be decrypted by this device again — the only
    /// copy of its key was the one just overwritten. The row stays so the
    /// bubble can still say what was there and when it was opened.
    ///
    /// Called *after* the plaintext has been produced, never before: a burn
    /// that ran first would lose the file to a failed download.
    pub fn burn_view_once(&self, client_id: &str, now_ms: i64) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE view_once
                SET enc_key = NULL, nonce = NULL, sha256 = NULL, opened_at_ms = ?2
              WHERE client_id = ?1",
            rusqlite::params![client_id, now_ms],
        )?;
        Ok(())
    }

    /// The message a name refers to, if this device has it.
    ///
    /// Returns the sender and the send time, which is exactly what deciding an
    /// edit or a retraction needs: who is allowed, and whether it is in time.
    pub fn message_by_client_id(
        &self,
        conversation_id: &str,
        client_id: &str,
    ) -> Result<Option<(i64, Option<String>, i64)>, StoreError> {
        Ok(self
            .connection
            .query_row(
                "SELECT envelope_id, sender_device_id, sent_at_ms
                 FROM messages WHERE conversation_id = ?1 AND client_id = ?2",
                rusqlite::params![conversation_id, client_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?)
    }

    /// Empty a message in place, leaving the row where it was.
    ///
    /// Not a delete — see the schema-14 migration. The row stays because
    /// `envelope_id` is the sync cursor's key and the FTS rowid, and because
    /// the gap is part of what happened. Emptying `body` is what takes the
    /// message out of the search index, through the trigger that already
    /// exists.
    pub fn retract_message(
        &self,
        conversation_id: &str,
        client_id: &str,
        retracted_at_ms: i64,
    ) -> Result<(), StoreError> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE messages
             SET body = '', payload = NULL, retracted_at_ms = ?3
             WHERE conversation_id = ?1 AND client_id = ?2",
            rusqlite::params![conversation_id, client_id, retracted_at_ms],
        )?;
        // The reactions go with it.
        //
        // They were left behind, and the tombstone rendered as "You took this
        // back" with a thumbs-up still under it: a reaction to content that no
        // longer exists, and a signal about a message somebody asked every app
        // to forget. Taking a message back has to take back what was hung on
        // it.
        transaction.execute(
            "DELETE FROM message_reactions
             WHERE conversation_id = ?1 AND message_client_id = ?2",
            rusqlite::params![conversation_id, client_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Replace what a message says.
    ///
    /// `edited_at_ms` is the sender's own clock, kept so the bubble can carry a
    /// quiet mark. Nothing decides anything by it.
    pub fn edit_message(
        &self,
        conversation_id: &str,
        client_id: &str,
        body: &str,
        edited_at_ms: i64,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE messages
             SET body = ?3, edited_at_ms = ?4
             WHERE conversation_id = ?1 AND client_id = ?2
               AND retracted_at_ms IS NULL",
            rusqlite::params![conversation_id, client_id, body, edited_at_ms],
        )?;
        Ok(())
    }

    /// Record or withdraw a reaction.
    ///
    /// Idempotent in both directions: reacting twice with the same emoji is
    /// one reaction, and withdrawing one that was never there is not an error.
    /// Both are things a double tap produces.
    pub fn set_reaction(
        &self,
        conversation_id: &str,
        message_client_id: &str,
        reactor_device_id: &str,
        emoji: &str,
        on: bool,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        if on {
            self.connection.execute(
                "INSERT INTO message_reactions
                     (message_client_id, conversation_id, reactor_device_id, emoji, reacted_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (message_client_id, reactor_device_id, emoji) DO NOTHING",
                rusqlite::params![
                    message_client_id,
                    conversation_id,
                    reactor_device_id,
                    emoji,
                    now_ms
                ],
            )?;
        } else {
            self.connection.execute(
                "DELETE FROM message_reactions
                 WHERE message_client_id = ?1 AND reactor_device_id = ?2 AND emoji = ?3",
                rusqlite::params![message_client_id, reactor_device_id, emoji],
            )?;
        }
        Ok(())
    }

    /// Every reaction in a conversation, grouped per message.
    ///
    /// The shape is `posts.rs`'s — emoji, count, and whether it is ours — so
    /// the reaction pills the feed already draws are reusable unchanged.
    /// `mine` is decided against this account's device id rather than against
    /// a NULL, for the reason in the schema-13 migration.
    pub fn reactions(
        &self,
        conversation_id: &str,
        my_device_id: Option<&str>,
    ) -> Result<HashMap<String, Vec<StoredReaction>>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT message_client_id, emoji, COUNT(*) AS n,
                    MAX(reactor_device_id = ?2) AS mine
             FROM message_reactions
             WHERE conversation_id = ?1
             GROUP BY message_client_id, emoji
             ORDER BY n DESC, emoji",
        )?;
        let rows = statement.query_map(
            rusqlite::params![conversation_id, my_device_id.unwrap_or("")],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    StoredReaction {
                        emoji: row.get(1)?,
                        count: row.get(2)?,
                        mine: row.get::<_, i64>(3)? != 0,
                    },
                ))
            },
        )?;
        let mut out: HashMap<String, Vec<StoredReaction>> = HashMap::new();
        for row in rows {
            let (target, reaction) = row?;
            out.entry(target).or_default().push(reaction);
        }
        Ok(out)
    }

    /// Remove a message from this device, for good.
    ///
    /// The row goes, rather than gaining a hidden flag, and that single choice
    /// answers four questions at once: it leaves [`messages`](Self::messages),
    /// it leaves the FTS index through the existing delete trigger, it leaves
    /// the conversation list's preview, and it leaves the attachment strip. A
    /// flag would have to be taught to each of those separately, and the first
    /// one anybody forgot would surface a message the person believed gone.
    ///
    /// It cannot come back, either: `set_conversation_cursor` never moves a
    /// cursor backwards, so the sync that would re-fetch it never asks.
    ///
    /// If the message is still queued it is dropped from the outbox in the
    /// same transaction and never sent at all — which is the one case where
    /// "delete for me" and "delete for everyone" are the same act.
    pub fn delete_message(
        &self,
        conversation_id: &str,
        envelope_id: i64,
    ) -> Result<(), StoreError> {
        let transaction = self.connection.unchecked_transaction()?;
        // The name first, while the row still exists, so the outbox can be
        // cleared by the same name the message answers to.
        let client_id: Option<String> = transaction
            .query_row(
                "SELECT client_id FROM messages WHERE conversation_id = ?1 AND envelope_id = ?2",
                rusqlite::params![conversation_id, envelope_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();

        transaction.execute(
            "DELETE FROM messages WHERE conversation_id = ?1 AND envelope_id = ?2",
            rusqlite::params![conversation_id, envelope_id],
        )?;
        transaction.execute(
            "DELETE FROM pinned_messages WHERE conversation_id = ?1 AND envelope_id = ?2",
            rusqlite::params![conversation_id, envelope_id],
        )?;
        if let Some(name) = client_id {
            transaction.execute(
                "DELETE FROM outbox WHERE conversation_id = ?1 AND client_id = ?2",
                rusqlite::params![conversation_id, name],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Pin or unpin a message, on this device.
    ///
    /// Nothing is sent. See the schema-12 migration for why a shared pin was
    /// rejected: the cap cannot be enforced where no single party may count.
    pub fn set_pinned(
        &self,
        conversation_id: &str,
        envelope_id: i64,
        pinned: bool,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        if pinned {
            self.connection.execute(
                "INSERT INTO pinned_messages (conversation_id, envelope_id, pinned_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT (conversation_id, envelope_id) DO NOTHING",
                rusqlite::params![conversation_id, envelope_id, now_ms],
            )?;
        } else {
            self.connection.execute(
                "DELETE FROM pinned_messages
                 WHERE conversation_id = ?1 AND envelope_id = ?2",
                rusqlite::params![conversation_id, envelope_id],
            )?;
        }
        Ok(())
    }

    /// What is pinned in a conversation, newest pin first.
    pub fn pinned_messages(&self, conversation_id: &str) -> Result<Vec<StoredMessage>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT m.envelope_id, m.sender_device_id, m.body, m.payload, m.sent_at_ms,
                    m.client_id, m.retracted_at_ms, m.edited_at_ms, m.reply_to
             FROM pinned_messages p
             JOIN messages m
                 ON m.conversation_id = p.conversation_id
                AND m.envelope_id = p.envelope_id
             WHERE p.conversation_id = ?1
             ORDER BY p.pinned_at_ms DESC",
        )?;
        let rows = statement.query_map([conversation_id], |row| {
            Ok(StoredMessage {
                envelope_id: row.get(0)?,
                sender_device_id: row.get(1)?,
                body: row.get(2)?,
                payload: row.get(3)?,
                sent_at_ms: row.get(4)?,
                client_id: row.get(5)?,
                retracted_at_ms: row.get(6)?,
                edited_at_ms: row.get(7)?,
                reply_to: row.get(8)?,
                pinned: true,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Remembers a conversation and its sync cursor.
    pub fn set_conversation_cursor(
        &self,
        conversation_id: &str,
        last_envelope_id: i64,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO conversations (id, last_envelope_id) VALUES (?1, ?2)
             ON CONFLICT (id) DO UPDATE SET
                 -- Never move a cursor backwards: an out-of-order write would
                 -- replay messages the client already has.
                 last_envelope_id = max(excluded.last_envelope_id, conversations.last_envelope_id)",
            rusqlite::params![conversation_id, last_envelope_id],
        )?;
        Ok(())
    }

    /// Where a conversation's sync should resume from.
    pub fn conversation_cursor(&self, conversation_id: &str) -> Result<i64, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT last_envelope_id FROM conversations WHERE id = ?1")?;
        let mut rows = statement.query([conversation_id])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(0),
        }
    }

    /// Removes a conversation and everything this device holds about it.
    ///
    /// Local only, and the name of the command above it says so. There is no
    /// "delete for everyone" behind this and there cannot be: the other
    /// members hold their own copies, and the server holds ciphertext it
    /// deletes on acknowledgement rather than on request.
    ///
    /// What goes is the message history, anything queued for it in the outbox,
    /// and the conversation row itself with its cursor and title. The MLS
    /// group state is not touched here -- it lives in `mls_state`, keyed by
    /// the provider, and dropping half of a group's cryptographic state while
    /// the server still lists us as a member is how a client ends up unable to
    /// read anything anyone sends it afterwards. Rejoining happens the
    /// ordinary way, through the next Welcome.
    ///
    /// One transaction, because a history without its conversation row is a
    /// set of messages the UI cannot reach and cannot delete -- and because a
    /// deletion without its tombstone is a conversation that comes back on the
    /// next sync.
    pub fn delete_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        let tx = self.connection.unchecked_transaction()?;
        // Read before the row goes: the cursor is how far this device had got,
        // and it is what decides later whether anything new has arrived.
        let through: i64 = tx
            .query_row(
                "SELECT last_envelope_id FROM conversations WHERE id = ?1",
                [conversation_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        tx.execute(
            "DELETE FROM outbox WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        tx.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
        tx.execute(
            "INSERT INTO forgotten_conversations (id, through_envelope_id)
             VALUES (?1, ?2)
             ON CONFLICT (id) DO UPDATE SET
                 -- Never move a tombstone backwards, for the same reason a
                 -- cursor never moves backwards: a stale write would resurrect
                 -- a conversation the person has removed twice.
                 through_envelope_id = max(excluded.through_envelope_id,
                                           forgotten_conversations.through_envelope_id)",
            rusqlite::params![conversation_id, through],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Every conversation this device was told to forget, and how far.
    ///
    /// The value is the newest envelope that existed when it was removed. A
    /// conversation whose newest envelope is still that one stays gone; one
    /// that has a newer envelope has been written in since, and comes back.
    pub fn forgotten_conversations(&self) -> Result<HashMap<String, i64>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, through_envelope_id FROM forgotten_conversations")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
    }

    /// Lifts a tombstone, so the conversation may be created locally again.
    ///
    /// Called when something newer arrives and when somebody deliberately
    /// opens a conversation with that person again -- asking for it back is a
    /// clearer instruction than any envelope.
    pub fn remember_conversation(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "DELETE FROM forgotten_conversations WHERE id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }

    /// Every conversation this device knows about.
    pub fn conversation_ids(&self) -> Result<Vec<String>, StoreError> {
        let mut statement = self.connection.prepare("SELECT id FROM conversations")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every conversation, with its title where one is known.
    pub fn conversations(&self) -> Result<Vec<StoredConversation>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, title, kind, members, avatar_payload FROM conversations")?;
        let rows = statement.query_map([], |row| {
            let members: Option<String> = row.get(3)?;
            Ok(StoredConversation {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                // A row written before the server said who was in it, or by a
                // version that did not ask. Empty is the honest answer.
                members: members
                    .and_then(|raw| serde_json::from_str(&raw).ok())
                    .unwrap_or_default(),
                has_avatar: row.get::<_, Option<String>>(4)?.is_some(),
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Remembers the payload that describes a conversation's picture.
    pub fn set_conversation_avatar(
        &self,
        conversation_id: &str,
        payload: &str,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO conversations (id, avatar_payload) VALUES (?1, ?2)
             ON CONFLICT (id) DO UPDATE SET avatar_payload = excluded.avatar_payload",
            rusqlite::params![conversation_id, payload],
        )?;
        Ok(())
    }

    /// The payload for a conversation's picture, if it has one.
    pub fn conversation_avatar(&self, conversation_id: &str) -> Result<Option<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare("SELECT avatar_payload FROM conversations WHERE id = ?1")?;
        let mut rows = statement.query([conversation_id])?;
        match rows.next()? {
            Some(row) => Ok(row.get(0)?),
            None => Ok(None),
        }
    }

    /// Messages matching a search term, newest first.
    ///
    /// The term is treated as literal text, not as FTS5 query syntax. Somebody
    /// searching for `AND` means the word; quoting it is what stops the parser
    /// reading it as an operator, and a bare `"` in the term would otherwise be
    /// a syntax error rather than a search.
    ///
    /// Prefix-matched on the last token, so results appear while typing rather
    /// than only on a completed word.
    pub fn search_messages(
        &self,
        term: &str,
        conversation_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<SearchHit>, StoreError> {
        let cleaned = term.trim();
        if cleaned.is_empty() {
            return Ok(Vec::new());
        }

        // Each token quoted, the last one given a prefix star. `""` is how FTS5
        // escapes a quote inside a quoted string.
        let mut tokens: Vec<String> = cleaned
            .split_whitespace()
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if let Some(last) = tokens.last_mut() {
            last.push('*');
        }
        let query = tokens.join(" ");

        let mut statement = self.connection.prepare(
            // The conversation filter is inside the query rather than applied
            // to its result, and that is not a tidiness point: `LIMIT` runs
            // last, so filtering afterwards would search the newest N messages
            // *anywhere* and then show whichever happened to be in this
            // conversation. In a quiet chat beside a busy one that finds
            // nothing, which reads as "no matches" rather than as a truncated
            // search.
            "SELECT m.envelope_id, m.conversation_id, m.body, m.sent_at_ms,
                    m.sender_device_id
             FROM messages_fts f
             JOIN messages m ON m.envelope_id = f.rowid
             WHERE messages_fts MATCH ?1
               AND (?2 IS NULL OR m.conversation_id = ?2)
             ORDER BY m.sent_at_ms DESC
             LIMIT ?3",
        )?;
        let rows =
            statement.query_map(rusqlite::params![query, conversation_id, limit], |row| {
                Ok(SearchHit {
                    envelope_id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    body: row.get(2)?,
                    sent_at_ms: row.get(3)?,
                    outgoing: row.get::<_, Option<String>>(4)?.is_none(),
                })
            })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Replace the cached map with what the server just returned.
    ///
    /// Wholesale, in one transaction: a pin that has gone is gone, and a
    /// half-written map is never visible to a reader. The list is small enough
    /// that reconciling row by row would be more code for no gain.
    pub fn cache_meet_pins(&self, pins: &[MeetPin], fetched_at_ms: i64) -> Result<(), StoreError> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM meet_pins", [])?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO meet_pins
                     (handle, display_name, lat, lon, headline, char_config,
                      updated_at_ms, fetched_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for pin in pins {
                statement.execute(rusqlite::params![
                    pin.handle,
                    pin.display_name,
                    pin.lat,
                    pin.lon,
                    pin.headline,
                    pin.char_config,
                    pin.updated_at_ms,
                    fetched_at_ms,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// The map as this device last saw it. Empty before the first fetch.
    pub fn cached_meet_pins(&self) -> Result<Vec<MeetPin>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT handle, display_name, lat, lon, headline, char_config,
                    updated_at_ms, fetched_at_ms
             FROM meet_pins
             ORDER BY handle",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(MeetPin {
                handle: row.get(0)?,
                display_name: row.get(1)?,
                lat: row.get(2)?,
                lon: row.get(3)?,
                headline: row.get(4)?,
                char_config: row.get(5)?,
                updated_at_ms: row.get(6)?,
                fetched_at_ms: row.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Every peer this device has seen in a conversation.
    pub fn peers(&self, conversation_id: &str) -> Result<Vec<StoredPeer>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT device_id, identity_key, first_seen_ms, verified_key, changed_at_ms
             FROM conversation_peers WHERE conversation_id = ?1",
        )?;
        let rows = statement.query_map([conversation_id], |row| {
            Ok(StoredPeer {
                device_id: row.get(0)?,
                identity_key: row.get(1)?,
                first_seen_ms: row.get(2)?,
                verified_key: row.get(3)?,
                changed_at_ms: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Records the members of a conversation, noticing any key that changed.
    ///
    /// Returns the device ids whose key is not the one last seen. A changed key
    /// clears `verified_key` in the same statement: whatever was confirmed out
    /// of band was confirmed about the *old* key, and leaving the mark in place
    /// would carry a human's assurance across to a key they never saw.
    ///
    /// One transaction, because a half-applied membership update would either
    /// lose a change or report one twice.
    pub fn record_peers(
        &self,
        conversation_id: &str,
        peers: &[(String, Vec<u8>)],
        now_ms: i64,
    ) -> Result<Vec<String>, StoreError> {
        let tx = self.connection.unchecked_transaction()?;
        let mut changed = Vec::new();

        for (device_id, identity_key) in peers {
            let previous: Option<Vec<u8>> = tx
                .query_row(
                    "SELECT identity_key FROM conversation_peers
                     WHERE conversation_id = ?1 AND device_id = ?2",
                    rusqlite::params![conversation_id, device_id],
                    |row| row.get(0),
                )
                .optional()?;

            match previous {
                // Known, and unchanged. Nothing to say.
                Some(seen) if seen == *identity_key => {}
                // Known, and different. This is the event.
                Some(_) => {
                    tx.execute(
                        "UPDATE conversation_peers
                         SET identity_key = ?3, changed_at_ms = ?4, verified_key = NULL
                         WHERE conversation_id = ?1 AND device_id = ?2",
                        rusqlite::params![conversation_id, device_id, identity_key, now_ms],
                    )?;
                    changed.push(device_id.clone());
                }
                // First sight. A baseline, not a change -- reporting it would
                // fire on every new conversation and teach people to ignore it.
                None => {
                    tx.execute(
                        "INSERT INTO conversation_peers
                             (conversation_id, device_id, identity_key, first_seen_ms)
                         VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![conversation_id, device_id, identity_key, now_ms],
                    )?;
                }
            }
        }

        tx.commit()?;
        Ok(changed)
    }

    /// Marks every current key in a conversation as verified.
    ///
    /// Records the key itself rather than a flag, so the mark cannot outlive
    /// what it refers to.
    pub fn mark_verified(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE conversation_peers
             SET verified_key = identity_key, changed_at_ms = NULL
             WHERE conversation_id = ?1",
            rusqlite::params![conversation_id],
        )?;
        Ok(())
    }

    /// Dismisses a key-change warning without claiming the new key is verified.
    ///
    /// Deliberately separate from [`mark_verified`](Self::mark_verified). Being
    /// told about a change and choosing to carry on is not the same as having
    /// compared digits, and collapsing the two would let one click produce a
    /// verification nobody performed.
    pub fn acknowledge_key_change(&self, conversation_id: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "UPDATE conversation_peers SET changed_at_ms = NULL WHERE conversation_id = ?1",
            rusqlite::params![conversation_id],
        )?;
        Ok(())
    }

    /// Records what kind of conversation this is and who is in it.
    ///
    /// Creates the row if it does not exist, like the title and cursor setters,
    /// so the three can happen in any order without one clobbering another.
    pub fn set_conversation_meta(
        &self,
        conversation_id: &str,
        kind: &str,
        members: &[String],
    ) -> Result<(), StoreError> {
        let encoded = serde_json::to_string(members).unwrap_or_else(|_| "[]".to_string());
        self.connection.execute(
            "INSERT INTO conversations (id, kind, members) VALUES (?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, members = excluded.members",
            rusqlite::params![conversation_id, kind, encoded],
        )?;
        Ok(())
    }

    /// Names a conversation.
    ///
    /// Creates the row if it does not exist yet, so naming and cursor-setting
    /// can happen in either order without one clobbering the other.
    pub fn set_conversation_title(
        &self,
        conversation_id: &str,
        title: &str,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO conversations (id, title) VALUES (?1, ?2)
             ON CONFLICT (id) DO UPDATE SET title = excluded.title",
            rusqlite::params![conversation_id, title],
        )?;
        Ok(())
    }
}

/// One message that matched a search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    /// The server's envelope id, which addresses the message.
    pub envelope_id: i64,
    /// Which conversation it is in, so the UI can open it.
    pub conversation_id: String,
    /// The plaintext body that matched.
    pub body: String,
    /// When the server received it.
    pub sent_at_ms: i64,
    /// Whether this device sent it.
    pub outgoing: bool,
}

/// A folder somebody made, and the conversations they filed in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFolder {
    /// The row id, which is what the UI refers to a folder by.
    pub id: i64,
    /// What they called it.
    pub name: String,
    /// Conversation ids, unordered — the list orders by activity, as always.
    pub conversations: Vec<String>,
}

/// A view-once message, and the key that opens it exactly once.
///
/// The key is here rather than in `messages.payload` because it has to be able
/// to disappear, and that column does not — see the schema-17 migration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredViewOnce {
    /// The sender's name for the message. Everything about it is keyed by this.
    pub client_id: String,
    /// Which conversation it belongs to, so a thread can read its own in one go.
    pub conversation_id: String,
    /// Where the ciphertext is. Kept after opening: it is not a secret, and the
    /// object is meaningless without the key that no longer exists.
    pub s3_key: String,
    /// The AES-256-GCM key, hex. `None` once opened, and for our own sends.
    pub enc_key: Option<String>,
    /// The nonce, hex. Goes with the key.
    pub nonce: Option<String>,
    /// SHA-256 of the plaintext, hex. Goes with the key.
    pub sha256: Option<String>,
    /// What kind of thing it was, so the bubble can say "Photo" or "Video"
    /// after there is nothing left to show.
    pub mime: String,
    /// Plaintext size in bytes, as the sender declared it.
    pub size: i64,
    /// When this device learned of it.
    pub received_at_ms: i64,
    /// When it was opened. `None` means it still can be.
    pub opened_at_ms: Option<i64>,
}

impl StoredViewOnce {
    /// Whether this can still be opened on this device.
    ///
    /// One question with one answer: the key is either there or it is not.
    /// `opened_at_ms` is for saying *when*, and is never what the decision
    /// rests on — two fields that could disagree would eventually disagree.
    #[must_use]
    pub fn openable(&self) -> bool {
        self.enc_key.is_some()
    }
}

/// A story this device was given, and the key that opens it.
///
/// The key is here rather than anywhere else because it is the thing that has
/// to be destroyed when the story expires — see `live_stories`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredStory {
    /// The server's id.
    pub id: i64,
    /// Who posted it, when that is known.
    ///
    /// Empty for a story that arrived over the wire: an envelope names a
    /// *device*, not an account, and inventing a handle from a device id would
    /// put a UUID under somebody's story. The author's own copy has it,
    /// because the server said so when it recorded the story.
    pub author_handle: String,
    /// The device that sent it. Always known for an incoming story.
    pub author_device_id: String,
    /// Where the ciphertext is, in the encrypted bucket.
    pub s3_key: String,
    /// The AES-256-GCM key, hex.
    pub enc_key: String,
    /// The nonce, hex.
    pub nonce: String,
    /// SHA-256 of the plaintext, hex.
    pub sha256: String,
    /// MIME type, sniffed from the bytes.
    pub mime: String,
    /// Plaintext size.
    pub size: i64,
    /// When it was posted.
    pub created_at_ms: i64,
    /// When it stops being available.
    pub expires_at_ms: i64,
}

/// One emoji on a message, and how many used it.
///
/// The same shape `posts.rs` returns for a post, deliberately: the pills in
/// the feed already render it and should not need a second version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredReaction {
    /// The emoji itself.
    pub emoji: String,
    /// How many people used it.
    pub count: i64,
    /// Whether this account is one of them.
    pub mine: bool,
}

/// One pin on the Meet&Greet map, as this device last fetched it.
///
/// A cached copy of what the server returned, kept only so the tab opens on a
/// map rather than on nothing. `char_config` is the JSON exactly as it
/// arrived — this crate does not read it, and the renderer is the only thing
/// that does.
#[derive(Debug, Clone, PartialEq)]
pub struct MeetPin {
    /// Who this is.
    pub handle: String,
    /// What to call them.
    pub display_name: String,
    /// Where the server says they are. Already coarsened when it was stored.
    pub lat: f64,
    /// The other half of the pin.
    pub lon: f64,
    /// Their one line, if they wrote one.
    pub headline: Option<String>,
    /// The NexoChar config, as JSON text.
    pub char_config: String,
    /// When they last moved the pin.
    pub updated_at_ms: i64,
    /// When this device last fetched the map, so a reader can tell how old it is.
    pub fetched_at_ms: i64,
}

/// One peer in a conversation, as this device last saw them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPeer {
    /// The device, which is what MLS names.
    pub device_id: String,
    /// The key currently signing for them.
    pub identity_key: Vec<u8>,
    /// When this device first saw them.
    pub first_seen_ms: i64,
    /// The key that was confirmed out of band, if one ever was. Compare it
    /// with `identity_key`: equal means verified, different means the mark is
    /// stale, absent means never verified.
    pub verified_key: Option<Vec<u8>>,
    /// When the key last changed under a device already known. `None` once
    /// acknowledged.
    pub changed_at_ms: Option<i64>,
}

/// A conversation as the local store knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredConversation {
    /// The conversation id, which is also the MLS group id.
    pub id: String,
    /// A human-readable name, if this device knows one.
    pub title: Option<String>,
    /// `dm` or `group`, once the server has said which.
    pub kind: Option<String>,
    /// Every member's handle, as the server listed them.
    pub members: Vec<String>,
    /// Whether a picture has been set. The payload itself is not handed out
    /// here -- it carries a key, and only the fetch path needs it.
    pub has_avatar: bool,
}

/// A message about to be written to the local history.
///
/// A struct rather than a seventh positional argument. Six was already at the
/// edge -- `insert_message_with_payload(1, "c", None, "hi", None, 0)` is a
/// line nobody reads without counting -- and it is the same reasoning that put
/// `Context` in `crates/client/src/conversations.rs`.
#[derive(Debug, Clone)]
pub struct NewMessage<'a> {
    /// The server's envelope id, which is also the sync cursor.
    pub envelope_id: i64,
    /// Which conversation it belongs to.
    pub conversation_id: &'a str,
    /// Which device sent it. `None` means ours.
    pub sender_device_id: Option<&'a str>,
    /// The plaintext, as the list and the bubble will show it.
    pub body: &'a str,
    /// The encoded payload, where the body alone is not enough.
    pub payload: Option<&'a str>,
    /// When it was sent -- the server's clock for anything incoming, ours for
    /// our own. Nothing compares the two: only our own messages carry a local
    /// time, and nobody else may act on those.
    pub sent_at_ms: i64,
    /// The sender's own name for it, from `Payload::id`.
    pub client_id: Option<&'a str>,
    /// The message this one answers, when it answers one.
    pub reply_to: Option<&'a str>,
}

/// A message as it sits in the local store, already decrypted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMessage {
    /// The server's envelope id, which is also the sync cursor.
    pub envelope_id: i64,
    /// Which device sent it.
    pub sender_device_id: Option<String>,
    /// The plaintext.
    pub body: String,
    /// The encoded payload, for a message that carries a file.
    pub payload: Option<String>,
    /// When the server received it.
    pub sent_at_ms: i64,
    /// The sender's own name for it, when it has one.
    ///
    /// `None` for everything sent before names existed. Nothing can refer to
    /// such a message, and the UI offers no action that would try.
    pub client_id: Option<String>,
    /// When the sender took it back, if they did.
    ///
    /// The row survives a retraction — see the schema-14 migration — so this
    /// is how a reader tells "emptied" from "never said anything".
    pub retracted_at_ms: Option<i64>,
    /// When the sender last changed it, by their own clock. Shown, not judged.
    pub edited_at_ms: Option<i64>,
    /// The `client_id` of the message this one answers, when it answers one.
    ///
    /// Whether that message is *here* is a separate question, and often no:
    /// see the schema-16 migration for why this is not a foreign key.
    pub reply_to: Option<String>,
    /// Pinned **on this device**.
    ///
    /// Local by design, not by omission — see the schema-12 migration. The UI
    /// says "Pinned on this device" for the same reason: claiming it was
    /// pinned for everyone would be a promise nothing here can keep.
    pub pinned: bool,
}

/// One message waiting to be sent.
///
/// Holds ciphertext rather than text: MLS ratchets forward on every
/// encryption, so the bytes for a message exist exactly once and a retry has
/// to send those same bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxItem {
    /// The client's own id for the message, which is what makes a retry
    /// idempotent on the server.
    pub client_msg_id: String,
    /// Which conversation it belongs to.
    pub conversation_id: String,
    /// Hex-encoded MLS message.
    pub ciphertext: String,
    /// The epoch it was built against.
    pub epoch: i64,
    /// Whether it carries a commit.
    pub is_commit: bool,
    /// The preview to show while it is pending. Plaintext.
    pub body: String,
    /// The full payload, for an attachment.
    pub payload: Option<String>,
    /// When it was queued.
    pub queued_at_ms: i64,
    /// How many times sending has been tried.
    pub attempts: i64,
    /// Why the last attempt failed.
    pub last_error: Option<String>,
    /// The sender's own name for the message, as it sits inside the
    /// ciphertext.
    ///
    /// Distinct from `client_msg_id`, which is the server's idempotency key.
    /// This one is how the group refers to the message; that one is how the
    /// server refuses a duplicate. Keeping them apart means the server never
    /// holds, in cleartext, the token that appears inside everyone's
    /// ciphertext.
    pub client_id: Option<String>,
}

/// The account this installation is signed in as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// Server-assigned user id.
    pub user_id: i64,
    /// The unique handle.
    pub handle: String,
    /// The display name.
    pub display_name: String,
    /// This device's id, as issued at registration.
    pub device_id: String,
}

/// The default store location, `%APPDATA%\Nexo\store.db`.
pub fn default_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(Path::new(&appdata).join("Nexo").join(STORE_FILE_NAME))
}

/// Deletes the store file and its WAL sidecars.
///
/// Logout does this *and* erases the keyring blob. Either alone is enough to
/// make the data unreadable; doing both means neither a leftover file nor a
/// leftover key is sitting around to worry about.
pub fn delete(path: impl AsRef<Path>) -> Result<(), StoreError> {
    let path = path.as_ref();
    for suffix in ["", "-wal", "-shm"] {
        let target = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            PathBuf::from(format!("{}{suffix}", path.display()))
        };
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

/// Re-exported so callers do not need `zeroize` in scope to hold a key.
pub type KeyBytes = Zeroizing<Vec<u8>>;

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nexo-store-{}-{}-{tag}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn db(&self) -> PathBuf {
            self.0.join(STORE_FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn a_key(byte: u8) -> Vec<u8> {
        vec![byte; key::KEY_LEN]
    }

    #[test]
    fn a_new_store_opens_and_migrates() {
        let dir = TempDir::new("new");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn data_survives_a_reopen() {
        // This is the "register, restart, still signed in" half of M2's
        // definition of done, at the storage layer.
        let dir = TempDir::new("reopen");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(2)).unwrap();
            store
                .set_account(42, "alice", "Alice", "device-uuid")
                .unwrap();
        }
        let store = EncryptedStore::open(dir.db(), &a_key(2)).unwrap();
        let account = store.account().unwrap().unwrap();
        assert_eq!(account.user_id, 42);
        assert_eq!(account.handle, "alice");
        assert_eq!(account.device_id, "device-uuid");
    }

    #[test]
    fn an_empty_store_has_no_account() {
        let dir = TempDir::new("empty");
        let store = EncryptedStore::open(dir.db(), &a_key(3)).unwrap();
        assert!(store.account().unwrap().is_none());
    }

    #[test]
    fn signing_in_again_replaces_the_account_rather_than_adding_one() {
        let dir = TempDir::new("replace");
        let store = EncryptedStore::open(dir.db(), &a_key(4)).unwrap();
        store.set_account(1, "alice", "Alice", "d1").unwrap();
        store.set_account(2, "bob", "Bob", "d2").unwrap();
        let account = store.account().unwrap().unwrap();
        assert_eq!(account.handle, "bob");
        let count: i64 = store
            .connection()
            .query_row("SELECT count(*) FROM account", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "v0.1 is one account per installation");
    }

    /// The half of M2's definition of done that is about the file itself.
    #[test]
    fn the_file_is_not_a_readable_sqlite_database() {
        let dir = TempDir::new("opaque");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(5)).unwrap();
            store
                .set_account(7, "carol", "Carol Plaintext", "device")
                .unwrap();
        }

        let bytes = std::fs::read(dir.db()).unwrap();

        // An unencrypted SQLite file starts with this exact string.
        assert!(
            !bytes.starts_with(b"SQLite format 3\0"),
            "the store must not carry a plaintext SQLite header"
        );
        // And none of the data we put in is findable by scanning.
        for needle in [b"Carol Plaintext".as_slice(), b"carol".as_slice()] {
            assert!(
                !bytes.windows(needle.len()).any(|w| w == needle),
                "found plaintext in the store file"
            );
        }
    }

    /// M2's definition of done, in its own words: "`store.db` is unreadable
    /// with plain `sqlite3`".
    ///
    /// A connection with no `PRAGMA key` is exactly what the `sqlite3` shell
    /// is — SQLCipher only behaves differently once keyed. So opening the file
    /// and never keying it reproduces the check without shelling out.
    #[test]
    fn an_unkeyed_connection_cannot_read_the_store() {
        let dir = TempDir::new("unkeyed");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(11)).unwrap();
            store.set_account(1, "frank", "Frank", "d").unwrap();
        }

        let plain = Connection::open(dir.db()).unwrap();
        let result = plain.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        });
        assert!(
            result.is_err(),
            "an unkeyed connection read the store; it is not encrypted"
        );

        // And specifically because the file is not a database it recognises,
        // rather than because the table happened to be missing.
        let message = result.unwrap_err().to_string();
        assert!(
            message.contains("not a database") || message.contains("encrypted"),
            "unexpected failure reason: {message}"
        );
    }

    #[test]
    fn the_wrong_key_is_refused_rather_than_silently_opening_an_empty_database() {
        let dir = TempDir::new("wrongkey");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(6)).unwrap();
            store.set_account(1, "dave", "Dave", "d").unwrap();
        }
        // Opening with a different key must fail loudly. Rule 7: fail closed.
        // The dangerous alternative is an apparently-empty store, which reads
        // as "you have no messages" rather than "this is not your database".
        let error = EncryptedStore::open(dir.db(), &a_key(99)).unwrap_err();
        assert!(
            matches!(error, StoreError::WrongKey { .. }),
            "expected WrongKey, got {error:?}"
        );
    }

    #[test]
    fn an_identity_survives_a_reopen() {
        // With the account row, this is the whole of "register, restart, still
        // signed in" at the storage layer.
        let dir = TempDir::new("identity");
        let secret = [0x11u8; 32];
        let public = [0x22u8; 32];
        {
            let store = EncryptedStore::open(dir.db(), &a_key(20)).unwrap();
            store.set_identity(&secret, &public).unwrap();
        }
        let store = EncryptedStore::open(dir.db(), &a_key(20)).unwrap();
        let (loaded_secret, loaded_public) = store.identity().unwrap().unwrap();
        assert_eq!(&loaded_secret[..], &secret[..]);
        assert_eq!(loaded_public, public);
    }

    #[test]
    fn deleting_a_conversation_leaves_the_others_alone() {
        // The failure this guards against is a `DELETE` without its `WHERE`,
        // or one keyed on the wrong column: both pass a test that only checks
        // the deleted conversation is gone.
        let dir = TempDir::new("delete-conversation");
        let store = EncryptedStore::open(dir.db(), &a_key(31)).unwrap();

        store
            .insert_message(1, "keep", None, "still here", 1_000)
            .unwrap();
        store
            .insert_message(2, "drop", None, "going", 2_000)
            .unwrap();
        store
            .insert_message(3, "drop", Some("them"), "also going", 3_000)
            .unwrap();
        store.set_conversation_cursor("keep", 1).unwrap();
        store.set_conversation_cursor("drop", 3).unwrap();

        store.delete_conversation("drop").unwrap();

        assert!(store.messages("drop").unwrap().is_empty());
        assert_eq!(store.messages("keep").unwrap().len(), 1);
        let left: Vec<String> = store.conversation_ids().unwrap();
        assert_eq!(left, vec!["keep".to_string()]);
        // The cursor went with the row, so a conversation that comes back
        // starts from the beginning rather than from a number that outlived
        // the history it referred to.
        assert_eq!(store.conversation_cursor("drop").unwrap(), 0);
    }

    #[test]
    fn deleting_a_conversation_that_is_not_there_is_not_an_error() {
        // The UI can ask twice -- a double click, a retry after a slow answer
        // -- and the second one must not surface as a failure.
        let dir = TempDir::new("delete-missing");
        let store = EncryptedStore::open(dir.db(), &a_key(32)).unwrap();
        store.delete_conversation("never-existed").unwrap();
    }

    #[test]
    fn removing_a_conversation_records_how_far_it_had_got() {
        // The whole point of the tombstone. Without the cursor recorded here,
        // `discover` cannot tell "removed, nothing new since" from "never
        // seen", and the conversation reappears on the next sync -- which is
        // exactly what was reported.
        let dir = TempDir::new("forget-through");
        let store = EncryptedStore::open(dir.db(), &a_key(33)).unwrap();

        store.set_conversation_cursor("gone", 42).unwrap();
        store.delete_conversation("gone").unwrap();

        let forgotten = store.forgotten_conversations().unwrap();
        assert_eq!(forgotten.get("gone"), Some(&42));
    }

    fn an_item(id: &str) -> OutboxItem {
        OutboxItem {
            client_msg_id: id.to_string(),
            conversation_id: "c1".to_string(),
            ciphertext: "aabb".to_string(),
            epoch: 3,
            is_commit: false,
            body: "hello".to_string(),
            payload: None,
            queued_at_ms: 1,
            attempts: 0,
            last_error: None,
            client_id: None,
        }
    }

    /// The pair that must not come apart.
    ///
    /// Encrypting advances the ratchet, so a queued ciphertext belongs to a
    /// generation the saved state does not describe until both writes land.
    #[test]
    fn queueing_a_message_saves_the_ratchet_with_it() {
        let dir = TempDir::new("outbox-atomic");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .enqueue_with_mls_state(&an_item("m1"), b"ratchet-at-generation-2")
            .unwrap();

        assert_eq!(store.outbox().unwrap().len(), 1);
        assert_eq!(
            store.mls_state().unwrap().as_deref(),
            Some(&b"ratchet-at-generation-2"[..])
        );
    }

    /// The half that would be silent.
    ///
    /// A failure inside the transaction must leave *neither* write, not the
    /// queued message alone -- that is the state RFC 9420 6.3.1 warns about,
    /// where the next send reuses a generation this one already consumed. The
    /// second insert is forced to fail by reusing a `client_msg_id` under a
    /// deliberate conflict, so the rollback is the real one and not a mock.
    #[test]
    fn a_failed_save_leaves_no_queued_message_behind() {
        let dir = TempDir::new("outbox-rollback");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        // A blob the `mls_state` table will refuse: the id column is
        // `CHECK (id = 1)`, so a NULL blob is fine but a failure has to come
        // from somewhere real. Instead, hold a transaction open and roll it
        // back the way a crash would -- by dropping it without committing.
        {
            let tx = store.connection().unchecked_transaction().unwrap();
            tx.execute(
                "INSERT INTO outbox
                     (client_msg_id, conversation_id, ciphertext, epoch, is_commit,
                      body, payload, queued_at_ms)
                 VALUES ('m2', 'c1', 'aabb', 3, 0, 'hello', NULL, 1)",
                [],
            )
            .unwrap();
            // No commit. Dropping rolls back, which is what a process that
            // dies between the two writes leaves behind.
        }

        assert!(
            store.outbox().unwrap().is_empty(),
            "a rolled-back queue write must leave nothing"
        );
        assert!(
            store.mls_state().unwrap().is_none(),
            "and no ratchet state either"
        );
    }

    /// First sight is a baseline, not an event.
    ///
    /// Reporting it would fire on every new conversation, and a warning that
    /// fires every time is one nobody reads.
    #[test]
    fn the_first_sight_of_a_peer_is_not_a_change() {
        let dir = TempDir::new("peers-first");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        let changed = store
            .record_peers("c1", &[("dev-a".into(), vec![1, 2, 3])], 100)
            .unwrap();
        assert!(changed.is_empty(), "a baseline is not a change");
        assert_eq!(store.peers("c1").unwrap().len(), 1);
    }

    #[test]
    fn seeing_the_same_key_again_is_not_a_change() {
        let dir = TempDir::new("peers-same");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        let peers = [("dev-a".to_string(), vec![1, 2, 3])];

        store.record_peers("c1", &peers, 100).unwrap();
        let changed = store.record_peers("c1", &peers, 200).unwrap();
        assert!(changed.is_empty(), "recording is idempotent");
    }

    /// The event the whole table exists for.
    #[test]
    fn a_key_that_changes_under_a_known_device_is_reported() {
        let dir = TempDir::new("peers-change");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .record_peers("c1", &[("dev-a".into(), vec![1, 2, 3])], 100)
            .unwrap();
        let changed = store
            .record_peers("c1", &[("dev-a".into(), vec![9, 9, 9])], 200)
            .unwrap();

        assert_eq!(changed, vec!["dev-a".to_string()]);
        let peer = &store.peers("c1").unwrap()[0];
        assert_eq!(peer.identity_key, vec![9, 9, 9], "the new key is stored");
        assert_eq!(peer.changed_at_ms, Some(200));
    }

    /// The reason the mark is a key and not a boolean.
    ///
    /// A flag would survive the key it was about. Verification is a statement
    /// concerning one specific key, and it must not be carried across to a key
    /// the person never saw.
    #[test]
    fn a_key_change_clears_a_verification_it_predates() {
        let dir = TempDir::new("peers-verify");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .record_peers("c1", &[("dev-a".into(), vec![1, 2, 3])], 100)
            .unwrap();
        store.mark_verified("c1").unwrap();
        assert_eq!(
            store.peers("c1").unwrap()[0].verified_key.as_deref(),
            Some(&[1u8, 2, 3][..]),
            "verifying records which key was confirmed"
        );

        store
            .record_peers("c1", &[("dev-a".into(), vec![9, 9, 9])], 200)
            .unwrap();
        assert_eq!(
            store.peers("c1").unwrap()[0].verified_key,
            None,
            "the mark does not survive the key it was about"
        );
    }

    /// Acknowledging is not verifying.
    #[test]
    fn acknowledging_clears_the_warning_without_claiming_verification() {
        let dir = TempDir::new("peers-ack");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .record_peers("c1", &[("dev-a".into(), vec![1, 2, 3])], 100)
            .unwrap();
        store
            .record_peers("c1", &[("dev-a".into(), vec![9, 9, 9])], 200)
            .unwrap();

        store.acknowledge_key_change("c1").unwrap();
        let peer = &store.peers("c1").unwrap()[0];
        assert_eq!(peer.changed_at_ms, None, "the warning is dismissed");
        assert_eq!(
            peer.verified_key, None,
            "but nothing has been verified by dismissing it"
        );
    }

    /// The warning has to outlive the window it was shown in.
    #[test]
    fn a_key_change_survives_a_reopen() {
        let dir = TempDir::new("peers-reopen");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            store
                .record_peers("c1", &[("dev-a".into(), vec![1, 2, 3])], 100)
                .unwrap();
            store
                .record_peers("c1", &[("dev-a".into(), vec![9, 9, 9])], 200)
                .unwrap();
        }

        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(
            store.peers("c1").unwrap()[0].changed_at_ms,
            Some(200),
            "closing the app must not dismiss a key-change warning"
        );
    }

    #[test]
    fn peers_are_kept_per_conversation() {
        let dir = TempDir::new("peers-scope");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .record_peers("c1", &[("dev-a".into(), vec![1])], 100)
            .unwrap();
        store
            .record_peers("c2", &[("dev-a".into(), vec![2])], 100)
            .unwrap();

        // The same device with a different key in another conversation is not
        // a change: they are separate groups and separate observations.
        assert_eq!(store.peers("c1").unwrap()[0].identity_key, vec![1]);
        assert_eq!(store.peers("c2").unwrap()[0].identity_key, vec![2]);
    }

    fn a_message(store: &EncryptedStore, id: i64, body: &str) {
        store
            .insert_message(id, "c1", None, body, 1_000 + id)
            .unwrap();
    }

    fn a_pin(handle: &str) -> MeetPin {
        MeetPin {
            handle: handle.into(),
            display_name: handle.to_uppercase(),
            lat: 47.1,
            lon: 8.2,
            headline: Some("here for the mountains".into()),
            char_config: r#"{"topVariant":"hoodie"}"#.into(),
            updated_at_ms: 1_760_000_000_000,
            fetched_at_ms: 0,
        }
    }

    #[test]
    fn the_cached_map_round_trips() {
        let dir = TempDir::new("meet-cache");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert!(store.cached_meet_pins().unwrap().is_empty());

        store
            .cache_meet_pins(&[a_pin("dice"), a_pin("bananaaboy")], 42)
            .unwrap();

        let back = store.cached_meet_pins().unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].handle, "bananaaboy", "ordered by handle");
        assert_eq!(back[1].char_config, r#"{"topVariant":"hoodie"}"#);
        assert!(back.iter().all(|p| p.fetched_at_ms == 42));
    }

    /// A pin that has gone must not linger. The cache is the whole map, not a
    /// pile of every pin ever seen.
    #[test]
    fn caching_the_map_again_replaces_it_rather_than_adding_to_it() {
        let dir = TempDir::new("meet-replace");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        store
            .cache_meet_pins(&[a_pin("dice"), a_pin("gone")], 1)
            .unwrap();
        store.cache_meet_pins(&[a_pin("dice")], 2).unwrap();

        let back = store.cached_meet_pins().unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].handle, "dice");
    }

    /// Upgrading an existing store must not lose it or fail to gain the table.
    #[test]
    fn a_store_from_before_the_map_gains_the_cache() {
        let dir = TempDir::new("meet-upgrade");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            store
                .connection()
                // v11's columns go too: a rollback test restores the shape
                // of the version it claims to be, not just the number.
                .execute_batch(
                    "DROP TABLE meet_pins;
                     DROP INDEX messages_client_id_idx;
                     ALTER TABLE messages DROP COLUMN client_id;
                     ALTER TABLE outbox   DROP COLUMN client_id;
                     PRAGMA user_version = 9;",
                )
                .unwrap();
        }
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.cached_meet_pins().unwrap().is_empty());
    }

    /// Pinning is local, and the flag has to survive the join in `messages`.
    #[test]
    fn a_pin_is_visible_on_the_message_it_pins() {
        let dir = TempDir::new("pin");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "keep this");
        a_message(&store, 2, "and this");

        assert!(store.messages("c1").unwrap().iter().all(|m| !m.pinned));

        store.set_pinned("c1", 2, true, 500).unwrap();

        let rows = store.messages("c1").unwrap();
        assert!(!rows[0].pinned, "1 was not pinned");
        assert!(rows[1].pinned, "2 was");
        assert_eq!(store.pinned_messages("c1").unwrap().len(), 1);

        store.set_pinned("c1", 2, false, 600).unwrap();
        assert!(store.pinned_messages("c1").unwrap().is_empty());
    }

    /// Pinning twice is not two pins, and unpinning what was never pinned is
    /// not an error. Both are things a double tap produces.
    #[test]
    fn pinning_is_idempotent_in_both_directions() {
        let dir = TempDir::new("pin-twice");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "once");

        store.set_pinned("c1", 1, true, 1).unwrap();
        store.set_pinned("c1", 1, true, 2).unwrap();
        assert_eq!(store.pinned_messages("c1").unwrap().len(), 1);

        store.set_pinned("c1", 1, false, 3).unwrap();
        store.set_pinned("c1", 1, false, 4).unwrap();
        assert!(store.pinned_messages("c1").unwrap().is_empty());
    }

    #[test]
    fn a_deleted_message_is_gone_from_the_conversation() {
        let dir = TempDir::new("delete");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "keep");
        a_message(&store, 2, "remove");

        store.delete_message("c1", 2).unwrap();

        let rows = store.messages("c1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].envelope_id, 1);
    }

    /// The reason the row is deleted rather than flagged.
    ///
    /// An external-content FTS table keeps no copy of the body, so the terms
    /// are withdrawn by the delete trigger and by nothing else. A `hidden`
    /// column would leave them in the index, and the message would go on
    /// answering searches after the person believed it gone — which is the
    /// quietest possible way to be wrong.
    #[test]
    fn a_deleted_message_leaves_the_search_index_too() {
        let dir = TempDir::new("delete-fts");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "pemmican");
        assert_eq!(
            store.search_messages("pemmican", None, 10).unwrap().len(),
            1
        );

        store.delete_message("c1", 1).unwrap();

        assert!(
            store
                .search_messages("pemmican", None, 10)
                .unwrap()
                .is_empty(),
            "a flag instead of a delete would have left this findable"
        );
    }

    /// Deleting a pinned message must not leave the pin behind, pointing at
    /// nothing.
    #[test]
    fn deleting_a_pinned_message_takes_the_pin_with_it() {
        let dir = TempDir::new("delete-pinned");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "pinned then deleted");
        store.set_pinned("c1", 1, true, 1).unwrap();

        store.delete_message("c1", 1).unwrap();

        assert!(store.pinned_messages("c1").unwrap().is_empty());
    }

    /// Upgrading an existing store must gain the table without losing anything.
    #[test]
    fn a_store_from_before_pinning_gains_the_table() {
        let dir = TempDir::new("pin-upgrade");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            a_message(&store, 1, "written before pinning existed");
            store
                .connection()
                .execute_batch("DROP TABLE pinned_messages; PRAGMA user_version = 11;")
                .unwrap();
        }
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.pinned_messages("c1").unwrap().is_empty());
        assert_eq!(store.messages("c1").unwrap().len(), 1, "history survived");
    }

    /// Taking a message back takes back what was hung on it.
    ///
    /// The tombstone used to read "You took this back" with the reactions
    /// still under it -- a response to content that is gone, and a signal
    /// about a message somebody asked every app to forget.
    #[test]
    fn retracting_a_message_removes_its_reactions() {
        let dir = TempDir::new("retract-reactions");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .set_reaction("c1", "m1", "them", "\u{1F44D}", true, 1)
            .unwrap();
        assert!(
            store
                .reactions("c1", Some("me"))
                .unwrap()
                .contains_key("m1"),
            "the reaction should be there before the retraction"
        );

        store.retract_message("c1", "m1", 2).unwrap();

        assert!(
            !store
                .reactions("c1", Some("me"))
                .unwrap()
                .contains_key("m1"),
            "a retracted message must carry no reactions"
        );
    }

    #[test]
    fn a_reaction_is_counted_and_marked_as_mine() {
        let dir = TempDir::new("react");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .set_reaction("c1", "m1", "me", "\u{1F44D}", true, 1)
            .unwrap();
        store
            .set_reaction("c1", "m1", "them", "\u{1F44D}", true, 2)
            .unwrap();
        store
            .set_reaction("c1", "m1", "them", "\u{2764}", true, 3)
            .unwrap();

        let all = store.reactions("c1", Some("me")).unwrap();
        let on_m1 = all.get("m1").expect("m1 has reactions");

        let thumb = on_m1.iter().find(|r| r.emoji == "\u{1F44D}").unwrap();
        assert_eq!(thumb.count, 2);
        assert!(thumb.mine, "we used this one");

        let heart = on_m1.iter().find(|r| r.emoji == "\u{2764}").unwrap();
        assert_eq!(heart.count, 1);
        assert!(!heart.mine, "we did not");
    }

    /// The reason `reactor_device_id` is NOT NULL and carries a real id.
    ///
    /// SQLite treats NULLs in a primary key as distinct, so if our own
    /// reactions were stored with NULL the conflict clause would never match
    /// and every repeated tap would add a row.
    #[test]
    fn reacting_twice_with_the_same_emoji_is_one_reaction() {
        let dir = TempDir::new("react-twice");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .set_reaction("c1", "m1", "me", "\u{1F44D}", true, 1)
            .unwrap();
        store
            .set_reaction("c1", "m1", "me", "\u{1F44D}", true, 2)
            .unwrap();

        let all = store.reactions("c1", Some("me")).unwrap();
        assert_eq!(all["m1"][0].count, 1);
    }

    #[test]
    fn a_reaction_can_be_taken_back_and_taking_back_nothing_is_fine() {
        let dir = TempDir::new("react-off");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .set_reaction("c1", "m1", "me", "\u{1F44D}", true, 1)
            .unwrap();
        store
            .set_reaction("c1", "m1", "me", "\u{1F44D}", false, 2)
            .unwrap();
        assert!(store.reactions("c1", Some("me")).unwrap().is_empty());

        // Withdrawing one that was never there is a double tap, not an error.
        store
            .set_reaction("c1", "m1", "me", "\u{1F44D}", false, 3)
            .unwrap();
    }

    /// A reaction whose target this installation never received is kept.
    ///
    /// This is why there is no foreign key: `PRAGMA foreign_keys = ON` is set,
    /// so a declared reference would refuse the row outright — and somebody
    /// reacting to a message that predates this device joining is ordinary.
    #[test]
    fn a_reaction_to_an_unknown_message_is_kept_rather_than_refused() {
        let dir = TempDir::new("react-orphan");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        store
            .set_reaction("c1", "never-arrived", "them", "\u{1F44D}", true, 1)
            .expect("an orphan reaction must be storable");

        let all = store.reactions("c1", Some("me")).unwrap();
        assert_eq!(all["never-arrived"][0].count, 1);
    }

    #[test]
    fn a_store_from_before_reactions_gains_the_table() {
        let dir = TempDir::new("react-upgrade");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            a_message(&store, 1, "written before reactions existed");
            store
                .connection()
                .execute_batch("DROP TABLE message_reactions; PRAGMA user_version = 12;")
                .unwrap();
        }
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.reactions("c1", None).unwrap().is_empty());
        assert_eq!(store.messages("c1").unwrap().len(), 1, "history survived");
    }

    fn a_named_message(store: &EncryptedStore, id: i64, name: &str, body: &str) {
        store
            .insert(&NewMessage {
                envelope_id: id,
                conversation_id: "c1",
                sender_device_id: None,
                body,
                payload: None,
                sent_at_ms: 1_000 + id,
                client_id: Some(name),
                reply_to: None,
            })
            .unwrap();
    }

    #[test]
    fn a_retracted_message_keeps_its_row_and_loses_its_words() {
        let dir = TempDir::new("retract");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_named_message(&store, 1, "m1", "something regrettable");

        store.retract_message("c1", "m1", 9_000).unwrap();

        let rows = store.messages("c1").unwrap();
        assert_eq!(rows.len(), 1, "the row stays: it is the cursor's key");
        assert_eq!(rows[0].body, "");
        assert_eq!(rows[0].retracted_at_ms, Some(9_000));
    }

    /// Emptying the body is what withdraws the terms, through the existing
    /// UPDATE trigger. If it did not, a retracted message would still answer
    /// searches — which is the same quiet wrongness a `hidden` flag would have
    /// caused for deletion.
    #[test]
    fn a_retracted_message_leaves_the_search_index() {
        let dir = TempDir::new("retract-fts");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_named_message(&store, 1, "m1", "quinoa");
        assert_eq!(store.search_messages("quinoa", None, 10).unwrap().len(), 1);

        store.retract_message("c1", "m1", 9_000).unwrap();

        assert!(
            store
                .search_messages("quinoa", None, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_edit_replaces_the_words_and_is_findable_by_the_new_ones() {
        let dir = TempDir::new("edit");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_named_message(&store, 1, "m1", "teh meeting is at five");

        store
            .edit_message("c1", "m1", "the meeting is at six", 9_000)
            .unwrap();

        let rows = store.messages("c1").unwrap();
        assert_eq!(rows[0].body, "the meeting is at six");
        assert_eq!(rows[0].edited_at_ms, Some(9_000));

        assert_eq!(store.search_messages("six", None, 10).unwrap().len(), 1);
        assert!(
            store.search_messages("five", None, 10).unwrap().is_empty(),
            "the old words go with the old body"
        );
    }

    /// Editing something already taken back would put words back into a
    /// message whose author withdrew it.
    #[test]
    fn a_retracted_message_cannot_be_edited_back_into_existence() {
        let dir = TempDir::new("edit-retracted");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_named_message(&store, 1, "m1", "original");
        store.retract_message("c1", "m1", 9_000).unwrap();

        store
            .edit_message("c1", "m1", "put it back", 9_500)
            .unwrap();

        assert_eq!(store.messages("c1").unwrap()[0].body, "");
    }

    /// Searching inside one conversation must not be the global search with
    /// the wrong rows thrown away afterwards.
    ///
    /// `LIMIT` runs last, so a filter applied to the result would search the
    /// newest N messages anywhere and then keep whichever were in this
    /// conversation. Beside a busy chat, a quiet one would find nothing and
    /// call it "no matches".
    #[test]
    fn searching_one_conversation_does_not_lose_hits_to_the_limit() {
        let dir = TempDir::new("search-scope");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();

        // The wanted hit is the oldest message, in the quiet conversation.
        store
            .insert_message(1, "quiet", None, "pemmican", 1_000)
            .unwrap();
        for id in 2..40 {
            store
                .insert_message(id, "busy", None, "pemmican", 1_000 + id)
                .unwrap();
        }

        let scoped = store
            .search_messages("pemmican", Some("quiet"), 10)
            .unwrap();
        assert_eq!(scoped.len(), 1, "the quiet conversation has one match");
        assert_eq!(scoped[0].conversation_id, "quiet");

        let global = store.search_messages("pemmican", None, 10).unwrap();
        assert_eq!(global.len(), 10, "unscoped search still takes the newest");
    }

    #[test]
    fn a_message_can_be_found_by_its_name() {
        let dir = TempDir::new("by-name");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_named_message(&store, 7, "m7", "hello");

        let (envelope_id, sender, sent_at) =
            store.message_by_client_id("c1", "m7").unwrap().unwrap();
        assert_eq!(envelope_id, 7);
        assert!(sender.is_none(), "ours are stored with no sender");
        assert_eq!(sent_at, 1_007);

        assert!(store.message_by_client_id("c1", "nope").unwrap().is_none());
    }

    #[test]
    fn a_store_from_before_retraction_gains_the_columns() {
        let dir = TempDir::new("retract-upgrade");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            a_named_message(&store, 1, "m1", "written before retraction existed");
        }
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        let rows = store.messages("c1").unwrap();
        assert_eq!(rows.len(), 1, "history survived");
        assert!(rows[0].retracted_at_ms.is_none());
        assert!(rows[0].edited_at_ms.is_none());
    }

    fn a_story(id: i64, expires_at_ms: i64) -> StoredStory {
        StoredStory {
            id,
            author_handle: "dice".into(),
            author_device_id: "dev-a".into(),
            s3_key: format!("enc/x/{id}"),
            enc_key: "aa".repeat(32),
            nonce: "bb".repeat(12),
            sha256: "cc".repeat(32),
            mime: "image/jpeg".into(),
            size: 4096,
            created_at_ms: 1_000,
            expires_at_ms,
        }
    }

    #[test]
    fn a_story_round_trips_with_its_key() {
        let dir = TempDir::new("story");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        store.insert_story(&a_story(1, 100_000)).unwrap();

        let live = store.live_stories(50_000).unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].enc_key, "aa".repeat(32));
    }

    /// The same story arriving down two conversations is one story.
    #[test]
    fn a_story_delivered_twice_is_stored_once() {
        let dir = TempDir::new("story-dup");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        store.insert_story(&a_story(1, 100_000)).unwrap();
        store.insert_story(&a_story(1, 100_000)).unwrap();
        assert_eq!(store.live_stories(50_000).unwrap().len(), 1);
    }

    /// The property the whole design rests on: reading removes the key, not
    /// merely hides the story. Ciphertext without its key is nothing, and a
    /// key left on disk is a promise broken quietly.
    #[test]
    fn reading_destroys_the_key_of_an_expired_story() {
        let dir = TempDir::new("story-expire");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        store.insert_story(&a_story(1, 100_000)).unwrap();
        store.insert_story(&a_story(2, 400_000)).unwrap();

        let live = store.live_stories(200_000).unwrap();
        assert_eq!(live.len(), 1, "the expired one is not returned");
        assert_eq!(live[0].id, 2);

        // And it is gone from the table, not merely filtered out of a read.
        let left: i64 = store
            .connection()
            .query_row("SELECT count(*) FROM stories", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 1, "the expired row and its key were deleted");
    }

    #[test]
    fn a_story_expires_at_its_boundary() {
        let dir = TempDir::new("story-boundary");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        store.insert_story(&a_story(1, 100_000)).unwrap();
        assert!(
            store.live_stories(100_000).unwrap().is_empty(),
            "at the instant it expires it is over"
        );
    }

    #[test]
    fn a_store_from_before_stories_gains_the_table() {
        let dir = TempDir::new("story-upgrade");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            a_message(&store, 1, "written before stories existed");
            store
                .connection()
                .execute_batch("DROP TABLE stories; PRAGMA user_version = 14;")
                .unwrap();
        }
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert!(store.live_stories(1).unwrap().is_empty());
        assert_eq!(store.messages("c1").unwrap().len(), 1, "history survived");
    }

    #[test]
    fn search_finds_a_message_by_a_word_in_it() {
        let dir = TempDir::new("fts-basic");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "the eagle has landed");
        a_message(&store, 2, "nothing to report");

        let hits = store.search_messages("eagle", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].envelope_id, 1);
        assert_eq!(hits[0].conversation_id, "c1");
    }

    /// Results should appear while typing, not only on a finished word.
    #[test]
    fn search_matches_a_prefix_of_the_last_word() {
        let dir = TempDir::new("fts-prefix");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "the eagle has landed");

        assert_eq!(store.search_messages("eag", None, 10).unwrap().len(), 1);
        assert_eq!(store.search_messages("the eag", None, 10).unwrap().len(), 1);
    }

    /// The term is text somebody typed, not a query language.
    ///
    /// `AND`, `OR`, `NOT` and `*` are FTS5 operators; a quote is a syntax
    /// error. Unescaped, searching for any of them returns a database error
    /// rather than a result, which reads as the search being broken.
    #[test]
    fn search_treats_operators_and_quotes_as_literal_text() {
        let dir = TempDir::new("fts-escape");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "salt AND pepper");
        a_message(&store, 2, r#"she said "hello" once"#);

        assert_eq!(
            store.search_messages("AND", None, 10).unwrap().len(),
            1,
            "AND is a word here, not an operator"
        );
        // The point is that this does not error.
        assert!(store.search_messages("\"hello\"", None, 10).is_ok());
        assert!(store.search_messages("*", None, 10).is_ok());
    }

    #[test]
    fn search_ignores_an_empty_term() {
        let dir = TempDir::new("fts-empty");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "something");
        assert!(store.search_messages("   ", None, 10).unwrap().is_empty());
    }

    /// The index must not drift from the messages it indexes.
    ///
    /// An external-content FTS table keeps no copy of the body, so a deletion
    /// has to withdraw the terms explicitly. Without that trigger a search
    /// returns rows whose message is gone.
    #[test]
    fn a_deleted_message_leaves_the_index() {
        let dir = TempDir::new("fts-delete");
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        a_message(&store, 1, "ephemeral");
        assert_eq!(
            store.search_messages("ephemeral", None, 10).unwrap().len(),
            1
        );

        store
            .connection()
            .execute("DELETE FROM messages WHERE envelope_id = 1", [])
            .unwrap();
        assert!(
            store
                .search_messages("ephemeral", None, 10)
                .unwrap()
                .is_empty(),
            "the index must forget what the table forgot"
        );
    }

    /// Messages that predate the upgrade have to be searchable too.
    ///
    /// A search that only found what arrived after the migration would look
    /// broken to anyone with existing history -- which is everyone upgrading.
    #[test]
    fn search_covers_messages_written_before_the_index_existed() {
        let dir = TempDir::new("fts-backfill");

        {
            let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
            a_message(&store, 1, "written beforehand");
            // Drop the index and the triggers, leaving the store as a v8 one:
            // rows in `messages`, nothing in `messages_fts`.
            store
                .connection()
                .execute_batch(
                    // Everything v9 and later added. `add_column` checks
                    // `PRAGMA table_info` and would skip a column already
                    // there, so this is not what keeps the re-run working --
                    // it is that a store claiming to be v8 while carrying
                    // v11's columns is a shape that never existed, and an
                    // upgrade test on it proves nothing about the upgrade.
                    "DROP TRIGGER messages_fts_insert;
                     DROP TRIGGER messages_fts_delete;
                     DROP TRIGGER messages_fts_update;
                     DROP TABLE messages_fts;
                     DROP INDEX messages_client_id_idx;
                     ALTER TABLE messages DROP COLUMN client_id;
                     ALTER TABLE outbox   DROP COLUMN client_id;
                     PRAGMA user_version = 8;",
                )
                .unwrap();
        }

        // Reopening runs migration 9, which backfills.
        let store = EncryptedStore::open(dir.db(), &a_key(1)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);
        assert_eq!(
            store.search_messages("beforehand", None, 10).unwrap().len(),
            1,
            "existing history must be searchable after the upgrade"
        );
    }

    /// A database from before names, opened by a build that has them.
    ///
    /// The upgrade must add the column without touching the rows: every
    /// message already there was sent when there was no name to give it, and
    /// inventing one would make them all answer to the same reference.
    #[test]
    fn a_v10_database_gains_the_column_and_keeps_its_messages() {
        let dir = TempDir::new("schema-11");

        {
            let store = EncryptedStore::open(dir.db(), &a_key(2)).unwrap();
            a_message(&store, 1, "from before names");
            // Back to a v10 store: the column gone, the version rolled back.
            store
                .connection()
                .execute_batch(
                    "DROP INDEX messages_client_id_idx;
                     ALTER TABLE messages DROP COLUMN client_id;
                     ALTER TABLE outbox   DROP COLUMN client_id;
                     PRAGMA user_version = 10;",
                )
                .unwrap();
        }

        let store = EncryptedStore::open(dir.db(), &a_key(2)).unwrap();
        assert_eq!(store.schema_version().unwrap(), SCHEMA_VERSION);

        let messages = store.messages("c1").unwrap();
        assert_eq!(messages.len(), 1, "the message must survive the upgrade");
        assert_eq!(messages[0].body, "from before names");
        assert_eq!(
            messages[0].client_id, None,
            "an old message has no name, and must not be given a made-up one"
        );
    }

    /// Two messages must not answer to one name.
    ///
    fn a_view_once(client_id: &str) -> StoredViewOnce {
        StoredViewOnce {
            client_id: client_id.into(),
            conversation_id: "c1".into(),
            s3_key: "enc/c1/abc".into(),
            enc_key: Some("aa".repeat(32)),
            nonce: Some("bb".repeat(12)),
            sha256: Some("cc".repeat(32)),
            mime: "image/jpeg".into(),
            size: 1234,
            received_at_ms: 1_000,
            opened_at_ms: None,
        }
    }

    #[test]
    fn a_draft_survives_being_written_and_read_back() {
        let dir = TempDir::new("drafts");
        let store = EncryptedStore::open(dir.db(), &a_key(30)).unwrap();
        store.set_draft("c1", "half a thought", 1_000).unwrap();
        assert_eq!(
            store.draft("c1").unwrap().as_deref(),
            Some("half a thought")
        );
    }

    #[test]
    fn clearing_a_draft_leaves_nothing_behind() {
        // Not a blank row: a conversation with an empty draft would still be
        // marked as having one, and a draft somebody cleared should be gone.
        let dir = TempDir::new("drafts-clear");
        let store = EncryptedStore::open(dir.db(), &a_key(31)).unwrap();
        store.set_draft("c1", "typed", 1_000).unwrap();
        store.set_draft("c1", "", 2_000).unwrap();
        assert_eq!(store.draft("c1").unwrap(), None);
        assert!(store.conversations_with_drafts().unwrap().is_empty());
    }

    #[test]
    fn whitespace_alone_is_not_a_draft() {
        let dir = TempDir::new("drafts-space");
        let store = EncryptedStore::open(dir.db(), &a_key(32)).unwrap();
        store
            .set_draft(
                "c1", "   
 ", 1_000,
            )
            .unwrap();
        assert_eq!(store.draft("c1").unwrap(), None);
    }

    #[test]
    fn a_draft_is_replaced_rather_than_accumulated() {
        // There is no history of drafts on purpose: keeping the versions
        // somebody typed and deleted would be keeping the sentences they
        // thought better of.
        let dir = TempDir::new("drafts-replace");
        let store = EncryptedStore::open(dir.db(), &a_key(33)).unwrap();
        store.set_draft("c1", "first", 1_000).unwrap();
        store.set_draft("c1", "second", 2_000).unwrap();
        assert_eq!(store.draft("c1").unwrap().as_deref(), Some("second"));
        assert_eq!(store.conversations_with_drafts().unwrap().len(), 1);
    }

    #[test]
    fn drafts_are_kept_apart_per_conversation() {
        let dir = TempDir::new("drafts-many");
        let store = EncryptedStore::open(dir.db(), &a_key(34)).unwrap();
        store.set_draft("c1", "for one", 1_000).unwrap();
        store.set_draft("c2", "for another", 1_000).unwrap();
        assert_eq!(store.draft("c1").unwrap().as_deref(), Some("for one"));
        assert_eq!(store.draft("c2").unwrap().as_deref(), Some("for another"));
        assert_eq!(store.conversations_with_drafts().unwrap().len(), 2);
    }

    #[test]
    fn a_folder_holds_conversations_without_owning_them() {
        let dir = TempDir::new("folders");
        let store = EncryptedStore::open(dir.db(), &a_key(20)).unwrap();

        let work = store.create_folder("Work", 1_000).unwrap();
        store.set_folder_member(work, "c1", true).unwrap();
        store.set_folder_member(work, "c2", true).unwrap();

        let folders = store.folders().unwrap();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Work");
        assert_eq!(folders[0].conversations.len(), 2);
    }

    #[test]
    fn a_conversation_can_sit_in_two_folders() {
        // Why membership is a table rather than a column.
        let dir = TempDir::new("folders-two");
        let store = EncryptedStore::open(dir.db(), &a_key(21)).unwrap();
        let a = store.create_folder("Work", 1_000).unwrap();
        let b = store.create_folder("Urgent", 1_000).unwrap();
        store.set_folder_member(a, "c1", true).unwrap();
        store.set_folder_member(b, "c1", true).unwrap();

        let folders = store.folders().unwrap();
        assert!(folders.iter().all(|f| f.conversations == vec!["c1"]));
    }

    #[test]
    fn filing_something_twice_is_not_an_error() {
        let dir = TempDir::new("folders-twice");
        let store = EncryptedStore::open(dir.db(), &a_key(22)).unwrap();
        let f = store.create_folder("Work", 1_000).unwrap();
        store.set_folder_member(f, "c1", true).unwrap();
        store.set_folder_member(f, "c1", true).unwrap();
        assert_eq!(store.folders().unwrap()[0].conversations.len(), 1);
    }

    #[test]
    fn deleting_a_folder_keeps_every_conversation_in_it() {
        // The one thing a folder must never do. Filing is not owning.
        let dir = TempDir::new("folders-delete");
        let store = EncryptedStore::open(dir.db(), &a_key(23)).unwrap();
        store
            .insert_message(1, "c1", None, "still here", 1_000)
            .unwrap();
        let f = store.create_folder("Work", 1_000).unwrap();
        store.set_folder_member(f, "c1", true).unwrap();

        store.delete_folder(f).unwrap();

        assert!(store.folders().unwrap().is_empty());
        assert_eq!(
            store.messages("c1").unwrap().len(),
            1,
            "deleting a folder must not touch what was in it"
        );
    }

    #[test]
    fn folders_come_back_in_the_order_they_were_made() {
        let dir = TempDir::new("folders-order");
        let store = EncryptedStore::open(dir.db(), &a_key(24)).unwrap();
        store.create_folder("First", 1_000).unwrap();
        store.create_folder("Second", 1_001).unwrap();
        store.create_folder("Third", 1_002).unwrap();
        let names: Vec<String> = store
            .folders()
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["First", "Second", "Third"]);
    }

    #[test]
    fn opening_a_view_once_destroys_the_key_rather_than_marking_it_used() {
        // The whole feature. A flag saying "opened" beside a key that is still
        // there would be a promise a modified build could simply ignore; with
        // the key gone there is nothing left to ignore.
        let dir = TempDir::new("view-once-burn");
        let store = EncryptedStore::open(dir.db(), &a_key(9)).unwrap();
        store.insert_view_once(&a_view_once("m1")).unwrap();

        let before = store.view_once("m1").unwrap().expect("it was written");
        assert!(before.openable());

        store.burn_view_once("m1", 2_000).unwrap();

        let after = store.view_once("m1").unwrap().expect("the row survives");
        assert!(!after.openable(), "the key must be gone");
        assert_eq!(after.enc_key, None);
        assert_eq!(after.nonce, None);
        assert_eq!(after.sha256, None);
        assert_eq!(after.opened_at_ms, Some(2_000));
    }

    #[test]
    fn a_burnt_view_once_keeps_enough_to_be_drawn() {
        // The row stays on purpose: the bubble still has to say what was there
        // and when it went. A deleted row would be indistinguishable from a
        // message that was never view-once at all.
        let dir = TempDir::new("view-once-remains");
        let store = EncryptedStore::open(dir.db(), &a_key(10)).unwrap();
        store.insert_view_once(&a_view_once("m1")).unwrap();
        store.burn_view_once("m1", 2_000).unwrap();

        let after = store.view_once("m1").unwrap().unwrap();
        assert_eq!(after.mime, "image/jpeg");
        assert_eq!(after.size, 1234);
        assert_eq!(after.s3_key, "enc/c1/abc");
    }

    #[test]
    fn burning_twice_is_not_an_error() {
        // Two windows, one message, both opened. The second finds nothing to
        // destroy, which is the state it wanted anyway.
        let dir = TempDir::new("view-once-twice");
        let store = EncryptedStore::open(dir.db(), &a_key(11)).unwrap();
        store.insert_view_once(&a_view_once("m1")).unwrap();
        store.burn_view_once("m1", 2_000).unwrap();
        store.burn_view_once("m1", 3_000).unwrap();
        assert!(!store.view_once("m1").unwrap().unwrap().openable());
    }

    #[test]
    fn our_own_view_once_was_never_openable() {
        // We kept the file we picked. A key that let the sender reopen what the
        // recipient no longer can would make the bubble's wording untrue on one
        // side of the conversation.
        let dir = TempDir::new("view-once-mine");
        let store = EncryptedStore::open(dir.db(), &a_key(12)).unwrap();
        let mut mine = a_view_once("m1");
        mine.enc_key = None;
        mine.nonce = None;
        mine.sha256 = None;
        mine.opened_at_ms = Some(1_000);
        store.insert_view_once(&mine).unwrap();

        assert!(!store.view_once("m1").unwrap().unwrap().openable());
    }

    /// The index is the rule; a handler check would have a window between
    /// deciding and writing that a retrying client drives straight through.
    #[test]
    fn a_name_cannot_be_used_twice() {
        let dir = TempDir::new("client-id-unique");
        let store = EncryptedStore::open(dir.db(), &a_key(3)).unwrap();

        let insert = |envelope_id: i64, client_id: &str| {
            store.insert(&NewMessage {
                envelope_id,
                conversation_id: "c1",
                sender_device_id: None,
                body: "hi",
                payload: None,
                sent_at_ms: 1_000,
                client_id: Some(client_id),
                reply_to: None,
            })
        };

        insert(1, "the-same-name").unwrap();
        assert!(
            insert(2, "the-same-name").is_err(),
            "a second message under one name must be refused"
        );

        // And the absence of a name is not a name: two of those are fine,
        // which is what the partial index is for.
        store.insert_message(3, "c1", None, "old one", 1).unwrap();
        store.insert_message(4, "c1", None, "another", 2).unwrap();
        assert_eq!(store.messages("c1").unwrap().len(), 3);
    }

    #[test]
    fn a_tombstone_never_moves_backwards() {
        // Removing a conversation that came back and was removed again must
        // leave the *later* mark. A stale write winning here would resurrect
        // something the person has now deleted twice.
        let dir = TempDir::new("forget-monotonic");
        let store = EncryptedStore::open(dir.db(), &a_key(34)).unwrap();

        store.set_conversation_cursor("gone", 90).unwrap();
        store.delete_conversation("gone").unwrap();
        // Back with a fresh row, then removed before anything new arrived: the
        // new row's cursor starts at zero.
        store.set_conversation_cursor("gone", 0).unwrap();
        store.delete_conversation("gone").unwrap();

        assert_eq!(
            store.forgotten_conversations().unwrap().get("gone"),
            Some(&90)
        );
    }

    #[test]
    fn remembering_lifts_the_tombstone() {
        let dir = TempDir::new("forget-lift");
        let store = EncryptedStore::open(dir.db(), &a_key(35)).unwrap();

        store.set_conversation_cursor("gone", 7).unwrap();
        store.delete_conversation("gone").unwrap();
        assert!(
            store
                .forgotten_conversations()
                .unwrap()
                .contains_key("gone")
        );

        store.remember_conversation("gone").unwrap();
        assert!(store.forgotten_conversations().unwrap().is_empty());

        // And lifting one that was never set is not an error: the caller
        // cannot know the current state without asking.
        store.remember_conversation("never").unwrap();
    }

    #[test]
    fn removing_one_conversation_does_not_forget_another() {
        let dir = TempDir::new("forget-scope");
        let store = EncryptedStore::open(dir.db(), &a_key(36)).unwrap();

        store.set_conversation_cursor("keep", 5).unwrap();
        store.set_conversation_cursor("drop", 6).unwrap();
        store.delete_conversation("drop").unwrap();

        let forgotten = store.forgotten_conversations().unwrap();
        assert_eq!(forgotten.len(), 1);
        assert!(forgotten.contains_key("drop"));
    }

    #[test]
    fn a_fresh_store_has_no_identity() {
        let dir = TempDir::new("no-identity");
        let store = EncryptedStore::open(dir.db(), &a_key(21)).unwrap();
        assert!(store.identity().unwrap().is_none());
    }

    #[test]
    fn the_identity_secret_is_not_findable_in_the_file() {
        // The reason the identity lives in the encrypted store rather than
        // beside it.
        let dir = TempDir::new("identity-opaque");
        let secret: Vec<u8> = (0u8..32)
            .map(|i| i.wrapping_mul(7).wrapping_add(3))
            .collect();
        {
            let store = EncryptedStore::open(dir.db(), &a_key(22)).unwrap();
            store.set_identity(&secret, &[0xAAu8; 32]).unwrap();
        }
        let bytes = std::fs::read(dir.db()).unwrap();
        assert!(
            !bytes.windows(secret.len()).any(|w| w == secret.as_slice()),
            "the identity secret appears verbatim in store.db"
        );
    }

    #[test]
    fn deleting_removes_the_file_and_its_sidecars() {
        let dir = TempDir::new("delete");
        {
            let store = EncryptedStore::open(dir.db(), &a_key(8)).unwrap();
            store.set_account(1, "erin", "Erin", "d").unwrap();
        }
        delete(dir.db()).unwrap();
        assert!(!dir.db().exists());
        assert!(!PathBuf::from(format!("{}-wal", dir.db().display())).exists());
    }

    #[test]
    fn deleting_something_absent_succeeds() {
        let dir = TempDir::new("delete-absent");
        assert!(delete(dir.db()).is_ok());
    }
}
