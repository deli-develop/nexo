//! Teams: an owner, admins and members over an ordinary conversation.
//!
//! A team is a conversation with `kind = 'team'`. Everything its members say
//! to each other -- the name, the description, every post, comment, reaction
//! and pin -- travels as MLS ciphertext through `delivery`, exactly as a group
//! message does, and this module never sees any of it. What it owns is the one
//! thing a team has that a group does not: **who may change who is in it**.
//!
//! That rule lives here, on the server, for the reason `blocks.rs` gives about
//! blocking: a rule only the client applies is one a modified client ignores.
//! The adds and removes themselves stay on `delivery`'s existing routes, which
//! ask [`may_add`] and [`may_remove`] when the conversation is a team -- one
//! membership path, with a gate on it, rather than a second path beside it.
//!
//! What this cannot enforce, and does not pretend to: the inside of an MLS
//! commit. A member running a modified client can build a commit that removes
//! somebody from the group; the server orders commits without reading them.
//! Every group here has that property, and `docs/THREAT-MODEL.md` says so.
//! Likewise pins and admin removals are content, so they are judged by every
//! receiving client against the roles this module serves -- not here.
//!
//! No activity field is served, ever: no "last active", no "online". A roster
//! is who is in the team and what they may do, not when they were last seen.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use nexo_protocol::ServerEvent;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::bearer::Caller;
use crate::delivery::DeliveryError;
use crate::state::AppState;

/// The most people a team may hold.
///
/// Commit size and fan-out both grow with the group: every add, removal and
/// key update is a commit every member processes, and every post is an
/// envelope every member's socket is sent. Two hundred keeps that ordinary on a
/// phone. And Nexo is not a broadcast tool -- the public feed is, and reaching
/// thousands of people is what it is for.
pub const MAX_MEMBERS: i64 = 200;

/// What somebody may do in a team.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Exactly one per team. May do everything, including hand the team on.
    Owner,
    /// May add people, remove members, promote members, pin and remove posts.
    Admin,
    /// May post, comment and react.
    Member,
}

impl Role {
    /// Reads the column. Anything else is refused by the CHECK constraint, so
    /// `None` here means a row this build cannot account for.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            _ => None,
        }
    }

    /// The column's spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}

/// Whether someone with `actor`'s role may add people.
pub fn may_add(actor: Role) -> bool {
    matches!(actor, Role::Owner | Role::Admin)
}

/// Whether `actor` may take `target` out of the team.
///
/// Anybody but the owner may take themselves out -- that is leaving. The owner
/// may not, because a team with no owner has nobody who can hand it on or
/// delete it; they transfer first, or delete. Otherwise an admin removes
/// members, and only the owner removes an admin.
pub fn may_remove(actor: Role, target: Role, is_self: bool) -> bool {
    if is_self {
        return actor != Role::Owner;
    }
    match actor {
        Role::Owner => target != Role::Owner,
        Role::Admin => target == Role::Member,
        Role::Member => false,
    }
}

/// Whether `actor` may give `target` the role `to`.
///
/// Only admin and member can be given this way. Ownership moves by
/// [`transfer`], which demotes the old owner in the same transaction; setting
/// it here would make two owners or none. An admin may promote a member; only
/// the owner may demote an admin.
pub fn may_set_role(actor: Role, target: Role, to: Role) -> bool {
    if to == Role::Owner || target == Role::Owner {
        return false;
    }
    match actor {
        Role::Owner => true,
        Role::Admin => target == Role::Member,
        Role::Member => false,
    }
}

/// Every team route. All of them require a [`Caller`].
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/teams", post(create_team).get(list_teams))
        .route("/v1/teams/{id}", delete(delete_team))
        .route("/v1/teams/{id}/members", get(list_members))
        .route("/v1/teams/{id}/members/{handle}", patch(set_role))
        .route("/v1/teams/{id}/transfer", post(transfer))
        .route("/v1/teams/{id}/leave", post(leave))
}

