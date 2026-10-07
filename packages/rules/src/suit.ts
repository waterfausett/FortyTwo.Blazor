export enum Suit {
  // The three Low trumps differ only in how doubles behave (see domino.ts). `Low` keeps its
  // original value (and its original doubles-high behavior) so stored matches read the same.
  LowDoublesOwnSuit = -4,
  LowDoublesLow = -3,
  Low = -2,
  None = -1,
  Blanks = 0,
  Aces = 1,
  Deuces = 2,
  Threes = 3,
  Fours = 4,
  Fives = 5,
  Sixes = 6,
  // Never a trump: the suit a double leads under `LowDoublesOwnSuit`, where doubles are a suit of
  // their own.
  Doubles = 7
}

export const LOW_TRUMPS = [Suit.Low, Suit.LowDoublesLow, Suit.LowDoublesOwnSuit] as const;

// Whether `trump` is any of the Low variants - the bidder plays alone trying to lose every trick.
export function isLow(trump: Suit | null | undefined): boolean {
  return trump === Suit.Low || trump === Suit.LowDoublesLow || trump === Suit.LowDoublesOwnSuit;
}

export function suitToPrettyString(suit: Suit): string {
  switch (suit) {
    case Suit.None:
      return 'Follow Me';
    case Suit.LowDoublesLow:
    case Suit.LowDoublesOwnSuit:
      return 'Low';
    default:
      return Suit[suit];
  }
}

// How doubles behave under a Low trump, for the picker and the scoreboard.
export function lowDoublesToPrettyString(trump: Suit): string {
  switch (trump) {
    case Suit.LowDoublesLow:
      return 'Low';
    case Suit.LowDoublesOwnSuit:
      return 'Suit of their own';
    default:
      return 'High';
  }
}
