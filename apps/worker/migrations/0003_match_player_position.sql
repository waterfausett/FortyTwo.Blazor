-- Which seat (0-3) each player sits in, so Find a Game can show which seats are still open for a
-- joining player to pick. Nullable: rows synced before this column existed are backfilled the
-- next time their match changes.
ALTER TABLE match_players ADD COLUMN position INTEGER;
