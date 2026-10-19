import { describe, expect, it } from 'vitest';
import { Teams, type MatchState } from '@fortytwo/rules';
import { endChoices } from './endChoices';

// Seats 0 and 2 are one team, 1 and 3 the other. 'me' and 'sam' are partners.
function finished(overrides: Partial<MatchState> = {}): MatchState {
  return {
    mode: 'live',
    winningTeam: Teams.TeamA,
    players: [
      { playerId: 'me', position: 0 },
      { playerId: 'foe1', position: 1 },
      { playerId: 'sam', position: 2 },
      { playerId: 'foe2', position: 3 },
    ],
    ...overrides,
  } as unknown as MatchState;
}

describe('endChoices', () => {
  it('is not Live for a daily match, with nothing to party up with', () => {
    const choices = endChoices(finished({ mode: 'daily' }), 'me');
    expect(choices.live).toBe(false);
    expect(choices.party).toEqual({ kind: 'hidden' });
    expect(choices.rematchDisabled).toBe(false);
  });

  it('offers to party up with the partner', () => {
    const choices = endChoices(finished(), 'me');
    expect(choices.live).toBe(true);
    expect(choices.partnerId).toBe('sam');
    expect(choices.party).toEqual({ kind: 'offer', partnerOffered: false });
    expect(choices.rematchDisabled).toBe(false);
    expect(choices.iAmBusy).toBe(false);
  });

  it("shows that the partner's offer is waiting", () => {
    expect(endChoices(finished({ partyOffers: ['sam'] }), 'me').party).toEqual({
      kind: 'offer',
      partnerOffered: true,
    });
  });

  it('waits once my own offer stands, and rematch is disabled', () => {
    const choices = endChoices(finished({ partyOffers: ['me'] }), 'me');
    expect(choices.party).toEqual({ kind: 'waiting' });
    expect(choices.rematchDisabled).toBe(true);
  });

  it('hides the button while the match is still being played', () => {
    expect(endChoices(finished({ winningTeam: null }), 'me').party).toEqual({ kind: 'hidden' });
  });

  it('hides the button for a viewer who is not seated', () => {
    const choices = endChoices(finished(), 'stranger');
    expect(choices.party).toEqual({ kind: 'hidden' });
    expect(choices.partnerId).toBeNull();
  });

  it('hides the button when the partner is a bot', () => {
    const match = finished({
      players: [
        { playerId: 'me', position: 0 },
        { playerId: 'foe1', position: 1 },
        { playerId: 'abc_bot-1', position: 2 },
        { playerId: 'foe2', position: 3 },
      ],
    } as unknown as Partial<MatchState>);
    expect(endChoices(match, 'me').party).toEqual({ kind: 'hidden' });
  });

  it('hides the button once I have moved on', () => {
    const choices = endChoices(finished({ movedOn: { me: 'left' } }), 'me');
    expect(choices.party).toEqual({ kind: 'hidden' });
    expect(choices.rematchDisabled).toBe(true);
  });

  it('says the partner left, whether they moved on or lapsed away', () => {
    expect(endChoices(finished({ movedOn: { sam: 'left' } }), 'me').party).toEqual({ kind: 'partnerLeft' });
    expect(endChoices(finished({ away: ['sam'] }), 'me').party).toEqual({ kind: 'partnerLeft' });
  });

  it('says the partner is in another game', () => {
    expect(endChoices(finished({ movedOn: { sam: 'busy' } }), 'me').party).toEqual({ kind: 'partnerBusy' });
  });

  it('links to the new game once my team has partied up', () => {
    const match = finished({ partyMatchIds: { [Teams.TeamA]: 'm2' }, partyOffers: ['me'] });
    expect(endChoices(match, 'me').party).toEqual({ kind: 'partied', matchId: 'm2' });
  });

  it("ignores the other team's party when it is not mine", () => {
    const match = finished({ partyMatchIds: { [Teams.TeamB]: 'm2' } });
    expect(endChoices(match, 'me').party).toEqual({ kind: 'offer', partnerOffered: false });
    expect(endChoices(match, 'me').rematchDisabled).toBe(true);
  });

  it('disables rematch when someone has left', () => {
    expect(endChoices(finished({ movedOn: { foe1: 'left' } }), 'me').rematchDisabled).toBe(true);
  });

  it('tells a viewer who is busy elsewhere', () => {
    expect(endChoices(finished({ movedOn: { me: 'busy' } }), 'me').iAmBusy).toBe(true);
    expect(endChoices(finished({ movedOn: { me: 'left' } }), 'me').iAmBusy).toBe(false);
  });
});
