export enum Teams {
  TeamA = 1,
  TeamB = 2
}

// Partners sit across from each other: seats 0 and 2 are TeamA, seats 1 and 3 are TeamB.
export function teamForPosition(position: number): Teams {
  return position % 2 === 0 ? Teams.TeamA : Teams.TeamB;
}
