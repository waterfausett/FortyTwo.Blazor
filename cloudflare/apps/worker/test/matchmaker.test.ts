// The Matchmaker: seats a player at the oldest open table of their mode, or starts one, and never
// splits players who press Play together across two tables. Each test uses its own instance.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_TURN_MS, Teams, createDomino, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { PRESENCE_BROADCAST_MS, presenceBroadcast } from '../src/matchmaker';

const testEnv = env as unknown as Env;

function matchmaker(name: string) {
  return testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName(name));
}
function matchStub(id: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(id));
}
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
    // Seed a newer table for b ahead of the older one's list position: older first, b at newer.
    const other = 'mm-live-prescan-other';
    await matchStub(other).create('b', other, 'live');
    await matchStub(older.id).leave('b');
    await runInDurableObject(mm, async (_instance, state) => {
      await state.storage.put('open:live', [older.id, other]);
    });

    const again = await mm.play('b', 'live');

    expect(again.id).toBe(other);
    expect((await matchStub(older.id).getMatch()) as { ok: true; value: { players: unknown[] } }).toMatchObject({
      value: { players: [expect.objectContaining({ playerId: 'a' })] },
    });
  });

  it('skips a table that throws and keeps it listed', async () => {
    const mm = matchmaker('mm-throwing');
    const broken = 'mm-throwing-broken';
    await runInDurableObject(mm, async (instance, state) => {
      await state.storage.put('open:daily', [broken]);
      const real = (instance as any).matchStub.bind(instance);
      (instance as any).matchStub = (id: string) =>
        id === broken
          ? { getSeating: () => Promise.reject(new Error('unreachable')) }
          : real(id);
    });

    const table = await mm.play('a', 'daily');

    expect(table.players.map((p) => p.playerId)).toEqual(['a']);
    await runInDurableObject(mm, async (_instance, state) => {
      expect(await state.storage.get('open:daily')).toEqual([broken, table.id]);
    });
  });

  it('lists a new table before creating it', async () => {
    const mm = matchmaker('mm-write-ahead');
    const listedAtCreate: unknown[] = [];
    await runInDurableObject(mm, async (instance, state) => {
      const real = (instance as any).matchStub.bind(instance);
      (instance as any).matchStub = (id: string) => ({
        create: async (...args: unknown[]) => {
          listedAtCreate.push(id, await state.storage.get('open:daily'));
          return real(id).create(...args);
        },
      });
    });

    const table = await mm.play('a', 'daily');

    expect(listedAtCreate).toEqual([table.id, [table.id]]);
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

  it('takes an offered table back onto the list, once', async () => {
    const mm = matchmaker('mm-offer');
    await mm.offer('t-1');
    await mm.offer('t-1');
    const list = await runInDurableObject(mm, (_i, state) => state.storage.get<string[]>('open:live'));
    expect(list).toEqual(['t-1']);
  });
});

// A dealt live table with p1 and three bots, in mm's list (p1 started it, then filled with bots).
async function underWay(mm: ReturnType<typeof matchmaker>) {
  const started = await mm.play('p1', 'live');
  await matchStub(started.id).addBots('p1');
  return started.id;
}

describe('Matchmaker and games under way', () => {
  it('prefers a table still filling over a game under way, even an older one', async () => {
    const mm = matchmaker('mm-prefer-filling');
    // A game under way first in the list, then a table still filling - both made directly and
    // offered, since playing would claim at the first before the second existed.
    await matchStub('g-busy').create('p1', 'g-busy', 'live');
    await matchStub('g-busy').addBots('p1');
    await matchStub('g-filling').create('a', 'g-filling', 'live');
    await mm.offer('g-busy');
    await mm.offer('g-filling');

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

  it('returns a human to their own game under way and keeps it listed', async () => {
    const mm = matchmaker('mm-own-game');
    const id = await underWay(mm);
    const again = await mm.play('p1', 'live');
    expect(again.id).toBe(id);
    const list = await runInDurableObject(mm, (_i, state) => state.storage.get<string[]>('open:live'));
    expect(list).toContain(id);
  });

  it('looks at each listed table once per Live search, and never fetches a whole match to seat', async () => {
    const mm = matchmaker('mm-one-look');
    await matchStub('g1-busy').create('p1', 'g1-busy', 'live');
    await matchStub('g1-busy').addBots('p1');
    await matchStub('g1-filling').create('a', 'g1-filling', 'live');
    await mm.offer('g1-busy');
    await mm.offer('g1-filling');
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
        return { getSeating: counted('getSeating'), getMatch: counted('getMatch'), takeSeat: counted('takeSeat') };
      };
    });

    const seated = await mm.play('b', 'live');

    expect(seated.id).toBe('g1-filling');
    expect(calls).toEqual(['getSeating g1-busy', 'getSeating g1-filling', 'takeSeat g1-filling']);
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

const claimKey = (mm: ReturnType<typeof matchmaker>, playerId: string) =>
  runInDurableObject(mm, (_i, state) => state.storage.get<string>(`claim:${playerId}`));

describe('Matchmaker and stale claims', () => {
  it('forgets a claim in a game since finished and seats the player afresh', async () => {
    const mm = matchmaker('mm-stale-finished');
    const id = await underWay(mm);
    await mm.play('n1', 'live');
    expect(await claimKey(mm, 'n1')).toBe(id);
    await changeMatch(id, () => ({ winningTeam: Teams.TeamA }));

    const fresh = await mm.play('n1', 'live');
    expect(fresh.id).not.toBe(id);
    expect(fresh.players.map((p) => p.playerId)).toEqual(['n1']);
    expect(await claimKey(mm, 'n1')).toBeUndefined();
  });

  it('forgets a released claim and claims again', async () => {
    const mm = matchmaker('mm-stale-released');
    const id = await underWay(mm);
    await mm.play('n1', 'live');
    // n1 cancelled at the table; the Matchmaker's key still names it.
    const left = await matchStub(id).leave('n1');
    expect(left.ok && !left.value.deleted && left.value.match.claims).toEqual([]);
    expect(await claimKey(mm, 'n1')).toBe(id);

    const again = await mm.play('n1', 'live');
    expect(again.id).toBe(id);
    expect(again.claims).toEqual(['n1']);
    expect(await claimKey(mm, 'n1')).toBe(id);
  });

  it('keeps a game paused on its last player listed when it refuses a claim', async () => {
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
    const list = await runInDurableObject(mm, (_i, state) => state.storage.get<string[]>('open:live'));
    expect(list).toContain(id);
  });
});

describe('presenceBroadcast', () => {
  const t = 1_000_000;

  it('sends at once when nothing has gone out in the last minute', () => {
    expect(presenceBroadcast(t, null, null)).toEqual({ kind: 'now' });
    expect(presenceBroadcast(t, t - PRESENCE_BROADCAST_MS, null)).toEqual({ kind: 'now' });
  });

  it('holds a change inside the minute for one alarm when the minute is up', () => {
    expect(presenceBroadcast(t, t - 10_000, null)).toEqual({ kind: 'alarm', at: t - 10_000 + PRESENCE_BROADCAST_MS });
  });

  it('adds nothing when that alarm is already set', () => {
    expect(presenceBroadcast(t, t - 10_000, t + 50_000)).toEqual({ kind: 'wait' });
  });
});
