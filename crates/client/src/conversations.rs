//! Starting, sending and syncing a conversation.
//!
//! Where MLS, the encrypted store and the transport meet. Everything here obeys
//! one ordering rule, and it is the same rule every time:
//!
//! > **The server decides, then we persist.**
//!
//! Encrypt, hand it to the delivery service, and only write local state once it
//! was accepted. The other order — apply locally, then send — is how a client
//! ends up in an epoch nobody else is in, with every subsequent message
//! undecryptable to everyone (PLAN.md risk 4(b)).

use nexo_crypto::CryptoError;
use nexo_crypto::mls::{self, Conversation, Incoming, Peeked};
use nexo_protocol::{ConversationId, Payload, VoiceMeta};
use nexo_store::EncryptedStore;
use openmls::prelude::CredentialWithKey;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;

use crate::mls_state;
use crate::outbox;
use crate::transport::{Transport, TransportError};

/// What can go wrong running a conversation.
#[derive(Debug, thiserror::Error)]
pub enum ConversationError {
    /// The network layer failed.
    #[error(transparent)]
    Transport(#[from] TransportError),
    /// MLS refused.
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    /// The local store failed.
    #[error(transparent)]
    Store(#[from] nexo_store::StoreError),
    /// Persisting MLS state failed.
    #[error(transparent)]
    MlsState(#[from] mls_state::MlsStateError),
    /// Identity key material was rejected.
    #[error(transparent)]
    Identity(#[from] nexo_crypto::identity::IdentityError),
    /// Attachment encryption or decryption failed.
    #[error(transparent)]
    Attachment(#[from] nexo_crypto::attachment::AttachmentError),
    /// This device is not in that conversation.
    #[error("this device is not a member of that conversation")]
    NotAMember,
    /// A caller asked to open something that is not a file.
    #[error("that message has no attachment")]
    NotAnAttachment,
}

impl ConversationError {
    /// Whether this is the network being down rather than a refusal.
    ///
    /// The distinction the outbox turns on: an unreachable server means try
    /// again later, anything else means retrying will produce the same answer.
    pub fn is_offline(&self) -> bool {
        matches!(
            self,
            ConversationError::Transport(TransportError::Unreachable(_))
        )
    }
}

/// Everything a conversation call needs to reach.
///
/// Grouped into one struct because passing five arguments to every function is
/// how one of them eventually gets passed in the wrong order.
pub struct Context<'a, T: Transport> {
    /// The network.
    pub transport: &'a T,
    /// MLS storage and crypto.
    pub provider: &'a OpenMlsRustCrypto,
    /// The encrypted local store.
    pub store: &'a EncryptedStore,
    /// This device's MLS signer.
    pub signer: &'a SignatureKeyPair,
    /// This device's MLS credential.
    pub credential: CredentialWithKey,
}

/// Publishes a fresh batch of KeyPackages, so other people can invite us.
///
/// Called at registration and whenever the server says the supply is low.
/// Running out is not a crash — it is nobody being able to start a conversation
/// with you, which is worse for being invisible.
pub fn publish_key_packages<T: Transport>(
    ctx: &Context<'_, T>,
    count: usize,
) -> Result<(), ConversationError> {
    let packages =
        mls::generate_key_packages(ctx.provider, ctx.signer, ctx.credential.clone(), count)?;
    let hex: Vec<String> = packages.iter().map(|p| to_hex(p)).collect();
    ctx.transport.publish_key_packages(&hex)?;
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// Tops up KeyPackages if the server says we are running low.
///
/// Returns how many were published, so a caller can log "nothing to do"
/// distinctly from "topped up".
pub fn refill_key_packages_if_low<T: Transport>(
    ctx: &Context<'_, T>,
) -> Result<usize, ConversationError> {
    let (remaining, refill_below) = ctx.transport.key_package_count()?;
    if remaining >= refill_below {
        return Ok(0);
    }
    let wanted = nexo_crypto::KEY_PACKAGE_TARGET.saturating_sub(remaining.max(0) as usize);
    if wanted == 0 {
        return Ok(0);
    }
    publish_key_packages(ctx, wanted)?;
    Ok(wanted)
}

/// Starts a 1:1 conversation with someone.
///
/// The order matters and is the rule at the top of this module:
///
/// 1. claim their KeyPackage — single-use, so this is the point of no return;
/// 2. build the group locally and create the add commit;
/// 3. register the conversation with the server, then **send the commit
///    before applying it**;
/// 4. only once the server accepted, confirm it locally and persist.
///
/// # Why registration moved to step 3
///
/// It used to happen before the commit was built, and the doc comment here
/// claimed that a refusal left "no half-created conversation the UI can find".
/// That was true of the local store and false of the server: `create` writes
/// the conversation and both membership rows and commits them, so a failure
/// afterwards left a row nobody could ever send in — and `discover` dutifully
/// pulled it onto both devices as a real chat. That is one of the two ways the
/// same person ended up with two conversations.
///
/// Registering last shrinks the window to a single round trip. It cannot close
/// it: there is no transaction spanning "create" and "send". What closes it is
/// [`open_with`] refusing to reuse a conversation with no envelopes and no
/// group, and the server refusing to open a second DM between the same two
/// people at all.
pub fn start_with<T: Transport>(
    ctx: &Context<'_, T>,
    handle: &str,
) -> Result<ConversationId, ConversationError> {
    let claimed = ctx.transport.claim_key_package(handle)?;
    let key_package = from_hex(&claimed.key_package)?;

    let conversation_id = ConversationId::new_v4();
    let mut conversation = Conversation::create(
        ctx.provider,
        ctx.signer,
        ctx.credential.clone(),
        conversation_id,
        now_ms(),
    )?;

    let commit = conversation.add_member(ctx.provider, ctx.signer, &key_package)?;

    // Only now, with something to send. Everything above this line is local
    // and costs nothing if it fails; everything below leaves a row on the
    // server whether or not the rest works.
    //
    // The commit is pending by this point, so a refusal here has to abandon it
    // for the same reason a refused `send` does -- a group left holding a
    // commit it will never apply cannot be used again.
    let settled = match ctx
        .transport
        .create_conversation(&conversation_id.to_string(), &[handle.to_string()])
    {
        Ok(settled) => settled,
        Err(error) => {
            conversation.abandon_commit(ctx.provider)?;
            return Err(error.into());
        }
    };

    // The server may hand back a different conversation: there is one DM per
    // pair of people, and if the other person started theirs a moment earlier
    // that is the one that exists. Adopt it. The group built above is thrown
    // away unused -- the way into theirs is the Welcome their commit already
    // sent to our KeyPackage, which arrives on the next sync.
    if settled != conversation_id.to_string() {
        tracing::info!(
            mine = %conversation_id,
            theirs = %settled,
            "the server already had a conversation with this person; adopting it"
        );
        conversation.abandon_commit(ctx.provider)?;
        ctx.store.remember_conversation(&settled)?;
        ctx.store.set_conversation_cursor(&settled, 0)?;
        ctx.store.set_conversation_title(&settled, handle)?;
        ctx.store
            .set_conversation_meta(&settled, "dm", &[handle.to_string()])?;
        mls_state::save(ctx.provider, ctx.store)?;
        return settled.parse::<ConversationId>().map_err(|error| {
            ConversationError::Transport(TransportError::Rejected(format!(
                "the server answered with a conversation id that will not parse: {error}"
            )))
        });
    }

    // Send first. If the delivery service refuses, nothing local has changed.
    // A fresh id per commit, so a retry after a lost reply is answered with
    // the envelope the first attempt created rather than refused as stale.
    let accepted = ctx.transport.send(
        &conversation_id.to_string(),
        &to_hex(&commit.message),
        conversation.epoch() as i64,
        true,
        &outbox::new_message_id(),
    );
    let accepted = match accepted {
        Ok(accepted) => accepted,
        Err(error) => {
            conversation.abandon_commit(ctx.provider)?;
            return Err(error.into());
        }
    };

    conversation.confirm_commit(ctx.provider, now_ms())?;

    // Persisted here, not at the end.
    //
    // Everything below can fail, and until this line the group exists only in
    // the provider's memory. A failure past `confirm_commit` used to return
    // without ever reaching the save at the bottom, which lost the group while
    // leaving the conversation, its membership rows and this commit on the
    // server -- a conversation both people can see, neither can send to, and
    // no retry can repair, because the way back in was a Welcome that was
    // never sent. That is the "You are not in that conversation." that follows
    // a chat around forever.
    mls_state::save(ctx.provider, ctx.store)?;

    // The Welcome travels as an ordinary envelope. The invitee is already a
    // member server-side, so the conversation's own stream is the delivery
    // path and no separate endpoint is needed.
    //
    // A failure here is reported, but the group above survives it: the commit
    // is on the server, so the conversation is real, and `repair` can send a
    // fresh Welcome rather than the invitee waiting on one that never comes.
    if let Some(welcome) = commit.welcome {
        ctx.transport.send(
            &conversation_id.to_string(),
            &to_hex(&welcome),
            conversation.epoch() as i64,
            false,
            &outbox::new_message_id(),
        )?;
    }

    ctx.store
        .set_conversation_cursor(&conversation_id.to_string(), accepted.envelope_id)?;
    // The only moment this device knows who it invited.
    ctx.store
        .set_conversation_title(&conversation_id.to_string(), handle)?;
    ctx.store
        .set_conversation_meta(&conversation_id.to_string(), "dm", &[handle.to_string()])?;
    mls_state::save(ctx.provider, ctx.store)?;

    Ok(conversation_id)
}

/// Opens the conversation with someone, starting one only if there is none.
///
/// The reason this exists rather than calling [`start_with`] directly: a
/// KeyPackage is single-use and a group is created per call, so "message this
/// person" wired straight to `start_with` makes a new conversation every time
/// it is pressed. Pressed from a profile, that is an endless list of identical
/// empty chats and a consumed KeyPackage for each.
///
/// The server's membership list is the authority, not the local store: the
/// other person may have started it, in which case this device has a
/// conversation it never created and must not duplicate.
///
/// # Not every match is worth reusing
///
/// A conversation can exist on the server and be **unusable**: [`start_with`]
/// registers it before it knows the add commit will be accepted, and if that
/// send fails the local group is abandoned while the server's row survives
/// with both members on it. Nothing can ever be sent in it -- nobody holds MLS
/// state for it -- and because the server lists newest first, such a leftover
/// would be found *before* a conversation that works. That is one of the two
/// ways the same person ended up with two chats. So a candidate is only reused
/// if it is alive: it has envelopes, or this device holds the group.
pub fn open_with<T: Transport>(
    ctx: &Context<'_, T>,
    handle: &str,
) -> Result<ConversationId, ConversationError> {
    let handle = handle.trim().to_lowercase();
    let me = ctx.store.account()?.map(|a| a.handle.to_lowercase());
    let forgotten = ctx.store.forgotten_conversations()?;

    let mut dead: Option<(ConversationId, String)> = None;

    for summary in ctx.transport.list_conversations()? {
        if summary.kind != "dm" {
            continue;
        }
        // Exactly the two of us. A DM that has grown members is a group the
        // server has not relabelled, and reusing it would put a private
        // message somewhere it does not belong.
        let others: Vec<String> = summary
            .members
            .iter()
            .map(|h| h.to_lowercase())
            .filter(|h| Some(h) != me.as_ref())
            .collect();
        if others.len() != 1 || others[0] != handle {
            continue;
        }
        let id = match summary.conversation_id.parse::<ConversationId>() {
            Ok(id) => id,
            Err(error) => {
                // Loud, because of what silence here would cost. This is the
                // one branch that turns "we already have this conversation"
                // into "start a new one", and a `if let Ok` that quietly moved
                // on would produce a second chat with the same person and no
                // trace of why. If this ever fires, the duplicate is the
                // symptom and this line is the cause.
                tracing::warn!(
                    id = %summary.conversation_id,
                    %error,
                    "the server listed a conversation whose id will not parse; \
                     it cannot be matched, and starting a new one is the only \
                     thing left"
                );
                continue;
            }
        };

        let has_envelopes = summary.latest_envelope_id.is_some();
        let mut joined = Conversation::load(ctx.provider, id, now_ms())?.is_some();

        // Envelopes, but no group here. Two very different situations wear
        // this shape, and only a sync tells them apart:
        //
        //  - An invitation that has not been collected yet. The Welcome is in
        //    the stream, waiting. Syncing joins the group and all is well.
        //  - A conversation whose Welcome was never sent, because the commit
        //    reached the server and the Welcome that followed it did not.
        //
        // The second is a trap with no way out, and it is worth being precise
        // about why. The server hands back the one DM that exists for a pair,
        // so every fresh attempt is answered with this same conversation;
        // `discard_conversation` refuses anything holding an envelope, and
        // this holds the commit; and the Welcome that would admit us is never
        // coming, because the device that would have sent it failed before it
        // could. So the chat is listed, opens, and answers every message with
        // "You are not in that conversation." for as long as the account
        // exists.
        //
        // Syncing first is what makes it safe to act: after a full pass from
        // the stored cursor, a Welcome addressed to this device either arrived
        // or does not exist.
        if has_envelopes && !joined {
            tracing::info!(%id, "no group for a conversation that has envelopes; syncing before judging it");
            sync(ctx, id)?;
            joined = Conversation::load(ctx.provider, id, now_ms())?.is_some();
            if !joined {
                // Leaving is the only exit. It is also the honest description
                // of the state: this device is a member the server believes in
                // and the group has never heard of. Once the membership row is
                // gone the pair no longer has a DM, and the next create makes
                // a real one.
                tracing::warn!(
                    %id,
                    "a full sync found no Welcome for this device; leaving the conversation so a usable one can be created"
                );
                if let Some(mine) = ctx.store.account()?.map(|a| a.handle)
                    && let Err(error) = ctx.transport.remove_member(&summary.conversation_id, &mine)
                {
                    // Worth saying, not worth stopping for: without it the
                    // create below is handed this same conversation again and
                    // the person stays stuck, which is what the log is for.
                    tracing::warn!(%id, %error, "could not leave the unjoinable conversation");
                }
                ctx.store.delete_conversation(&summary.conversation_id)?;
                continue;
            }
        }

        // Has anything ever been sent in it, or do we hold the group? Either
        // makes it real. Neither makes it a leftover from a `start_with` that
        // did not finish.
        if !has_envelopes && !joined {
            tracing::warn!(
                %id,
                "the server lists a conversation with this person that has no \
                 envelopes and no group on this device; it is a half-created \
                 leftover and will not be reused"
            );
            dead.get_or_insert((id, summary.conversation_id.clone()));
            continue;
        }

        // Asking to talk to somebody again is a clearer instruction than any
        // envelope, so a deliberate open lifts a tombstone -- and resumes from
        // where the removal left off rather than replaying what was deleted.
        let resume = forgotten
            .get(&summary.conversation_id)
            .copied()
            .unwrap_or(0);
        if resume > 0 {
            ctx.store.remember_conversation(&summary.conversation_id)?;
        }

        // It may be one we have never synced -- the other side started it.
        ctx.store
            .set_conversation_cursor(&summary.conversation_id, resume)?;
        ctx.store
            .set_conversation_title(&summary.conversation_id, &handle)?;
        ctx.store.set_conversation_meta(
            &summary.conversation_id,
            &summary.kind,
            &summary.members,
        )?;
        return Ok(id);
    }

    // Nothing usable. If a leftover is what we found, clear it away first --
    // locally, so `discover` stops drawing it beside the conversation about to
    // be created, and on the server, so the one-DM-per-pair rule does not hand
    // the same leftover back forever.
    //
    // The server refuses to discard anything with an envelope in it, so this
    // cannot reach a real conversation. What it can reach, in the width of one
    // round trip, is a conversation the other person created a moment ago and
    // has not sent into yet. That resolves itself: their send then fails, they
    // abandon their commit and try again, and they find the one created here.
    // One conversation survives either way, which is the point.
    if let Some((id, raw)) = dead {
        tracing::info!(%id, "clearing a half-created conversation before starting a new one");
        ctx.store.delete_conversation(&raw)?;
        if let Err(error) = ctx.transport.discard_conversation(&raw) {
            // Best effort. Failing here means the leftover stays on the server
            // and `start_with` below will be handed it back -- worth a line in
            // the log, not worth refusing to open a conversation over.
            tracing::warn!(%id, %error, "the server would not discard the leftover");
        }
    }

    tracing::debug!(%handle, "no existing conversation on the server; starting one");
    start_with(ctx, &handle)
}

/// What the conversation with yourself is called.
pub const SELF_TITLE: &str = "Saved messages";

/// The conversation you have with yourself.
///
/// A place for notes, links and files, and the thing people reach for most in
/// every messenger that has one. It is an ordinary MLS group that happens to
/// have one member, so everything a conversation can do it can do — search,
/// attachments, pinning, stickers — without a second code path that would
/// drift from the first.
///
/// # What it is not
///
/// It is not a cloud drive. Every other messenger's version of this syncs
/// across devices, and this one cannot: the server stores ciphertext it cannot
/// read, history is local, and there is one device per account. What is kept
/// here is kept on this machine, and the UI has to say so rather than let
/// somebody assume otherwise.
///
/// # Why the server keeps only one
///
/// The id is minted here, so two launches racing could each mint one. The
/// server hands back the existing conversation instead of making a second, the
/// same way it does for a DM, and this adopts whatever it is given.
pub fn start_self_conversation<T: Transport>(
    ctx: &Context<'_, T>,
) -> Result<ConversationId, ConversationError> {
    // Already have one? The store is asked first, so the ordinary case costs
    // nothing at all.
    if let Some(existing) = ctx
        .store
        .conversations()?
        .into_iter()
        .find(|c| c.kind.as_deref() == Some("self"))
        && let Ok(id) = existing.id.parse()
    {
        return Ok(id);
    }

    let conversation_id = ConversationId::new_v4();
    let conversation = Conversation::create(
        ctx.provider,
        ctx.signer,
        ctx.credential.clone(),
        conversation_id,
        now_ms(),
    )?;

    let id = conversation_id.to_string();
    // No members: the server reads that as "with yourself", and hands back the
    // one that already exists rather than making a second.
    let settled = ctx.transport.create_conversation(&id, &[])?;

    if settled != id {
        // The server had one already. The group just built is dropped rather
        // than kept beside it -- `start_with` does the same, and for the same
        // reason: two MLS groups for one conversation is a state nothing else
        // in this crate knows how to read.
        ctx.store.remember_conversation(&settled)?;
        ctx.store.set_conversation_cursor(&settled, 0)?;
        ctx.store.set_conversation_title(&settled, SELF_TITLE)?;
        ctx.store.set_conversation_meta(&settled, "self", &[])?;
        mls_state::save(ctx.provider, ctx.store)?;
        return settled.parse::<ConversationId>().map_err(|error| {
            ConversationError::Transport(TransportError::Rejected(format!(
                "the server named a conversation this client cannot read: {error}"
            )))
        });
    }

    mls_state::save(ctx.provider, ctx.store)?;
    ctx.store.remember_conversation(&id)?;
    ctx.store.set_conversation_cursor(&id, 0)?;
    // Named here rather than sent, unlike a group's title: there is nobody to
    // tell, and `title_from` has no members to build a name out of.
    ctx.store.set_conversation_title(&id, SELF_TITLE)?;
    ctx.store.set_conversation_meta(&id, "self", &[])?;
    let _ = conversation;
    Ok(conversation_id)
}

/// Starts a group conversation with several people at once.
///
/// The same order as [`start_with`], repeated per member: each KeyPackage is
/// claimed, added by its own commit, and the resulting Welcome sent, before
/// moving to the next. One commit per member rather than one for all of them,
/// because a partial failure then leaves a group that is smaller than asked
/// for rather than one whose state the server and this device disagree about.
///
/// The server decides `kind` from the member count, so naming every member at
/// creation is what makes this a group rather than a DM that grew.
pub fn start_group_with<T: Transport>(
    ctx: &Context<'_, T>,
    handles: &[String],
    title: &str,
) -> Result<ConversationId, ConversationError> {
    if handles.is_empty() {
        return Err(ConversationError::NotAMember);
    }

    // Claim every KeyPackage first. They are single-use, so a handle that
    // cannot be invited should fail before any group exists rather than after
    // half of them are in it.
    let mut packages = Vec::with_capacity(handles.len());
    for handle in handles {
        let claimed = ctx.transport.claim_key_package(handle)?;
        packages.push((handle.clone(), from_hex(&claimed.key_package)?));
    }

    let conversation_id = ConversationId::new_v4();
    let mut conversation = Conversation::create(
        ctx.provider,
        ctx.signer,
        ctx.credential.clone(),
        conversation_id,
        now_ms(),
    )?;

    let id = conversation_id.to_string();
    ctx.transport.create_conversation(&id, handles)?;

    for (_, key_package) in &packages {
        let commit = conversation.add_member(ctx.provider, ctx.signer, key_package)?;

        let sent = ctx.transport.send(
            &id,
            &to_hex(&commit.message),
            conversation.epoch() as i64,
            true,
            &outbox::new_message_id(),
        );
        if let Err(error) = sent {
            conversation.abandon_commit(ctx.provider)?;
            return Err(error.into());
        }
        conversation.confirm_commit(ctx.provider, now_ms())?;

        // Per member, for the reason given in `start_with`: past this point
        // the group has advanced, and returning without saving would strand a
        // conversation that exists on the server and nowhere else.
        mls_state::save(ctx.provider, ctx.store)?;

        if let Some(welcome) = commit.welcome {
            ctx.transport.send(
                &id,
                &to_hex(&welcome),
                conversation.epoch() as i64,
                false,
                &outbox::new_message_id(),
            )?;
        }
    }

    // The name has to be *sent*, not just written down here.
    //
    // The server holds no title -- what a group is called is content, which is
    // why `rename` carries it as an encrypted `Payload::Rename` that every
    // member applies on sync. Creation used to skip that and only write the
    // title locally, so the person who named the group was the only one who
    // ever saw the name: everybody else fell back to `title_from`, and a group
    // called "Weekend plans" read as "alice, carol" on their machines for ever,
    // until somebody happened to rename it.
    //
    // Sent after the loop above, once every member has been added, because a
    // member is admitted at an epoch and cannot read what was encrypted before
    // it. The same reason `a_member_added_later_cannot_read_earlier_messages`
    // is a test.
    let payload = Payload::Rename {
        title: title.to_string(),
    };
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;
    ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    ctx.store.set_conversation_title(&id, title)?;
    ctx.store.set_conversation_meta(&id, "group", handles)?;
    mls_state::save(ctx.provider, ctx.store)?;
    // A baseline, so the first sync sees these keys as already known. Without
    // it every new conversation would report a key change on its second pass,
    // and a warning that fires every time is one nobody reads.
    record_membership(ctx, conversation_id)?;
    Ok(conversation_id)
}

/// Adds someone to an existing conversation.
///
/// The order is the whole of M5's correctness, and it is the reverse of what
/// looks natural:
///
/// 1. **Membership row first.** The invitee has to be able to *fetch* the
///    Welcome, and they cannot sync a conversation they are not a member of.
///    The row grants no ability to read — the server holds no group secrets.
/// 2. **Then the commit**, sent before it is applied, like every other commit.
/// 3. **Then the Welcome**, which is the thing that actually admits them.
///
/// Doing it the other way — commit first — produces a Welcome addressed to
/// someone who cannot reach it, and a group that has already rekeyed around a
/// member who will never arrive.
///
/// What the new member can read is decided by MLS, not by any of this: they
/// join at the current epoch and the ratchet gives them no way back. That is
/// M5's check, and `a_member_added_later_cannot_read_earlier_messages` is where
/// it is proven.
pub fn add_to<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    handle: &str,
) -> Result<(), ConversationError> {
    let claimed = ctx.transport.claim_key_package(handle)?;
    let key_package = from_hex(&claimed.key_package)?;

    let id = conversation_id.to_string();
    ctx.transport.add_member(&id, handle)?;

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;

    let commit = conversation.add_member(ctx.provider, ctx.signer, &key_package)?;

    let sent = ctx.transport.send(
        &id,
        &to_hex(&commit.message),
        conversation.epoch() as i64,
        true,
        &outbox::new_message_id(),
    );
    if let Err(error) = sent {
        // The membership row is left in place deliberately: it grants nothing
        // on its own, and removing it here would need another call that can
        // also fail. The next successful add reuses it.
        conversation.abandon_commit(ctx.provider)?;
        return Err(error.into());
    }

    conversation.confirm_commit(ctx.provider, now_ms())?;

    // Before the Welcome, as in `start_with`. The commit has already rekeyed
    // the group around the new member; returning from a failed Welcome without
    // saving would leave this device on the old epoch while the server holds
    // the commit that moved everyone else off it.
    mls_state::save(ctx.provider, ctx.store)?;

    if let Some(welcome) = commit.welcome {
        ctx.transport.send(
            &id,
            &to_hex(&welcome),
            conversation.epoch() as i64,
            false,
            &outbox::new_message_id(),
        )?;
    }

    // The new member is a peer from now on, and their key at this moment is
    // the baseline the next sync compares against.
    record_membership(ctx, conversation_id)?;

    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// Removes someone from a conversation.
///
/// The reverse ordering, for the same reason: the **commit** goes first,
/// because that is what rekeys the group and actually stops them reading.
/// Dropping the membership row first would stop them fetching while leaving
/// them able to decrypt anything they had already collected — and would remove
/// the only route the removal commit has to reach them.
pub fn remove_from<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    handle: &str,
    leaf_index: u32,
) -> Result<(), ConversationError> {
    let id = conversation_id.to_string();
    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;

    let commit = conversation.remove_member(ctx.provider, ctx.signer, leaf_index)?;

    let sent = ctx.transport.send(
        &id,
        &to_hex(&commit.message),
        conversation.epoch() as i64,
        true,
        &outbox::new_message_id(),
    );
    if let Err(error) = sent {
        conversation.abandon_commit(ctx.provider)?;
        return Err(error.into());
    }
    conversation.confirm_commit(ctx.provider, now_ms())?;

    // Only now does routing catch up with the crypto.
    ctx.transport.remove_member(&id, handle)?;
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// Sends a message.
///
/// Encrypt, send, then persist — never the other way round. A message written
/// to the local history that the server refused is a message the user believes
/// they sent.
pub fn send_message<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    body: &str,
) -> Result<Sent, ConversationError> {
    send_written(ctx, conversation_id, body, None)
}

/// Passes a message on to another conversation.
///
/// A forward is a *re-encryption*, not a move: the plaintext this device
/// already holds is encrypted afresh into the target group and sent as a new
/// message of its own. There is no other way for it to work — the target group
/// has different keys, and the server never had the plaintext to copy.
///
/// `forwarded_from` is what the caller believes the original author to be, and
/// travels with it so the reader is told this is second-hand. `None` is the
/// honest answer when the forwarding device cannot name the author, which is
/// the ordinary case for a group message.
///
/// **Text only, deliberately.** Forwarding an attachment would mean either
/// re-uploading its ciphertext — expensive, and a second object nobody ever
/// deletes — or pointing a second conversation at the first one's object,
/// which raises a question this crate has no answer for yet: whose object is
/// it, and what happens to the forward when the original is deleted. Until
/// that is decided, the menu does not offer forwarding for anything but text,
/// and this refuses it rather than quietly forwarding a caption.
pub fn forward_message<T: Transport>(
    ctx: &Context<'_, T>,
    from: ConversationId,
    envelope_id: i64,
    to: ConversationId,
    forwarded_from: Option<String>,
) -> Result<Sent, ConversationError> {
    let encoded = ctx
        .store
        .message_payload(envelope_id)?
        .ok_or(ConversationError::NotAMember)?;

    // The body comes from the payload rather than the stored preview, because
    // the preview is what a list shows and may be prose invented for something
    // that has no words of its own.
    let body = match Payload::decode(encoded.as_bytes()) {
        Payload::Text { body, .. } | Payload::Reply { body, .. } => body,
        // A reply forwards as its own words: the message it answered is not in
        // the target conversation, so carrying the reference would draw a
        // quote of something nobody there can see.
        _ => return Err(ConversationError::NotAnAttachment),
    };
    if body.is_empty() {
        return Err(ConversationError::NotAnAttachment);
    }

    // `from` is not read beyond this point: the message has been found by its
    // envelope id, which is unique across conversations. It is in the
    // signature because a caller that did not know which conversation it was
    // forwarding out of would be a caller that had lost track of what it was
    // doing.
    let _ = from;

    let payload = Payload::forwarded(&body, forwarded_from);
    send_message_payload(ctx, to, payload, &body)
}

/// Sends a message answering another one.
///
/// `target` is the sender's own name for the message being answered, which is
/// what [`Payload::Reply`] refers to. Nothing checks that this device has that
/// message: a reply to something never received is still a reply, and the
/// reader draws it as one with the quote marked unresolved.
pub fn send_reply<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    body: &str,
    target: uuid::Uuid,
) -> Result<Sent, ConversationError> {
    send_written(ctx, conversation_id, body, Some(target))
}

/// The one path both of the above take.
///
/// Split so that a reply cannot drift from a message: the ratchet, the outbox,
/// the idempotency key and the local write are subtle enough once. A second
/// copy of them would be a second place for the crash window between
/// encrypting and queueing to be got wrong.
fn send_written<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    body: &str,
    reply_to: Option<uuid::Uuid>,
) -> Result<Sent, ConversationError> {
    let payload = match reply_to {
        Some(target) => Payload::Reply {
            target,
            body: body.to_string(),
            id: Some(uuid::Uuid::new_v4()),
        },
        None => Payload::text(body),
    };
    send_message_payload(ctx, conversation_id, payload, body)
}

/// Encrypts, queues and sends one already-built payload as a *message*.
///
/// Distinct from [`send_payload`], which is the fire-and-forget path used for
/// things that change state without drawing a bubble: this one goes through the
/// outbox, writes local history, and returns what happened to it.
///
/// `stored_body` is what the local history and the conversation list show. It
/// is passed rather than derived so a payload with no words of its own -- a
/// sticker -- can still be written down without `preview()` having to invent
/// prose for it.
fn send_message_payload<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    payload: Payload,
    stored_body: &str,
) -> Result<Sent, ConversationError> {
    let reply_to = match &payload {
        Payload::Reply { target, .. } => Some(*target),
        _ => None,
    };
    let body = stored_body;
    // One retry through a sync, before giving up.
    //
    // The Welcome that admits this device is an ordinary envelope, so there is
    // a window in which the conversation is listed, drawn, and typed into
    // while the thing that makes it usable is still sitting on the server
    // unfetched. Failing outright there reports "You are not in that
    // conversation." about a conversation the person is looking at, and the
    // only cure was to wait for the poll and try again.
    //
    // A sync is the cure, so do it rather than describe it. Nothing here
    // repairs a conversation whose Welcome was never sent -- that is
    // `repair_dm`'s job -- but it costs one round trip on a path that was
    // otherwise about to fail.
    let mut conversation = match Conversation::load(ctx.provider, conversation_id, now_ms())? {
        Some(conversation) => conversation,
        None => {
            tracing::info!(
                %conversation_id,
                "no group for this conversation; syncing once before giving up"
            );
            sync(ctx, conversation_id)?;
            Conversation::load(ctx.provider, conversation_id, now_ms())?
                .ok_or(ConversationError::NotAMember)?
        }
    };

    // Built before it is encrypted, because the name inside it has to be read
    // back out: MLS ratchets forward on every encryption, so these bytes are
    // the message and there is no second chance to look inside and learn what
    // it was called. A retry sends the same bytes rather than producing new
    // ones, so the name is stable too.
    let client_id = payload.id().map(|id| id.to_string());
    // Kept for anything the body alone cannot describe. A plain message needs
    // nothing beyond the body already stored beside it, and writing an encoded
    // copy of every message into the outbox would double what a queue costs for
    // nothing. A reply needs it, because the quote lives in the payload until
    // the message reaches its own column; a sticker needs it, because the body
    // is empty and the payload is the only record of which sticker it was.
    let queued_payload = match &payload {
        Payload::Reply { .. } | Payload::Sticker { .. } => Some(payload.encode_string()),
        _ => None,
    };
    let stored_payload = queued_payload.clone();
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    // Queued before it is sent, not after a failure. If this process dies
    // between encrypting and sending, the message is on disk and the ratchet
    // has already moved -- queueing first is what makes those two facts agree.
    let client_msg_id = outbox::new_message_id();
    let item = nexo_store::OutboxItem {
        client_msg_id: client_msg_id.clone(),
        conversation_id: conversation_id.to_string(),
        ciphertext: to_hex(&ciphertext),
        epoch: conversation.epoch() as i64,
        is_commit: false,
        body: body.to_string(),
        payload: queued_payload,
        queued_at_ms: now_ms(),
        attempts: 0,
        last_error: None,
        client_id: client_id.clone(),
    };
    // One transaction, not two statements. The ratchet advanced when the
    // message was encrypted, so the queued ciphertext belongs to a generation
    // the stored state does not yet know about; a crash between the two writes
    // would hand that generation out twice. RFC 9420 6.3.1 is explicit about
    // the consequence, and both writes already go to the same connection.
    ctx.store
        .enqueue_with_mls_state(&item, &mls_state::encode(ctx.provider)?)?;

    match outbox::send_now(ctx, &item) {
        Ok(accepted) => {
            ctx.store.dequeue(&client_msg_id)?;
            // Our own message is not echoed back by sync in a form we can
            // decrypt -- MLS does not let a sender decrypt its own ciphertext
            // -- so the local copy is written here, keyed by the server's
            // envelope id so a later sync cannot duplicate it.
            ctx.store.insert(&nexo_store::NewMessage {
                envelope_id: accepted.envelope_id,
                conversation_id: &conversation_id.to_string(),
                sender_device_id: None,
                body,
                payload: stored_payload.as_deref(),
                sent_at_ms: now_ms(),
                client_id: client_id.as_deref(),
                reply_to: reply_to.map(|t| t.to_string()).as_deref(),
            })?;
            Ok(Sent::Delivered {
                envelope_id: accepted.envelope_id,
                client_id,
            })
        }
        Err(error) if error.is_offline() => {
            ctx.store
                .record_attempt(&client_msg_id, &error.to_string())?;
            // Not an error to the caller. The message is written down, it will
            // go when the network returns, and telling someone their message
            // failed when it is safely queued is worse than useless.
            Ok(Sent::Queued {
                client_msg_id,
                client_id,
            })
        }
        Err(error) => {
            ctx.store
                .record_attempt(&client_msg_id, &error.to_string())?;
            Err(error)
        }
    }
}

/// What happened to a message the user just wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    /// The server has it.
    Delivered {
        /// The envelope id, which is also the local message's key.
        envelope_id: i64,
        /// The name inside the ciphertext, for referring to it later.
        client_id: Option<String>,
    },
    /// Written to the outbox, waiting for the network.
    ///
    /// Not a failure. The UI shows it as pending, and the next flush sends it.
    Queued {
        /// Its id in the outbox.
        client_msg_id: String,
        /// The name inside the ciphertext.
        ///
        /// Carried even here, and this is the case it exists for: a queued
        /// message has no envelope id, and taking a message back is most
        /// useful in exactly the minutes it might still be sitting here.
        client_id: Option<String>,
    },
}

