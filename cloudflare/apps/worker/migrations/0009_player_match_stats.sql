-- Each human's figures from one completed match (stats.ts), for the Profile's Stats section: one
-- row per human, written once when the match is won, added up when they ask. Counted from launch:
-- matches completed before this table existed aren't in it. No reference to `matches` - stats
-- outlive the lobby index's rows.
CREATE TABLE player_match_stats (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  with_bots INTEGER NOT NULL,
  won INTEGER NOT NULL,
  marks_won INTEGER NOT NULL,
  bids_won INTEGER NOT NULL,
  bids_made INTEGER NOT NULL,
  points_bid_total INTEGER NOT NULL,
  points_bid_count INTEGER NOT NULL,
  marks_bids INTEGER NOT NULL,
  completed_on TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX idx_player_match_stats_player ON player_match_stats(player_id);
