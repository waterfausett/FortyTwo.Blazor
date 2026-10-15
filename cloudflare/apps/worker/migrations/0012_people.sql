-- Recent players, friends and invites (#116). played_with is who has sat at a started game with
-- whom, one row per direction, humans only - kept apart from match_players, whose rows go when a
-- match expires. friends are one-way stars. invites are to a custom table, until used or stale.
CREATE TABLE played_with (
  user_id TEXT NOT NULL,
  other_id TEXT NOT NULL,
  last_played_on TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, other_id)
);
CREATE INDEX played_with_recent ON played_with (user_id, last_played_on);

CREATE TABLE friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_on TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE invites (
  match_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  created_on TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, to_id)
);
CREATE INDEX invites_to ON invites (to_id, created_on);

CREATE INDEX users_display_name ON users (display_name COLLATE NOCASE);

-- Everyone who shared a full table still in the lobby index. Expired matches are gone, so the
-- list starts from what's left.
INSERT INTO played_with (user_id, other_id, last_played_on, games)
SELECT a.player_id, b.player_id, MAX(m.updated_on), COUNT(*)
FROM match_players a
JOIN match_players b ON b.match_id = a.match_id AND b.player_id <> a.player_id
JOIN matches m ON m.id = a.match_id
WHERE m.player_count = 4 AND a.player_id NOT LIKE 'bot-%' AND b.player_id NOT LIKE 'bot-%'
GROUP BY a.player_id, b.player_id;
