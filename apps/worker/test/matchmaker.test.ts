// The Matchmaker: seats a player at the oldest open table of their mode, or starts one, and never
// splits players who press Play together across two tables. Each test uses its own instance - and
// as tables report to the 'global' one, a test's instance hears of a change it didn't make only
// through `index` below, or by finding it out: the same as a report that was lost.
import { describe, it, expect, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_TURN_MS, Teams, createDomino, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import {
  DEFAULT_PRESENCE_BROADCAST_MS,
  MIN_PRESENCE_BROADCAST_MS,
  presenceBroadcast,
  presenceBroadcastMs,
} from '../src/matchmaker';
import type { Entry, Listing, QueueMode } from '../src/seatIndex';

const testEnv = env as unknown as Env;

function matchmaker(name: string) {
  return testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName(name));
}
function matchStub(id: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(id));
}
// Indexes a table in mm, as the table's report would.
async function index(mm: ReturnType<typeof matchmaker>, id: string, mode: QueueMode = 'live') {
  const { listing } = await matchStub(id).getListing();
  await mm.report(id, mode, listing);
}
async function entries(mm: ReturnType<typeof matchmaker>): Promise<Map<string, Entry>> {
  return runInDurableObject(mm, async (_i, state) => {
    const stored = await state.storage.list<Entry>({ prefix: 'table:' });
    return new Map([...stored.values()].map((e) => [e.id, e]));
  });
}
const listing = (over: Partial<Listing> = {}): Listing => ({
  seq: 1,
  seats: [{ playerId: 'x', position: 0 }],
  claims: [],
  dealt: false,
  won: false,
  takesClaims: false,
  ...over,
});

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

