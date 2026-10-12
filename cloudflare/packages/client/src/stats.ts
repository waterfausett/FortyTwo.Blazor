// How the Profile's Stats section reads, shared by the web and mobile apps: the filters, and each
// figure as a label and the text to show, in its section. A rate with nothing to divide by shows as a dash.
import type { BestPartner, FavoriteTrump, StatsFilter, StatsSummary, TrumpKey } from '@fortytwo/api-types';

export const STATS_FILTERS: { filter: StatsFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'humansOnly', label: 'Humans only' },
  { filter: 'withBots', label: 'With bots' },
];

export interface StatTile {
  label: string;
  value: string;
}

function rate(part: number, whole: number): string {
  return whole === 0 ? '–' : `${Math.round((part / whole) * 100)}%`;
}

export interface StatSection {
  // Which figures: each app shows best partner under 'matches' and favorite trump under 'bidding'.
  key: 'matches' | 'bidding';
  title: string;
  tiles: StatTile[];
}

// Whole matches first, then the hands they bid on, each under its own heading.
export function statSections(s: StatsSummary): StatSection[] {
  return [
    {
      key: 'matches',
      title: 'Matches',
      tiles: [
        { label: 'Played', value: String(s.played) },
        { label: 'Won', value: String(s.won) },
        { label: 'Lost', value: String(s.lost) },
        { label: 'Win rate', value: rate(s.won, s.played) },
        { label: 'Marks won', value: String(s.marksWon) },
      ],
    },
    {
      key: 'bidding',
      title: 'Bidding',
      tiles: [
        { label: 'Bids won', value: String(s.bidsWon) },
        { label: 'Made', value: String(s.bidsMade) },
        { label: 'Set', value: String(s.bidsSet) },
        { label: 'Made rate', value: rate(s.bidsMade, s.bidsWon) },
        { label: 'Avg. points bid', value: s.averagePointsBid === null ? '–' : s.averagePointsBid.toFixed(1) },
        { label: 'Bids of 42+', value: rate(s.marksBids, s.bidsWon) },
      ],
    },
  ];
}

export function bestPartnerRecord(partner: BestPartner): string {
  return `${partner.won}–${partner.lost} together`;
}

const TRUMP_LABELS: Record<TrumpKey, string> = {
  low: 'Low',
  followMe: 'Follow Me',
  blanks: 'Blanks',
  aces: 'Aces',
  deuces: 'Deuces',
  threes: 'Threes',
  fours: 'Fours',
  fives: 'Fives',
  sixes: 'Sixes',
};

export function trumpLabel(trump: TrumpKey): string {
  return TRUMP_LABELS[trump];
}

export function favoriteTrumpRecord(favorite: FavoriteTrump, bidsWon: number): string {
  return `${favorite.times} of ${bidsWon} bids`;
}
