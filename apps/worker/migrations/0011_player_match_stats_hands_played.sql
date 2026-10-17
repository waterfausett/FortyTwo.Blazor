-- How many hands the player played themselves in the match, and how many hands the match had in
-- all (stats.ts). A player who took over a seat late may have played only a few; their result
-- counts once they played MIN_HANDS_FOR_RESULT hands, or every hand of a match shorter than that
-- (one won by marks bids can be over in two), and their bids always. Null on rows from before
-- they were kept, which count as before.
ALTER TABLE player_match_stats ADD COLUMN hands_played INTEGER;
ALTER TABLE player_match_stats ADD COLUMN hands_total INTEGER;
