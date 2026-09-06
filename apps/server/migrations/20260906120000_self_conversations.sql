-- A conversation with yourself.
--
-- `kind` was written when there were two shapes a conversation could have, and
-- the CHECK said so. A conversation whose only member is the person who made
-- it is a third: a place to keep notes, links and files, and an ordinary
-- one-member MLS group as far as everything else is concerned.
--
-- The constraint is replaced rather than dropped. It is what stops a typo in
-- one query putting a value in this column that every `match` on it will fall
-- through, and that is worth keeping -- it just has one more case now.
ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;

ALTER TABLE conversations
    ADD CONSTRAINT conversations_kind_check
    CHECK (kind IN ('dm', 'group', 'self'));