impl Sent {
    /// The envelope id, for a message that actually reached the server.
    pub fn envelope_id(&self) -> Option<i64> {
        match self {
            Sent::Delivered { envelope_id, .. } => Some(*envelope_id),
            Sent::Queued { .. } => None,
        }
    }

    /// The name inside the ciphertext, whichever way it went out.
    pub fn client_id(&self) -> Option<&str> {
        match self {
            Sent::Delivered { client_id, .. } | Sent::Queued { client_id, .. } => {
                client_id.as_deref()
            }
        }
    }
}

/// Learns about conversations this device has been invited to.
///
/// Being added to a conversation happens entirely on the server: the inviter
/// calls `add_member`, and a membership row appears. Nothing about that reaches
/// this device on its own — the Welcome that admits us to the group is inside
/// *that conversation's* envelope stream, and a stream we do not know exists is
/// a stream we never sync. Without this, an invitation is invisible: the server
/// knows, the inviter knows, and the invitee's app shows an empty list forever.
///
/// The local row is metadata only and grants no ability to read. The cursor
/// starts at 0 deliberately, because the Welcome is one of the earliest
/// envelopes in the conversation and starting anywhere later would skip past
/// the one message that makes the rest readable.
pub fn discover<T: Transport>(ctx: &Context<'_, T>) -> Result<usize, ConversationError> {
    // Titles as well as ids: a conversation this device joined before the
    // server reported its membership is already known but still nameless, and
    // skipping it outright would leave it "Unnamed" for good.
    let known: std::collections::HashMap<String, Option<String>> = ctx
        .store
        .conversations()?
        .into_iter()
        .map(|c| (c.id, c.title))
        .collect();

    // Our own handle, so a DM is named after the other person rather than
    // after whoever the server happened to list first.
    let me = ctx.store.account()?.map(|a| a.handle);

    // Conversations this device was told to forget, and how far. Without this
    // "Remove from this device" lasted until the next sync: the row was gone,
    // the server still listed us as a member, and the loop below could not
    // tell "never seen" from "deliberately removed". The chat came back within
    // seconds, empty, which is the opposite of what the button said.
    let forgotten = ctx.store.forgotten_conversations()?;

    let mut added = 0;
    for summary in ctx.transport.list_conversations()? {
        let existing = known.get(&summary.conversation_id);
        let is_new = existing.is_none();

        // A tombstone holds until something newer than the removal exists.
        // When it lifts, the conversation resumes from where it was removed
        // rather than from zero -- the confirmation promises it comes back
        // "with the new message in it", not with the history that was deleted.
        let resume = match forgotten.get(&summary.conversation_id) {
            Some(&through) => {
                if summary.latest_envelope_id.unwrap_or(0) <= through {
                    continue;
                }
                ctx.store.remember_conversation(&summary.conversation_id)?;
                through
            }
            None => 0,
        };

        // A conversation that holds nothing and that this device has no group
        // for cannot be opened, sent to, or repaired by waiting.
        //
        // `open_with` already refuses to reuse this shape and calls it a
        // half-created leftover; `discover` used to draw one anyway, because it
        // builds rows from the server's membership list and membership is not
        // the same fact as having been let in. The result was a chat in the
        // sidebar that answered every message with "You are not in that
        // conversation." -- and, being listed, it looked like the conversation
        // rather than the wreck of one.
        //
        // Both conditions are required. A real invitation always arrives with
        // a Welcome envelope behind it, so `latest_envelope_id` is `Some` and
        // nothing legitimate is hidden here.
        if summary.latest_envelope_id.is_none() {
            let joined = summary
                .conversation_id
                .parse::<ConversationId>()
                .ok()
                .map(|id| Conversation::load(ctx.provider, id, now_ms()))
                .transpose()?
                .flatten()
                .is_some();
            if !joined {
                // Already drawn on this device from an earlier sync, before
                // this check existed. Skipping is not enough for those: the row
                // is in the store and will keep being drawn, answering every
                // message with "You are not in that conversation." until the
                // person deletes it by hand. Clear it instead, here and on the
                // server, exactly as `open_with` does when it meets one.
                if !is_new {
                    tracing::info!(
                        id = %summary.conversation_id,
                        "clearing a half-created conversation already on this device"
                    );
                    ctx.store.delete_conversation(&summary.conversation_id)?;
                    if let Err(error) = ctx.transport.discard_conversation(&summary.conversation_id)
                    {
                        // Best effort, as in `open_with`: the server refuses to
                        // discard anything holding an envelope, so this cannot
                        // reach a real conversation.
                        tracing::warn!(
                            id = %summary.conversation_id,
                            %error,
                            "the server would not discard the leftover"
                        );
                    }
                } else {
                    tracing::warn!(
                        id = %summary.conversation_id,
                        "an empty conversation with no group here: a half-created leftover"
                    );
                }
                continue;
            }
        }

        if is_new {
            ctx.store
                .set_conversation_cursor(&summary.conversation_id, resume)?;
            added += 1;
        }

        // What the server knows about the shape of it. Kept so the UI can tell
        // a DM from a group without asking again -- it used to assume every
        // conversation was a DM, and looked up its title as if it were a handle.
        ctx.store.set_conversation_meta(
            &summary.conversation_id,
            &summary.kind,
            &summary.members,
        )?;

        // Name it only when it has no name. A title the user or `start_with`
        // already set is better than one derived from a member list, and this
        // runs on every sync — overwriting each time would undo a rename on
        // the next pass.
        let unnamed = existing.map(|t| t.is_none()).unwrap_or(true);
        if unnamed && let Some(title) = title_from(&summary.members, me.as_deref()) {
            ctx.store
                .set_conversation_title(&summary.conversation_id, &title)?;
        }
    }
    Ok(added)
}