describe('Matchmaker', () => {
  it('starts a table for the first player and seats the next one at it', async () => {
    const mm = matchmaker('mm-basic');
    const first = await mm.play('a', 'daily');
    const second = await mm.play('b', 'daily');

    expect(first.mode).toBe('daily');
    expect(second.id).toBe(first.id);
    expect(second.players.map((p) => p.playerId).sort()).toEqual(['a', 'b']);
  });

  it('puts two players who press Play at once at the same table', async () => {
    const mm = matchmaker('mm-race');
    const [a, b] = await Promise.all([mm.play('a', 'live'), mm.play('b', 'live')]);
    expect(a.id).toBe(b.id);
  });

  it('keeps Live and Async tables apart', async () => {
    const mm = matchmaker('mm-modes');
    const live = await mm.play('a', 'live');
    const daily = await mm.play('b', 'daily');
    expect(daily.id).not.toBe(live.id);
  });

  it('returns your current Live search instead of starting a second one', async () => {
    const mm = matchmaker('mm-live-again');
    const first = await mm.play('a', 'live');
    const again = await mm.play('a', 'live');
    expect(again.id).toBe(first.id);
    expect(again.players).toHaveLength(1);
  });

  it('keeps a Live player at the table they wait at, not an older one with room', async () => {
    const mm = matchmaker('mm-live-prescan');
    const older = await mm.play('a', 'live');
    const newer = await mm.play('b', 'live');
    expect(newer.id).toBe(older.id);
    // b leaves the older table, and that report never arrives; then waits at a newer one.
    await matchStub(older.id).leave('b');
    const other = 'mm-live-prescan-other';
    await matchStub(other).create('b', other, 'live');
    await index(mm, other);

    const again = await mm.play('b', 'live');

    expect(again.id).toBe(other);
    expect((await matchStub(older.id).getMatch()) as { ok: true; value: { players: unknown[] } }).toMatchObject({
      value: { players: [expect.objectContaining({ playerId: 'a' })] },
    });
  });

  it('skips a table that throws and keeps it indexed', async () => {
    const mm = matchmaker('mm-throwing');
    const broken = 'mm-throwing-broken';
    await mm.report(broken, 'daily', listing());
    await runInDurableObject(mm, async (instance) => {
      const real = (instance as any).matchStub.bind(instance);
      (instance as any).matchStub = (id: string) =>
        id === broken ? { takeSeatListed: () => Promise.reject(new Error('unreachable')) } : real(id);
    });

    const table = await mm.play('a', 'daily');

    expect(table.players.map((p) => p.playerId)).toEqual(['a']);
    expect([...(await entries(mm)).keys()].sort()).toEqual([broken, table.id].sort());
  });

  it('indexes a new table before creating it', async () => {
    const mm = matchmaker('mm-write-ahead');
    const indexedAtCreate: unknown[] = [];
    await runInDurableObject(mm, async (instance, state) => {
      const real = (instance as any).matchStub.bind(instance);
      (instance as any).matchStub = (id: string) => ({
        createListed: async (...args: unknown[]) => {
          indexedAtCreate.push(id, (await state.storage.get<Entry>(`table:${id}`))?.seats);
          return real(id).createListed(...args);
        },
      });
    });

    const table = await mm.play('a', 'daily');

    expect(indexedAtCreate).toEqual([table.id, [{ playerId: 'a', position: 0 }]]);
    expect((await entries(mm)).get(table.id)?.seq).toBe(1);
  });

  it('lets one player wait at several Async tables', async () => {
    const mm = matchmaker('mm-daily-several');
    const first = await mm.play('a', 'daily');
    const second = await mm.play('a', 'daily');
    expect(second.id).not.toBe(first.id);
  });

  it('moves on from a table filled outside matchmaking (an invite link)', async () => {
    const mm = matchmaker('mm-filled-elsewhere');
    const table = await mm.play('a', 'daily');
    const stub = matchStub(table.id);
    await stub.takeSeat('x', 1);
    await stub.takeSeat('y', 2);
    await stub.takeSeat('z', 3, deck());

    const next = await mm.play('b', 'daily');

    expect(next.id).not.toBe(table.id);
    expect(next.players.map((p) => p.playerId)).toEqual(['b']);
  });

  it('moves on from a table deleted when its last player left', async () => {
    const mm = matchmaker('mm-deleted');
    const table = await mm.play('a', 'daily');
    await matchStub(table.id).leave('a');

    const next = await mm.play('b', 'daily');

    expect(next.id).not.toBe(table.id);
  });

  it('takes a reported table into the index, and ignores a report older than the one it holds', async () => {
    const mm = matchmaker('mm-report');
    await mm.report('t-1', 'live', listing({ seq: 2 }));
    await mm.report('t-1', 'live', listing({ seq: 1, seats: [] }));
    const held = await entries(mm);
    expect([...held.keys()]).toEqual(['t-1']);
    expect(held.get('t-1')).toMatchObject({ seq: 2, seats: [{ playerId: 'x', position: 0 }] });
  });

  it('drops a reported table once it is deleted', async () => {
    const mm = matchmaker('mm-report-deleted');
    await mm.report('t-1', 'live', listing());
    await mm.report('t-1', 'live', null);
    expect((await entries(mm)).size).toBe(0);
  });

  it('indexes the tables it listed before the index, once', async () => {
    const mm = matchmaker('mm-migrate');
    await matchStub('mm-migrate-t').create('a', 'mm-migrate-t', 'daily');
    await runInDurableObject(mm, async (_i, state) => {
      await state.storage.put({ 'open:daily': ['mm-migrate-t', 'mm-migrate-gone'], 'claim:n1': 'mm-migrate-t' });
    });

    const seated = await mm.play('b', 'daily');

    expect(seated.id).toBe('mm-migrate-t');
    const keys = await runInDurableObject(mm, async (_i, state) => [...(await state.storage.list()).keys()]);
    expect(keys).toEqual(['table:mm-migrate-t']);
  });
});

// A dealt live table with p1 and three bots, in mm's index (p1 started it, then filled with bots).
async function underWay(mm: ReturnType<typeof matchmaker>) {
  const started = await mm.play('p1', 'live');
  await matchStub(started.id).addBots('p1');
  return started.id;
}

