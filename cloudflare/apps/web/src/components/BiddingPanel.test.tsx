// BiddingPanel.tsx renders the bids `availableBids` allows (the rule details are covered in the
// rules package's validation tests), disabled entirely whenever it isn't this player's turn
// (game.currentPlayerId !== myPlayerId).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bid, Teams, createDomino, type Game, type Hand } from '@fortytwo/rules';
import { BiddingPanel } from './BiddingPanel';

afterEach(() => {
  cleanup();
});

// p1's hand with `doubles` doubles, padded out to seven dominoes with non-doubles.
function hand(doubles: number): Hand {
  const dominoes = [
    ...Array.from({ length: doubles }, (_, i) => createDomino(i, i)),
    ...Array.from({ length: 7 - doubles }, (_, i) => createDomino(6, i)),
  ];
  return { playerId: 'p1', team: Teams.TeamA, dominoes, bid: null };
}

function baseGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    name: 'Game 1',
    firstActionBy: 'p1',
    bid: null,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: 'p1',
    hands: [],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
    ...overrides,
  };
}

describe('BiddingPanel', () => {
  it('renders a Pass button and every bid above the current game.bid', () => {
    render(<BiddingPanel game={baseGame({ bid: Bid.Thirty })} myPlayerId="p1" onBid={() => {}} />);

    expect(screen.getByRole('button', { name: /pass/i })).not.toBeNull();
    expect(screen.getByRole('button', { name: /^31$/ })).not.toBeNull();
    // Bid.Thirty itself and anything below it must NOT be offered as a raisable option.
    expect(screen.queryByRole('button', { name: /^30$/ })).toBeNull();
  });

  it('offers every non-Pass bid when no bid has been made yet', () => {
    render(<BiddingPanel game={baseGame({ bid: null })} myPlayerId="p1" onBid={() => {}} />);

    expect(screen.getByRole('button', { name: /^30$/ })).not.toBeNull();
    expect(screen.getByRole('button', { name: /42/ })).not.toBeNull();
  });

  it('does not offer marks bids until the rung below has been bid', () => {
    render(<BiddingPanel game={baseGame({ bid: Bid.FortyTwo })} myPlayerId="p1" onBid={() => {}} />);

    expect(screen.getByRole('button', { name: /^84$/ })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /marks/i })).toBeNull();
  });

  it('offers only the next marks rung over a standing marks bid', () => {
    render(<BiddingPanel game={baseGame({ bid: Bid.EightyFour })} myPlayerId="p1" onBid={() => {}} />);

    expect(screen.getByRole('button', { name: /3 marks/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /4 marks/i })).toBeNull();
  });

  it('hides Plunge without four doubles', () => {
    render(<BiddingPanel game={baseGame({ hands: [hand(3)] })} myPlayerId="p1" onBid={() => {}} />);

    expect(screen.queryByRole('button', { name: /plunge/i })).toBeNull();
  });

  it('hides Pass when the other three players already passed', () => {
    const passed = (playerId: string) => ({ ...hand(0), playerId, bid: Bid.Pass });
    render(
      <BiddingPanel
        game={baseGame({ hands: [hand(0), passed('p2'), passed('p3'), passed('p4')] })}
        myPlayerId="p1"
        onBid={() => {}}
      />
    );

    expect(screen.queryByRole('button', { name: /pass/i })).toBeNull();
  });

  it('offers Plunge as a clickable option with four doubles in hand', () => {
    const onBid = vi.fn();
    render(<BiddingPanel game={baseGame({ bid: Bid.ThreeMarks, hands: [hand(4)] })} myPlayerId="p1" onBid={onBid} />);

    const plungeButton = screen.getByRole('button', { name: /plunge/i }) as HTMLButtonElement;
    expect(plungeButton.disabled).toBe(false);

    fireEvent.click(plungeButton);
    expect(onBid).toHaveBeenCalledWith(Bid.Plunge);
  });

  it('calls onBid with the right Bid value when a bid button is clicked', () => {
    const onBid = vi.fn();
    render(<BiddingPanel game={baseGame({ bid: null })} myPlayerId="p1" onBid={onBid} />);

    fireEvent.click(screen.getByRole('button', { name: /^30$/ }));

    expect(onBid).toHaveBeenCalledWith(Bid.Thirty);
  });

  it('calls onBid with Pass when the Pass button is clicked', () => {
    const onBid = vi.fn();
    render(<BiddingPanel game={baseGame({ bid: null })} myPlayerId="p1" onBid={onBid} />);

    fireEvent.click(screen.getByRole('button', { name: /pass/i }));

    expect(onBid).toHaveBeenCalledWith(Bid.Pass);
  });

  it('disables every button when it is not this player\'s turn', () => {
    render(<BiddingPanel game={baseGame({ currentPlayerId: 'someone-else' })} myPlayerId="p1" onBid={() => {}} />);

    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
  });

  it('enables buttons when it is this player\'s turn', () => {
    render(<BiddingPanel game={baseGame({ currentPlayerId: 'p1' })} myPlayerId="p1" onBid={() => {}} />);

    expect((screen.getByRole('button', { name: /pass/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
