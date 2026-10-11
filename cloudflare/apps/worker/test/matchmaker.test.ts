// The Matchmaker: seats a player at the oldest open table of their mode, or starts one, and never
// splits players who press Play together across two tables. Each test uses its own instance.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
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
