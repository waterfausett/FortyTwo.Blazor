import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Bid, Teams, createDomino, type Game, type Trick } from '@fortytwo/rules';
import { BiddingPanel } from '../BiddingPanel';
import { Hand, isInside, moveBefore, reconcileOrder } from '../Hand';
import { JoinMatchPanel } from '../JoinMatchPanel';
import { SeatPicker } from '../SeatPicker';
import { PENDING_SPINNER_DELAY_MS, Table, type SeatInfo } from '../Table';
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
    await fireEvent.press(screen.getByLabelText('1-2'));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('with highlighting off (the default), lets any domino be tapped and leaves the rules to the caller', async () => {
    const onPlay = jest.fn();
    await render(<Hand dominoes={dominoes} canPlay isValidPlay={(d) => d.top === 6} onPlay={onPlay} />);

    await fireEvent.press(screen.getByLabelText('1-2'));
    expect(onPlay).toHaveBeenCalledWith(dominoes[1]);
  });

  it('hides a domino on its way to the table, and puts it back in its place if the play is refused', async () => {
    const three = [createDomino(6, 6), createDomino(1, 2), createDomino(3, 4)];
    const hand = (playingId: string | null) => (
      <Hand dominoes={three} canPlay isValidPlay={() => true} onPlay={jest.fn()} playingId={playingId} />
    );
    const { rerender } = await render(hand(three[0].id));
    expect(screen.queryByLabelText('6-6')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.props.accessibilityLabel)).toEqual(['1-2', '3-4']);

    await rerender(hand(null));
    expect(screen.getAllByRole('button').map((b) => b.props.accessibilityLabel)).toEqual(['6-6', '1-2', '3-4']);
  });

  it('takes no room once empty', async () => {
    await render(<Hand dominoes={[]} canPlay={false} isValidPlay={() => true} onPlay={jest.fn()} />);
    expect(StyleSheet.flatten(screen.getByLabelText('Your hand').props.style).minHeight).toBeUndefined();
  });

  it("can't be played from when it isn't the player's turn, but can still be picked up to reorder", async () => {
    const onPlay = jest.fn();
    const onDragChange = jest.fn();
    await render(
      <Hand dominoes={dominoes} canPlay={false} isValidPlay={() => true} onPlay={onPlay} dropZone={{ current: null }} onDragChange={onDragChange} />
    );
    await fireEvent.press(screen.getByLabelText('6-6'));
    expect(onPlay).not.toHaveBeenCalled();
    await fireEvent(screen.getByLabelText('6-6'), 'longPress');
    expect(onDragChange).toHaveBeenCalledWith({ dragging: true, overDropZone: false });
  });

  it('picks a domino up for dragging when it is held', async () => {
    const onDragChange = jest.fn();
    await render(
      <Hand dominoes={dominoes} canPlay isValidPlay={() => true} onPlay={jest.fn()} dropZone={{ current: null }} onDragChange={onDragChange} />
    );
    await fireEvent(screen.getByLabelText('6-6'), 'longPress');
    expect(onDragChange).toHaveBeenCalledWith({ dragging: true, overDropZone: false });
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

  it('shows placeholders, not names, for taken seats while names load', async () => {
    await render(<SeatPicker seats={['', null, null, null]} loading disabled={false} onPick={jest.fn()} />);
    expect(screen.getAllByLabelText('Loading name').length).toBeGreaterThan(0);
  });
});

