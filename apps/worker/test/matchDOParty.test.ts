// Partying up and moving on at the end of a Live game, at MatchDO's RPC boundary. These reach the
// 'global' Matchmaker, which every test shares, so each test seats players of its own.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Teams, teamForPosition, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { finishedMatch } from './finishedMatch';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected an ok result, got ${JSON.stringify(result)}`);
  return result.value;
}

// A finished Live match between `name`-p1..p4: p1 and p3 are TeamA, p2 and p4 TeamB.
async function seedLive(name: string) {
  const ids = ['p1', 'p2', 'p3', 'p4'].map((p) => `${name}-${p}`);
  const match: MatchState = { ...finishedMatch(name, ids), mode: 'live' };
  const stub = stubFor(name);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  const [p1, p2, p3, p4] = ids;
  return { stub, p1, p2, p3, p4 };
}

describe('MatchDO party up', () => {
  it('records the first offer and goes nowhere yet', async () => {
    const { stub, p1 } = await seedLive('party-offer');

    const after = valueOf(await stub.partyUp(p1));

    expect(after.partyOffers).toEqual([p1]);
    expect(after.partyMatchIds).toBeUndefined();
  });

  it('seats the pair together at a new match once both offer', async () => {
    const { stub, p1, p3 } = await seedLive('party-both');

    await stub.partyUp(p1);
    const after = valueOf(await stub.partyUp(p3));

    const newId = after.partyMatchIds?.[Teams.TeamA];
    expect(newId).toBeTruthy();
    expect(after.partyOffers ?? []).toEqual([]);
    const created = valueOf(await stubFor(newId!).getMatch());
    const seat = (id: string) => created.players.find((p) => p.playerId === id)!.position;
    expect(teamForPosition(seat(p1))).toBe(teamForPosition(seat(p3)));
  });

  it('moves on a partner already at another Live table, and seats nobody', async () => {
    const { stub, p1, p3 } = await seedLive('party-busy');
    const matchmaker = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('global'));
    await matchmaker.play(p3, 'live');

    await stub.partyUp(p1);
    const after = valueOf(await stub.partyUp(p3));

    expect(after.movedOn).toEqual({ [p3]: 'busy' });
    expect(after.partyMatchIds).toBeUndefined();
    // Saved, not just returned.
    expect(valueOf(await stub.getMatch()).movedOn).toEqual({ [p3]: 'busy' });
  });

  it('lets a player move on, which ends the rematch', async () => {
    const { stub, p1, p2 } = await seedLive('party-move-on');

    const after = valueOf(await stub.moveOn(p2));

    expect(after.movedOn).toEqual({ [p2]: 'left' });
    expect(await stub.rematch(p1)).toMatchObject({ ok: false, status: 400 });
  });

  it('takes an offer back', async () => {
    const { stub, p1 } = await seedLive('party-cancel');
    await stub.partyUp(p1);

    const after = valueOf(await stub.cancelParty(p1));

    expect(after.partyOffers).toEqual([]);
  });

  it('refuses moving on or cancelling outside a finished Live match', async () => {
    const stub = stubFor('party-custom');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('match', finishedMatch('party-custom'));
    });

    expect(await stub.moveOn('p1')).toMatchObject({ ok: false, status: 400 });
    expect(await stub.cancelParty('p1')).toMatchObject({ ok: false, status: 400 });
    expect(await stub.partyUp('p1')).toMatchObject({ ok: false, status: 400 });
  });
});
