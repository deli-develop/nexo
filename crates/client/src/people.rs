//! Finding people, letting them in, and reporting them.
//!
//! What is left of the Meet&Greet client after the map was removed, and left
//! because none of it was ever about the map: search is how anybody finds
//! anybody, an invitation is how somebody gets past a private account's gate,
//! and reporting is the one thing blocking cannot do.
//!
//! The same shape as [`crate::feed`]: everything goes through the
//! [`Transport`](crate::transport::Transport) trait, there is no HTTP client
//! here and no platform call, so this crate still compiles for Android
//! unchanged.

use crate::transport::{Transport, TransportError};

/// What went wrong.
///
/// One variant, because none of these calls touch the local store: they ask
/// the server a question and hand back the answer. The moment one of them
/// caches something, this grows a `Store` variant and not before.
#[derive(Debug, thiserror::Error)]
pub enum PeopleError {
    /// The network, or the server.
    #[error(transparent)]
    Transport(#[from] TransportError),
}

/// Everything these calls need.
pub struct Context<'a, T: Transport> {
    /// The network.
    pub transport: &'a T,
}

/// Find people. Public accounts only, and never yourself.
///
/// A private account is absent from this, and that absence is enforced by the
/// server rather than filtered here — a directory the client trims is one
/// anybody can untrim.
pub fn search<T: Transport>(
    ctx: &Context<'_, T>,
    term: &str,
) -> Result<Vec<crate::transport::SearchResult>, PeopleError> {
    Ok(ctx.transport.search_users(term)?)
}

/// Mint an invitation.
///
/// The secret comes back once. It is stored as a hash, so a lost one cannot be
/// recovered — it is revoked and replaced, the same answer a password reset
/// gives and for the same reason.
pub fn create_invite<T: Transport>(
    ctx: &Context<'_, T>,
    label: Option<&str>,
    days: i64,
) -> Result<crate::transport::MintedInvite, PeopleError> {
    Ok(ctx.transport.create_invite(label, days)?)
}

/// My invitations, live and spent.
pub fn invites<T: Transport>(
    ctx: &Context<'_, T>,
) -> Result<Vec<crate::transport::InviteSummary>, PeopleError> {
    Ok(ctx.transport.list_invites()?)
}

/// Withdraw an invitation. The row stays, so the uses recorded against it can
/// still be counted.
pub fn revoke_invite<T: Transport>(ctx: &Context<'_, T>, id: i64) -> Result<(), PeopleError> {
    ctx.transport.revoke_invite(id)?;
    Ok(())
}

/// File a report about somebody.
///
/// Blocking answers "I do not want to see this person", reporting answers
/// "this should not be here", and the second needs somebody other than the
/// reporter to act. The server has had the endpoint since BRIEF 13.
pub fn report<T: Transport>(
    ctx: &Context<'_, T>,
    subject_kind: &str,
    subject_id: i64,
    reason: &str,
    note: Option<&str>,
) -> Result<(), PeopleError> {
    ctx.transport
        .report(subject_kind, subject_id, reason, note)?;
    Ok(())
}
