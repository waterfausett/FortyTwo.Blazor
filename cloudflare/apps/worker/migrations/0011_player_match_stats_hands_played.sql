-- How many hands the player played themselves in the match (stats.ts). A player who took over a
-- seat late may have played only a few; their result counts from MIN_HANDS_FOR_RESULT up, their
-- bids always. Null on rows from before it was kept, which count as before.
ALTER TABLE player_match_stats ADD COLUMN hands_played INTEGER;
