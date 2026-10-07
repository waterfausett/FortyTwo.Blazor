// Plays random hands through the real rules engine and writes one JSON line per hand (gzipped),
// for the Python port's parity test (ml/tests/test_parity.py). Legal actions are found black-box:
// every candidate is offered to the same guard the Worker uses, and whatever doesn't throw is
// legal. A hand stops the moment it's decided, matching the Python engine.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  Bid,
  Suit,
  Teams,
  assertValidBid,
  assertValidDomino,
  assertValidTrump,
  createMatch,
  gameValue,
  gameWinningTeam,
  placeBid,
  playDomino,
  setTrump,
  shuffledDominoOrder,
  takeSeat,
  trickValue,
  type MatchState,
} from '../src/index';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '1' },
    out: { type: 'string' },
  },
});
if (!values.out) throw new Error('--out is required');

// mulberry32: a small seeded PRNG, so a trace file can be regenerated exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Step = { seat: number; phase: 'bid' | 'trump' | 'play'; legal: (number | string)[]; action: number | string };

const PLAYERS = ['p0', 'p1', 'p2', 'p3'];
const ALL_BIDS = Object.values(Bid).filter((v): v is Bid => typeof v === 'number');
const ALL_SUITS = Object.values(Suit).filter((v): v is Suit => typeof v === 'number');

function legal<T>(candidates: T[], check: (candidate: T) => void): T[] {
  return candidates.filter((candidate) => {
    try {
      check(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function pick<T>(xs: T[], random: () => number): T {
  return xs[Math.floor(random() * xs.length)];
}

function playHand(id: number, random: () => number) {
  const deal = shuffledDominoOrder(random);
  let match: MatchState = createMatch(PLAYERS[0]);
  for (let seat = 1; seat < 4; seat++) {
    match = takeSeat(match, PLAYERS[seat], seat, seat === 3 ? deal : undefined);
  }
  const opener = Math.floor(random() * 4);
  match = {
    ...match,
    currentGame: { ...match.currentGame, firstActionBy: PLAYERS[opener], currentPlayerId: PLAYERS[opener] },
  };

  const steps: Step[] = [];
  while (gameWinningTeam(match.currentGame) === null) {
    const game = match.currentGame;
    const playerId = game.currentPlayerId!;
    const seat = PLAYERS.indexOf(playerId);

    if (game.hands.some((h) => h.bid === null)) {
      const bids = legal(ALL_BIDS, (b) => assertValidBid(game, playerId, b));
      // Plunge is rare (it needs four doubles), so take it half the time it's offered.
      const action = bids.includes(Bid.Plunge) && random() < 0.5 ? Bid.Plunge : pick(bids, random);
      steps.push({ seat, phase: 'bid', legal: bids, action });
      match = placeBid(match, playerId, action);
    } else if (game.trump === null) {
      const trumps = legal(ALL_SUITS, (s) => assertValidTrump(game, s));
      const action = pick(trumps, random);
      steps.push({ seat, phase: 'trump', legal: trumps, action });
      match = setTrump(match, playerId, action);
    } else {
      const hand = game.hands.find((h) => h.playerId === playerId)!.dominoes;
      const plays = legal(hand, (d) => assertValidDomino(game, playerId, d));
      const action = pick(plays, random);
      steps.push({ seat, phase: 'play', legal: plays.map((d) => d.id), action: action.id });
      match = playDomino(match, playerId, action);
    }
  }

  const game = match.currentGame;
  const points = [0, 0];
  for (const trick of game.tricks) {
    if (trick.team !== null) points[trick.team - Teams.TeamA] += trickValue(trick);
  }
  return {
    id,
    deal: deal.map((d) => d.id),
    opener,
    steps,
    result: { winningTeam: gameWinningTeam(game)! - Teams.TeamA, marks: gameValue(game), points },
  };
}

const random = mulberry32(Number(values.seed));
const lines: string[] = [];
for (let i = 0; i < Number(values.count); i++) lines.push(JSON.stringify(playHand(i, random)));
writeFileSync(values.out, gzipSync(lines.join('\n') + '\n'));
console.log(`wrote ${lines.length} hands to ${values.out}`);
