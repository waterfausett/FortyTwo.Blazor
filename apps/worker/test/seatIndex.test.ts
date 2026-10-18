// The seat index's pure parts: what a table lists, and how the Matchmaker's index takes a listing in.
import { describe, it, expect } from 'vitest';
import { Teams, createDomino, createMatch, mintBotId, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import {
  applyListing,
  canSeat,
  freeSeat,
  indexed,
  listingOf,
  sameListing,
  searchOrder,
  tablesOf,
  type Entry,
  type Listing,
} from '../src/seatIndex';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// 'a' alone at a table of this mode, or - `dealt` - with three bots, so the fourth seat dealt.
function table(mode: MatchState['mode'], { dealt = false } = {}): MatchState {
  let match = { ...createMatch('a', mode), id: 't' };
  if (!dealt) return match;
  for (const position of [1, 2, 3]) {
    match = takeSeat(match, mintBotId('t', match.players.map((p) => p.playerId))!, position, deck());
  }
  return match;
}

// `n` hands won by Team A, each bid at 42: one mark apiece.
function marks(match: MatchState, n: number): MatchState {
  const hand = { ...match.currentGame, biddingPlayerId: 'a', hands: [{ ...match.currentGame.hands[0], playerId: 'a', bid: 42 }] };
  return { ...match, games: { ...match.games, [Teams.TeamA]: Array.from({ length: n }, () => hand) } };
}

const listing = (over: Partial<Listing> = {}): Listing => ({
  seq: 1,
  seats: [{ playerId: 'a', position: 0 }],
  claims: [],
  dealt: false,
  won: false,
  takesClaims: false,
  ...over,
});

describe('listingOf', () => {
  it('lists only Live and Async tables', () => {
    expect(listingOf(table('custom'))).toBeNull();
    expect(listingOf(table('bots'))).toBeNull();
    expect(listingOf(table('daily'))).toEqual({
      seats: [{ playerId: 'a', position: 0 }],
      claims: [],
      dealt: false,
      won: false,
      takesClaims: false,
    });
  });

  it('takes claims in a Live game under way, until a team is nearly home or it is won', () => {
    const game = table('live', { dealt: true });
    expect(listingOf(game)).toMatchObject({ dealt: true, takesClaims: true });
    expect(listingOf(game)!.seats.map((s) => s.position)).toEqual([0, 1, 2, 3]);
    expect(listingOf(marks(game, 4))!.takesClaims).toBe(true);
    expect(listingOf(marks(game, 5))!.takesClaims).toBe(false);
    expect(listingOf({ ...game, winningTeam: Teams.TeamA })).toMatchObject({ won: true, takesClaims: false });
    expect(listingOf(table('daily', { dealt: true }))!.takesClaims).toBe(false);
  });

  it('keeps who claimed a seat', () => {
    expect(listingOf({ ...table('live', { dealt: true }), claims: ['n1'] })!.claims).toEqual(['n1']);
  });
});

describe('indexed', () => {
  it('holds an Async table while it fills', () => {
    expect(indexed('daily', listing())).toBe(true);
    expect(indexed('daily', listing({ dealt: true }))).toBe(false);
  });

  it('holds a Live table until it is won, even with no seat to take', () => {
    expect(indexed('live', listing({ dealt: true, takesClaims: false }))).toBe(true);
    expect(indexed('live', listing({ dealt: true, won: true }))).toBe(false);
  });
});

describe('canSeat', () => {
  it('seats someone at a table still filling', () => {
    expect(canSeat(listing())).toBe(true);
    expect(canSeat(listing({ dealt: true }))).toBe(false);
  });

  it('seats a claim while bot seats outnumber the claims', () => {
    const seats = ['a', 't_bot-1', 't_bot-2', 'b'].map((playerId, position) => ({ playerId, position }));
    expect(canSeat(listing({ seats, dealt: true, takesClaims: true, claims: ['n1'] }))).toBe(true);
    expect(canSeat(listing({ seats, dealt: true, takesClaims: true, claims: ['n1', 'n2'] }))).toBe(false);
    expect(canSeat(listing({ seats, dealt: true, takesClaims: false }))).toBe(false);
  });
});

describe('sameListing', () => {
  it('compares everything but the seq', () => {
    expect(sameListing(listing({ seq: 1 }), listing({ seq: 7 }))).toBe(true);
    expect(sameListing(listing(), listing({ claims: ['n1'] }))).toBe(false);
    expect(sameListing(listing(), undefined)).toBe(false);
  });
});

describe('applyListing', () => {
  const entries = (...list: Entry[]) => new Map(list.map((e) => [e.id, e]));
  const entry = (id: string, order: number, over: Partial<Listing> = {}): Entry => ({ id, mode: 'live', order, ...listing(over) });

  it('lists a new table that can seat someone after every other', () => {
    const index = entries(entry('t1', 3));
    expect(applyListing(index, 't2', 'live', listing())).toEqual({ kind: 'put', entry: { ...entry('t2', 4) } });
    expect(searchOrder(index, 'live').map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('updates a listed table in its place', () => {
    const index = entries(entry('t1', 1), entry('t2', 2));
    const seats = [0, 1].map((position) => ({ playerId: `p${position}`, position }));
    expect(applyListing(index, 't1', 'live', listing({ seq: 2, seats }))).toEqual({
      kind: 'put',
      entry: entry('t1', 1, { seq: 2, seats }),
    });
    expect(searchOrder(index, 'live').map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('ignores a listing no newer than the one held: it arrived late', () => {
    const index = entries(entry('t1', 1, { seq: 5 }));
    expect(applyListing(index, 't1', 'live', listing({ seq: 4, seats: [] }))).toBeNull();
    expect(applyListing(index, 't1', 'live', listing({ seq: 5, seats: [] }))).toBeNull();
    expect(index.get('t1')!.seats).toHaveLength(1);
  });

  it('drops a table won, filled or gone', () => {
    const index = entries(entry('t1', 1), entry('t2', 2), { ...entry('t3', 3), mode: 'daily' });
    expect(applyListing(index, 't1', 'live', listing({ seq: 2, dealt: true, won: true }))).toEqual({ kind: 'delete' });
    expect(applyListing(index, 't2', 'live', null)).toEqual({ kind: 'delete' });
    expect(applyListing(index, 't3', 'daily', listing({ seq: 2, dealt: true }))).toEqual({ kind: 'delete' });
    expect(index.size).toBe(0);
  });

  it('keeps a Live game under way with every bot seat claimed', () => {
    const index = entries(entry('t1', 1));
    const change = applyListing(index, 't1', 'live', listing({ seq: 2, dealt: true, takesClaims: false }));
    expect(change).toMatchObject({ kind: 'put' });
    expect(index.has('t1')).toBe(true);
  });

  it('leaves out a table it never held that it would not hold', () => {
    const index = entries();
    expect(applyListing(index, 't1', 'live', listing({ dealt: true, won: true }))).toBeNull();
    expect(applyListing(index, 't1', 'live', null)).toBeNull();
    expect(index.size).toBe(0);
  });
});

describe('searching the index', () => {
  const index = new Map<string, Entry>([
    ['d1', { id: 'd1', mode: 'daily', order: 1, ...listing({ seats: [{ playerId: 'x', position: 0 }] }) }],
    ['l2', { id: 'l2', mode: 'live', order: 3, ...listing({ seats: [{ playerId: 'p9', position: 0 }], claims: ['n1'], dealt: true, takesClaims: true }) }],
    ['l1', { id: 'l1', mode: 'live', order: 2, ...listing({ seats: [{ playerId: 'a', position: 1 }] }) }],
  ]);

  it('goes oldest first, one mode at a time', () => {
    expect(searchOrder(index, 'live').map((e) => e.id)).toEqual(['l1', 'l2']);
    expect(searchOrder(index, 'daily').map((e) => e.id)).toEqual(['d1']);
  });

  it('finds the tables a player sits or claims at', () => {
    expect(tablesOf(index, 'live', 'a').map((e) => e.id)).toEqual(['l1']);
    expect(tablesOf(index, 'live', 'n1').map((e) => e.id)).toEqual(['l2']);
    expect(tablesOf(index, 'live', 'x')).toEqual([]);
  });

  it('picks the lowest free seat', () => {
    expect(freeSeat(index.get('l1')!)).toBe(0);
    expect(freeSeat({ ...index.get('l1')!, seats: [0, 1, 2].map((position) => ({ playerId: `p${position}`, position })) })).toBe(3);
  });
});
