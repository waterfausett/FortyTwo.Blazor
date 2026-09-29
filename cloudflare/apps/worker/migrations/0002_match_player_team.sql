-- Which team each seated player is on (1 = TeamA, 2 = TeamB), so the lobby can show matchups
-- ("A & B vs C & D"). Nullable: rows synced before this column existed are backfilled the next
-- time their match changes.
ALTER TABLE match_players ADD COLUMN team INTEGER;
