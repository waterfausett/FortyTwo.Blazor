import { Bid } from './bid';
import { Domino } from './domino';
import { Teams } from './teams';

export interface Hand {
  playerId: string;
  team: Teams;
  dominoes: Domino[];
  bid: Bid | null;
}