/// What to call a conversation known only by its membership.
///
/// A DM is the other person. A group is everyone else, which is a placeholder
/// for a real name rather than a good one — the server holds no title, so this
/// is the most a discovering device can honestly say. `None` when there is
/// nobody but us to name it after, which leaves any existing title alone
/// rather than replacing it with something worse.
fn title_from(members: &[String], me: Option<&str>) -> Option<String> {
    let others: Vec<&str> = members
        .iter()
        .map(String::as_str)
        .filter(|h| Some(*h) != me)
        .collect();

    match others.len() {
        0 => None,
        1 => Some(others[0].to_string()),
        _ => Some(others.join(", ")),
    }
}

/// What a sync did.
// No longer `Copy`: `key_changes` is a `Vec`. Nothing moved it by value
// where a borrow would not do.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SyncOutcome {
    /// New messages written to the local history.
    pub messages: usize,
    /// Commits applied, each of which moved the epoch.
    pub commits: usize,
    /// Envelopes that could not be processed. Rule 7: counted and reported,
    /// never silently skipped.
    pub failed: usize,
    /// Devices whose identity key is not the one last seen here.
    ///
    /// The event the verification ceremony exists for. Empty is the normal
    /// answer; anything in it means somebody's key changed under a device this
    /// conversation already knew, which is either a reinstall or the attack
    /// safety numbers are compared to catch. The client cannot tell those
    /// apart, and neither can this -- which is why it is reported rather than
    /// judged.
    pub key_changes: Vec<String>,
    /// Envelopes that predate this device joining, and so are not its to
    /// apply.
    ///
    /// Distinct from `failed` on purpose. The commit that *adds* you arrives
    /// before the Welcome that lets you join, and you are already past it by
    /// the time you can read anything — counting that as a failure would report
    /// "a message could not be read" on every new conversation, and any alert
    /// built on `failed` would cry wolf immediately.
    pub skipped: usize,
}

