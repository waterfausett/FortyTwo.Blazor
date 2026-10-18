// A table's listing for the Matchmaker's seat index (seatIndex.ts), against the real MatchDO: what
// changes it, what's reported, and what the Matchmaker's own calls hand back instead.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createDomino, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { Listing } from '../src/seatIndex';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}
type Stub = ReturnType<typeof stubFor>;

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// Every listing the table reports from now on, in order (null: it was deleted), in place of sending them.
async function reportsOf(stub: Stub): Promise<(Listing | null)[]> {
  const reports: (Listing | null)[] = [];
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { report(m: MatchState, l: Listing | null): void }).report = (_m, l) => reports.push(l);
  });
  return reports;
}

const seatIds = (listing: Listing | null) => listing?.seats.map((s) => s.playerId);

describe('a table listing', () => {
  it('is kept only at Live and Async tables', async () => {
    const stub = stubFor('ls-custom');
    await stub.create('a', 'ls-custom', 'custom');
    await stub.takeSeat('b', 1);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.get('listing'))).toBeUndefined();
  });

  it("comes back with the Matchmaker's own calls, which report nothing", async () => {
    const stub = stubFor('ls-own');
    const created = await stub.createListed('a', 'ls-own', 'live');
    expect(created.listing).toMatchObject({ seq: 1, seats: [{ playerId: 'a', position: 0 }], dealt: false });
    const reports = await reportsOf(stub);

    const joined = await stub.takeSeatListed('b', 1, deck());
    expect(joined.result.ok).toBe(true);
    expect(joined.listing).toMatchObject({ seq: 2 });
    expect(seatIds(joined.listing)).toEqual(['a', 'b']);
    expect(reports).toEqual([]);
  });

  it('comes back with a refusal, so the Matchmaker learns the seat was taken', async () => {
    const stub = stubFor('ls-refused');
    await stub.createListed('a', 'ls-refused', 'daily');
    await stub.takeSeat('b', 1);

    const refused = await stub.takeSeatListed('c', 1, deck());

    expect(refused.result.ok).toBe(false);
    expect(seatIds(refused.listing)).toEqual(['a', 'b']);
  });

  it('is null for a table that is gone', async () => {
    expect(await stubFor('ls-never').getListing()).toEqual({
      result: expect.objectContaining({ ok: false, status: 404 }),
      listing: null,
    });
  });

  it('reports a join from outside matchmaking, a leave before the deal, and bots filling the seats', async () => {
    const stub = stubFor('ls-reports');
    await stub.createListed('a', 'ls-reports', 'live');
    const reports = await reportsOf(stub);

    await stub.takeSeat('b', 1);
    await stub.leave('b');
    await stub.addBots('a');

    expect(reports.map(seatIds)).toEqual([['a', 'b'], ['a'], ['a', 'ls-reports_bot-1', 'ls-reports_bot-2', 'ls-reports_bot-3']]);
    expect(reports.map((l) => l!.seq)).toEqual([2, 3, 4]);
    expect(reports.at(-1)).toMatchObject({ dealt: true, takesClaims: true });
  });

  it("doesn't change with a bot's move", async () => {
    const stub = stubFor('ls-bot-move');
    await stub.createListed('a', 'ls-bot-move', 'live');
    await stub.addBots('a');
    const reports = await reportsOf(stub);
    const before = (await stub.getListing()).listing;

    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);

    expect((await stub.getListing()).listing).toEqual(before);
    expect(reports).toEqual([]);
  });

  it('reports a claim given up', async () => {
    const stub = stubFor('ls-claim');
    await stub.createListed('a', 'ls-claim', 'live');
    await stub.addBots('a');
    await stub.claimSeatListed('n1');
    const reports = await reportsOf(stub);

    await stub.leave('n1');

    expect(reports.map((l) => l?.claims)).toEqual([[]]);
  });

  it('reports a table deleted when its last player leaves', async () => {
    const stub = stubFor('ls-deleted');
    await stub.createListed('a', 'ls-deleted', 'daily');
    const reports = await reportsOf(stub);

    await stub.leave('a');

    expect(reports).toEqual([null]);
  });

  it('stops reporting an Async table once it has filled', async () => {
    const stub = stubFor('ls-filled');
    await stub.createListed('a', 'ls-filled', 'daily');
    await stub.takeSeat('b', 1);
    await stub.takeSeat('c', 2);
    const reports = await reportsOf(stub);

    await stub.takeSeat('d', 3, deck());
    await stub.leave('d').catch(() => undefined);

    expect(reports.map((l) => l?.dealt)).toEqual([true]);
  });

  it('starts at seq 1 for a table stored before listings were kept', async () => {
    const stub = stubFor('ls-old');
    await stub.create('a', 'ls-old', 'live');
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.delete('listing');
      (instance as unknown as { listing: unknown }).listing = undefined;
    });

    const looked = await stub.getListing();

    expect(looked.listing).toMatchObject({ seq: 1, seats: [{ playerId: 'a', position: 0 }] });
  });
});
