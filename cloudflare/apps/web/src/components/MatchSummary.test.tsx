import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bid, Positions, Suit, Teams, type Game, type MatchState } from '@fortytwo/rules';
import { MatchSummary } from './MatchSummary';

afterEach(cleanup);

function game(name: string, bidder: string, bid: Bid, trump: Suit, bidderTeam: Teams): Game {
  return {
    id: name,
    name,
    firstActionBy: 'p1',
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

function finishedMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
    id: 'match-1',
    createdOn: '',
    updatedOn: '',
    winningTeam: Teams.TeamA,
    players: [
      { playerId: 'p1', position: Positions.First, ready: false },
      { playerId: 'p2', position: Positions.Second, ready: false },
      { playerId: 'p3', position: Positions.Third, ready: false },
      { playerId: 'p4', position: Positions.Fourth, ready: false },
    ],
    games: {
      [Teams.TeamA]: [game('Game 1', 'p1', Bid.EightyFour, Suit.Fives, Teams.TeamA)],
      [Teams.TeamB]: [game('Game 2', 'p1', Bid.Thirty, Suit.Aces, Teams.TeamA)],
    },
    currentGame: game('Game 2', 'p1', Bid.Thirty, Suit.Aces, Teams.TeamA),
    ...overrides,
  };
}

const names: Record<string, string> = { p1: 'You', p2: 'Bea', p3: 'Cal', p4: 'Dee', 'bot-1': 'bot-1' };

function renderSummary(props: Partial<Parameters<typeof MatchSummary>[0]> = {}) {
  const handlers = { onRematch: vi.fn(), onClose: vi.fn() };
  render(
    <MemoryRouter>
      <MatchSummary
        match={finishedMatch()}
        myTeam={Teams.TeamA}
        nameFor={(id) => (id == null ? '' : names[id])}
        iVoted={false}
        rematchDisabled={false}
        {...handlers}
        {...props}
      />
    </MemoryRouter>
  );
  return handlers;
}

describe('MatchSummary', () => {
  it('names the winner, both teams and their marks', () => {
    renderSummary();

    const dialog = screen.getByRole('dialog', { name: /you won the match/i });
    expect(within(dialog).getByText('You & Cal')).not.toBeNull();
    expect(within(dialog).getByText('Bea & Dee')).not.toBeNull();
    expect(within(dialog).getByTestId('final-marks-us').textContent).toBe('2');
    expect(within(dialog).getByTestId('final-marks-them').textContent).toBe('1');
  });

  it('says they won when the other team did', () => {
    renderSummary({ myTeam: Teams.TeamB });
    expect(screen.getByRole('dialog', { name: /they won the match/i })).not.toBeNull();
  });

  it('lists each hand in order with its bidder, bid, trump and result', () => {
    renderSummary();

    const rows = screen.getAllByRole('row').slice(1); // skip the header row
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Game 1.*You.*84.*Fives.*Made.*\+2/),
      expect.stringMatching(/Game 2.*You.*30.*Aces.*Set.*\+1/),
    ]);
  });

  it('links back to the lobby', () => {
    renderSummary();
    expect(screen.getByRole('link', { name: /back to lobby/i }).getAttribute('href')).toBe('/');
  });

  it('votes for a rematch', () => {
    const { onRematch } = renderSummary();
    fireEvent.click(screen.getByRole('button', { name: /^rematch/i }));
    expect(onRematch).toHaveBeenCalled();
  });

  it('shows how many have agreed once I have voted, counting bots', () => {
    renderSummary({
      iVoted: true,
      match: finishedMatch({
        players: [
          { playerId: 'p1', position: Positions.First, ready: false },
          { playerId: 'bot-1', position: Positions.Second, ready: false },
          { playerId: 'p3', position: Positions.Third, ready: false },
          { playerId: 'p4', position: Positions.Fourth, ready: false },
        ],
        rematchVotes: ['p1'],
      }),
    });

    const button = screen.getByRole('button', { name: /waiting for rematch \(2 of 4\)/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('offers a plain Rematch on a match stored before votes existed', () => {
    renderSummary({ match: finishedMatch({ rematchVotes: undefined }) });
    expect(screen.getByRole('button', { name: /^rematch$/i })).not.toBeNull();
  });

  it('closes', () => {
    const { onClose } = renderSummary();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
