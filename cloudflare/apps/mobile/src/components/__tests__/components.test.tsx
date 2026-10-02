import { fireEvent, render, screen } from '@testing-library/react-native';
import { Bid, Teams, createDomino, type Game, type Trick } from '@fortytwo/rules';
import { BiddingPanel } from '../BiddingPanel';
import { Hand } from '../Hand';
import { SeatPicker } from '../SeatPicker';
import { TrickHistory } from '../TrickHistory';

function biddingGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    name: 'Game 1',
    firstActionBy: 'p1',
    bid: null,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: 'p1',
    hands: [{ playerId: 'p1', team: 1, dominoes: [], bid: null }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
    ...overrides,
  } as Game;
}

describe('BiddingPanel', () => {
  it('offers Pass and the opening bids, and reports the one picked', async () => {
    const onBid = jest.fn();
    await render(<BiddingPanel game={biddingGame()} myPlayerId="p1" onBid={onBid} />);

    expect(screen.getByText('Pass')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
    await fireEvent.press(screen.getByText('31'));
    expect(onBid).toHaveBeenCalledWith(Bid.ThirtyOne);
  });

  it('only offers bids above the current high bid', async () => {
    await render(<BiddingPanel game={biddingGame({ bid: Bid.ThirtyFive, biddingPlayerId: 'p4' })} myPlayerId="p1" onBid={jest.fn()} />);
    expect(screen.queryByText('35')).toBeNull();
    expect(screen.getByText('36')).toBeTruthy();
  });
});

describe('Hand', () => {
  const dominoes = [createDomino(6, 6), createDomino(1, 2)];

  it('with highlighting on, plays a legal domino on tap and leaves an illegal one inert', async () => {
    const onPlay = jest.fn();
    await render(
      <Hand dominoes={dominoes} canPlay isValidPlay={(d) => d.top === 6} onPlay={onPlay} highlightPlayable />
    );

    await fireEvent.press(screen.getByLabelText('6-6'));
    expect(onPlay).toHaveBeenCalledWith(dominoes[0]);
    expect(screen.queryByRole('button', { name: '1-2' })).toBeNull();
  });

  it('with highlighting off (the default), lets any domino be tapped and leaves legality to the server', async () => {
    const onPlay = jest.fn();
    await render(<Hand dominoes={dominoes} canPlay isValidPlay={(d) => d.top === 6} onPlay={onPlay} />);

    await fireEvent.press(screen.getByLabelText('1-2'));
    expect(onPlay).toHaveBeenCalledWith(dominoes[1]);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it("can't be played from when it isn't the player's turn", async () => {
    await render(<Hand dominoes={dominoes} canPlay={false} isValidPlay={() => true} onPlay={jest.fn()} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('SeatPicker', () => {
  it('shows taken seats by name and says who an open seat partners with', async () => {
    const onPick = jest.fn();
    await render(<SeatPicker seats={['Ann', null, null, 'Di']} disabled={false} onPick={onPick} />);

    expect(screen.getByText('Ann')).toBeTruthy();
    // Seat 2 is across from Ann; seat 1 is across from Di.
    await fireEvent.press(screen.getByLabelText('Sit here, with Ann'));
    expect(onPick).toHaveBeenCalledWith(2);
    await fireEvent.press(screen.getByLabelText('Sit here, with Di'));
    expect(onPick).toHaveBeenCalledWith(1);
  });
});

describe('TrickHistory', () => {
  const trick = (team: Teams, ...pairs: [number, number][]): Trick => ({
    playerId: 'p1',
    team,
    suit: null,
    dominoes: pairs.map(([a, b]) => createDomino(a, b)),
  });

  it("shows each team's points, the bidders' target, and tricks newest first", async () => {
    const first = trick(Teams.TeamA, [0, 0], [0, 1], [0, 2], [0, 3]);
    const second = trick(Teams.TeamA, [5, 5], [1, 1], [1, 2], [1, 3]);
    await render(
      <TrickHistory
        us={{ label: 'Us', color: 'teal', tricks: [first, second], points: 12, target: 32 }}
        them={{ label: 'Them', color: 'orange', tricks: [], points: 0, target: null }}
        stacked={false}
      />
    );

    expect(screen.getByLabelText('Us tricks: 12 points')).toBeTruthy();
    expect(screen.getByText(' of 32')).toBeTruthy();
    expect(screen.getByText(' pts')).toBeTruthy();
    expect(screen.getByText('No tricks yet')).toBeTruthy();
    // Each trick's worth: its count plus one. The newer trick (with the 5-5) is listed first.
    const values = screen.getAllByText(/^\+\d+$/).map((t) => t.props.children.join(''));
    expect(values).toEqual(['+11', '+1']);
  });
});
