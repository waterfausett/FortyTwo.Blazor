import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Bid, Suit, Teams, createDomino, type Game, type MatchState } from '@fortytwo/rules';
import { endChoices } from '@fortytwo/client';
import { MatchSummary } from '../MatchSummary';
import { profileErrors } from '../profileErrors';

describe('profileErrors', () => {
  it('accepts a name and an https picture, or a blank picture', () => {
    expect(profileErrors('Ann', 'https://example.com/me.png')).toEqual([]);
    expect(profileErrors('Ann', '')).toEqual([]);
  });

  it('rejects a blank or over-long name and a non-https picture', () => {
    expect(profileErrors('   ', '')).toEqual(['Enter a display name.']);
    expect(profileErrors('x'.repeat(51), '')).toEqual(['Keep the display name to 50 characters.']);
    expect(profileErrors('Ann', 'http://example.com/me.png')).toHaveLength(1);
    expect(profileErrors('Ann', 'javascript:alert(1)')).toHaveLength(1);
  });
});

describe('MatchSummary', () => {
  const game = (n: number, biddingPlayerId: string, bid: Bid, bidderTeam: Teams): Game =>
    ({
      id: `g${n}`,
      name: `Game ${n}`,
      bid,
      biddingPlayerId,
      trump: Suit.Sixes,
      hands: [{ playerId: biddingPlayerId, team: bidderTeam, dominoes: [], bid }],
      tricks: [],
    }) as unknown as Game;

  // Team A (p1 & p3) won hand 1 on p1's bid and set p2's 84 in hand 2; Team B made hand 3.
  const match = {
    id: 'm1',
    winningTeam: Teams.TeamA,
    players: [
      { playerId: 'p1', position: 0, ready: false },
      { playerId: 'p2', position: 1, ready: false },
      { playerId: 'p3', position: 2, ready: false },
      { playerId: 'p4', position: 3, ready: false },
    ],
    games: {
      [Teams.TeamA]: [game(1, 'p1', Bid.Thirty, Teams.TeamA), game(2, 'p2', Bid.EightyFour, Teams.TeamB)],
      [Teams.TeamB]: [game(3, 'p4', Bid.ThirtyTwo, Teams.TeamB)],
    },
    rematchVotes: [],
  } as unknown as MatchState;
  const names: Record<string, string> = { p1: 'You', p2: 'Bo', p3: 'Cy', p4: 'Di' };

  async function show(overrides: Partial<Parameters<typeof MatchSummary>[0]> = {}) {
    const props = {
      visible: true,
      match,
      myPlayerId: 'p1',
      myTeam: Teams.TeamA,
      nameFor: (id: string | null) => (id ? names[id] : ''),
      iVoted: false,
      rematchDisabled: false,
      onRematch: jest.fn(),
      onGoToRematch: jest.fn(),
      onLobby: jest.fn(),
      onClose: jest.fn(),
      ...overrides,
    };
    // The app gets this from Expo Router.
    const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <MatchSummary {...props} />
      </SafeAreaProvider>
    );
    return props;
  }

  it('opens a hand to show the dominoes I held, my bid and trump', async () => {
    const held = [[6, 6], [5, 5], [0, 5], [1, 4], [2, 3], [1, 1], [0, 0]].map(([a, b]) => createDomino(a, b));
    const first = game(1, 'p1', Bid.Thirty, Teams.TeamA);
    first.hands[0].dominoes = held;
    await show({ match: { ...match, games: { [Teams.TeamA]: [first] } } });

    expect(screen.queryByLabelText(/^Your hand/)).toBeNull();
    await fireEvent.press(screen.getByLabelText('Game 1: You bid 30, made, 1 mark'));
    expect(screen.getByLabelText('Your hand: 6/6, 5/5, 0/5, 1/4, 2/3, 1/1, 0/0')).toBeTruthy();
    expect(screen.getByText('You bid 30 · Sixes trump')).toBeTruthy();

    await fireEvent.press(screen.getByLabelText('Game 1: You bid 30, made, 1 mark'));
    expect(screen.queryByLabelText(/^Your hand/)).toBeNull();
  });

  it("says so when I wasn't at the table for a hand", async () => {
    await show({ myPlayerId: 'newcomer' });
    await fireEvent.press(screen.getByLabelText('Game 3: Di bid 32, made, 1 mark'));
    expect(screen.getByText("You weren't at the table for this hand.")).toBeTruthy();
  });

  it('shows the winner, both teams with their marks, and every hand in order', async () => {
    await show();
    expect(screen.getByText('You won the match')).toBeTruthy();
    // Team A took 1 + 2 marks (a set 84 scores its 2 marks for the defenders); Team B took 1.
    expect(screen.getByLabelText('Us: You & Cy, 3 marks')).toBeTruthy();
    expect(screen.getByLabelText('Them: Bo & Di, 1 marks')).toBeTruthy();
    expect(screen.getAllByText(/^Game \d$/).map((t) => t.props.children)).toEqual(['Game 1', 'Game 2', 'Game 3']);
    expect(screen.getByLabelText('Game 2: Bo bid 84, set, 2 marks')).toBeTruthy();
  });

  it('asks for a rematch, and shows the count once someone has', async () => {
    const props = await show();
    await fireEvent.press(screen.getByText('Rematch'));
    expect(props.onRematch).toHaveBeenCalled();
  });

  it('offers the way to the rematch once it exists, and back to the lobby', async () => {
    const props = await show({ match: { ...match, rematchId: 'm2' } });
    await fireEvent.press(screen.getByText('Go to rematch'));
    expect(props.onGoToRematch).toHaveBeenCalled();
    await fireEvent.press(screen.getByText('Back to lobby'));
    expect(props.onLobby).toHaveBeenCalled();
  });
  it('shows the match so far before it is over, with the marks to win and no way on', async () => {
    await show({ match: { ...match, winningTeam: null } });
    expect(screen.getByText('The match so far')).toBeTruthy();
    expect(screen.getByText('First to 7 marks')).toBeTruthy();
    expect(screen.getAllByText(/^Game \d$/)).toHaveLength(3);
    expect(screen.queryByText('Rematch')).toBeNull();
    expect(screen.queryByText('Back to lobby')).toBeNull();
  });

  it('says so when no hand has been decided yet', async () => {
    await show({ match: { ...match, winningTeam: null, games: {} } });
    expect(screen.getByText('No hands decided yet.')).toBeTruthy();
  });
});

