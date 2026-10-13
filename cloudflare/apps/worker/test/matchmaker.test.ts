// The Matchmaker: seats a player at the oldest open table of their mode, or starts one, and never
// splits players who press Play together across two tables. Each test uses its own instance.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createDomino, type Domino } from '@fortytwo/rules';
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

  it('keeps Live and Daily tables apart', async () => {
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
          ? { getMatch: () => Promise.reject(new Error('unreachable')) }
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

  it('lets one player wait at several Daily tables', async () => {
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

  it('starts a new table once every bot seat is claimed', async () => {
    const mm = matchmaker('mm-claims-full');
    const id = await underWay(mm);
    for (const n of ['n1', 'n2', 'n3']) await mm.play(n, 'live');
    const fresh = await mm.play('n4', 'live');
    expect(fresh.id).not.toBe(id);
    expect(fresh.players.map((p) => p.playerId)).toEqual(['n4']);
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
