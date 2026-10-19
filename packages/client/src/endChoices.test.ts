import { describe, expect, it } from 'vitest';
import { Teams, type MatchState } from '@fortytwo/rules';
import { LIVE_END_CHOICES_MS, endChoices } from './endChoices';

const WON_AT = Date.parse('2026-10-19T12:00:00.000Z');

// Seats 0 and 2 are one team, 1 and 3 the other. 'me' and 'sam' are partners.
function finished(overrides: Partial<MatchState> = {}): MatchState {
  return {
    mode: 'live',
    winningTeam: Teams.TeamA,
    wonOn: new Date(WON_AT).toISOString(),
    players: [
      { playerId: 'me', position: 0 },
      { playerId: 'foe1', position: 1 },
      { playerId: 'sam', position: 2 },
      { playerId: 'foe2', position: 3 },
    ],
    ...overrides,
  } as unknown as MatchState;
}

// The screen opened a moment after the game ended, unless a test says otherwise.
function choicesFor(match: MatchState, playerId: string, openedAt = WON_AT + 1000) {
  return endChoices(match, playerId, openedAt);
}

describe('endChoices', () => {
  it('is not Live for a daily match, with nothing to party up with', () => {
    const choices = choicesFor(finished({ mode: 'daily' }), 'me');
    expect(choices.live).toBe(false);
    expect(choices.party).toEqual({ kind: 'hidden' });
    expect(choices.rematchDisabled).toBe(false);
  });

  it('offers to party up with the partner', () => {
    const choices = choicesFor(finished(), 'me');
    expect(choices.live).toBe(true);
    expect(choices.partnerId).toBe('sam');
    expect(choices.party).toEqual({ kind: 'offer', partnerOffered: false });
    expect(choices.rematchDisabled).toBe(false);
    expect(choices.iAmBusy).toBe(false);
  });

  it("shows that the partner's offer is waiting", () => {
    expect(choicesFor(finished({ partyOffers: ['sam'] }), 'me').party).toEqual({
      kind: 'offer',
      partnerOffered: true,
    });
  });

  it('waits once my own offer stands, and rematch is disabled', () => {
    const choices = choicesFor(finished({ partyOffers: ['me'] }), 'me');
    expect(choices.party).toEqual({ kind: 'waiting' });
    expect(choices.rematchDisabled).toBe(true);
  });

  it('hides the button while the match is still being played', () => {
    expect(choicesFor(finished({ winningTeam: null }), 'me').party).toEqual({ kind: 'hidden' });
  });

  it('hides the button for a viewer who is not seated', () => {
    const choices = choicesFor(finished(), 'stranger');
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
    expect(choicesFor(match, 'me').party).toEqual({ kind: 'hidden' });
  });

  it('hides the button once I have moved on', () => {
    const choices = choicesFor(finished({ movedOn: { me: 'left' } }), 'me');
    expect(choices.party).toEqual({ kind: 'hidden' });
    expect(choices.rematchDisabled).toBe(true);
  });

  it('says the partner left, whether they moved on or lapsed away', () => {
    expect(choicesFor(finished({ movedOn: { sam: 'left' } }), 'me').party).toEqual({ kind: 'partnerLeft' });
    expect(choicesFor(finished({ away: ['sam'] }), 'me').party).toEqual({ kind: 'partnerLeft' });
  });

  it('says the partner is in another game', () => {
    expect(choicesFor(finished({ movedOn: { sam: 'busy' } }), 'me').party).toEqual({ kind: 'partnerBusy' });
  });

  // No link to the party's game, which may since have finished or been dropped: Find a game takes
  // me back to it while it's still going.
  it('offers only Find a game once my team has partied up', () => {
    const choices = choicesFor(finished({ partyMatchIds: { [Teams.TeamA]: 'm2' }, partyOffers: ['me'] }), 'me');
    expect(choices.party).toEqual({ kind: 'hidden' });
    expect(choices.showFindGame).toBe(true);
    expect(choices.showRematch).toBe(false);
  });

  it('offers only Find a game once a Live rematch is made, but keeps the rematch elsewhere', () => {
    const live = choicesFor(finished({ rematchId: 'r1' }), 'me');
    expect(live.showFindGame).toBe(true);
    expect(live.showRematch).toBe(false);
    expect(choicesFor(finished({ mode: 'daily', rematchId: 'r1' }), 'me').showRematch).toBe(true);
  });

  it('offers Find a game and Rematch until then', () => {
    const choices = choicesFor(finished(), 'me');
    expect(choices.showFindGame).toBe(true);
    expect(choices.showRematch).toBe(true);
  });

  // The rematch already seats all four together, partners included.
  it('hides Party up once the rematch is made', () => {
    expect(choicesFor(finished({ rematchId: 'r1' }), 'me').party).toEqual({ kind: 'hidden' });
  });

  it("ignores the other team's party when it is not mine", () => {
    const match = finished({ partyMatchIds: { [Teams.TeamB]: 'm2' } });
    expect(choicesFor(match, 'me').party).toEqual({ kind: 'offer', partnerOffered: false });
    expect(choicesFor(match, 'me').rematchDisabled).toBe(true);
  });

  it('disables rematch when someone has left', () => {
    expect(choicesFor(finished({ movedOn: { foe1: 'left' } }), 'me').rematchDisabled).toBe(true);
  });

  it('tells a viewer who is busy elsewhere', () => {
    expect(choicesFor(finished({ movedOn: { me: 'busy' } }), 'me').iAmBusy).toBe(true);
    expect(choicesFor(finished({ movedOn: { me: 'left' } }), 'me').iAmBusy).toBe(false);
  });

  describe('opened after the moment', () => {
    it('offers everything up to five minutes after the game ended', () => {
      const choices = choicesFor(finished(), 'me', WON_AT + LIVE_END_CHOICES_MS - 1);
      expect(choices.expired).toBe(false);
      expect(choices.party).toEqual({ kind: 'offer', partnerOffered: false });
    });

    it('offers nothing once five minutes have passed', () => {
      const choices = choicesFor(finished({ partyOffers: ['sam'] }), 'me', WON_AT + LIVE_END_CHOICES_MS);
      expect(choices.expired).toBe(true);
      expect(choices.party).toEqual({ kind: 'hidden' });
      expect(choices.showFindGame).toBe(false);
      expect(choices.showRematch).toBe(false);
    });

    // The screen was already open when the game ended.
    it('offers everything when the game ended after the screen opened', () => {
      expect(choicesFor(finished(), 'me', WON_AT - 60 * 60_000).expired).toBe(false);
    });

    it('offers nothing for a Live game won before the time was recorded', () => {
      expect(choicesFor(finished({ wonOn: undefined }), 'me').expired).toBe(true);
    });

    it('never expires another mode', () => {
      const choices = choicesFor(finished({ mode: 'daily', wonOn: undefined }), 'me', WON_AT + 24 * 60 * 60_000);
      expect(choices.expired).toBe(false);
      expect(choices.showRematch).toBe(true);
    });
  });
});
