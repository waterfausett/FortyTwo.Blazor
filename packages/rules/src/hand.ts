import { Bid } from './bid';
import { Domino } from './domino';
import { Teams } from './teams';

export interface Hand {
  playerId: string;
  team: Teams;
  dominoes: Domino[];
  bid: Bid | null;
  // Set only on a hand hidden from the viewer (view.ts's matchViewFor): `dominoes` is then empty
  // and this says how many they hold.
  hiddenCount?: number;
}
