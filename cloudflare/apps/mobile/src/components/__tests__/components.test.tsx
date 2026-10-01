import { fireEvent, render, screen } from '@testing-library/react-native';
import { Bid, createDomino, type Game } from '@fortytwo/rules';
import { BiddingPanel } from '../BiddingPanel';
import { Hand } from '../Hand';
import { SeatPicker } from '../SeatPicker';

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

  it('plays a legal domino on tap and leaves an illegal one inert', async () => {
    const onPlay = jest.fn();
    await render(
      <Hand dominoes={dominoes} canPlay isValidPlay={(d) => d.top === 6} onPlay={onPlay} />
    );

    await fireEvent.press(screen.getByLabelText('6-6'));
    expect(onPlay).toHaveBeenCalledWith(dominoes[0]);
    expect(screen.queryByRole('button', { name: '1-2' })).toBeNull();
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
