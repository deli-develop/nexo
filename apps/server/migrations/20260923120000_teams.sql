-- Teams: a private board for up to 200 people, with an owner and admins.
--
-- A team is a conversation. Its id is the conversation id, its MLS group is
-- the conversation's group, and its posts travel as envelopes like any other
-- message -- so this migration adds no table for posts, comments, names or
-- descriptions, and must never gain one. All of that is inside the ciphertext,
-- where the server cannot read it (rule 4). What the server learns from a team
-- is what it already learns from a group: that it exists, who is in it, and
-- when envelopes flow. It learns one thing more, and this file is where: who
-- in it is the owner and who is an admin.
--
-- Roles are enforced here and in `teams.rs`, not in the client, because a rule
-- only the client applies is one a modified client ignores. What the server can
-- gate is the routing table -- who may add, remove, promote. What it cannot
-- gate is the inside of an MLS commit: a member running a modified client can
-- still build a commit that removes somebody from the group. That is a property
-- of every group here, recorded in `docs/THREAT-MODEL.md`, not a gap in this
-- migration.
--
-- Deliberately not here: custom roles, per-permission flags, topics, a public
-- directory of teams, a join link. See `docs/TELEGRAM-FEATURES.md`, "Group
-- scale".

-- conversations_kind_check was last widened in 20260906120000_self_conversations.
ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
    CHECK (kind IN ('dm', 'group', 'self', 'team'));

-- conversation_members.role has existed since the first migration and nothing
-- has ever read or written it: every row is the default. Teams give it a
-- meaning; every other kind stays 'member'. The CHECK is what stops a typo in
-- one query from inventing a fourth role that every `match` falls through.
ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_role_check
    CHECK (role IN ('owner', 'admin', 'member'));

-- One owner per team. "At most one" is this index, not a handler check: two
-- transfers racing each other cannot both commit, whatever the handlers do.
-- "At least one" is `teams.rs`: the owner cannot leave or be removed, only hand
-- the team on or delete it.
CREATE UNIQUE INDEX conversation_members_one_owner
    ON conversation_members (conversation_id) WHERE role = 'owner';
