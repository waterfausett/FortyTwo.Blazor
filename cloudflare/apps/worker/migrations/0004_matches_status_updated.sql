-- Serves the two queries that scan matches by status and age: the daily expiry sweep (oldest
-- active first) and the lobby's paged lists (newest first, keyset on updated_on then id).
CREATE INDEX idx_matches_status_updated ON matches(status, updated_on);