describe('Matchmaker and games under way', () => {
  it('prefers a table still filling over a game under way, even an older one', async () => {
    const mm = matchmaker('mm-prefer-filling');
    // A game under way first in the index, then a table still filling - both made directly and
    // indexed, since playing would claim at the first before the second existed.
    await matchStub('g-busy').create('p1', 'g-busy', 'live');
    await matchStub('g-busy').addBots('p1');
    await matchStub('g-filling').create('a', 'g-filling', 'live');
    await index(mm, 'g-busy');
    await index(mm, 'g-filling');

    const seated = await mm.play('b', 'live');
    expect(seated.id).toBe('g-filling');
    const busy = await matchStub('g-busy').getMatch();
    expect(busy.ok && (busy.value.claims ?? []).length).toBe(0);
  });

  it('claims a bot seat in a game under way when no table is filling', async () => {
    const mm = matchmaker('mm-claim');
    const id = await underWay(mm);
    const joined = await mm.play('n1', 'live');
    expect(joined.id).toBe(id);
    expect(joined.claims).toEqual(['n1']);
  });

  it('returns the game you claim in when you press play again', async () => {
    const mm = matchmaker('mm-claim-again');
    const id = await underWay(mm);
    await mm.play('n1', 'live');
    await mm.play('n2', 'live');
    await mm.play('n3', 'live'); // all three bot seats claimed: the table drops off the list
    const again = await mm.play('n1', 'live');
    expect(again.id).toBe(id);
  });

  it('returns a human to their own game under way and keeps it indexed', async () => {
    const mm = matchmaker('mm-own-game');
    const id = await underWay(mm);
    const again = await mm.play('p1', 'live');
    expect(again.id).toBe(id);
    expect((await entries(mm)).has(id)).toBe(true);
  });

  it('seats a Live player with one call, however many games are under way', async () => {
    const mm = matchmaker('mm-one-look');
    for (const busy of ['g1-busy', 'g2-busy']) {
      await matchStub(busy).create('p1', busy, 'live');
      await matchStub(busy).addBots('p1');
      await index(mm, busy);
    }
    await matchStub('g1-filling').create('a', 'g1-filling', 'live');
    await index(mm, 'g1-filling');
    const calls: string[] = [];
    await runInDurableObject(mm, async (instance) => {
      const real = (instance as any).matchStub.bind(instance);
      (instance as any).matchStub = (id: string) => {
        const stub = real(id);
        const counted =
          (name: string) =>
          (...args: unknown[]) => {
            calls.push(`${name} ${id}`);
            return stub[name](...args);
          };
        return Object.fromEntries(
          ['getListing', 'getMatch', 'takeSeatListed', 'claimSeatListed', 'createListed'].map((name) => [name, counted(name)])
        );
      };
    });

    const seated = await mm.play('b', 'live');

    expect(seated.id).toBe('g1-filling');
    expect(calls).toEqual(['takeSeatListed g1-filling']);
  });

  it('starts a new table once every bot seat is claimed', async () => {
    const mm = matchmaker('mm-claims-full');
    const id = await underWay(mm);
    for (const n of ['n1', 'n2', 'n3']) await mm.play(n, 'live');
    const fresh = await mm.play('n4', 'live');
    expect(fresh.id).not.toBe(id);
    expect(fresh.players.map((p) => p.playerId)).toEqual(['n4']);
  });
});

async function changeMatch(id: string, change: (match: MatchState) => Partial<MatchState>) {
  await runInDurableObject(matchStub(id), async (_i, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    await state.storage.put('match', { ...match, ...change(match) });
  });
}

// The tables mm's index has this player claiming a seat at.
const claimedAt = async (mm: ReturnType<typeof matchmaker>, playerId: string) =>
  [...(await entries(mm)).values()].filter((e) => e.claims.includes(playerId)).map((e) => e.id);

