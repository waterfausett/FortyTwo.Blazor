import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Bid, Suit, Teams, type Game, type MatchState, type Positions } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { readPlayerStats, recordMatchStats } from '../src/stats';
import { saveUsers } from '../src/users/publicUsers';

const testEnv = env as unknown as Env;

function hand(n: number, bidder: string, bidderTeam: Teams, bid: Bid): Game {
  return {
    id: `g${n}`, name: `Game ${n}`, firstActionBy: null, bid, biddingPlayerId: bidder, trump: Suit.Sixes,
    currentPlayerId: null, hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] }, tricks: [],
  };
}

// A won match: seats 0 & 2 are TeamA. TeamA's filed hands are bid by seat 0 (30 each).
function won(id: string, players: string[], winner: Teams, marks = 7): MatchState {
  const bidder = players[winner === Teams.TeamA ? 0 : 1];
  return {
    id, createdOn: '2026-10-01T00:00:00.000Z', updatedOn: '2026-10-01T01:00:00.000Z', winningTeam: winner,
    games: { [winner]: Array.from({ length: marks }, (_, i) => hand(i, bidder, winner, Bid.Thirty)) },
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: hand(99, players[0], Teams.TeamA, Bid.Thirty),
  };
}

beforeEach(async () => {
  await testEnv.DB.batch([testEnv.DB.prepare('DELETE FROM player_match_stats'), testEnv.DB.prepare('DELETE FROM users')]);
  await saveUsers(testEnv.DB, [
    { user_id: 'sam', displayName: 'Sam' },
    { user_id: 'kim', displayName: 'Kim' },
  ]);
});

describe('recordMatchStats', () => {
  it('writes one row per human, and writing again changes nothing', async () => {
    const match = won('m1', ['me', 'bot-1', 'sam', 'bot-2'], Teams.TeamA);
    await recordMatchStats(testEnv.DB, match);
    await recordMatchStats(testEnv.DB, match);

    const { results } = await testEnv.DB.prepare('SELECT player_id, with_bots, won FROM player_match_stats ORDER BY player_id').all();
    expect(results).toEqual([
      { player_id: 'me', with_bots: 1, won: 1 },
      { player_id: 'sam', with_bots: 1, won: 1 },
    ]);
  });

  it('writes nothing for a match not yet won', async () => {
    await recordMatchStats(testEnv.DB, { ...won('m2', ['a', 'b', 'c', 'd'], Teams.TeamA), winningTeam: null });
    const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM player_match_stats').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('readPlayerStats', () => {
  it('is all zeros with no best partner for a player with no games', async () => {
    const stats = await readPlayerStats(testEnv, 'nobody');
    for (const summary of [stats.all, stats.humansOnly, stats.withBots]) {
      expect(summary).toEqual({
        played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
        averagePointsBid: null, marksBids: 0, bestPartner: null,
      });
    }
  });

  it('adds up each filter, and All is both together', async () => {
    // Humans only: won twice with sam, lost once with kim. With bots: won once with bot-2.
    await recordMatchStats(testEnv.DB, won('h1', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('h2', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('h3', ['me', 'x', 'kim', 'y'], Teams.TeamB));
    await recordMatchStats(testEnv.DB, won('b1', ['me', 'bot-1', 'bot-2', 'bot-3'], Teams.TeamA));

    const stats = await readPlayerStats(testEnv, 'me');

    expect(stats.humansOnly).toMatchObject({ played: 3, won: 2, lost: 1, marksWon: 14, bidsWon: 14, bidsMade: 14, bidsSet: 0, averagePointsBid: 30 });
    expect(stats.withBots).toMatchObject({ played: 1, won: 1, lost: 0, marksWon: 7 });
    expect(stats.all).toMatchObject({ played: 4, won: 3, lost: 1, marksWon: 21, bidsWon: 21 });
  });

  it('names the best human partner over at least 3 games, never a bot', async () => {
    // sam: 2-1 over 3 games. kim: 2-0 over 2 games (too few). bot-2: 4-0 (a bot).
    await recordMatchStats(testEnv.DB, won('s1', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('s2', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('s3', ['me', 'x', 'sam', 'y'], Teams.TeamB));
    await recordMatchStats(testEnv.DB, won('k1', ['me', 'x', 'kim', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('k2', ['me', 'x', 'kim', 'y'], Teams.TeamA));
    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      await recordMatchStats(testEnv.DB, won(id, ['me', 'bot-1', 'bot-2', 'bot-3'], Teams.TeamA));
    }

    const stats = await readPlayerStats(testEnv, 'me');

    expect(stats.all.bestPartner).toEqual({ user: { user_id: 'sam', displayName: 'Sam' }, won: 2, lost: 1 });
    expect(stats.humansOnly.bestPartner?.user.user_id).toBe('sam');
    expect(stats.withBots.bestPartner).toBeNull();
  });

  it('breaks a tie in win rate by more games together', async () => {
    for (const id of ['s1', 's2', 's3']) await recordMatchStats(testEnv.DB, won(id, ['me', 'x', 'sam', 'y'], Teams.TeamA));
    for (const id of ['k1', 'k2', 'k3', 'k4']) await recordMatchStats(testEnv.DB, won(id, ['me', 'x', 'kim', 'y'], Teams.TeamA));
    expect((await readPlayerStats(testEnv, 'me')).all.bestPartner?.user.displayName).toBe('Kim');
  });

  it('still answers, with a neutral name, when the best partner has no name to show', async () => {
    for (const id of ['g1', 'g2', 'g3']) await recordMatchStats(testEnv.DB, won(id, ['me', 'x', 'ghost', 'y'], Teams.TeamA));
    const partner = (await readPlayerStats(testEnv, 'me')).all.bestPartner;
    expect(partner).toEqual({ user: { user_id: 'ghost', displayName: 'Unknown player' }, won: 3, lost: 0 });
  });
});