/// Pulls everything new for a conversation and applies it.
///
/// Idempotent on purpose: reconnecting replays from the stored cursor, and
/// messages are keyed by envelope id, so running this twice changes nothing the
/// second time.
pub fn sync<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
) -> Result<SyncOutcome, ConversationError> {
    let id = conversation_id.to_string();
    let since = ctx.store.conversation_cursor(&id)?;
    let envelopes = ctx.transport.sync(&id, since)?;

    let mut outcome = SyncOutcome::default();
    let mut cursor = since;

    // Our own device id. The delivery service returns every envelope in the
    // conversation, ours included, and MLS cannot decrypt a message this device
    // sent -- the ratchet moves on as it encrypts. Handing our own ciphertext
    // back to `decrypt` therefore fails every time, and counted that failure as
    // "a message could not be read" for a message the sender is looking at.
    let mine = ctx.store.account()?.map(|a| a.device_id);

    // Decode once. An envelope whose hex is malformed never reached us intact,
    // and that is a genuine failure.
    let mut decoded = Vec::with_capacity(envelopes.len());
    for envelope in envelopes {
        match from_hex(&envelope.ciphertext) {
            Ok(bytes) => decoded.push((envelope, bytes)),
            Err(_) => {
                outcome.failed += 1;
            }
        }
    }

    // First pass: joins.
    //
    // A Welcome later in the batch is what makes the batch processable, so it
    // has to be handled before anything that depends on membership. Joining
    // also fixes the epoch: everything at or before the Welcome is history this
    // device was never part of, which MLS is explicit about — a member added at
    // epoch N cannot read anything before N.
    let mut joined_at: Option<i64> = None;
    for (envelope, bytes) in &decoded {
        if matches!(mls::peek(bytes), Ok(Peeked::Welcome))
            && Conversation::join(ctx.provider, bytes, now_ms()).is_ok()
        {
            joined_at = Some(envelope.envelope_id);
        }
    }

    // Second pass: everything else.
    for (envelope, bytes) in &decoded {
        cursor = cursor.max(envelope.envelope_id);

        // Ours already: `send` writes to local history the moment the server
        // accepts, so there is nothing here to learn and nothing to report.
        if mine.as_deref() == Some(envelope.sender_device_id.as_str()) {
            continue;
        }

        // Anything up to and including the Welcome predates membership.
        if joined_at.is_some_and(|at| envelope.envelope_id <= at) {
            outcome.skipped += 1;
            continue;
        }

        match mls::peek(bytes) {
            // A Welcome we did not join from: either already a member, or an
            // invitation to a group this device is not the target of.
            Ok(Peeked::Welcome) => outcome.skipped += 1,

            Ok(Peeked::GroupMessage) => {
                match Conversation::load(ctx.provider, conversation_id, now_ms())? {
                    Some(mut conversation) => match conversation.decrypt(ctx.provider, bytes) {
                        Ok(Incoming::Message { sender, plaintext }) => {
                            // What is stored is the preview. The full payload —
                            // including an attachment's key — stays inside the
                            // ciphertext until someone asks to open the file.
                            let payload = Payload::decode(&plaintext);

                            // Neither of these is a message: they change what
                            // the conversation is called or looks like, and
                            // leave no bubble behind.
                            if let Payload::Rename { title } = &payload {
                                ctx.store.set_conversation_title(&id, title)?;
                                continue;
                            }
                            if let Payload::Story {
                                story_id,
                                s3_key,
                                key,
                                nonce,
                                sha256,
                                mime,
                                size,
                                expires_at_ms,
                            } = &payload
                            {
                                // Already expired by the time it arrived. Do
                                // not write the key down at all -- the point of
                                // the expiry is that the key stops existing.
                                if *expires_at_ms > envelope.server_timestamp_ms {
                                    ctx.store.insert_story(&nexo_store::StoredStory {
                                        id: received_story_id(*story_id, s3_key),
                                        // The device that sent it, not a
                                        // handle -- an envelope carries no
                                        // handle, and MLS names devices. The
                                        // UI resolves it, the same way an
                                        // incoming message's author is
                                        // resolved; storing a guess here
                                        // would put a UUID under somebody's
                                        // story.
                                        author_handle: String::new(),
                                        author_device_id: envelope.sender_device_id.clone(),
                                        s3_key: s3_key.clone(),
                                        enc_key: key.clone(),
                                        nonce: nonce.clone(),
                                        sha256: sha256.clone(),
                                        mime: mime.clone(),
                                        size: *size as i64,
                                        created_at_ms: envelope.server_timestamp_ms,
                                        expires_at_ms: *expires_at_ms,
                                    })?;
                                }
                                // Like `Rename`: state elsewhere, no bubble.
                                continue;
                            }
                            if let Payload::Retract { target } | Payload::Edit { target, .. } =
                                &payload
                            {
                                apply_revision(
                                    ctx,
                                    &id,
                                    *target,
                                    &payload,
                                    &envelope.sender_device_id,
                                    envelope.server_timestamp_ms,
                                )?;
                                // Like `Rename`: shared state, no bubble.
                                continue;
                            }
                            if let Payload::Reaction { target, emoji, on } = &payload {
                                // Checked here because nothing else can: the
                                // server never read this payload, so the
                                // receiver is the only place the rule can be
                                // applied. An unacceptable emoji is dropped
                                // rather than stored -- it would be rendered
                                // as-is in a pill.
                                if nexo_protocol::is_reaction_emoji(emoji) {
                                    ctx.store.set_reaction(
                                        &id,
                                        &target.to_string(),
                                        // Whoever sent the envelope is the
                                        // reactor, and MLS authenticated them.
                                        &envelope.sender_device_id,
                                        emoji,
                                        *on,
                                        envelope.server_timestamp_ms,
                                    )?;
                                }
                                // Like `Rename`: it changes shared state and
                                // draws no bubble. A reaction to a message
                                // this device never received is kept anyway --
                                // there is no foreign key, and it lights up if
                                // the message turns up later.
                                continue;
                            }
                            // A view-once splits in two on arrival: an
                            // ordinary message row that draws a bubble, and a
                            // key row that can be destroyed. The payload is
                            // **not** stored -- it holds the key, and
                            // `messages.payload` outlives the opening.
                            if let Payload::ViewOnce {
                                s3_key,
                                key,
                                nonce,
                                sha256,
                                mime,
                                size,
                                id: name,
                            } = &payload
                            {
                                ctx.store.insert_view_once(&nexo_store::StoredViewOnce {
                                    client_id: name.to_string(),
                                    conversation_id: id.clone(),
                                    s3_key: s3_key.clone(),
                                    enc_key: Some(key.clone()),
                                    nonce: Some(nonce.clone()),
                                    sha256: Some(sha256.clone()),
                                    mime: mime.clone(),
                                    size: *size as i64,
                                    received_at_ms: envelope.server_timestamp_ms,
                                    opened_at_ms: None,
                                })?;
                                ctx.store.insert(&nexo_store::NewMessage {
                                    envelope_id: envelope.envelope_id,
                                    conversation_id: &id,
                                    sender_device_id: sender.map(|s| s.to_string()).as_deref(),
                                    body: "",
                                    payload: None,
                                    sent_at_ms: envelope.server_timestamp_ms,
                                    client_id: Some(&name.to_string()),
                                    reply_to: None,
                                })?;
                                outcome.messages += 1;
                                continue;
                            }
                            if matches!(payload, Payload::GroupAvatar { .. }) {
                                // The payload is kept, not the picture: it
                                // holds the key, and the bytes are fetched when
                                // something actually needs to draw them.
                                ctx.store
                                    .set_conversation_avatar(&id, &payload.encode_string())?;
                                continue;
                            }

                            let body = payload.preview().to_string();
                            // Written down now or never: MLS will not decrypt
                            // this envelope a second time.
                            let stored = match &payload {
                                // A sticker's body is empty, so the payload is
                                // the only record of which one it was. Without
                                // this the message arrives as a blank bubble.
                                Payload::Attachment { .. } | Payload::Sticker { .. } => {
                                    Some(payload.encode_string())
                                }
                                // Kept verbatim rather than re-encoded: this
                                // build cannot represent what arrived, so
                                // encoding it back would write "{}" over it.
                                // And this is the only chance -- MLS will not
                                // decrypt this envelope again, so a build that
                                // learns the variant later reads the bytes
                                // from here or never sees them at all.
                                Payload::Unsupported { .. } => {
                                    Some(String::from_utf8_lossy(&plaintext).into_owned())
                                }
                                // Text needs nothing beyond the body already in
                                // `body`; a future variant that does will fail
                                // to open its file until it is added here, which
                                // is the safe direction for this to go wrong.
                                _ => None,
                            };
                            // The sender's name for it, when they gave one.
                            // Written now for the same reason the payload is:
                            // this envelope will not decrypt again.
                            let client_id = payload.id().map(|id| id.to_string());
                            // Lifted into its own column at arrival rather
                            // than left in the payload, because the thread
                            // resolves a quote for every bubble it draws and
                            // a parse per message in that loop is a parse too
                            // many. See the schema-16 migration.
                            let reply_to = match &payload {
                                Payload::Reply { target, .. } => Some(target.to_string()),
                                _ => None,
                            };
                            ctx.store.insert(&nexo_store::NewMessage {
                                envelope_id: envelope.envelope_id,
                                conversation_id: &id,
                                sender_device_id: sender.map(|s| s.to_string()).as_deref(),
                                body: &body,
                                payload: stored.as_deref(),
                                sent_at_ms: envelope.server_timestamp_ms,
                                client_id: client_id.as_deref(),
                                reply_to: reply_to.as_deref(),
                            })?;
                            outcome.messages += 1;
                        }
                        Ok(Incoming::CommitApplied { .. }) => outcome.commits += 1,
                        Ok(Incoming::ProposalQueued) => {}
                        // `Incoming` is non-exhaustive; an unrecognised variant
                        // is counted rather than assumed harmless.
                        Ok(_) => outcome.failed += 1,
                        // Rule 7: a message that cannot be decrypted is counted,
                        // never skipped silently and never shown as plaintext.
                        Err(_) => outcome.failed += 1,
                    },
                    // A message for a group this device is not in. Not a
                    // failure to read — there is nothing here to read it with.
                    None => outcome.skipped += 1,
                }
            }

            // `Peeked` is non-exhaustive, so a future variant lands here rather
            // than failing to compile in a build nobody expected to touch this.
            Ok(_) | Err(_) => outcome.failed += 1,
        }
    }

    // Who is in the group now, and whether anyone's key moved.
    //
    // After the commits, because a commit is what changes membership; before
    // the state is saved, so a crash between them re-runs a comparison rather
    // than skipping one. Recording is idempotent -- the same members produce
    // no changes the second time.
    outcome.key_changes = record_membership(ctx, conversation_id)?;

    ctx.store.set_conversation_cursor(&id, cursor)?;
    mls_state::save(ctx.provider, ctx.store)?;

    Ok(outcome)
}

