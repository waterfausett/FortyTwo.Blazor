-- Whether the app on the device draws its own notices with buttons (push/send.ts): on Android, a
-- notification Expo sends with a title is drawn by the OS without the app's buttons, so an app that
-- can is sent those notices headless to draw itself. Older versions of the app don't say, so a
-- device starts out with the OS drawing everything.
ALTER TABLE push_tokens ADD COLUMN draws_own INTEGER NOT NULL DEFAULT 0;
