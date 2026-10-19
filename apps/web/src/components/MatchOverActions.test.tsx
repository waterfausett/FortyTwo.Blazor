import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EndChoices, PartyButton } from '@fortytwo/client';
import { MatchOverActions } from './MatchOverActions';

afterEach(cleanup);

function choices(party: PartyButton, overrides: Partial<EndChoices> = {}): EndChoices {
  return {
    live: true,
    expired: false,
    partnerId: 'p3',
    party,
    rematchDisabled: false,
    iAmBusy: false,
    showFindGame: true,
    showRematch: true,
    ...overrides,
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

  // Partied, or the rematch made: Find a game takes me back to that game while it's still going.
  it('offers only Find a game once the team has gone on, beside the Lobby link in rows', () => {
    const goneOn = choices({ kind: 'hidden' }, { showRematch: false });
    renderActions({ kind: 'hidden' }, { choices: goneOn });
    expect(labels()).toEqual(['Find a game']);
    cleanup();
    renderActions({ kind: 'hidden' }, { choices: goneOn, layout: 'rows' });
    expect(labels()).toEqual(['Lobby', 'Find a game']);
  });

  // Opened long after the game ended: history, with nothing to choose.
  it('shows nothing once expired, and only the Lobby link in rows', () => {
    const expired = choices({ kind: 'hidden' }, { expired: true, showFindGame: false, showRematch: false });
    const { container } = renderActions({ kind: 'hidden' }, { choices: expired });
    expect(container.querySelector('.match-over-actions')).toBeNull();
    cleanup();
    renderActions({ kind: 'hidden' }, { choices: expired, layout: 'rows' });
    expect(labels()).toEqual(['Lobby']);
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