/// Writes down who is in a conversation, and returns whose key changed.
///
/// Called after every sync and after this device creates or joins a group, so
/// that the first sight of a peer is a baseline rather than a change. A
/// conversation this device is not in yields nothing: there is no membership to
/// read, and reporting that as "no changes" would be indistinguishable from
/// reading an empty group.
fn record_membership<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
) -> Result<Vec<String>, ConversationError> {
    let Some(conversation) = Conversation::load(ctx.provider, conversation_id, now_ms())? else {
        return Ok(Vec::new());
    };

    // Our own device is not a peer. Warning someone that their own key changed
    // when they reinstalled would be noise, and it is the one key they have no
    // way to verify out of band with themselves.
    let me = ctx.store.account()?.map(|a| a.device_id);
    let peers: Vec<(String, Vec<u8>)> = conversation
        .members()
        .into_iter()
        .map(|m| (m.device_id.to_string(), m.signature_key))
        .filter(|(device_id, _)| Some(device_id) != me.as_ref())
        .collect();

    Ok(ctx
        .store
        .record_peers(&conversation_id.to_string(), &peers, now_ms())?)
}

/// Renames a conversation, for everyone in it.
///
/// Sent as an ordinary encrypted message rather than written to the server:
/// what people call their group is content, and the server holds no title
/// column to leak. Every member applies it when they sync, so the name
/// converges without anyone having to agree on who owns it.
///
/// Applied locally only after the delivery service accepted it — the ordering
/// rule at the top of this module, for the same reason.
pub fn rename<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    title: &str,
) -> Result<(), ConversationError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ConversationError::NotAMember);
    }

    let id = conversation_id.to_string();
    let payload = Payload::Rename {
        title: title.to_string(),
    };

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    ctx.store.set_conversation_title(&id, title)?;
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// React to a message, or take the reaction back.
///
/// Sent as an ordinary encrypted payload, the way `rename` is, and applied
/// locally only after the delivery service has accepted it — the same ordering
/// rule as everywhere else in this module. There is no reaction endpoint and
/// there must not be one: an emoji is content, and rule 4 says the server
/// never holds content.
///
/// The target is the name inside the message's own ciphertext, not its
/// envelope id, so a reaction can address a message that is still in an
/// outbox.
pub fn react<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    target: uuid::Uuid,
    emoji: &str,
    on: bool,
) -> Result<(), ConversationError> {
    // Checked before it is sent as well as when it arrives. The server cannot
    // do it for us -- it never reads the payload -- so both ends check, and
    // this end is the one that can tell the person why.
    if !nexo_protocol::is_reaction_emoji(emoji) {
        return Err(ConversationError::Transport(TransportError::Rejected(
            "That is not an emoji.".into(),
        )));
    }

    let id = conversation_id.to_string();
    let payload = Payload::Reaction {
        target,
        emoji: emoji.to_string(),
        on,
    };

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    // Ours carries this device's real id, not NULL -- see the schema-13
    // migration for why that matters to `ON CONFLICT`.
    let me = ctx
        .store
        .account()?
        .map(|a| a.device_id)
        .unwrap_or_default();
    ctx.store
        .set_reaction(&id, &target.to_string(), &me, emoji, on, now_ms())?;
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// Send a payload that changes state and draws no bubble.
///
/// `Rename`, `Reaction`, `Retract`, `Edit` and `Story` all do the same three
/// things: load the group, encrypt, send. Extracted so a fifth one does not
/// mean a fifth copy of the ordering.
pub fn send_payload<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    payload: &Payload,
    now_ms_value: i64,
) -> Result<(), ConversationError> {
    let _ = now_ms_value;
    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;
    ctx.transport.send(
        &conversation_id.to_string(),
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// Apply an arriving edit or retraction, if it is allowed to be applied.
///
/// Two checks, and the order is deliberate.
///
/// **Who.** The envelope carrying the change must come from the same device
/// that sent the message being changed. MLS authenticates the sender, so this
/// is enforceable rather than advisory — and without it any member of a group
/// could empty anybody else's messages. This is the security check; the window
/// below is not.
///
/// **When.** Both timestamps are the server's — the one on the target and the
/// one on this envelope — so neither is a clock the sender controls. The
/// receiver allows a minute more than the sender takes, for the reason set out
/// in `nexo_protocol::window`.
///
/// A change that fails either check is dropped silently. There is nobody to
/// report it to: the sender is not listening for a refusal, and a warning in
/// the conversation would tell everyone that somebody tried something.
fn apply_revision<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: &str,
    target: uuid::Uuid,
    payload: &Payload,
    from_device: &str,
    change_sent_at_ms: i64,
) -> Result<(), ConversationError> {
    let name = target.to_string();
    let Some((_, sender, target_sent_at_ms)) =
        ctx.store.message_by_client_id(conversation_id, &name)?
    else {
        // A message this device never received. Nothing to change, and nothing
        // to remember: unlike a reaction, an edit to an unknown message has no
        // meaning to hold on to.
        return Ok(());
    };

    // `None` means the message is ours. Nobody else may change it, and an
    // arriving change never can be ours -- our own envelopes are skipped
    // before this point.
    let Some(owner) = sender else {
        tracing::warn!(
            conversation_id,
            "a device tried to change one of our own messages"
        );
        return Ok(());
    };
    if owner != from_device {
        tracing::warn!(
            conversation_id,
            "a device tried to change a message it did not send"
        );
        return Ok(());
    }

    if !nexo_protocol::window::receiver_may_apply(target_sent_at_ms, change_sent_at_ms) {
        return Ok(());
    }

    match payload {
        Payload::Retract { .. } => {
            ctx.store
                .retract_message(conversation_id, &name, change_sent_at_ms)?
        }
        Payload::Edit {
            body, edited_at_ms, ..
        } => ctx
            .store
            .edit_message(conversation_id, &name, body, *edited_at_ms)?,
        _ => {}
    }
    Ok(())
}

/// Take back one of our own messages, or change what it says.
///
/// Both are the same act with different content, so they share a path. What
/// goes out is a request: a well-behaved Nexo applies it, and a modified one
/// need not. `docs/THREAT-MODEL.md` says so, and so must the UI.
///
/// The ten minutes checked here are a courtesy — a modified client sends
/// whenever it likes. The check that has teeth is on the receiving side, and
/// it is about *who*, not *when*.
pub fn revise<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    target: uuid::Uuid,
    body: Option<&str>,
    now_ms_value: i64,
) -> Result<(), ConversationError> {
    let id = conversation_id.to_string();
    let name = target.to_string();

    let (_, sender, sent_at_ms) = ctx
        .store
        .message_by_client_id(&id, &name)?
        .ok_or(ConversationError::NotAMember)?;

    // Ours are stored with no sender: MLS will not let a sender decrypt its
    // own ciphertext, so that absence is the signal. Anything else is somebody
    // else's message and not ours to change.
    if sender.is_some() {
        return Err(ConversationError::Transport(TransportError::Rejected(
            "That is not your message.".into(),
        )));
    }
    if !nexo_protocol::window::sender_may_change(sent_at_ms, now_ms_value) {
        return Err(ConversationError::Transport(TransportError::Rejected(
            "That message is too old to change.".into(),
        )));
    }

    let payload = match body {
        Some(text) => Payload::Edit {
            target,
            body: text.to_string(),
            edited_at_ms: now_ms_value,
        },
        None => Payload::Retract { target },
    };

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    match body {
        Some(text) => ctx.store.edit_message(&id, &name, text, now_ms_value)?,
        None => ctx.store.retract_message(&id, &name, now_ms_value)?,
    }
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// Sets the conversation's picture, for everyone in it.
///
/// The bytes are encrypted before they are uploaded and the key travels inside
/// an MLS message, exactly as an attachment does — so the bucket holds
/// ciphertext and the server never sees the picture. It is sent before it is
/// applied locally, which is the ordering rule at the top of this module.
pub fn set_group_avatar<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    contents: &[u8],
    mime: &str,
) -> Result<(), ConversationError> {
    let sealed = nexo_crypto::attachment::encrypt(contents)?;

    let id = conversation_id.to_string();
    let (url, s3_key) = ctx
        .transport
        .upload_url(&id, sealed.ciphertext.len() as u64)?;
    ctx.transport.put_object(&url, sealed.ciphertext)?;

    let payload = Payload::GroupAvatar {
        s3_key,
        key: to_hex(sealed.key.as_slice()),
        nonce: to_hex(&sealed.nonce),
        sha256: to_hex(&sealed.sha256),
        mime: mime.to_string(),
        size: sealed.size,
    };

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    ctx.store
        .set_conversation_avatar(&id, &payload.encode_string())?;
    mls_state::save(ctx.provider, ctx.store)?;
    Ok(())
}