/// The caller's role in a team, or `NotAMember` -- the same answer a
/// conversation that does not exist, or is not a team, gives.
pub(crate) async fn role_in(
    db: impl sqlx::PgExecutor<'_>,
    conversation_id: Uuid,
    user_id: i64,
) -> Result<Role, DeliveryError> {
    let row = sqlx::query!(
        "SELECT m.role FROM conversation_members m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.conversation_id = $1 AND m.user_id = $2 AND c.kind = 'team'",
        conversation_id,
        user_id
    )
    .fetch_optional(db)
    .await?
    .ok_or(DeliveryError::NotAMember)?;
    Role::parse(&row.role)
        .ok_or_else(|| DeliveryError::Internal(anyhow::anyhow!("unknown role {:?}", row.role)))
}

/// Holds the team's row for the rest of the transaction.
///
/// Every change to a team's membership or roles takes this first, so two of
/// them on the same team happen one after the other: a transfer and a
/// promotion, two adds racing for the last seat, cannot interleave their reads
/// and writes.
pub(crate) async fn lock_team(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    conversation_id: Uuid,
) -> Result<(), DeliveryError> {
    sqlx::query!(
        "SELECT id FROM conversations WHERE id = $1 AND kind = 'team' FOR UPDATE",
        conversation_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(DeliveryError::NotAMember)?;
    Ok(())
}

/// Tells every member's socket that the roster changed.
///
/// A nudge, not the change -- see [`ServerEvent::Membership`]. Also what ends a
/// removed member's subscription: `stream` re-checks membership when it sees
/// one, rather than on every envelope.
pub(crate) fn announce(state: &AppState, conversation_id: Uuid) {
    state
        .fanout
        .publish(conversation_id, ServerEvent::Membership { conversation_id });
}

#[derive(Deserialize)]
pub struct CreateTeamRequest {
    /// The client picks the id, because it is also the MLS group id and the
    /// group exists on the client before the server hears of it.
    pub conversation_id: Uuid,
}

/// One team, as its member sees it.
#[derive(Serialize)]
pub struct TeamView {
    pub conversation_id: Uuid,
    /// The caller's own role.
    pub role: &'static str,
    pub member_count: i64,
    pub created_at_ms: i64,
}

/// Starts a team with the caller as its owner and only member.
///
/// People are added afterwards through `delivery`'s member route, one commit
/// each, which is where the add gates are. Nothing about the team -- not even
/// its name -- is sent here: the name is the first message.
async fn create_team(
    State(state): State<AppState>,
    caller: Caller,
    Json(request): Json<CreateTeamRequest>,
) -> Result<(StatusCode, Json<TeamView>), DeliveryError> {
    if !state.limits.teams.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "team creation rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let mut tx = state.db.begin().await?;
    let created = sqlx::query!(
        "INSERT INTO conversations (id, kind) VALUES ($1, 'team')
         ON CONFLICT (id) DO NOTHING
         RETURNING (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS \"created_at_ms!\"",
        request.conversation_id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| DeliveryError::Invalid("That conversation already exists.".into()))?;

    sqlx::query!(
        "INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'owner')",
        request.conversation_id,
        caller.user_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok((
        StatusCode::CREATED,
        Json(TeamView {
            conversation_id: request.conversation_id,
            role: Role::Owner.as_str(),
            member_count: 1,
            created_at_ms: created.created_at_ms,
        }),
    ))
}

/// The caller's teams.
async fn list_teams(
    State(state): State<AppState>,
    caller: Caller,
) -> Result<Json<Vec<TeamView>>, DeliveryError> {
    let rows = sqlx::query!(
        "SELECT c.id, m.role,
                (SELECT count(*) FROM conversation_members all_m
                 WHERE all_m.conversation_id = c.id) AS \"member_count!\",
                (EXTRACT(EPOCH FROM c.created_at) * 1000)::BIGINT AS \"created_at_ms!\"
         FROM conversations c
         JOIN conversation_members m ON m.conversation_id = c.id
         WHERE m.user_id = $1 AND c.kind = 'team'
         ORDER BY c.created_at",
        caller.user_id
    )
    .fetch_all(&state.db)
    .await?;

    rows.into_iter()
        .map(|row| {
            let role = Role::parse(&row.role).ok_or_else(|| {
                DeliveryError::Internal(anyhow::anyhow!("unknown role {:?}", row.role))
            })?;
            Ok(TeamView {
                conversation_id: row.id,
                role: role.as_str(),
                member_count: row.member_count,
                created_at_ms: row.created_at_ms,
            })
        })
        .collect::<Result<Vec<_>, DeliveryError>>()
        .map(Json)
}

/// One person on a team's roster.
///
/// Three fields, and the absence of a fourth is the design: nothing here says
/// when anybody was last active.
#[derive(Serialize)]
pub struct MemberView {
    pub handle: String,
    pub role: &'static str,
    pub joined_at_ms: i64,
}

/// Who is in a team, owner first, then admins, then members, each by when they
/// joined. For members only.
async fn list_members(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
) -> Result<Json<Vec<MemberView>>, DeliveryError> {
    role_in(&state.db, conversation_id, caller.user_id).await?;

    let rows = sqlx::query!(
        "SELECT u.handle, m.role,
                (EXTRACT(EPOCH FROM m.joined_at) * 1000)::BIGINT AS \"joined_at_ms!\"
         FROM conversation_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.conversation_id = $1
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                  m.joined_at, u.handle",
        conversation_id
    )
    .fetch_all(&state.db)
    .await?;

    rows.into_iter()
        .map(|row| {
            let role = Role::parse(&row.role).ok_or_else(|| {
                DeliveryError::Internal(anyhow::anyhow!("unknown role {:?}", row.role))
            })?;
            Ok(MemberView {
                handle: row.handle,
                role: role.as_str(),
                joined_at_ms: row.joined_at_ms,
            })
        })
        .collect::<Result<Vec<_>, DeliveryError>>()
        .map(Json)
}

#[derive(Deserialize)]
pub struct RoleRequest {
    /// `"admin"` or `"member"`.
    pub role: String,
}

/// Promotes a member to admin, or an admin back to member.
async fn set_role(
    State(state): State<AppState>,
    caller: Caller,
    Path((conversation_id, handle)): Path<(Uuid, String)>,
    Json(request): Json<RoleRequest>,
) -> Result<StatusCode, DeliveryError> {
    if !state.limits.membership.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "membership rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }
    let to = Role::parse(&request.role)
        .ok_or_else(|| DeliveryError::Invalid("A role is \"admin\" or \"member\".".into()))?;

    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, conversation_id).await?;
    let actor = role_in(&mut *tx, conversation_id, caller.user_id).await?;
    let (target_id, target) = member_by_handle(&mut tx, conversation_id, &handle).await?;

    if !may_set_role(actor, target, to) {
        return Err(DeliveryError::NotPermitted(
            "Only the owner can change an admin, and ownership is handed on, not set.",
        ));
    }
    if target == to {
        return Ok(StatusCode::NO_CONTENT);
    }

    sqlx::query!(
        "UPDATE conversation_members SET role = $3
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        target_id,
        to.as_str()
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    announce(&state, conversation_id);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct TransferRequest {
    /// Who becomes the owner. Must already be in the team.
    pub handle: String,
}

/// Hands the team to somebody else. The old owner stays, as an admin.
///
/// One transaction under the team's lock, demoting before promoting: the
/// one-owner index would refuse the other order, and without the lock two
/// transfers could each read "I am the owner" before either wrote.
async fn transfer(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
    Json(request): Json<TransferRequest>,
) -> Result<StatusCode, DeliveryError> {
    if !state.limits.membership.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "membership rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, conversation_id).await?;
    if role_in(&mut *tx, conversation_id, caller.user_id).await? != Role::Owner {
        return Err(DeliveryError::NotPermitted(
            "Only the owner can hand the team on.",
        ));
    }
    let (target_id, _) = member_by_handle(&mut tx, conversation_id, &request.handle).await?;
    if target_id == caller.user_id {
        return Err(DeliveryError::Invalid("You already own this team.".into()));
    }

    sqlx::query!(
        "UPDATE conversation_members SET role = 'admin'
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        caller.user_id
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE conversation_members SET role = 'owner'
         WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        target_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    announce(&state, conversation_id);
    Ok(StatusCode::NO_CONTENT)
}

/// Takes the caller out of a team. Anybody but the owner.
///
/// Routing only, like every removal here: it stops the caller fetching. The
/// MLS commit that stops them *reading* is made by an owner's or admin's
/// device when it sees the roster change -- a member cannot commit their own
/// removal and keep the rest of the group's keys moving.
async fn leave(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
) -> Result<StatusCode, DeliveryError> {
    if !state.limits.membership.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "membership rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, conversation_id).await?;
    let role = role_in(&mut *tx, conversation_id, caller.user_id).await?;
    if !may_remove(role, role, true) {
        return Err(DeliveryError::NotPermitted(
            "The owner hands the team on or deletes it, rather than leaving it.",
        ));
    }
    sqlx::query!(
        "DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
        conversation_id,
        caller.user_id
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    announce(&state, conversation_id);
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes a team for everybody. The owner only.
///
/// The conversation row goes, and its membership and every envelope with it.
/// The members' own copies of what was said are on their devices and are not
/// this server's to reach; the objects its posts' files point at stay in the
/// bucket as ciphertext nobody holds a key for any more.
async fn delete_team(
    State(state): State<AppState>,
    caller: Caller,
    Path(conversation_id): Path<Uuid>,
) -> Result<StatusCode, DeliveryError> {
    if !state.limits.membership.check(&caller.user_id.to_string()) {
        tracing::warn!(user_id = caller.user_id, "membership rate limit reached");
        return Err(DeliveryError::TooManyRequests);
    }

    let mut tx = state.db.begin().await?;
    lock_team(&mut tx, conversation_id).await?;
    if role_in(&mut *tx, conversation_id, caller.user_id).await? != Role::Owner {
        return Err(DeliveryError::NotPermitted(
            "Only the owner can delete the team.",
        ));
    }
    sqlx::query!("DELETE FROM conversations WHERE id = $1", conversation_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    announce(&state, conversation_id);
    Ok(StatusCode::NO_CONTENT)
}

/// A member of this team, by handle, with their role.
async fn member_by_handle(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    conversation_id: Uuid,
    handle: &str,
) -> Result<(i64, Role), DeliveryError> {
    let row = sqlx::query!(
        "SELECT u.id, m.role FROM users u
         JOIN conversation_members m ON m.user_id = u.id
         WHERE m.conversation_id = $1 AND u.handle = $2",
        conversation_id,
        handle as _
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(DeliveryError::NotFound("member"))?;
    let role = Role::parse(&row.role)
        .ok_or_else(|| DeliveryError::Internal(anyhow::anyhow!("unknown role {:?}", row.role)))?;
    Ok((row.id, role))
}

#[cfg(test)]
mod tests {
    use super::*;
    use Role::{Admin, Member, Owner};

    #[test]
    fn only_owners_and_admins_add() {
        assert!(may_add(Owner));
        assert!(may_add(Admin));
        assert!(!may_add(Member));
    }

    #[test]
    fn the_owner_cannot_leave_and_everyone_else_can() {
        assert!(!may_remove(Owner, Owner, true));
        assert!(may_remove(Admin, Admin, true));
        assert!(may_remove(Member, Member, true));
    }

    #[test]
    fn removal_goes_down_the_ladder_only() {
        assert!(may_remove(Owner, Admin, false));
        assert!(may_remove(Owner, Member, false));
        assert!(may_remove(Admin, Member, false));
        // An admin cannot remove the owner or another admin; only the owner
        // removes an admin.
        assert!(!may_remove(Admin, Owner, false));
        assert!(!may_remove(Admin, Admin, false));
        assert!(!may_remove(Member, Member, false));
        assert!(!may_remove(Member, Admin, false));
    }

    #[test]
    fn roles_move_between_admin_and_member_and_never_to_owner() {
        assert!(may_set_role(Owner, Member, Admin));
        assert!(may_set_role(Owner, Admin, Member));
        assert!(may_set_role(Admin, Member, Admin));
        // Demoting an admin is the owner's alone.
        assert!(!may_set_role(Admin, Admin, Member));
        assert!(!may_set_role(Member, Member, Admin));
        // Ownership is transferred, not set, and the owner is not demoted here.
        assert!(!may_set_role(Owner, Admin, Owner));
        assert!(!may_set_role(Owner, Owner, Admin));
    }

    #[test]
    fn roles_read_back_as_written() {
        for role in [Owner, Admin, Member] {
            assert_eq!(Role::parse(role.as_str()), Some(role));
        }
        assert_eq!(Role::parse("editor"), None);
    }
}
