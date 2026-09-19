-- Meet&Greet is removed. The map, the pins, the agreement and the intro
-- requests go with it.
--
-- The invitations do not. `meet_invites` was only ever named after the module
-- it happened to live in: what it actually holds is the way past the
-- private-account gate in `invites::may_reach`, which the delivery service
-- calls before creating any conversation. Dropping it would quietly turn every
-- private account into an unreachable one, so it is renamed rather than
-- removed.
--
-- This migration is destructive and deliberately so. A pin was a claim
-- somebody typed about where they were, and an intro was a message that had
-- already been delivered or refused; neither has a second home to be moved to.

-- The foreign key from requests to invitations goes first, so the invitations
-- survive the drop below.
ALTER TABLE meet_requests DROP CONSTRAINT IF EXISTS meet_requests_invite_id_fkey;

DROP TABLE IF EXISTS meet_requests;
DROP TABLE IF EXISTS meet_profiles;
DROP TABLE IF EXISTS meet_consent;

ALTER TABLE meet_invites RENAME TO invites;
ALTER INDEX meet_invites_owner_idx RENAME TO invites_owner_idx;

-- The column the requests table used to carry is gone with it, so the count of
-- "how many people came through this invitation" needs a home of its own.
--
-- One row per person, not per attempt: the number the owner reads is how many
-- people the link let in, and a retry is not another person. Written by
-- `may_reach` at the moment the secret is spent, which is the only moment the
-- server can see it happen.
CREATE TABLE invite_uses (
    invite_id BIGINT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (invite_id, user_id)
);

CREATE INDEX invite_uses_invite_idx ON invite_uses (invite_id, used_at DESC);
