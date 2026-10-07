// Bots seated on demand in whichever seats real players leave open (unless BOTS_ENABLED is 'false',
// see index.ts's Env). They are the ML bot (@fortytwo/bot, loaded by mlBot.ts) when it is
// available; the simple rules below are its fallback for any model problem. The simple bots aren't
// smart: they pass unless forced to bid, set trump to their most-held suit, and play the first
// legal domino they hold - just enough to keep a match moving.
import {
  Bid,
  Domino,
  Game,
  Hand,
  isOfSuit,
  MatchState,
  Suit,
  gameWinningTeam,
  BOT_IDS,
  isBot,
  patchPlayerReady,
  placeBid,
  playDomino,
  setTrump,
  shuffledDominoOrder,
} from '@fortytwo/rules';
import type { Bot } from '@fortytwo/bot';

// Defined in the rules package so the web client can tell bots apart too; re-exported here for
// the Worker code that already imports them from this file.
export { BOT_IDS, isBot };

// The forced-bid rule (validation.ts's assertValidBid) only ever applies to whichever hand acts
// last in a bidding round where the other three all passed - so "forced" needs no positional
// bookkeeping here, just a count of passes among the OTHER hands already recorded.
export function decideBid(game: Game, hand: Hand): Bid {
  const forced = game.hands.filter((h) => h.playerId !== hand.playerId && h.bid === Bid.Pass).length === 3;
  return forced ? Bid.Thirty : Bid.Pass;
}

const REAL_SUITS = [Suit.Blanks, Suit.Aces, Suit.Deuces, Suit.Threes, Suit.Fours, Suit.Fives, Suit.Sixes];

export function decideTrump(hand: Hand): Suit {
  let best = REAL_SUITS[0];
  let bestCount = -1;
  for (const suit of REAL_SUITS) {
    const count = hand.dominoes.filter((d) => d.top === suit || d.bottom === suit).length;
    if (count > bestCount) {
      best = suit;
      bestCount = count;
    }
  }
  return best;
}

export function decideDomino(game: Game, hand: Hand): Domino {
  const trickSuit = game.currentTrick.suit;
  if (trickSuit === null) return hand.dominoes[0];

  const legal = hand.dominoes.filter((d) => isOfSuit(d, trickSuit, game.trump!));
  return legal[0] ?? hand.dominoes[0];
}

export type BotAction =
  | { kind: 'ready'; playerId: string }
  | { kind: 'bid'; playerId: string }
  | { kind: 'setTrump'; playerId: string }
  | { kind: 'play'; playerId: string };

// Inspects match state to find the single next bot action to take, or null if it's a human's
// turn, we're waiting on a human to ready up, or the match is over. Callers act on exactly one
// returned action, then call this again - see matchDO.ts's alarm-per-action pacing.
//
// Once a hand is decided, bots ready up straight away, then keep playing their turns so a human
// who wants to play the hand out can - until the last domino is down or everyone's ready.
export function findNextBotAction(match: MatchState): BotAction | null {
  if (match.winningTeam !== null) return null;

  if (gameWinningTeam(match.currentGame) !== null) {
    const waitingBot = match.players.find((p) => isBot(p.playerId) && !p.ready);
    if (waitingBot) return { kind: 'ready', playerId: waitingBot.playerId };

    const currentPlayerId = match.currentGame.currentPlayerId;
    const hand = match.currentGame.hands.find((h) => h.playerId === currentPlayerId);
    return currentPlayerId !== null && isBot(currentPlayerId) && (hand?.dominoes.length ?? 0) > 0
      ? { kind: 'play', playerId: currentPlayerId }
      : null;
  }

  const currentPlayerId = match.currentGame.currentPlayerId;
  if (currentPlayerId === null || !isBot(currentPlayerId)) return null;

  if (match.currentGame.hands.some((h) => h.bid === null)) {
    return { kind: 'bid', playerId: currentPlayerId };
  }
  if (match.currentGame.trump === null) {
    return { kind: 'setTrump', playerId: currentPlayerId };
  }
  return { kind: 'play', playerId: currentPlayerId };
}

// How long a bot "thinks" before each kind of action (matchDO.ts schedules it with the alarm API,
// so the wait costs no CPU). Plays are slower than bids, so a table of bots doesn't rattle through
// a hand, and a bot leading the next trick waits longer still, so everyone can see the finished
// trick before the next one starts.
export const BOT_DELAY_MS = { ready: 600, bid: 900, setTrump: 1000, play: 1100, leadAfterTrick: 2000 } as const;

export function botDelayMs(match: MatchState, action: BotAction): number {
  if (action.kind !== 'play') return BOT_DELAY_MS[action.kind];
  const game = match.currentGame;
  const leading = game.currentTrick.dominoes.every((d) => d === null);
  return leading && game.tricks.length > 0 ? BOT_DELAY_MS.leadAfterTrick : BOT_DELAY_MS.play;
}

export function botsEnabled(env: { BOTS_ENABLED?: string }): boolean {
  return env.BOTS_ENABLED !== 'false';
}

function simple(match: MatchState, action: BotAction): MatchState {
  const hand = match.currentGame.hands.find((h) => h.playerId === action.playerId)!;
  switch (action.kind) {
    case 'ready':
      return patchPlayerReady(match, action.playerId, true, shuffledDominoOrder());
    case 'bid':
      return placeBid(match, action.playerId, decideBid(match.currentGame, hand));
    case 'setTrump':
      return setTrump(match, action.playerId, decideTrump(hand));
    case 'play':
      return playDomino(match, action.playerId, decideDomino(match.currentGame, hand));
  }
}

function ml(match: MatchState, action: BotAction, bot: Bot): MatchState {
  switch (action.kind) {
    case 'ready':
      return simple(match, action);
    case 'bid':
      return placeBid(match, action.playerId, bot.decideBid(match, action.playerId));
    case 'setTrump':
      return setTrump(match, action.playerId, bot.decideTrump(match, action.playerId));
    case 'play':
      return playDomino(match, action.playerId, bot.decideDomino(match, action.playerId));
  }
}

// Performs exactly one bot action. The ML bot decides when it's loaded; if it throws or its move
// is illegal (the rules functions throw), that action falls back to the simple rules, so a model
// problem never stalls a match.
export function applyBotAction(match: MatchState, action: BotAction, bot: Bot | null): MatchState {
  // Readying up is the simple bot's job either way, so a failure there isn't an ML failure.
  if (bot !== null && action.kind !== 'ready') {
    try {
      return ml(match, action, bot);
    } catch (e) {
      console.error(`ML bot ${action.kind} for ${action.playerId} failed, using the simple bot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return simple(match, action);
}