/// The conversation's picture, decrypted.
///
/// `None` when it has none. The payload holding the key never leaves the
/// encrypted store; only the bytes come back.
pub fn group_avatar<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
) -> Result<Option<(Vec<u8>, String)>, ConversationError> {
    let Some(encoded) = ctx
        .store
        .conversation_avatar(&conversation_id.to_string())?
    else {
        return Ok(None);
    };
    let payload = Payload::decode(encoded.as_bytes());
    let Payload::GroupAvatar { mime, .. } = &payload else {
        return Ok(None);
    };
    let mime = mime.clone();
    let contents = fetch_attachment(ctx, &payload)?;
    Ok(Some((contents, mime)))
}

/// Sends a file.
///
/// Brief 5.3, in order: encrypt with a fresh key, upload the **ciphertext**,
/// then put the key inside the MLS message. The bucket receives bytes the
/// server cannot read, and the only copy of the key that opens them travels
/// end-to-end.
///
/// The upload happens before the message for the same reason every commit is
/// sent before it is applied: a message announcing a file that failed to upload
/// is a message pointing at nothing, and the recipient has no way to tell that
/// from a file they simply cannot fetch yet.
///
/// `voice` is what separates a recording from a file the sender chose. It comes
/// from the recorder and is carried rather than inferred; see
/// [`nexo_protocol::VoiceMeta`].
///
/// Video is sealed in segments so a recipient can start watching before the
/// file has arrived; everything else is sealed whole, as it always was.
pub fn send_attachment<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    name: &str,
    mime: &str,
    contents: &[u8],
    body: Option<&str>,
    voice: Option<VoiceMeta>,
) -> Result<Sent, ConversationError> {
    // Segmented only for video, and only because video is the thing anybody
    // wants to start watching before it has arrived. Sending every attachment
    // segmented would change the encoding of every file for a benefit a PDF
    // cannot use -- and it would change the encoding of every file already
    // understood by every client in the field.
    let segmented = mime.starts_with("video/");
    let sealed = if segmented {
        nexo_crypto::attachment::encrypt_segmented(contents)?
    } else {
        nexo_crypto::attachment::encrypt(contents)?
    };

    let id = conversation_id.to_string();
    let (url, s3_key) = ctx
        .transport
        .upload_url(&id, sealed.ciphertext.len() as u64)?;
    ctx.transport.put_object(&url, sealed.ciphertext)?;

    let payload = Payload::Attachment {
        s3_key,
        key: to_hex(sealed.key.as_slice()),
        nonce: to_hex(&sealed.nonce),
        sha256: to_hex(&sealed.sha256),
        name: name.to_string(),
        mime: mime.to_string(),
        size: sealed.size,
        body: body.map(str::to_string),
        voice,
        segmented,
        id: Some(uuid::Uuid::new_v4()),
    };
    let client_id = payload.id().map(|id| id.to_string());

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    let accepted = ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    // With the payload, exactly as `sync` stores an arriving one. Without it
    // the sender's own copy is a line of text naming a file: the message list
    // builds its attachment view from the payload, so a message stored without
    // one has no picture to draw and no key to open the file with. The
    // recipient saw the image; the person who sent it did not.
    ctx.store.insert(&nexo_store::NewMessage {
        envelope_id: accepted.envelope_id,
        conversation_id: &id,
        sender_device_id: None,
        body: payload.preview(),
        payload: Some(&payload.encode_string()),
        sent_at_ms: now_ms(),
        client_id: client_id.as_deref(),
        // An attachment is not an answer to anything. Replying *to* one is a
        // `Payload::Reply` naming it, which travels the ordinary send path.
        reply_to: None,
    })?;
    mls_state::save(ctx.provider, ctx.store)?;

    // The same shape `send_message` returns, and for the same reason: the
    // payload was given a name a moment ago, and a caller that only got the
    // envelope id would have to report `None` for a message that plainly has
    // one -- which would quietly withhold reacting, editing and taking back
    // from every attachment until the next reload.
    Ok(Sent::Delivered {
        envelope_id: accepted.envelope_id,
        client_id,
    })
}

