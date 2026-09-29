// The guards behind every match action. Each one throws `ValidationError`, whose title and detail
// the client shows as-is (detail may hold <code> markup).
import { Bid, bidToPrettyString } from './bid';
import { Domino, dominoEquals, isDouble, isOfSuit } from './domino';
import { ValidationError } from './errors';
import { Game, gameWinningTeam } from './game';
import { LOW_TRUMPS, Suit, isLow, suitToPrettyString } from './suit';
import { Teams, teamForPosition } from './teams';

// The part of a match the guards look at. matchEngine.ts imports this file, so this file names
// the shape it needs rather than importing `MatchState` back.
export interface MatchLike {
  winningTeam: Teams | null;
  players: { playerId: string }[];
}

function isGame(x: MatchLike | Game): x is Game {
  return 'hands' in x;
}

// Whether a match, or a single hand (Game), is still being played. A hand has no stored winner,
// so its result is worked out from its tricks.
export function assertActive(match: MatchLike): void;
export function assertActive(game: Game): void;
export function assertActive(x: MatchLike | Game): void {
  if (isGame(x)) {
    if (gameWinningTeam(x) !== null) throw new ValidationError('This game is over');
  } else {
    if (x.winningTeam !== null) throw new ValidationError('This match is over');
  }
}

export function assertNotFull(match: MatchLike): void {
  if (match.players.length >= 4) {
    throw new ValidationError('Match is full', 'This match already has enough players');
  }
}

// `addPlayer` (matchEngine.ts) seats a third player on a team in the same seat as the second -
// both go across from the first - so a full team has to be turned away here.
export function assertTeamNotFull(players: { position: number }[], team: Teams): void {
  const teamCount = players.filter((p) => teamForPosition(p.position) === team).length;
  if (teamCount >= 2) {
    throw new ValidationError('Team is full', 'This team already has 2 players');
  }
}

// `takeSeat` (matchEngine.ts) needs a real, unoccupied position or it would stack two players in
// one seat.
export function assertSeatOpen(players: { position: number }[], position: number): void {
  if (!Number.isInteger(position) || position < 0 || position > 3) {
    throw new ValidationError('Invalid seat', 'Pick one of the four seats at the table');
  }
  if (players.some((p) => p.position === position)) {
    throw new ValidationError('Seat is taken', 'Someone is already sitting there');
  }
}

export function assertActiveTurn(game: Game, userId: string): void {
  if (game.currentPlayerId !== userId) throw new ValidationError("It's not your turn!");
}

// Only the winning bidder names trump - except on a Plunge, where their partner does.
export function assertActiveBidder(game: Game, userId: string): void {
  const biddingTeamId = game.hands.find((h) => h.playerId === game.biddingPlayerId)?.team ?? null;

  if (
    (game.bid !== Bid.Plunge && game.biddingPlayerId !== userId) ||
    (game.bid === Bid.Plunge &&
      (game.biddingPlayerId === userId || game.hands.find((h) => h.playerId === userId)!.team !== biddingTeamId))
  ) {
    throw new ValidationError("It's not your turn!");
  }
}

// Checked in order so a player gets the most specific reason a bid was turned down.
export function assertValidBid(game: Game, userId: string, bid: Bid): void {
  if (game.hands.find((h) => h.playerId === userId)!.bid !== null) {
    throw new ValidationError('Invalid Action', 'You have already submitted a bid!');
  }

  if (bid !== Bid.Pass && game.bid !== null && game.bid >= bid) {
    throw new ValidationError(
      'Insufficient bid!',
      `A new bid must be higher than the current bid of <code>${bidToPrettyString(game.bid)}</code>`
    );
  }

  if (game.hands.filter((h) => h.bid === Bid.Pass).length === 3 && bid === Bid.Pass) {
    throw new ValidationError('Invalid Bid', "Everyone can't pass! You have to bid \u{1F605}");
  }

  // Everything else (the marks ladder, the Plunge's doubles) is whatever `availableBids` allows,
  // so a hand-made request can't get around what the UI offers.
  if (!availableBids(game, userId).includes(bid)) {
    throw new ValidationError('Invalid Bid', `<code>${bidToPrettyString(bid)}</code> isn't an available bid right now`);
  }
}

const RANKED_BIDS = (Object.values(Bid).filter((value): value is number => typeof value === 'number') as Bid[])
  .filter((value) => value !== Bid.Pass && value !== Bid.Plunge)
  .sort((a, b) => a - b);

