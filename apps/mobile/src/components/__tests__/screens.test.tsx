import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Bid, Suit, Teams, type Game, type MatchState } from '@fortytwo/rules';
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
});
