-- The indexes the previous migration could not rename by renaming the table.
--
-- `ALTER TABLE meet_invites RENAME TO invites` renames the table and the
-- indexes that were created explicitly, but **not** the ones Postgres created
-- for you behind a PRIMARY KEY or a UNIQUE constraint. Those kept their
-- original names, so a product with no Meet&Greet still had a
-- `meet_invites_pkey` in its schema -- harmless to the server, and a trap for
-- the next person who writes a migration that has to name the constraint.
--
-- A second file rather than an edit to the first, even though the first has
-- not been deployed anywhere: a migration that has been applied to *any*
-- database, including a developer's, is one that gets edited at somebody's
-- cost. The rule is worth more than the tidiness of one file.

ALTER INDEX IF EXISTS meet_invites_pkey RENAME TO invites_pkey;
ALTER INDEX IF EXISTS meet_invites_secret_hash_key RENAME TO invites_secret_hash_key;
