import { describe, expect, it } from 'vitest';
import { mergeNames, missingIds, nameText, playerName, type NameLookup } from './playerNames';

const players = [
  { playerId: 'p1', position: 0 },
  { playerId: 'p2', position: 1 },
  { playerId: 'p3', position: 2 },
];
const lookup = (over: Partial<NameLookup> = {}): NameLookup => ({
  myPlayerId: 'p1',
  players,
  names: new Map([['p2', 'Bob']]),
  settled: true,
  failed: false,
  ...over,
});

describe('playerName', () => {
  it('calls the viewer You, whatever the lookup says', () => {
    expect(playerName('p1', lookup({ names: undefined, settled: false }))).toEqual({ status: 'loaded', name: 'You' });
  });

  it('uses a looked-up name', () => {
    expect(playerName('p2', lookup())).toEqual({ status: 'loaded', name: 'Bob' });
  });

  it('waits while the lookup for this player is still out', () => {
    expect(playerName('p3', lookup({ settled: false }))).toEqual({ status: 'loading' });
  });

  it('falls back to the seat, never the id, once the lookup came back without them', () => {
    expect(playerName('p3', lookup())).toEqual({ status: 'failed', name: 'Player 3' });
  });

  it('falls back to the seat when the lookup failed', () => {
    expect(playerName('p3', lookup({ settled: false, failed: true }))).toEqual({ status: 'failed', name: 'Player 3' });
  });

  it('keeps a known name even when the latest lookup failed', () => {
    expect(playerName('p2', lookup({ settled: false, failed: true }))).toEqual({ status: 'loaded', name: 'Bob' });
  });

  it('calls someone not seated "A player"', () => {
    expect(playerName('gone', lookup())).toEqual({ status: 'failed', name: 'A player' });
  });
});

describe('nameText', () => {
  it('is the name, the fallback, or null while loading', () => {
    expect(nameText({ status: 'loaded', name: 'Bob' })).toBe('Bob');
    expect(nameText({ status: 'failed', name: 'Player 3' })).toBe('Player 3');
    expect(nameText({ status: 'loading' })).toBeNull();
  });
});

describe('missingIds / mergeNames', () => {
  it('finds the ids not looked up yet', () => {
    expect(missingIds(['p2', 'p3'], new Map([['p2', 'Bob']]))).toEqual(['p3']);
  });

  it('merges lookups, later ones winning, skipping missing ones', () => {
    const merged = mergeNames(new Map([['p2', 'Bob']]), undefined, new Map([['p2', 'Bobby'], ['p3', 'Cy']]));
    expect([...merged]).toEqual([['p2', 'Bobby'], ['p3', 'Cy']]);
  });
});