/// Downloads and decrypts the attachment on a stored message.
///
/// Takes an envelope id because that is what a message list has. The payload
/// -- and with it the only copy of the file's key -- comes from the encrypted
/// store, where `sync` wrote it when the message arrived.
pub fn fetch_attachment_by_id<T: Transport>(
    ctx: &Context<'_, T>,
    envelope_id: i64,
) -> Result<Attachment, ConversationError> {
    let encoded = ctx
        .store
        .message_payload(envelope_id)?
        .ok_or(ConversationError::NotAnAttachment)?;
    let payload = Payload::decode(encoded.as_bytes());
    let Payload::Attachment { name, mime, .. } = &payload else {
        return Err(ConversationError::NotAnAttachment);
    };
    let (name, mime) = (name.clone(), mime.clone());
    let contents = fetch_attachment(ctx, &payload)?;
    Ok(Attachment {
        name,
        mime,
        contents,
    })
}

/// A decrypted attachment, ready to be written to disk or shown.
#[derive(Debug)]
pub struct Attachment {
    /// The sender's filename. Untrusted -- see `nexo_protocol::safe_file_name`.
    pub name: String,
    /// The sender's declared type. Also untrusted.
    pub mime: String,
    /// The verified plaintext.
    pub contents: Vec<u8>,
}

/// Sends a sticker.
///
/// Nothing is uploaded: the message carries the pack and the sticker's name,
/// and every client draws it from art it already has. See
/// [`Payload::Sticker`] for why that is the shape rather than sending a
/// picture.
///
/// Goes through the ordinary text path, outbox and all, because that is what it
/// is — a very short message that happens to render as a picture.
pub fn send_sticker<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    pack: &str,
    sticker_id: &str,
) -> Result<Sent, ConversationError> {
    send_message_payload(
        ctx,
        conversation_id,
        Payload::Sticker {
            pack: pack.to_string(),
            id: sticker_id.to_string(),
            message_id: Some(uuid::Uuid::new_v4()),
        },
        "",
    )
}

/// Sends a picture or clip the recipient can open once.
///
/// Encrypted and uploaded exactly like an attachment -- the difference is what
/// the receiving side does with the key, not how the bytes are protected. See
/// [`Payload::ViewOnce`] for what that does and does not buy.
///
/// Our own copy is written with **no key**. We still have the original file we
/// picked; keeping a key that let the sender reopen what the recipient no
/// longer can would make the bubble's own wording untrue on one side.
pub fn send_view_once<T: Transport>(
    ctx: &Context<'_, T>,
    conversation_id: ConversationId,
    mime: &str,
    contents: &[u8],
) -> Result<Sent, ConversationError> {
    let sealed = nexo_crypto::attachment::encrypt(contents)?;

    let id = conversation_id.to_string();
    let (url, s3_key) = ctx
        .transport
        .upload_url(&id, sealed.ciphertext.len() as u64)?;
    ctx.transport.put_object(&url, sealed.ciphertext)?;

    let name = uuid::Uuid::new_v4();
    let payload = Payload::ViewOnce {
        s3_key: s3_key.clone(),
        key: to_hex(sealed.key.as_slice()),
        nonce: to_hex(&sealed.nonce),
        sha256: to_hex(&sealed.sha256),
        mime: mime.to_string(),
        size: sealed.size,
        id: name,
    };

    let mut conversation = Conversation::load(ctx.provider, conversation_id, now_ms())?
        .ok_or(ConversationError::NotAMember)?;
    let ciphertext = conversation.encrypt(ctx.provider, ctx.signer, &payload.encode())?;

    let accepted = ctx.transport.send(
        &id,
        &to_hex(&ciphertext),
        conversation.epoch() as i64,
        false,
        &outbox::new_message_id(),
    )?;

    // The message row carries **no payload**. That is not an omission: the
    // payload holds the key, `messages.payload` is kept for the life of the
    // message, and a key kept there could be read again -- which is the one
    // thing this feature promises cannot happen.
    ctx.store.insert(&nexo_store::NewMessage {
        envelope_id: accepted.envelope_id,
        conversation_id: &id,
        sender_device_id: None,
        body: "",
        payload: None,
        sent_at_ms: now_ms(),
        client_id: Some(&name.to_string()),
        reply_to: None,
    })?;
    ctx.store.insert_view_once(&nexo_store::StoredViewOnce {
        client_id: name.to_string(),
        conversation_id: id,
        s3_key,
        enc_key: None,
        nonce: None,
        sha256: None,
        mime: mime.to_string(),
        size: contents.len() as i64,
        received_at_ms: now_ms(),
        // Ours, and already spent: there was never anything here for us to
        // open. Dated now so the bubble can say when it was sent.
        opened_at_ms: Some(now_ms()),
    })?;
    mls_state::save(ctx.provider, ctx.store)?;

    Ok(Sent::Delivered {
        envelope_id: accepted.envelope_id,
        client_id: Some(name.to_string()),
    })
}

/// Opens a view-once message, and destroys the key on the way out.
///
/// The order is the whole of the correctness here: fetch, decrypt, *then*
/// burn. Burning first would lose the picture to a dropped connection, and
/// burning is not undoable -- there is no second copy of that key anywhere,
/// which is exactly what was promised.
///
/// A second call finds no key and fails. Not "is refused by a check": the
/// bytes in the bucket cannot be decrypted by this device any more.
pub fn open_view_once<T: Transport>(
    ctx: &Context<'_, T>,
    client_id: &str,
) -> Result<(Vec<u8>, String), ConversationError> {
    let item = ctx
        .store
        .view_once(client_id)?
        .ok_or(ConversationError::NotAnAttachment)?;

    let (Some(key), Some(nonce), Some(sha256)) = (&item.enc_key, &item.nonce, &item.sha256) else {
        // Already opened, or ours. Either way there is nothing left to open,
        // and saying so is the honest answer rather than an error about state.
        return Err(ConversationError::NotAnAttachment);
    };

    let url = ctx.transport.download_url(&item.s3_key)?;
    let ciphertext = ctx.transport.get_object(&url)?;
    let plaintext = nexo_crypto::attachment::decrypt(
        &ciphertext,
        &from_hex(key)?,
        &from_hex(nonce)?,
        &from_hex(sha256)?,
    )?;

    ctx.store.burn_view_once(client_id, now_ms())?;
    Ok((plaintext.to_vec(), item.mime))
}

