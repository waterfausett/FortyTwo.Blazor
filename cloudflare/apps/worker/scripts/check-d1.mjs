// Read-only health check of the D1 lobby index against the remote database (or the local one with
// --local): row counts, then each check below, listing any rows it finds. Exits 1 when a check finds
// something. Useful after D1 writes have been failing (say, the daily write quota ran out), since
// the match DOs keep going while their lobby rows fall behind.
//
//   npm run db:check -w @fortytwo/worker [-- --local]
//
// Can't see a match whose DO exists but never got a matches row at all: DOs can't be listed, so
// nothing in D1 points to it. Such a match is missing from the lobby until its seats change again.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const DATABASE = 'fortytwo';
const where = process.argv.includes('--local') ? '--local' : '--remote';

// Same as MATCH_IDLE_DAYS in src/expiry.ts.
const MATCH_IDLE_DAYS = 14;

const counts = `
  SELECT
    (SELECT COUNT(*) FROM matches WHERE status = 'active') AS active_matches,
    (SELECT COUNT(*) FROM matches WHERE status = 'completed') AS completed_matches,
    (SELECT COUNT(*) FROM match_players) AS match_players,
    (SELECT COUNT(*) FROM push_tokens) AS push_tokens`;

const checks = [
  {
    name: "player_count doesn't match the seated rows",
    hint: 'the matches row and match_players were written separately and one of them failed',
    sql: `
      SELECT m.id, m.status, m.player_count, COUNT(p.player_id) AS seated, m.updated_on
      FROM matches m LEFT JOIN match_players p ON p.match_id = m.id
      GROUP BY m.id HAVING m.player_count != COUNT(p.player_id)
      ORDER BY m.updated_on DESC`,
  },
  {
    name: 'Seated rows with no matches row',
    hint: 'left behind by a delete that only got partway',
    sql: `
      SELECT p.match_id, COUNT(*) AS seated
      FROM match_players p LEFT JOIN matches m ON m.id = p.match_id
      WHERE m.id IS NULL GROUP BY p.match_id`,
  },
  {
    name: 'Seats missing, out of range or shared',
    hint: 'a null position or team is from before those columns existed; the next seat change rewrites it',
    sql: `
      SELECT match_id, player_id, team, position FROM match_players
      WHERE position IS NULL OR team IS NULL OR position NOT BETWEEN 0 AND 3
         OR (match_id, position) IN (
           SELECT match_id, position FROM match_players
           WHERE position IS NOT NULL GROUP BY match_id, position HAVING COUNT(*) > 1)
      ORDER BY match_id, position`,
  },
  {
    name: `Active matches idle more than ${MATCH_IDLE_DAYS} days`,
    hint: 'the daily expiry cron (src/expiry.ts) should have dealt with these; check its logs',
    sql: `
      SELECT id, player_count, updated_on FROM matches
      WHERE status = 'active' AND updated_on < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${MATCH_IDLE_DAYS} days')
      ORDER BY updated_on`,
  },
];

const require = createRequire(import.meta.url);
const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');

// Runs one statement through wrangler and returns its rows. Run without a shell, so the SQL needs
// no quoting.
function query(sql) {
  const run = spawnSync(
    process.execPath,
    [wrangler, 'd1', 'execute', DATABASE, where, '--json', '--command', sql.replace(/\s+/g, ' ').trim()],
    { encoding: 'utf8' }
  );
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    process.exit(2);
  }
  return JSON.parse(run.stdout)[0].results;
}

console.log(`D1 '${DATABASE}' (${where.slice(2)})\n`);
console.table(query(counts));

let problems = 0;
for (const { name, hint, sql } of checks) {
  const rows = query(sql);
  if (rows.length === 0) {
    console.log(`ok    ${name}`);
    continue;
  }
  problems++;
  console.log(`FOUND ${name}: ${rows.length} (${hint})`);
  console.table(rows);
}
process.exit(problems > 0 ? 1 : 0);
