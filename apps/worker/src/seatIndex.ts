// The Matchmaker's seat index: who sits where at every Async table still filling and every Live
// table not yet won, so a search reads the Matchmaker's own storage instead of asking every table
// (matchmaker.ts). Live games stay in it while under way: a newcomer may claim a bot seat there,
// and a Live player in one - seated or claiming - is taken back to it rather than seated anew.
//
// Each table works out its own listing from its match (listingOf) and keeps it with a seq that
// only goes up. The Matchmaker's own calls (seat, claim, create) hand the new listing back with
// their result; any other change to a listing the MatchDO reports (matchDO.ts). A listing is a
// whole snapshot, not a change, so one arriving after a newer one (a report overtaken by a
// result, say) adds nothing and is ignored.
import { TAKEOVER_MAX_MARKS, hasBeenDealt, isBot, matchMode, matchScores, type MatchState } from '@fortytwo/rules';

export type QueueMode = 'live' | 'daily';

export interface Seat {
  playerId: string;
  position: number;
}

export interface Listing {
  seq: number;
  // Bots included, in position order.
  seats: Seat[];
  // Newcomers waiting on a bot seat at the next hand break (Live).
  claims: string[];
  dealt: boolean;
  won: boolean;
  // A Live game under way that takes claims: not won, and no team at TAKEOVER_MAX_MARKS. One paused
  // on its last player still says yes - that changes with the clock, so the claim finds it out.
  takesClaims: boolean;
}

export interface Entry extends Listing {
  id: string;
  mode: QueueMode;
  // When it was listed, against the other entries: searches go oldest first.
  order: number;
}

// This table's listing, without its seq - or null when matchmaking never seats anyone at it
// (Over the table, vs Bots).
export function listingOf(match: MatchState): Omit<Listing, 'seq'> | null {
  const mode = matchMode(match);
  if (mode !== 'live' && mode !== 'daily') return null;
  const dealt = hasBeenDealt(match);
  const nearlyOver = Object.values(matchScores(match)).some((marks) => (marks ?? 0) >= TAKEOVER_MAX_MARKS);
  return {
    seats: [...match.players].sort((a, b) => a.position - b.position).map(({ playerId, position }) => ({ playerId, position })),
    claims: [...(match.claims ?? [])],
    dealt,
    won: match.winningTeam !== null,
    takesClaims: mode === 'live' && dealt && match.winningTeam === null && !nearlyOver,
  };
}

// Whether the index holds a table with this listing: an Async table while it fills, a Live one
// until it's won.
export function indexed(mode: QueueMode, listing: Omit<Listing, 'seq'>): boolean {
  return mode === 'live' ? !listing.won : !listing.dealt && listing.seats.length < 4;
}

// Still filling, or a Live game under way with a bot seat nobody has claimed yet.
export function canSeat(listing: Omit<Listing, 'seq'>): boolean {
  if (!listing.dealt) return listing.seats.length < 4;
  return listing.takesClaims && listing.seats.filter((s) => isBot(s.playerId)).length > listing.claims.length;
}

export function sameListing(a: Omit<Listing, 'seq'>, b: Omit<Listing, 'seq'> | undefined): boolean {
  if (b === undefined) return false;
  const key = (l: Omit<Listing, 'seq'>) => JSON.stringify([l.seats, l.claims, l.dealt, l.won, l.takesClaims]);
  return key(a) === key(b);
}

export type IndexChange = { kind: 'put'; entry: Entry } | { kind: 'delete' };

// Takes a table's listing (null: the table is gone) into the index, and says what to save: the
// entry, its deletion, or nothing. A table the index no longer holds (indexed) leaves it.
export function applyListing(
  entries: Map<string, Entry>,
  id: string,
  mode: QueueMode,
  listing: Listing | null
): IndexChange | null {
  const held = entries.get(id);
  if (listing === null || !indexed(mode, listing)) {
    if (held === undefined) return null;
    if (listing !== null && listing.seq <= held.seq) return null;
    entries.delete(id);
    return { kind: 'delete' };
  }
  if (held !== undefined && listing.seq <= held.seq) return null;
  const order = held?.order ?? Math.max(0, ...[...entries.values()].map((e) => e.order)) + 1;
  const entry: Entry = { id, mode, order, ...listing };
  entries.set(id, entry);
  return { kind: 'put', entry };
}

// This mode's tables, oldest first.
export function searchOrder(entries: Map<string, Entry>, mode: QueueMode): Entry[] {
  return [...entries.values()].filter((e) => e.mode === mode).sort((a, b) => a.order - b.order);
}

// The tables of this mode the player sits or claims a seat at, as far as the index knows, oldest first.
export function tablesOf(entries: Map<string, Entry>, mode: QueueMode, playerId: string): Entry[] {
  return searchOrder(entries, mode).filter(
    (e) => e.claims.includes(playerId) || e.seats.some((s) => s.playerId === playerId)
  );
}

// A Live solo fills one team before the other, so a partner who joins next sits across from them
// and the team that's left is whole; Daily seats in order.
export function freeSeat(entry: Entry): number | undefined {
  const order = entry.mode === 'live' ? [0, 2, 1, 3] : [0, 1, 2, 3];
  return order.find((position) => entry.seats.every((s) => s.position !== position));
}

const TEAMS: [number, number][] = [
  [0, 2],
  [1, 3],
];

// A team with both seats empty at a table not yet dealt, the first that fits.
export function freeTeam(entry: Entry): [number, number] | undefined {
  if (entry.dealt) return undefined;
  return TEAMS.find((team) => team.every((position) => entry.seats.every((s) => s.position !== position)));
}

// A team of two bots at a Live game that takes claims, with bot seats enough besides the claims
// already waiting. Only a pre-filter: the table has the last word (claimTeam).
export function botTeam(entry: Entry): [number, number] | undefined {
  if (!entry.dealt || !entry.takesClaims) return undefined;
  const bots = entry.seats.filter((s) => isBot(s.playerId));
  if (bots.length - entry.claims.length < 2) return undefined;
  return TEAMS.find((team) => team.every((position) => bots.some((s) => s.position === position)));
}
