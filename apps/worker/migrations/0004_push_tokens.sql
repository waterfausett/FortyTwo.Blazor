-- Each device that can receive push notifications, by its Expo push token, and whose it is. A
-- token belongs to one device, so signing in as someone else on that device moves it to them.
CREATE TABLE push_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  updated_on TEXT NOT NULL
);

CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);
