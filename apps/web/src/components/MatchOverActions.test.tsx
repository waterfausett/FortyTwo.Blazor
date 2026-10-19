import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndChoices, PartyButton } from '@fortytwo/client';
import { MatchOverActions } from './MatchOverActions';

afterEach(cleanup);

function choices(party: PartyButton): EndChoices {
  const partied = party.kind === 'partied';
  return {
    live: true,
    partnerId: 'p3',
    party,
    rematchDisabled: false,
    iAmBusy: false,
    showFindGame: !partied,
    showRematch: !partied,
  };
}

function renderActions(party: PartyButton, props: Partial<Parameters<typeof MatchOverActions>[0]> = {}) {
  const handlers = { onPartyUp: vi.fn(), onCancelParty: vi.fn(), onFindGame: vi.fn() };
  const { container } = render(
    <MemoryRouter>
      <MatchOverActions
        choices={choices(party)}
        partnerName="Cal"
        layout="stack"
        rematch={<button type="button">Rematch</button>}
        lobby={<a href="/">Lobby</a>}
        busy={false}
        pending={false}
        {...handlers}
        {...props}
      />
    </MemoryRouter>
  );
  return { ...handlers, container };
}

const labels = () => Array.from(document.querySelectorAll('button, a')).map((e) => e.textContent);

describe('MatchOverActions', () => {
  it('stacks Party up, Find a game, then Rematch', () => {
    renderActions({ kind: 'offer', partnerOffered: false });
    expect(labels()).toEqual(['Party up with Cal', 'Find a game', 'Rematch']);
  });

  it('lays rows out as Lobby | Rematch, then Find a game | Party up', () => {
    const { container } = renderActions({ kind: 'offer', partnerOffered: false }, { layout: 'rows' });
    const rows = Array.from(container.querySelectorAll('.match-over-actions-row')).map((r) =>
      Array.from(r.children).map((c) => c.textContent)
    );
    expect(rows).toEqual([
      ['Lobby', 'Rematch'],
      ['Find a game', 'Party up with Cal'],
    ]);
  });

  it('shows no party button when there is nothing to offer', () => {
    renderActions({ kind: 'hidden' });
    expect(labels()).toEqual(['Find a game', 'Rematch']);
  });

  it('says when the partner has already asked, and accepts on a press', () => {
    const { onPartyUp } = renderActions({ kind: 'offer', partnerOffered: true });
    const button = screen.getByRole('button', { name: 'Cal wants to party up ✓' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(onPartyUp).toHaveBeenCalledTimes(1);
  });

  it('cancels my offer from the waiting button', () => {
    const { onCancelParty } = renderActions({ kind: 'waiting' });
    fireEvent.click(screen.getByRole('button', { name: 'Waiting for Cal…' }));
    expect(onCancelParty).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'partnerLeft' } as const, 'Cal left'],
    [{ kind: 'partnerBusy' } as const, 'Cal is in another game'],
  ])('disables the party button when %j', (party, name) => {
    const { onPartyUp, onCancelParty } = renderActions(party);
    const button = screen.getByRole('button', { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onPartyUp).not.toHaveBeenCalled();
    expect(onCancelParty).not.toHaveBeenCalled();
  });

  it('links to the new game once the party has one', () => {
    renderActions({ kind: 'partied', matchId: 'match-9' });
    expect(screen.getByRole('link', { name: 'Go to your new game' }).getAttribute('href')).toBe('/match/match-9');
  });

  // Find a game and Rematch could only lead back to that same new game.
  it('offers only the new game once partied, beside the Lobby link in rows', () => {
    renderActions({ kind: 'partied', matchId: 'match-9' });
    expect(labels()).toEqual(['Go to your new game']);
    cleanup();
    renderActions({ kind: 'partied', matchId: 'match-9' }, { layout: 'rows' });
    expect(labels()).toEqual(['Lobby', 'Go to your new game']);
  });

  it('calls Find a game, and disables the buttons while busy', () => {
    const { onFindGame } = renderActions({ kind: 'offer', partnerOffered: false });
    fireEvent.click(screen.getByRole('button', { name: 'Find a game' }));
    expect(onFindGame).toHaveBeenCalledTimes(1);
    cleanup();
    renderActions({ kind: 'offer', partnerOffered: false }, { busy: true });
    expect((screen.getByRole('button', { name: 'Find a game' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Party up with Cal' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores presses while a choice is pending, without looking disabled', () => {
    const { onCancelParty, onFindGame } = renderActions({ kind: 'waiting' }, { pending: true });
    const waiting = screen.getByRole('button', { name: 'Waiting for Cal…' }) as HTMLButtonElement;
    const findGame = screen.getByRole('button', { name: 'Find a game' }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(false);
    expect(findGame.disabled).toBe(false);
    expect(waiting.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(waiting);
    fireEvent.click(findGame);
    expect(onCancelParty).not.toHaveBeenCalled();
    expect(onFindGame).not.toHaveBeenCalled();
  });
});