// Every bid `userId` may legally make right now, in ascending order. The UI renders exactly this
// list and `assertValidBid` enforces it.
// - Pass, unless the other three already passed (the last bidder is forced to bid).
// - Only bids strictly above the current high bid.
// - Marks climb one rung at a time: 3 Marks needs a standing 84, 4 Marks a standing 3 Marks, etc.
//   (no marks bid at all over a points bid or an empty table).
// - Plunge needs at least four doubles in hand, and only while the high bid is under 4 Marks.
export function availableBids(game: Game, userId: string): Bid[] {
  const current = game.bid;
  const hand = game.hands.find((h) => h.playerId === userId);
  const bids: Bid[] = [];

  if (game.hands.filter((h) => h.bid === Bid.Pass).length < 3) bids.push(Bid.Pass);

  for (const bid of RANKED_BIDS) {
    if (current !== null && bid <= current) continue;
    if (bid > Bid.EightyFour && (current === null || bid > current + Bid.FortyTwo)) continue;
    bids.push(bid);
  }

  const doubles = hand?.dominoes.filter(isDouble).length ?? 0;
  if (doubles >= 4 && (current ?? Bid.Pass) < Bid.FourMarks) bids.push(Bid.Plunge);

  return bids.sort((a, b) => a - b);
}

const NAMED_SUITS = [Suit.Blanks, Suit.Aces, Suit.Deuces, Suit.Threes, Suit.Fours, Suit.Fives, Suit.Sixes];

// The trumps the bidder may call, in picker order:
// every named suit, plus Follow Me (Suit.None) and the three Low variants (one per doubles rule)
// once the winning bid is at least one mark (42). A Plunge has to take every trick, so it gets
// Follow Me but never Low.
export function availableTrumps(game: Game): Suit[] {
  if (game.bid === Bid.Plunge) return [...NAMED_SUITS, Suit.None];
  return game.bid !== null && game.bid >= Bid.FortyTwo
    ? [...NAMED_SUITS, Suit.None, ...LOW_TRUMPS]
    : [...NAMED_SUITS];
}

// Enforces `availableTrumps`, with a reason that says why a trump isn't allowed.
export function assertValidTrump(game: Game, suit: Suit): void {
  if (!availableTrumps(game).includes(suit)) {
    throw new ValidationError(
      'Invalid Trump',
      game.bid === Bid.Plunge && isLow(suit)
        ? "A Plunge has to take every trick, so it can't go Low"
        : suit === Suit.None || isLow(suit)
          ? `<code>${suitToPrettyString(suit)}</code> needs a bid of at least 42`
          : "That isn't a trump you can call"
    );
  }
}

export function assertBiddingComplete(game: Game): void {
  if (game.hands.some((h) => h.bid === null)) {
    throw new ValidationError('Invalid Action', "We're still bidding!");
  }
}

// Play starts once everyone has bid and trump is named.
export function assertReadyToPlay(game: Game): void {
  assertBiddingComplete(game);

  if (game.trump === null) {
    throw new ValidationError('Invalid Action', "We're still bidding!");
  }
}

// Matched by value (`dominoEquals`, either way round), since the caller's domino comes from a
// request body, not from the hand.
export function assertHasDomino(game: Game, userId: string, domino: Domino): void {
  const hand = game.hands.find((h) => h.playerId === userId)!;
  if (!hand.dominoes.some((d) => dominoEquals(d, domino))) {
    throw new ValidationError('Invalid Domino');
  }
}

// Follow suit: a player holding the led suit must play it.
export function assertValidDomino(game: Game, userId: string, domino: Domino): void {
  const trickSuit = game.currentTrick.suit;

  if (
    trickSuit !== null &&
    !isOfSuit(domino, trickSuit, game.trump) &&
    game.hands.find((h) => h.playerId === userId)!.dominoes.some((d) => isOfSuit(d, trickSuit, game.trump))
  ) {
    throw new ValidationError(
      'You must follow suit!',
      `If you have a <code>${singularizeSuit(trickSuit)}</code>, you must play it`
    );
  }
}

// The singular suit name for the follow-suit message above. Only a led suit reaches it (Blanks to
// Sixes, or Doubles when doubles are their own suit, never Low or Follow Me), so a lookup covers
// every case - trimming a trailing "s" would turn "Sixes" into "Sixe".
const SUIT_SINGULAR: Partial<Record<Suit, string>> = {
  [Suit.Blanks]: 'Blank',
  [Suit.Aces]: 'Ace',
  [Suit.Deuces]: 'Deuce',
  [Suit.Threes]: 'Three',
  [Suit.Fours]: 'Four',
  [Suit.Fives]: 'Five',
  [Suit.Sixes]: 'Six',
  [Suit.Doubles]: 'Double',
};

function singularizeSuit(suit: Suit): string {
  return SUIT_SINGULAR[suit] ?? Suit[suit];
}

export function assertIsMatchPlayer(match: MatchLike, userId: string): void {
  if (match.players.every((p) => p.playerId !== userId)) {
    throw new ValidationError("You aren't a part of this match!");
  }
}

export function assertIsNotMatchPlayer(match: MatchLike, userId: string): void {
  if (match.players.some((p) => p.playerId === userId)) {
    throw new ValidationError('You are already in this match!');
  }
}
