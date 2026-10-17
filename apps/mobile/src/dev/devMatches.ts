// Canned matches for the dev bypass (devBypass.ts), so the match screen can be worked on in the
// emulator: open `match/dev-<name>` for a match at that point, with you at the bottom seat.
//
//   dev-bidding   your turn to bid
//   dev-trump     you won the bid; name trump
//   dev-playing   trump named; your lead
//   dev-hand-over the hand is decided; ready up
//   dev-practice-bidding / -trump / -playing   the same, in a practice match (vs bots), with hints
//
// Or still waiting for players, as each kind of match shows it:
//
//   dev-live-search    Live Play's lobby, Grandma Jo seated with you, the bar filling
//   dev-live-filling   the same, then Uncle Ray and Beth join (4 s, 8 s): Table full, then the deal
//   dev-async-waiting  Async, two seated
//   dev-custom-waiting Custom Match, two seated
//
// Your moves go through the real rules and come back over a stand-in socket, but nobody else
// moves: the table waits on the next player after yours. Opening the match again starts it over.
import {
  Bid,
  Suit,
  availableBids,
  availableTrumps,
  botDisplayName,
  createDomino,
  createMatch,
  isBot,
  matchViewFor,
  patchPlayerReady,
  placeBid,
  playDomino,
  setTrump,
  takeSeat,
  type Domino,
  type MatchState,
} from '@fortytwo/rules';
import type { MatchSocketOptions } from '@fortytwo/client';
import type { Hint, HintResponse, PublicUser } from '@fortytwo/api-types';
import type { Api } from '@/api/useApi';

// The bypass's own player, as its profile has it.
export const DEV_PLAYER_ID = 'dev|bypass';

const NAMES: Record<string, string> = {
  [DEV_PLAYER_ID]: 'You',
  'dev|jo': 'Grandma Jo',
  'dev|ray': 'Uncle Ray',
  'dev|beth': 'Beth',
};

// How long a move's reply and its broadcast take to arrive. The broadcast usually wins on a real
// table; swap them to see the screen when the reply wins.
export const devTiming = { replyMs: 300, broadcastMs: 150 };

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// Plays the first domino the rules allow, for whoever's turn it is.
function playAny(match: MatchState): MatchState {
  const turn = match.currentGame.currentPlayerId!;
  const hand = match.currentGame.hands.find((h) => h.playerId === turn)!.dominoes;
  for (const domino of hand) {
    try {
      return playDomino(match, turn, domino);
    } catch {
      // Not playable; try the next.
    }
  }
  throw new Error(`${turn} has nothing to play`);
}

// Dealt from an unshuffled deck, so each is the same every time. You open the bidding. The waiting
// ones aren't dealt yet: nobody else joins, so they wait for good.
const SCENARIOS: Record<string, () => MatchState> = {
  'dev-bidding': () => {
    let match = createMatch(DEV_PLAYER_ID);
    match = takeSeat(match, 'dev|jo', 1);
    match = takeSeat(match, 'dev|ray', 2);
    return takeSeat(match, 'dev|beth', 3, deck());
  },
  'dev-trump': () => {
    let match = SCENARIOS['dev-bidding']();
    match = placeBid(match, DEV_PLAYER_ID, Bid.Thirty);
    for (const player of ['dev|jo', 'dev|ray', 'dev|beth']) match = placeBid(match, player, Bid.Pass);
    return match;
  },
  'dev-playing': () => setTrump(SCENARIOS['dev-trump'](), DEV_PLAYER_ID, Suit.Sixes),
  'dev-hand-over': () => {
    let match = SCENARIOS['dev-playing']();
    while (match.currentGame.currentPlayerId != null && match.currentGame.tricks.length < 7) match = playAny(match);
    return match;
  },
  'dev-practice-bidding': () => ({ ...SCENARIOS['dev-bidding'](), mode: 'bots' }),
  'dev-practice-trump': () => ({ ...SCENARIOS['dev-trump'](), mode: 'bots' }),
  'dev-practice-playing': () => ({ ...SCENARIOS['dev-playing'](), mode: 'bots' }),
  'dev-live-search': () => takeSeat(createMatch(DEV_PLAYER_ID, 'live'), 'dev|jo', 1),
  'dev-live-filling': () => takeSeat(createMatch(DEV_PLAYER_ID, 'live'), 'dev|jo', 1),
  'dev-async-waiting': () => takeSeat(createMatch(DEV_PLAYER_ID, 'daily'), 'dev|jo', 1),
  'dev-custom-waiting': () => takeSeat(createMatch(DEV_PLAYER_ID, 'custom'), 'dev|jo', 1),
};

// The rules engine names games with crypto.randomUUID, which React Native doesn't have.
function ensureRandomUUID() {
  const global = globalThis as { crypto?: { randomUUID?: () => string } };
  global.crypto ??= {};
  global.crypto.randomUUID ??= () => `dev-${Math.random().toString(36).slice(2)}`;
}

