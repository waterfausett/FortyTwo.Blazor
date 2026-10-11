// How the Profile's Stats section reads, shared by the web and mobile apps: the filters, and each
// figure as a label and the text to show. A rate with nothing to divide by shows as a dash.
import type { BestPartner, StatsFilter, StatsSummary } from '@fortytwo/api-types';

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

export function statTiles(s: StatsSummary): StatTile[] {
  return [
    { label: 'Played', value: String(s.played) },
    { label: 'Won', value: String(s.won) },
    { label: 'Lost', value: String(s.lost) },
    { label: 'Win rate', value: rate(s.won, s.played) },
    { label: 'Marks won', value: String(s.marksWon) },
    { label: 'Bids won', value: String(s.bidsWon) },
    { label: 'Made', value: String(s.bidsMade) },
    { label: 'Set', value: String(s.bidsSet) },
    { label: 'Made rate', value: rate(s.bidsMade, s.bidsWon) },
    { label: 'Avg. points bid', value: s.averagePointsBid === null ? '–' : s.averagePointsBid.toFixed(1) },
    { label: 'Marks bids', value: String(s.marksBids) },
  ];
}

export function bestPartnerRecord(partner: BestPartner): string {
  return `${partner.won}–${partner.lost} together`;
}
