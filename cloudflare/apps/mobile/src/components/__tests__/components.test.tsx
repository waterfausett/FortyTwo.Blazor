import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { Bid, DEFAULT_HOUSE_RULES, Teams, createDomino, type Game, type Trick } from '@fortytwo/rules';
import { BiddingPanel } from '../BiddingPanel';
import { Hand, isInside, moveBefore, reconcileOrder } from '../Hand';
import { HelpButton } from '../HelpButton';
import { HowToPlayCard } from '../HowToPlayCard';
import { HowToPlayContent } from '../HowToPlayContent';
import { JoinMatchPanel } from '../JoinMatchPanel';
import { NewMatchSheet, SLOW_MS } from '../NewMatchSheet';
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
    await render(<SeatPicker seats={['', null, null, null]} loading={[true, false, false, false]} disabled={false} onPick={jest.fn()} />);
    expect(screen.getAllByLabelText('Loading name').length).toBeGreaterThan(0);
  });

  it("keeps a loaded seat's name while another seat loads", async () => {
    await render(
      <SeatPicker seats={['Ann', '', null, 'Di']} loading={[false, true, false, false]} disabled={false} onPick={jest.fn()} />
    );
    expect(screen.getByText('Ann')).toBeTruthy();
    expect(screen.getAllByLabelText('Loading name')).toHaveLength(1);
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
    away: false,
    clock: null,
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

describe('Table seats on a Live clock', () => {
  it("shows a seat's Live clock and marks a player who's away", async () => {
    const seat = (name: string, overrides: Partial<SeatInfo> = {}): SeatInfo => ({
      name,
      side: 'them',
      isActive: false,
      isDealer: false,
      bid: null,
      isHighBidder: false,
      trump: null,
      ready: null,
      dominoCount: null,
      away: false,
      clock: null,
      ...overrides,
    });
    await render(
      <Table
        seats={{ bottom: seat('Me', { side: 'us', clock: '0:42' }), left: seat('Eli', { away: true }), top: null, right: null }}
        trick={null}
        slotSeats={[null, null, null, null]}
        winningSlot={null}
      />,
    );
    expect(screen.getByText('0:42')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
  });

  it('marks a paused seat as waiting', async () => {
    const seat: SeatInfo = {
      name: 'Eli',
      side: 'them',
      isActive: true,
      isDealer: false,
      bid: null,
      isHighBidder: false,
      trump: null,
      ready: null,
      dominoCount: 3,
      away: false,
      clock: '0:00',
      paused: true,
    };
    await render(
      <Table seats={{ bottom: null, left: seat, top: null, right: null }} trick={null} slotSeats={[null, null, null, null]} winningSlot={null} />,
    );
    expect(screen.getByText('0:00')).toBeTruthy();
    expect(screen.getByText('Waiting…')).toBeTruthy();
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

const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const inApp = (ui: React.ReactElement) => <SafeAreaProvider initialMetrics={metrics}>{ui}</SafeAreaProvider>;

describe('NewMatchSheet', () => {
  it('offers Live Play, Async and Custom Match, and reports the choice', async () => {
    const onChoose = jest.fn();
    await render(inApp(<NewMatchSheet visible liveEnabled online={5} pending={null} error={null} onChoose={onChoose} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /live play/i }));
    await fireEvent.press(screen.getByRole('button', { name: /async/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily']]);
    expect(screen.getByText('5 online')).toBeTruthy();
    expect(screen.getByText(/kicked if away for a full hand/)).toBeTruthy();
  });

  it('asks for house rules before creating a Custom Match', async () => {
    const onChoose = jest.fn();
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={onChoose} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByText('House rules')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Off' }));
    await fireEvent.press(screen.getByRole('button', { name: /more marks/i }));
    await fireEvent.press(screen.getByRole('button', { name: /create table/i }));
    expect(onChoose).toHaveBeenLastCalledWith('challenge', { ...DEFAULT_HOUSE_RULES, low: 'off', marksToWin: 8 });
  });

  it('disables Low only when forced while Redeal is picked, and says why', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    await fireEvent.press(screen.getByRole('radio', { name: /redeal/i }));
    const forced = screen.getByRole('radio', { name: /only when forced/i });
    expect(forced.props.accessibilityState).toMatchObject({ disabled: true });
    expect(forced.props.accessibilityHint).toMatch(/everyone passing redeals/i);
  });

  it('goes back from the house rules to the choices', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    await fireEvent.press(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('button', { name: /async/i })).toBeTruthy();
  });

  it('shows the choices on default rules again after closing and reopening', async () => {
    const sheet = (visible: boolean) =>
      inApp(<NewMatchSheet visible={visible} liveEnabled online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />);
    const { rerender } = await render(sheet(true));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Off' }));
    await rerender(sheet(false));
    await rerender(sheet(true));
    expect(screen.getByRole('button', { name: /async/i })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    expect(screen.getByRole('radio', { name: 'On' }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it('labels the matchmade options apart from playing with friends', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    expect(screen.getByRole('header', { name: /find opponents/i })).toBeTruthy();
    expect(screen.getByRole('header', { name: /play with friends/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /live play.*60-second turns/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /async.*take turns whenever/i })).toBeTruthy();
  });

  it('leaves Live Play out when bots are off', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled={false} online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    expect(screen.queryByRole('button', { name: /^live play/i })).toBeNull();
  });

  it('offers Play vs bots under Practice', async () => {
    const onChoose = jest.fn();
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={onChoose} onClose={jest.fn()} />));
    expect(screen.getByRole('header', { name: /practice/i })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /play vs bots.*jump straight in against three bots/i }));
    expect(onChoose).toHaveBeenCalledWith('bots');
  });

  it('says Play vs bots is setting up the table while it works', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending="bots" error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    expect(screen.getByRole('button', { name: /play vs bots.*setting up the table/i })).toBeDisabled();
  });

  it('leaves Play vs bots out when bots are off', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled={false} online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    expect(screen.queryByRole('button', { name: /play vs bots/i })).toBeNull();
    expect(screen.queryByRole('header', { name: /practice/i })).toBeNull();
  });

  it('shows which choice is working, and says so when it takes a while', async () => {
    jest.useFakeTimers();
    try {
      await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending="daily" error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
      expect(screen.getByRole('button', { name: /async.*finding a seat/i })).toBeTruthy();
      // The others still read as themselves, just disabled.
      expect(screen.getByRole('button', { name: /custom match.*send the invite link/i })).toBeDisabled();

      await act(() => jest.advanceTimersByTime(SLOW_MS));
      expect(screen.getByRole('button', { name: /async.*still working/i })).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stays open while a choice is working', async () => {
    const onClose = jest.fn();
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending="challenge" error={null} onChoose={jest.fn()} onClose={onClose} />));
    await fireEvent.press(screen.getByLabelText('Close'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows why the last choice failed', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error="Request timed out" onChoose={jest.fn()} onClose={jest.fn()} />));
    expect(screen.getByRole('alert')).toHaveTextContent('Request timed out');
  });
});

describe('HowToPlayContent', () => {
  it('shows every section, and reads out each domino example with its caption', async () => {
    await render(<HowToPlayContent />);
    for (const section of HOW_TO_PLAY) expect(screen.getByRole('header', { name: section.title })).toBeTruthy();
    expect(screen.getByLabelText('10 points each: 5-5 and 6-4. 5 points each: 5-0, 4-1 and 3-2. 5-5, 6-4, 5-0, 4-1, 3-2')).toBeTruthy();
  });
});

describe('HowToPlayCard', () => {
  it('opens the rules, or dismisses itself', async () => {
    const onOpen = jest.fn();
    const onDismiss = jest.fn();
    await render(<HowToPlayCard onOpen={onOpen} onDismiss={onDismiss} />);
    await fireEvent.press(screen.getByRole('button', { name: 'New to 42? Learn how to play' }));
    expect(onOpen).toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('HelpButton', () => {
  it('is a button named How to play', async () => {
    const onPress = jest.fn();
    await render(<HelpButton onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'How to play' }));
    expect(onPress).toHaveBeenCalled();
  });
});