const matches = new Map<string, MatchState>();
// Practice matches that have already answered one 'warming' (see getHint).
const warmedOnce = new Set<string>();
const listeners = new Map<string, Set<(match: MatchState) => void>>();

function current(id: string): MatchState {
  const scenario = SCENARIOS[id];
  if (!scenario) throw new Error(`Not in the dev bypass: match ${id}`);
  if (!matches.has(id)) {
    ensureRandomUUID();
    matches.set(id, scenario());
  }
  return matches.get(id)!;
}

const seen = (match: MatchState) => matchViewFor(match, DEV_PLAYER_ID);
const later = <T,>(ms: number, value: () => T) =>
  new Promise<T>((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(value());
      } catch (error) {
        reject(error);
      }
    }, ms)
  );

// A move: applied now, broadcast after `broadcastMs`, answered after `replyMs`. One the rules turn
// away rejects at once, as the Worker would.
function move(id: string, action: (match: MatchState) => MatchState): Promise<MatchState> {
  try {
    matches.set(id, action(current(id)));
  } catch (error) {
    return Promise.reject(error);
  }
  const next = seen(matches.get(id)!);
  setTimeout(() => listeners.get(id)?.forEach((listener) => listener(next)), devTiming.broadcastMs);
  return later(devTiming.replyMs, () => next);
}

export const devMatchApi: Partial<Api> = {
  getMatch: (id) => later(300, () => seen(current(id))),
  searchUsers: (ids) =>
    later(300, () =>
      ids.map((user_id): PublicUser => ({ user_id, displayName: isBot(user_id) ? botDisplayName(user_id) : (NAMES[user_id] ?? user_id) }))
    ),
  getConfig: () => later(300, () => ({ bots: true, presence: false, hintDetails: false })),
  bid: (id, bid) => move(id, (match) => placeBid(match, DEV_PLAYER_ID, bid)),
  setTrump: (id, suit) => move(id, (match) => setTrump(match, DEV_PLAYER_ID, suit)),
  playDomino: (id, { top, bottom }) => move(id, (match) => playDomino(match, DEV_PLAYER_ID, createDomino(top, bottom))),
  // Nobody goes on autopilot in the bypass, so there's nothing to take back.
  resume: (id) => later(devTiming.replyMs, () => seen(current(id))),
  readyUp: (id, ready) => move(id, (match) => patchPlayerReady(match, DEV_PLAYER_ID, ready, deck())),
  // A made-up hint for the current turn - the first legal moves with fixed numbers - after one
  // 'warming' reply, so the screen shows Thinking… first. Only the screen is real here.
  getHint: (id) => {
    const match = current(id);
    const game = match.currentGame;
    if (!warmedOnce.has(id)) {
      warmedOnce.add(id);
      return later<HintResponse>(300, () => ({ status: 'warming' }));
    }
    let hint: Hint;
    if (game.hands.some((h) => h.bid === null)) {
      const bids = availableBids(game, DEV_PLAYER_ID).filter((b) => b !== Bid.Pass).slice(0, 3);
      const options = bids.map((bid, i) => ({ bid, trump: Suit.Sixes, pMake: 0.8 - i * 0.12 }));
      hint = { kind: 'bid', suggestion: options[1] ?? options[0], options };
    } else if (game.trump === null) {
      const options = availableTrumps(game).slice(0, 3).map((trump, i) => ({ trump, pMake: 0.75 - i * 0.1 }));
      hint = { kind: 'trump', suggestion: options[0], options };
    } else {
      const hand = game.hands.find((h) => h.playerId === DEV_PLAYER_ID)!.dominoes;
      hint = {
        kind: 'play',
        dominoes: hand.map((domino, i) => {
          const gap = i === 0 ? 0 : i * 0.06;
          return { domino, marks: 0.6 - gap, gap, rating: gap === 0 ? 'best' : gap < 0.1 ? 'close' : 'weaker' };
        }),
      };
    }
    return later<HintResponse>(300, () => ({ status: 'ready', hint }));
  },
};

// Stands in for connectMatchSocket: connects at once, starting the match over, and passes on each
// move's broadcast. Any other match never connects.
export function connectDevMatchSocket({ matchId, onOpen, onMatch }: MatchSocketOptions): () => void {
  if (!SCENARIOS[matchId]) return () => {};
  matches.delete(matchId);
  const forMatch = listeners.get(matchId) ?? new Set();
  listeners.set(matchId, forMatch);
  forMatch.add(onMatch);
  onOpen?.();
  onMatch(seen(current(matchId)));
  // The filling table's other players sit down, through the same broadcast as a move.
  const arrivals =
    matchId === 'dev-live-filling'
      ? [
          setTimeout(() => void move(matchId, (match) => takeSeat(match, 'dev|ray', 2)), 4000),
          setTimeout(() => void move(matchId, (match) => takeSeat(match, 'dev|beth', 3, deck())), 8000),
        ]
      : [];
  return () => {
    arrivals.forEach(clearTimeout);
    forMatch.delete(onMatch);
  };
}
