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
  // The bot made this seat's bid or trump call for a player on autopilot, so the hand isn't
  // theirs for stats (stats.ts).
  autoBid?: true;
}