describe('Table', () => {
  const seat = (name: string, dominoCount: number | null, overrides: Partial<SeatInfo> = {}): SeatInfo => ({
    name,
    side: 'them',
    isActive: false,
    isDealer: false,
    bid: null,
    isHighBidder: false,
    trump: null,
    ready: null,
    dominoCount,
    ...overrides,
  });

  it('seats everyone on the felt, with a face-down tile for each domino another player holds', async () => {
    await render(
      <Table
        seats={{
          bottom: seat('You', null, { side: 'us' }),
          left: seat('Ann', 7),
          top: seat('Bo', 6, { side: 'us', isActive: true }),
          right: null,
        }}
        trick={null}
        slotSeats={[null, null, null, null]}
        winningSlot={null}
      />,
    );

    expect(screen.getByLabelText('Table')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByLabelText('7 dominoes')).toBeTruthy();
    expect(screen.getByLabelText('6 dominoes')).toBeTruthy();
    expect(screen.getByLabelText('Bo, to act')).toBeTruthy();
    expect(screen.getByText('Open seat')).toBeTruthy();
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

describe('isInside', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };

  it('is true inside the rectangle, edges included, and false outside or without one', () => {
    expect(isInside(10, 20, rect)).toBe(true);
    expect(isInside(110, 70, rect)).toBe(true);
    expect(isInside(9, 40, rect)).toBe(false);
    expect(isInside(50, 71, rect)).toBe(false);
    expect(isInside(50, 40, null)).toBe(false);
  });
});

describe('hand order', () => {
  it('moves a domino to where another one is', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveBefore(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveBefore(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });

  it("keeps the player's arrangement across a play, and adds a new deal in the order dealt", () => {
    const d = (id: string) => ({ id }) as never;
    expect(reconcileOrder(['c', 'a', 'b'], [d('a'), d('b'), d('c')].filter((x: { id: string }) => x.id !== 'a'))).toEqual(['c', 'b']);
    expect(reconcileOrder(['c', 'b'], [d('x'), d('y')])).toEqual(['x', 'y']);
  });
});

describe('JoinMatchPanel', () => {
  it('offers the open seats, saying who each would partner, and takes the one picked', async () => {
    const onPick = jest.fn();
    await render(<JoinMatchPanel seats={['Ann', 'Bo', null, 'Di']} joining={false} onPick={onPick} onLobby={jest.fn()} />);

    expect(screen.getByText('Pick a seat to join')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Sit here, with Ann'));
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it('says when the match is full, with the way back', async () => {
    const onLobby = jest.fn();
    await render(<JoinMatchPanel seats={['Ann', 'Bo', 'Cy', 'Di']} joining={false} onPick={jest.fn()} onLobby={onLobby} />);

    expect(screen.getByText('This match is full')).toBeTruthy();
    expect(screen.queryByText('Sit here')).toBeNull();
    await fireEvent.press(screen.getByText('Back to matches'));
    expect(onLobby).toHaveBeenCalled();
  });
});

describe('Table', () => {
  const seats = { top: null, left: null, right: null, bottom: null };
  const slotSeats = ['left', 'bottom', null, null] as const;

  it('shows a spinner on my unconfirmed play once it has waited a moment', async () => {
    jest.useFakeTimers();
    try {
      const mine = createDomino(4, 5);
      const trick: Trick = { playerId: null, team: null, suit: null, dominoes: [createDomino(1, 2), mine, null, null] };
      await render(<Table seats={seats} trick={trick} slotSeats={[...slotSeats]} winningSlot={null} pendingId={mine.id} />);

      // A play that lands promptly never flashes the spinner.
      expect(screen.queryByLabelText('Sending your play')).toBeNull();
      await act(() => jest.advanceTimersByTime(PENDING_SPINNER_DELAY_MS - 1));
      expect(screen.queryByLabelText('Sending your play')).toBeNull();
      await act(() => jest.advanceTimersByTime(1));
      expect(screen.getByLabelText('Sending your play')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows no spinner when nothing is pending', async () => {
    jest.useFakeTimers();
    try {
      const trick: Trick = { playerId: null, team: null, suit: null, dominoes: [createDomino(1, 2), createDomino(4, 5), null, null] };
      await render(<Table seats={seats} trick={trick} slotSeats={[...slotSeats]} winningSlot={null} />);

      await act(() => jest.advanceTimersByTime(PENDING_SPINNER_DELAY_MS));
      expect(screen.queryByLabelText('Sending your play')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
