import { describe, it, expect } from 'vitest';
import { ValidationError } from './errors';
import { mintBotId } from './botIds';
import { Positions } from './positions';
import { Teams } from './teams';
import type { MatchState } from './matchEngine';
import {
  cancelParty,
  moveOn,
  offerParty,
  partnerOf,
  partyAgreed,
  recordParty,
  rematchBlocked,
  setAway,
} from './party';

// A won Live match with p1/p3 on TeamA and p2/p4 on TeamB.
function wonLive(overrides: Partial<MatchState> = {}): MatchState {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  return {
    id: 'm1',
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: '2026-01-01T00:00:00.000Z',
    winningTeam: Teams.TeamA,
    games: {},
    mode: 'live',
    players: ids.map((playerId, position) => ({ playerId, position: position as Positions, ready: false })),
    currentGame: {
      id: 'g9',
      name: 'Game 9',
      firstActionBy: 'p1',
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: 'p1',
      hands: ids.map((playerId, position) => ({
        playerId,
        team: position % 2 === 0 ? Teams.TeamA : Teams.TeamB,
        dominoes: [],
        bid: null,
      })),
      currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
      tricks: [],
    },
    ...overrides,
  };
}

describe('partnerOf', () => {
  it('is the other seat on the team', () => {
    expect(partnerOf(wonLive(), 'p1')).toBe('p3');
    expect(partnerOf(wonLive(), 'p2')).toBe('p4');
  });

  it('is null when the partner seat is empty', () => {
    const m = wonLive();
    expect(partnerOf({ ...m, players: m.players.filter((p) => p.playerId !== 'p3') }, 'p1')).toBeNull();
  });
});

describe('offerParty', () => {
  it('records the offer, drops the rematch vote, and is idempotent', () => {
    const m = offerParty(wonLive({ rematchVotes: ['p1', 'p2'] }), 'p1');
    expect(m.partyOffers).toEqual(['p1']);
    expect(m.rematchVotes).toEqual(['p2']);
    expect(offerParty(m, 'p1').partyOffers).toEqual(['p1']);
  });

  it('throws outside Live', () => {
    expect(() => offerParty(wonLive({ mode: 'custom' }), 'p1')).toThrow(ValidationError);
  });

  it('throws before the match is won', () => {
    expect(() => offerParty(wonLive({ winningTeam: null }), 'p1')).toThrow(ValidationError);
  });

  it('throws for someone not seated', () => {
    expect(() => offerParty(wonLive(), 'stranger')).toThrow(ValidationError);
  });

  it('throws when the partner is a bot', () => {
    const m = wonLive();
    const bot = mintBotId('m1', ['p1', 'p2', 'p4'])!;
    const botted = { ...m, players: m.players.map((p) => (p.position === 2 ? { ...p, playerId: bot } : p)) };
    expect(() => offerParty(botted, 'p1')).toThrow(ValidationError);
  });

  it('throws when the partner has moved on or is away', () => {
    expect(() => offerParty(wonLive({ movedOn: { p3: 'left' } }), 'p1')).toThrow(ValidationError);
    expect(() => offerParty(wonLive({ away: ['p3'] }), 'p1')).toThrow(ValidationError);
  });

  it('throws when the player has moved on', () => {
    expect(() => offerParty(wonLive({ movedOn: { p1: 'busy' } }), 'p1')).toThrow(ValidationError);
  });

  it('throws when the team already has a party match', () => {
    expect(() => offerParty(wonLive({ partyMatchIds: { [Teams.TeamA]: 'x' } }), 'p1')).toThrow(ValidationError);
  });
});

describe('cancelParty and partyAgreed', () => {
  it('cancels an offer', () => {
    expect(cancelParty(offerParty(wonLive(), 'p1'), 'p1').partyOffers).toEqual([]);
  });

  it('agrees only once both partners offered', () => {
    const one = offerParty(wonLive(), 'p1');
    expect(partyAgreed(one, 'p1')).toBe(false);
    expect(partyAgreed(offerParty(one, 'p3'), 'p1')).toBe(true);
  });
});

describe('moveOn', () => {
  it('removes the offer and vote and keeps the first reason', () => {
    const m = moveOn(offerParty(wonLive({ rematchVotes: ['p1'] }), 'p1'), 'p1', 'left');
    expect(m.partyOffers).toEqual([]);
    expect(m.rematchVotes).toEqual([]);
    expect(m.movedOn).toEqual({ p1: 'left' });
    expect(moveOn(m, 'p1', 'busy').movedOn).toEqual({ p1: 'left' });
  });
});

describe('setAway', () => {
  it('lists the player and removes their offer and vote, then unlists', () => {
    const m = setAway(offerParty(wonLive({ rematchVotes: ['p1'] }), 'p1'), 'p1', true);
    expect(m.away).toEqual(['p1']);
    expect(m.partyOffers).toEqual([]);
    expect(m.rematchVotes).toEqual([]);
    expect(setAway(m, 'p1', false).away).toEqual([]);
  });

  it('returns the same match when nothing changes', () => {
    const m = wonLive();
    expect(setAway(m, 'p1', false)).toBe(m);
    const away = setAway(m, 'p1', true);
    expect(setAway(away, 'p1', true)).toBe(away);
  });
});

describe('recordParty', () => {
  it("sets the id and clears both partners' offers", () => {
    const both = offerParty(offerParty(wonLive(), 'p1'), 'p3');
    const m = recordParty(both, Teams.TeamA, 'new');
    expect(m.partyMatchIds).toEqual({ [Teams.TeamA]: 'new' });
    expect(m.partyOffers).toEqual([]);
  });
});

describe('rematchBlocked', () => {
  it('is false for a fresh Live match', () => {
    expect(rematchBlocked(wonLive())).toBe(false);
  });

  it('is true once someone is away, has moved on, or a party match exists', () => {
    expect(rematchBlocked(wonLive({ away: ['p2'] }))).toBe(true);
    expect(rematchBlocked(wonLive({ movedOn: { p2: 'busy' } }))).toBe(true);
    expect(rematchBlocked(wonLive({ partyMatchIds: { [Teams.TeamB]: 'x' } }))).toBe(true);
  });

  it('is always false for daily', () => {
    const m = wonLive({
      mode: 'daily',
      away: ['p2'],
      movedOn: { p2: 'left' },
      partyMatchIds: { [Teams.TeamA]: 'x' },
    });
    expect(rematchBlocked(m)).toBe(false);
  });
});
