export enum Suit {
  Low = -2,
  None = -1,
  Blanks = 0,
  Aces = 1,
  Deuces = 2,
  Threes = 3,
  Fours = 4,
  Fives = 5,
  Sixes = 6
}

export function suitToPrettyString(suit: Suit): string {
  return suit === Suit.None ? 'Follow Me' : Suit[suit];
}
