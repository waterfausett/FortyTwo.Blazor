// Canned matches for the dev bypass (devBypass.ts), so the match screen can be worked on in the
// emulator: open `match/dev-<name>` for a match at that point, with you at the bottom seat.
//
//   dev-bidding   your turn to bid
//   dev-trump     you won the bid; name trump
//   dev-playing   trump named; your lead
//   dev-hand-over the hand is decided; ready up
//
// Your moves go through the real rules and come back over a stand-in socket, but nobody else
// moves: the table waits on the next player after yours. Opening the match again starts it over.
import {
  Bid,
  Suit,
  createDomino,
  createMatch,
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
import type { PublicUser } from '@fortytwo/api-types';
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

// Dealt from an unshuffled deck, so each is the same every time. You open the bidding.
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
};

// The rules engine names games with crypto.randomUUID, which React Native doesn't have.
function ensureRandomUUID() {
  const global = globalThis as { crypto?: { randomUUID?: () => string } };
  global.crypto ??= {};
  global.crypto.randomUUID ??= () => `dev-${Math.random().toString(36).slice(2)}`;
}

const matches = new Map<string, MatchState>();
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
    later(300, () => ids.map((user_id): PublicUser => ({ user_id, displayName: NAMES[user_id] ?? user_id }))),
  getConfig: () => later(300, () => ({ bots: true })),
  bid: (id, bid) => move(id, (match) => placeBid(match, DEV_PLAYER_ID, bid)),
  setTrump: (id, suit) => move(id, (match) => setTrump(match, DEV_PLAYER_ID, suit)),
  playDomino: (id, { top, bottom }) => move(id, (match) => playDomino(match, DEV_PLAYER_ID, createDomino(top, bottom))),
  readyUp: (id, ready) => move(id, (match) => patchPlayerReady(match, DEV_PLAYER_ID, ready, deck())),
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
  return () => forMatch.delete(onMatch);
}
