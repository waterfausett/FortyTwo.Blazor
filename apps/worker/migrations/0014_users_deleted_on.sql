-- Account deletion (#139). A deleted player's users row stays as a tombstone - display name
-- "Unknown", no picture, deleted_on set - so the finished matches they're still seated in show a
-- name without asking Auth0 about an id it no longer knows. People search skips tombstones.
ALTER TABLE users ADD COLUMN deleted_on TEXT;
