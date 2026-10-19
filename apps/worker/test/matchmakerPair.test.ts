// The Matchmaker for a pair who search together (playPair), and its check on who is already in a
// Live game (liveBusy). Each test uses its own instance, as in matchmaker.test.ts.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index';
import type { Entry, QueueMode } from '../src/seatIndex';

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
const seatsOf = (players: { playerId: string; position: number }[]) =>
  [...players].sort((a, b) => a.position - b.position).map(({ playerId, position }) => [playerId, position]);

describe('Matchmaker.playPair', () => {
  it('starts a new table for a pair, partners at 0 and 2', async () => {
    const mm = matchmaker('pair-new');
    const placed = await mm.playPair('a', 'b');
    expect(placed.kind).toBe('seated');
    if (placed.kind !== 'seated') return;
    expect(placed.match.mode).toBe('live');
    expect(seatsOf(placed.match.players)).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
    expect((await entries(mm)).get(placed.match.id)?.seats).toEqual([
      { playerId: 'a', position: 0 },
      { playerId: 'b', position: 2 },
    ]);
  });

  it('seats a pair as the free team at a filling table', async () => {
    const mm = matchmaker('pair-filling');
    await matchStub('pair-filling-t').create('x', 'pair-filling-t', 'live');
    await index(mm, 'pair-filling-t');

    const placed = await mm.playPair('a', 'b');

    expect(placed.kind === 'seated' && placed.match.id).toBe('pair-filling-t');
    if (placed.kind !== 'seated') return;
    expect(seatsOf(placed.match.players)).toEqual([
      ['x', 0],
      ['a', 1],
      ['b', 3],
    ]);
  });

  it('starts a new table rather than split a pair across teams', async () => {
    const mm = matchmaker('pair-split');
    await matchStub('pair-split-t').create('x', 'pair-split-t', 'live');
    await matchStub('pair-split-t').takeSeat('y', 1);
    await index(mm, 'pair-split-t');

    const placed = await mm.playPair('a', 'b');

    expect(placed.kind).toBe('seated');
    if (placed.kind !== 'seated') return;
    expect(placed.match.id).not.toBe('pair-split-t');
    expect(seatsOf(placed.match.players)).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
  });

  it('returns the same table when a pair is placed twice', async () => {
    const mm = matchmaker('pair-again');
    const first = await mm.playPair('a', 'b');
    const again = await mm.playPair('a', 'b');
    expect(first.kind === 'seated' && again.kind === 'seated' && again.match.id).toBe(
      first.kind === 'seated' && first.match.id
    );
  });

  it('says who is already at a Live table and seats neither', async () => {
    const mm = matchmaker('pair-busy');
    const held = await mm.play('a', 'live');

    const placed = await mm.playPair('a', 'b');

    expect(placed).toEqual({ kind: 'busy', playerIds: ['a'] });
    const seated = [...(await entries(mm)).values()].filter((e) => e.seats.some((s) => s.playerId === 'b'));
    expect(seated).toEqual([]);
    const table = await matchStub(held.id).getMatch();
    expect(table.ok && table.value.players.map((p) => p.playerId)).toEqual(['a']);
  });

  it('claims a team of two bots in a Live game under way', async () => {
    const mm = matchmaker('pair-claim');
    const started = await mm.play('p1', 'live');
    await matchStub(started.id).addBots('p1');
    await index(mm, started.id);

    const placed = await mm.playPair('a', 'b');

    expect(placed.kind === 'seated' && placed.match.id).toBe(started.id);
    if (placed.kind !== 'seated') return;
    expect(placed.match.claims).toEqual(['a', 'b']);
    expect(placed.match.claimPositions).toEqual({ a: 1, b: 3 });
  });
});

describe('Matchmaker.liveBusy', () => {
  it('names the players at a Live table', async () => {
    const mm = matchmaker('busy-some');
    await mm.play('a', 'live');
    expect(await mm.liveBusy(['a', 'c'])).toEqual(['a']);
  });

  it('leaves out the table it is told to', async () => {
    const mm = matchmaker('busy-except');
    const table = await mm.play('a', 'live');
    expect(await mm.liveBusy(['a'], table.id)).toEqual([]);
  });
});
