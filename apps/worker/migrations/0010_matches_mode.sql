-- How each match was started: 'live', 'daily' or 'custom'. Null on rows from before modes, which
-- read as 'custom'. Set when the row is first written and never changed after, so it costs no
-- extra writes.
ALTER TABLE matches ADD COLUMN mode TEXT;
