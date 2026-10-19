// A pair seated or claiming together at one Live table, against the real MatchDO: the Matchmaker's
// team calls change both seats in one update, or neither.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createDomino, type Domino } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

const seats = (players: { playerId: string; position: number }[]) =>
  [...players].sort((x, y) => x.position - y.position).map((p) => `${p.playerId}@${p.position}`);

describe('seating a pair in one update', () => {
  it('creates a Live table with the pair as partners', async () => {
    const stub = stubFor('pair-create');
    const placed = await stub.createTeamListed('a', 'b', 'pair-create');
    expect(placed.result.ok).toBe(true);
    const match = (await stub.getMatch());
    expect(match.ok && match.value.mode).toBe('live');
    expect(match.ok && seats(match.value.players)).toEqual(['a@0', 'b@2']);
    expect(placed.listing?.seats.map((s) => s.playerId)).toEqual(['a', 'b']);
  });

  it('seats a pair at a table with one player in it', async () => {
    const stub = stubFor('pair-take');
    await stub.createListed('x', 'pair-take', 'live');
    const placed = await stub.takeTeamListed('a', 'b', [1, 3], deck());
    expect(placed.result.ok).toBe(true);
    const match = await stub.getMatch();
    expect(match.ok && seats(match.value.players)).toEqual(['x@0', 'a@1', 'b@3']);
  });

  it('refuses the whole pair when one seat is taken', async () => {
    const stub = stubFor('pair-refused');
    await stub.createListed('x', 'pair-refused', 'live');
    await stub.takeSeat('y', 3);
    const placed = await stub.takeTeamListed('a', 'b', [1, 3], deck());
    expect(placed.result.ok).toBe(false);
    const match = await stub.getMatch();
    expect(match.ok && seats(match.value.players)).toEqual(['x@0', 'y@3']);
  });

  it('claims two pinned bot seats together', async () => {
    const stub = stubFor('pair-claim');
    await stub.create('p1', 'pair-claim', 'live');
    await stub.addBots('p1');
    const placed = await stub.claimTeamListed('a', 'b', [1, 3]);
    expect(placed.result.ok).toBe(true);
    const match = await stub.getMatch();
    expect(match.ok && match.value.claims).toEqual(['a', 'b']);
    expect(match.ok && match.value.claimPositions).toEqual({ a: 1, b: 3 });
  });
});
