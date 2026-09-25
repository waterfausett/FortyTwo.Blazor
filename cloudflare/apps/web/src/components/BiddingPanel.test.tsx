// BiddingPanel.tsx renders available bids (values strictly greater than game.bid, plus a
// dedicated Pass button), disabled entirely whenever it isn't this player's turn
// (game.currentPlayerId !== myPlayerId). It intentionally omits the old app's more elaborate
// BiddingOptions logic (forced-bid-on-last-pass, the doubles-count-gated "Plunge" bid, the
// >2-marks cap) - Task 20's brief only asks for "available bids above game.bid" + a Pass button,
// so those extra rules are out of this component's scope (see Task 20's report).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bid, type Game } from '@fortytwo/rules';
import { BiddingPanel } from './BiddingPanel';

afterEach(() => {
  cleanup();
});

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

  // Regression test for IMPORTANT finding #9 from the final whole-branch review: Plunge used to be
  // filtered out of the available-bids list alongside Pass, making it unreachable through the UI
  // even though the engine (matchEngine.ts/validation.ts) fully supports it and the design spec's
  // explicit goal is to preserve every game rule, including Plunge.
  it('offers Plunge as a clickable option when it is a legal next bid', () => {
    const onBid = vi.fn();
    render(<BiddingPanel game={baseGame({ bid: Bid.FourMarks })} myPlayerId="p1" onBid={onBid} />);

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
