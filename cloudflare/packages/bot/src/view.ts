// What features.py reads from the Python HandState, rebuilt from a TS MatchState. A TS Trick
// lists its dominoes in play order, not by seat, so seats come from turn order: the trump namer
// (the plunger's partner on a Plunge, else the bidder) leads the first trick, each trick's winner
// leads the next, and under Low the bidder's partner sits out and is skipped.
import { Bid, isLow, isOfSuit, trickValue, type Domino, type MatchState, type Suit } from '@fortytwo/rules';
import { toIndex } from './dominoes';

export interface BotView {
  seat: number;
  hand: number[];
  played: number[];
  trick: [number, number][];
  led: number | null;
  trump: number;
  highBid: number;
  bidder: number;
  voids: number[];
  points: [number, number];
  tricks: number;
  sitsOut: number | null;
}

export function seatOf(match: MatchState, playerId: string): number {
  return match.players.find((p) => p.playerId === playerId)!.position;
}

export function buildView(match: MatchState, playerId: string): BotView {
  const game = match.currentGame;
  const seat = seatOf(match, playerId);
  const bidder = seatOf(match, game.biddingPlayerId!);
  const trump = game.trump! as number;
  const sitsOut = isLow(game.trump) ? (bidder + 2) % 4 : null;
  const next = (s: number) => {
    const n = (s + 1) % 4;
    return n === sitsOut ? (n + 1) % 4 : n;
  };
  const played = [0, 0, 0, 0];
  const voids = [0, 0, 0, 0];
  const points: [number, number] = [0, 0];

  let leader = game.bid === Bid.Plunge ? (bidder + 2) % 4 : bidder;
  const replay = (dominoes: (Domino | null)[], suit: Suit | null): [number, number][] => {
    const plays: [number, number][] = [];
    let s = leader;
    for (const d of dominoes) {
      if (d === null) break;
      if (plays.length > 0 && !isOfSuit(d, suit!, game.trump)) voids[s] |= 1 << suit!;
      const i = toIndex(d);
      played[s] |= 1 << i;
      plays.push([s, i]);
      s = next(s);
    }
    return plays;
  };
  for (const t of game.tricks) {
    replay(t.dominoes, t.suit);
    const winner = seatOf(match, t.playerId!);
    points[winner % 2] += trickValue(t);
    leader = winner;
  }
  const trick = replay(game.currentTrick.dominoes, game.currentTrick.suit);

  return {
    seat,
    hand: game.hands.find((h) => h.playerId === playerId)!.dominoes.map(toIndex),
    played,
    trick,
    led: game.currentTrick.suit,
    trump,
    highBid: game.bid!,
    bidder,
    voids,
    points,
    tricks: game.tricks.length,
    sitsOut,
  };
}