describe('Matchmaker and stale claims', () => {
  it('forgets a claim in a game since finished and seats the player afresh', async () => {
    const mm = matchmaker('mm-stale-finished');
    const id = await underWay(mm);
    await mm.play('n1', 'live');
    expect(await claimedAt(mm, 'n1')).toEqual([id]);
    await changeMatch(id, () => ({ winningTeam: Teams.TeamA }));

    const fresh = await mm.play('n1', 'live');
    expect(fresh.id).not.toBe(id);
    expect(fresh.players.map((p) => p.playerId)).toEqual(['n1']);
  });

  it('forgets a released claim and claims again', async () => {
    const mm = matchmaker('mm-stale-released');
    const id = await underWay(mm);
    await mm.play('n1', 'live');
    // n1 cancelled at the table; mm's index, missing the report, still has the claim.
    const left = await matchStub(id).leave('n1');
    expect(left.ok && !left.value.deleted && left.value.match.claims).toEqual([]);
    expect(await claimedAt(mm, 'n1')).toEqual([id]);

    const again = await mm.play('n1', 'live');
    expect(again.id).toBe(id);
    expect(again.claims).toEqual(['n1']);
    expect(await claimedAt(mm, 'n1')).toEqual([id]);
  });

  it('keeps a game paused on its last player indexed when it refuses a claim', async () => {
    const mm = matchmaker('mm-paused');
    const id = await underWay(mm);
    const stub = matchStub(id);
    // Let the bots act until the table waits on p1, then run p1's turn out.
    for (let i = 0; i < 10; i++) {
      const match = await runInDurableObject(stub, async (_i, state) => (await state.storage.get<MatchState>('match'))!);
      if (match.currentGame.currentPlayerId === 'p1') break;
      await runDurableObjectAlarm(stub);
    }
    await changeMatch(id, () => ({ updatedOn: new Date(Date.now() - LIVE_TURN_MS - 1000).toISOString() }));

    const elsewhere = await mm.play('n1', 'live');
    expect(elsewhere.id).not.toBe(id);
    expect((await entries(mm)).has(id)).toBe(true);
  });
});

describe('presenceBroadcast', () => {
  const t = 1_000_000;
  const windowMs = 60_000;

  it('sends at once when nothing has gone out within the window', () => {
    expect(presenceBroadcast(t, null, null, windowMs)).toEqual({ kind: 'now' });
    expect(presenceBroadcast(t, t - windowMs, null, windowMs)).toEqual({ kind: 'now' });
  });

  it('holds a change within the window for one alarm when that is up', () => {
    expect(presenceBroadcast(t, t - 10_000, null, windowMs)).toEqual({ kind: 'alarm', at: t - 10_000 + windowMs });
  });

  it('adds nothing when that alarm is already set', () => {
    expect(presenceBroadcast(t, t - 10_000, t + 50_000, windowMs)).toEqual({ kind: 'wait' });
  });
});

describe('presenceBroadcastMs', () => {
  it('uses PRESENCE_BROADCAST_MS when it is a number at or above the floor', () => {
    expect(presenceBroadcastMs({ PRESENCE_BROADCAST_MS: '30000' })).toBe(30_000);
    expect(presenceBroadcastMs({ PRESENCE_BROADCAST_MS: String(MIN_PRESENCE_BROADCAST_MS) })).toBe(MIN_PRESENCE_BROADCAST_MS);
  });

  it('falls back to the default when unset', () => {
    expect(presenceBroadcastMs({})).toBe(DEFAULT_PRESENCE_BROADCAST_MS);
    expect(presenceBroadcastMs({ PRESENCE_BROADCAST_MS: '' })).toBe(DEFAULT_PRESENCE_BROADCAST_MS);
  });

  it('ignores a malformed or too-small value, warning once per value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(presenceBroadcastMs({ PRESENCE_BROADCAST_MS: '5m' })).toBe(DEFAULT_PRESENCE_BROADCAST_MS);
      expect(presenceBroadcastMs({ PRESENCE_BROADCAST_MS: '5m' })).toBe(DEFAULT_PRESENCE_BROADCAST_MS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(presenceBroadcastMs({ PRESENCE_BROADCAST_MS: String(MIN_PRESENCE_BROADCAST_MS - 1) })).toBe(DEFAULT_PRESENCE_BROADCAST_MS);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
