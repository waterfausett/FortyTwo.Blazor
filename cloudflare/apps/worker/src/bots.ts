// Dumb, deterministic "auto-play" players used when AUTO_PLAY_BOTS is set (index.ts's Env), seated
// on demand in whichever seats real players leave open, so a match can be exercised locally without
// four real accounts. Bots aren't smart: they pass unless forced to bid, set trump to their
// most-held suit, and play the first legal domino they hold - just enough to keep a match moving
// for UI/flow testing.
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
} from '@fortytwo/rules';

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
