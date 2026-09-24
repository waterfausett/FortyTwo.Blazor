// Port of `FortyTwo/Server/Services/MatchValidationService.cs`.
//
// Every guard throws `ValidationError` (never returns an error value), mirroring the C#
// `CustomValidationException`. Title/detail text is preserved verbatim from the C# source,
// including its "hight" typo in `assertValidBid` — this is a faithful port, not a copy-edit.
//
// `IsNotNull(match)` / `IsNotNull(game)` have no TS equivalent: `MatchLike`/`Game` parameters
// here are non-null by type (unlike C#'s nullable-by-runtime-lookup), so those checks would be
// dead code. `assertActive` still calls through to the "is this thing over" check exactly as
// the C# `IsActive` does after its `IsNotNull` call.
import { Bid, bidToPrettyString } from './bid';
import { Domino, dominoEquals, isOfSuit } from './domino';
import { ValidationError } from './errors';
import { Game, gameWinningTeam } from './game';
import { Suit } from './suit';
import { Teams } from './teams';

// Minimal structural shape validation needs from a Match/MatchState. Defined here (rather than
// imported from matchEngine.ts) to avoid a circular import — matchEngine.ts's `MatchState`
// satisfies this structurally.
export interface MatchLike {
  winningTeam: Teams | null;
  players: { playerId: string }[];
}

function isGame(x: MatchLike | Game): x is Game {
  return 'hands' in x;
}

// Port of `IsActive(Match)` / `IsActive(Game)` — a single C# method name overloaded on type.
// Game has no stored `winningTeam` field on its TS interface (it's the computed
// `gameWinningTeam` function from game.ts), so the Game branch below calls that function
// rather than reading a nonexistent field.
export function assertActive(match: MatchLike): void;
export function assertActive(game: Game): void;
export function assertActive(x: MatchLike | Game): void {
  if (isGame(x)) {
    if (gameWinningTeam(x) !== null) throw new ValidationError('This game is over');
  } else {
    if (x.winningTeam !== null) throw new ValidationError('This match is over');
  }
}

// Port of `IsNotFull`.
export function assertNotFull(match: MatchLike): void {
  if (match.players.length >= 4) {
    throw new ValidationError('Match is full', 'This match already has enough players');
  }
}

// NEW guard, not a port of any C# method: the real C# `AddPlayerAsync` had no team-capacity check
// either (only a total-player-count check via `IsNotFull`), but the OLD Blazor client's UI was the
// only thing that ever kept a 3rd player from requesting an already-full team - it never sent an
// invalid request in practice. The new React client has no equivalent client-side guard, so without
// a server-side check here, `addPlayer`'s teammate-position lookup (matchEngine.ts) can place a 3rd
// same-team player at the SAME position as the 2nd (both compute `teammatePosition + 2` from the
// same first teammate), corrupting the players array and later crashing `selectNextPlayer` on a
// non-null assertion for a position that was never actually assigned. A justified, necessary
// deviation from a pure faithful port - see the final review's finding for the full corruption
// trace.
export function assertTeamNotFull(players: { position: number }[], team: Teams): void {
  // Mirrors matchEngine.ts's private `teamForPosition` formula exactly (duplicated rather than
  // imported, for the same anti-circular-import reason documented in this file's header comment).
  const teamCount = players.filter((p) => (p.position % 2 === 0 ? Teams.TeamA : Teams.TeamB) === team).length;
  if (teamCount >= 2) {
    throw new ValidationError('Team is full', 'This team already has 2 players');
  }
}

// Port of `IsActiveTurn`.
export function assertActiveTurn(game: Game, userId: string): void {
  if (game.currentPlayerId !== userId) throw new ValidationError("It's not your turn!");
}

// Port of `IsActiveBidder`.
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

// Port of `ValidateBid`.
export function assertValidBid(game: Game, userId: string, bid: Bid): void {
  if (game.hands.find((h) => h.playerId === userId)!.bid !== null) {
    throw new ValidationError('Invalid Action', 'You have already submitted a bid!');
  }

  if (bid !== Bid.Pass && game.bid !== null && game.bid >= bid) {
    // NOTE: "hight" (not "higher") is a typo in the real C# source — preserved verbatim.
    throw new ValidationError(
      'Insufficient bid!',
      `A new bid must be hight than the current bid of <code>${bidToPrettyString(game.bid)}</code>`
    );
  }

  if (game.hands.filter((h) => h.bid === Bid.Pass).length === 3 && bid === Bid.Pass) {
    throw new ValidationError('Invalid Bid', "Everyone can't pass! You have to bid \u{1F605}");
  }
}

// Port of `BiddingComplete`.
export function assertBiddingComplete(game: Game): void {
  if (game.hands.some((h) => h.bid === null)) {
    throw new ValidationError('Invalid Action', "We're still bidding!");
  }
}

// Port of `IsReadyToPlay`.
export function assertReadyToPlay(game: Game): void {
  assertBiddingComplete(game);

  if (game.trump === null) {
    throw new ValidationError('Invalid Action', "We're still bidding!");
  }
}

// Port of `HasDomino`. `.Contains` in C# uses Domino value equality (ignores orientation) —
// use `dominoEquals`, not reference/array-index equality.
export function assertHasDomino(game: Game, userId: string, domino: Domino): void {
  const hand = game.hands.find((h) => h.playerId === userId)!;
  if (!hand.dominoes.some((d) => dominoEquals(d, domino))) {
    throw new ValidationError('Invalid Domino');
  }
}

// Port of `IsValidDomino` (follow-suit rule).
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

// Port of `PluralizationProvider.Singularize(game.CurrentTrick.Suit.ToString())` for the error
// message above. Only real suits (Blanks..Sixes) ever reach this call site (`trickSuit` is a
// set trick suit, never Low/None), so a small lookup table covers every case exactly — a plain
// strip-trailing-"s" would mangle "Sixes" -> "Sixe" instead of "Six".
const SUIT_SINGULAR: Partial<Record<Suit, string>> = {
  [Suit.Blanks]: 'Blank',
  [Suit.Aces]: 'Ace',
  [Suit.Deuces]: 'Deuce',
  [Suit.Threes]: 'Three',
  [Suit.Fours]: 'Four',
  [Suit.Fives]: 'Five',
  [Suit.Sixes]: 'Six',
};

function singularizeSuit(suit: Suit): string {
  return SUIT_SINGULAR[suit] ?? Suit[suit];
}

// Port of `IsMatchPlayer`.
export function assertIsMatchPlayer(match: MatchLike, userId: string): void {
  if (match.players.every((p) => p.playerId !== userId)) {
    throw new ValidationError("You aren't a part of this match!");
  }
}

// Port of `IsNotMatchPlayer`.
export function assertIsNotMatchPlayer(match: MatchLike, userId: string): void {
  if (match.players.some((p) => p.playerId === userId)) {
    throw new ValidationError('You are already in this match!');
  }
}