describe('MatchSummary at the end of a Live game', () => {
  const players = (ids: string[]) => ids.map((playerId, position) => ({ playerId, position, ready: false }));
  const finished = (mode: string, ids = ['p1', 'p2', 'p3', 'p4']) =>
    ({
      id: 'm1',
      mode,
      winningTeam: Teams.TeamA,
      players: players(ids),
      games: { [Teams.TeamA]: [], [Teams.TeamB]: [] },
      rematchVotes: [],
      wonOn: new Date().toISOString(),
    }) as unknown as MatchState;
  const names: Record<string, string> = { p1: 'You', p2: 'Bo', p3: 'Cy', p4: 'Di' };

  // What the match screen passes: the Live choices only for a Live match.
  async function show(match: MatchState) {
    const choices = endChoices(match, 'p1', Date.now());
    const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <MatchSummary
          visible
          match={match}
          myPlayerId="p1"
          myTeam={Teams.TeamA}
          nameFor={(id) => (id ? (names[id] ?? id) : '')}
          iVoted={false}
          rematchDisabled={false}
          onRematch={jest.fn()}
          onGoToRematch={jest.fn()}
          onLobby={jest.fn()}
          onClose={jest.fn()}
          live={
            choices.live
              ? {
                  choices,
                  partnerName: choices.partnerId ? (names[choices.partnerId] ?? choices.partnerId) : '',
                  busy: false,
                  pending: false,
                  onPartyUp: jest.fn(),
                  onCancelParty: jest.fn(),
                  onFindGame: jest.fn(),
                }
              : undefined
          }
        />
      </SafeAreaProvider>
    );
  }

  it('offers Party up with the partner, Find a game and Rematch after a won Live match', async () => {
    await show(finished('live'));
    expect(screen.getByText('Party up with Cy')).toBeTruthy();
    expect(screen.getByText('Find a game')).toBeTruthy();
    expect(screen.getByText('Rematch')).toBeTruthy();
    expect(screen.getByText('Back to lobby')).toBeTruthy();
  });

  it('hides Party up when the partner is a bot', async () => {
    await show(finished('live', ['p1', 'p2', 'm1_bot-1', 'p4']));
    expect(screen.queryByText(/Party up with/)).toBeNull();
    expect(screen.getByText('Find a game')).toBeTruthy();
    expect(screen.getByText(/^Rematch/)).toBeTruthy();
  });

  // Find a game takes me back to the party's game while it's still going, so there's no link to it.
  it('offers only Find a game once my team has partied up', async () => {
    await show({ ...finished('live'), partyMatchIds: { [Teams.TeamA]: 'm2' } } as MatchState);
    expect(screen.queryByText('Go to your new game')).toBeNull();
    expect(screen.getByText('Find a game')).toBeTruthy();
    expect(screen.queryByText(/^Rematch/)).toBeNull();
    expect(screen.getByText('Back to lobby')).toBeTruthy();
  });

  it('offers only Find a game once the rematch is made', async () => {
    await show({ ...finished('live'), rematchId: 'm3' } as MatchState);
    expect(screen.queryByText(/Party up with/)).toBeNull();
    expect(screen.queryByText('Go to rematch')).toBeNull();
    expect(screen.getByText('Find a game')).toBeTruthy();
  });

  it('offers only the way back to the lobby for a Live game ended long ago', async () => {
    await show({ ...finished('live'), wonOn: new Date(Date.now() - 60 * 60_000).toISOString() } as MatchState);
    expect(screen.queryByText(/Party up with/)).toBeNull();
    expect(screen.queryByText('Find a game')).toBeNull();
    expect(screen.queryByText(/Rematch/)).toBeNull();
    expect(screen.getByText('Back to lobby')).toBeTruthy();
  });

  it('leaves a won Daily match with only Rematch', async () => {
    await show(finished('daily'));
    expect(screen.queryByText(/Party up with/)).toBeNull();
    expect(screen.queryByText('Find a game')).toBeNull();
    expect(screen.getByText('Rematch')).toBeTruthy();
  });
});
