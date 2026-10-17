-- A custom table's house rules as JSON (the rules package's HouseRules). Null for every other
-- table and for a custom table on the default rules. Set when the row is first written and never
-- changed after, so it costs no extra writes.
ALTER TABLE matches ADD COLUMN rules TEXT;