/// What a reader needs to stream one attachment without opening all of it.
#[derive(Debug, Clone)]
pub struct StreamInfo {
    /// Plaintext length, so a player can be told how long the file is before
    /// any of it has been fetched.
    pub size: u64,
    /// How many segments it is sealed in.
    pub segments: u64,
    /// The plaintext type the sender declared. A hint for choosing a player,
    /// never what decides whether bytes are rendered.
    pub mime: String,
}

/// Whether an attachment can be read a segment at a time, and how big it is.
///
/// `None` for anything sealed whole -- which is every attachment sent before
/// segmenting existed, and every non-video since. A caller that gets `None`
/// falls back to fetching the file, which is what it did before this existed.
pub fn stream_info<T: Transport>(
    ctx: &Context<'_, T>,
    envelope_id: i64,
) -> Result<Option<StreamInfo>, ConversationError> {
    let Some(encoded) = ctx.store.message_payload(envelope_id)? else {
        return Ok(None);
    };
    let Payload::Attachment {
        size,
        mime,
        segmented,
        ..
    } = Payload::decode(encoded.as_bytes())
    else {
        return Ok(None);
    };
    if !segmented {
        return Ok(None);
    }
    Ok(Some(StreamInfo {
        size,
        segments: nexo_crypto::attachment::segment_count(size),
        mime,
    }))
}

/// Fetches and opens one segment of a segmented attachment.
///
/// This is the call a range request turns into. It moves one segment over the
/// network, not the file: the ciphertext offsets are fixed by
/// `SEGMENT_CIPHERTEXT_LEN`, so the range is computed here rather than
/// discovered by reading.
///
/// Fails closed on every disagreement. A segment that was reordered, a stream
/// cut short, a `size` the sender lied about -- all of them come back as a
/// decryption failure rather than as short or shuffled bytes, because the index
/// and the total are authenticated with the segment (rule 7).
pub fn attachment_segment<T: Transport>(
    ctx: &Context<'_, T>,
    envelope_id: i64,
    index: u64,
) -> Result<Vec<u8>, ConversationError> {
    let payload = attachment_payload(ctx.store, envelope_id)?;
    attachment_segment_with(ctx.transport, &payload, index)
}

/// One message's payload, decoded.
///
/// The cheap half of the media reads: a row out of SQLCipher and a decode,
/// with no network in it. Public so the shell can do this under its lock and
/// then let go of it before the download.
pub fn attachment_payload(
    store: &EncryptedStore,
    envelope_id: i64,
) -> Result<Payload, ConversationError> {
    let encoded = store
        .message_payload(envelope_id)?
        .ok_or(ConversationError::NotAnAttachment)?;
    Ok(Payload::decode(encoded.as_bytes()))
}

/// The same segment fetch, given only a transport and an already-read payload.
///
/// See [`fetch_attachment_with`] for why the halves are separate: this one is
/// a ranged download and a decryption, and holding the client lock across it
/// makes every range request of a playing video block the rest of the app.
pub fn attachment_segment_with<T: Transport>(
    transport: &T,
    payload: &Payload,
    index: u64,
) -> Result<Vec<u8>, ConversationError> {
    use nexo_crypto::attachment::{SEGMENT_CIPHERTEXT_LEN, segment_count};

    let Payload::Attachment {
        s3_key,
        key,
        nonce,
        size,
        segmented,
        ..
    } = payload
    else {
        return Err(ConversationError::NotAnAttachment);
    };
    if !*segmented {
        return Err(ConversationError::NotAnAttachment);
    }

    let total = segment_count(*size);
    if index >= total {
        return Err(ConversationError::NotAnAttachment);
    }

    let from = index * SEGMENT_CIPHERTEXT_LEN as u64;
    // Inclusive, as HTTP means it. The last segment is short and the store
    // returns what exists rather than padding, which is why the length is not
    // checked here -- the tag is what decides whether it was the right bytes.
    let to = from + SEGMENT_CIPHERTEXT_LEN as u64 - 1;

    let url = transport.download_url(s3_key)?;
    let ciphertext = transport.get_object_range(&url, from, to)?;

    let plaintext = nexo_crypto::attachment::decrypt_segment(
        &ciphertext,
        &from_hex(key)?,
        &from_hex(nonce)?,
        index,
        total,
    )?;
    Ok(plaintext.to_vec())
}

/// Downloads and decrypts a whole attachment.
///
/// Both checks apply either way: GCM's tag catches a ciphertext altered in the
/// bucket or in transit, and the SHA-256 catches an upload that disagrees with
/// the message describing it.
///
/// **Handles both encodings.** A video is sealed in segments so it can be
/// streamed (see `attachment::encrypt_segmented`); everything else is sealed
/// whole. The two are indistinguishable from the ciphertext, so `segmented` on
/// the payload decides, and reading it wrongly is not a subtle failure — a
/// whole-object decrypt of segmented bytes fails its tag outright. That is what
/// it did between the segmented encoding landing and this branch being written:
/// saving a video, and opening one in the lightbox, both failed.
pub fn fetch_attachment<T: Transport>(
    ctx: &Context<'_, T>,
    payload: &Payload,
) -> Result<Vec<u8>, ConversationError> {
    fetch_attachment_with(ctx.transport, payload)
}

/// The same fetch, given only a transport.
///
/// Split out because this half touches neither the store nor the MLS provider
/// — it is a download and a decryption — while the shell holds one lock over
/// all three for the duration of a command. Opening a photo therefore stalled
/// every other IPC call behind it, a draft save included. A caller that has
/// already read the payload can hold this part outside the lock.
pub fn fetch_attachment_with<T: Transport>(
    transport: &T,
    payload: &Payload,
) -> Result<Vec<u8>, ConversationError> {
    // A group picture is encrypted the same way and read the same way; only
    // what it is attached to differs. It is never segmented -- only video is,
    // and an avatar is not a video.
    let (s3_key, key, nonce, sha256, segmented, size) = match payload {
        Payload::Attachment {
            s3_key,
            key,
            nonce,
            sha256,
            segmented,
            size,
            ..
        } => (s3_key, key, nonce, sha256, *segmented, *size),
        Payload::GroupAvatar {
            s3_key,
            key,
            nonce,
            sha256,
            ..
        } => (s3_key, key, nonce, sha256, false, 0),
        _ => return Err(ConversationError::NotAnAttachment),
    };

    let url = transport.download_url(s3_key)?;
    let ciphertext = transport.get_object(&url)?;
    let key = from_hex(key)?;
    let nonce = from_hex(nonce)?;
    let sha256 = from_hex(sha256)?;

    if !segmented {
        let plaintext = nexo_crypto::attachment::decrypt(&ciphertext, &key, &nonce, &sha256)?;
        return Ok(plaintext.to_vec());
    }

    // Reassembly and the hash check both live in `nexo-crypto`: this crate
    // does no cryptography of its own, and a second implementation of the
    // segment layout here is exactly how the two would drift.
    let plaintext =
        nexo_crypto::attachment::decrypt_segmented(&ciphertext, &key, &nonce, &sha256, size)?;
    Ok(plaintext.to_vec())
}

/// The safety number for a 1:1 conversation, for the Verify screen.
///
/// `None` when the group does not have exactly two members: a safety number is
/// a fingerprint over *both* parties, and there is no meaningful one to show
/// for a group of five.
pub fn safety_number(
    provider: &OpenMlsRustCrypto,
    conversation_id: ConversationId,
) -> Result<Option<String>, ConversationError> {
    let Some(conversation) = Conversation::load(provider, conversation_id, now_ms())? else {
        return Ok(None);
    };
    let keys = conversation.member_identity_keys();
    if keys.len() != 2 {
        return Ok(None);
    }
    let number = nexo_crypto::identity::SafetyNumber::new(&keys[0], &keys[1])?;
    Ok(Some(number.to_display_string()))
}

/// A stable local id for a story, from its object key.
///
/// The envelope does not carry the server's id — the author had it, the
/// recipients do not — so the key stands in. It is unique by construction
/// (`upload_url` mints it) and stable, which is all the local table needs to
/// avoid storing the same story twice when it arrives down two conversations.
/// Which id a received story is filed under.
///
/// The server's, whenever the sender carried one -- it is the only number the
/// download route and the story listing recognise, and the reader has no way
/// to derive it: an envelope names a device, and the stories table knows
/// nothing about devices.
///
/// The hash of the object key is not a substitute and never was. It stands in
/// for exactly one case, a story posted by a build from before
/// `Payload::Story::story_id` existed, and it buys exactly one thing there:
/// the same story arriving down two conversations is one row rather than two.
/// Such a story still cannot be opened, which is what it was already doing
/// before this function had a name.
fn received_story_id(carried: i64, s3_key: &str) -> i64 {
    if carried > 0 {
        carried
    } else {
        story_id_from(s3_key)
    }
}

fn story_id_from(s3_key: &str) -> i64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in s3_key.as_bytes() {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    // Positive, because the column is a rowid alias and negative ids are legal
    // but confusing to read in a log.
    (h >> 1) as i64
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(b & 0x0F), 16).unwrap());
    }
    out
}

fn from_hex(s: &str) -> Result<Vec<u8>, ConversationError> {
    if !s.len().is_multiple_of(2) {
        return Err(TransportError::Rejected("not hex".into()).into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|_| TransportError::Rejected("not hex".into()).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
        assert_eq!(from_hex("000fa5ff").unwrap(), vec![0x00, 0x0f, 0xa5, 0xff]);
    }

    #[test]
    fn odd_length_hex_is_refused_rather_than_truncated() {
        assert!(from_hex("abc").is_err());
        assert!(from_hex("zz").is_err());
    }

    /// The bug this replaced: every received story was filed under a hash of
    /// its object key, and `stories::open` then asked the server for that
    /// number. No route has ever known it, so a contact's story was listed
    /// with a blank name and refused to open.
    #[test]
    fn a_received_story_is_filed_under_the_servers_id() {
        assert_eq!(received_story_id(4242, "story/abc"), 4242);
    }

    #[test]
    fn a_story_from_a_build_without_the_id_keeps_the_old_stand_in() {
        assert_eq!(
            received_story_id(0, "story/abc"),
            story_id_from("story/abc"),
        );
        assert_ne!(
            story_id_from("story/abc"),
            story_id_from("story/def"),
            "and two stories must not collide into one row"
        );
    }

    #[test]
    fn a_sync_outcome_starts_empty() {
        let outcome = SyncOutcome::default();
        assert_eq!(outcome.messages, 0);
        assert_eq!(outcome.commits, 0);
        assert_eq!(outcome.failed, 0);
    }
}
