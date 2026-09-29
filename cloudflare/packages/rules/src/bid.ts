export enum Bid {
  Pass = 0,
  Thirty = 30,
  ThirtyOne = 31,
  ThirtyTwo = 32,
  ThirtyThree = 33,
  ThirtyFour = 34,
  ThirtyFive = 35,
  ThirtySix = 36,
  ThirtySeven = 37,
  ThirtyEight = 38,
  ThirtyNine = 39,
  Forty = 40,
  FortyOne = 41,
  FortyTwo = 42,
  EightyFour = 84,
  ThreeMarks = 126,
  FourMarks = 168,
  Plunge = 169,
  FiveMarks = 210,
  SixMarks = 252,
  SevenMarks = 294
}

export function bidToPrettyString(bid: Bid | null | undefined): string {
  if (bid === null || bid === undefined) return 'N/A';
  return bid === Bid.Pass || bid === Bid.Plunge
    ? Bid[bid]
    : bid === Bid.ThreeMarks
      ? '3 Marks'
      : bid === Bid.FourMarks
        ? '4 Marks'
        : bid === Bid.FiveMarks
          ? '5 Marks'
          : bid === Bid.SixMarks
            ? '6 Marks'
            : bid === Bid.SevenMarks
              ? '7 Marks'
              : String(bid);
}
