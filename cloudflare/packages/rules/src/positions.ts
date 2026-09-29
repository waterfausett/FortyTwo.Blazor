export enum Positions {
  First = 0,
  Second = 1,
  Third = 2,
  Fourth = 3
}

export function nextPosition(position: Positions): Positions {
  return ((position + 1) % 4) as Positions;
}
