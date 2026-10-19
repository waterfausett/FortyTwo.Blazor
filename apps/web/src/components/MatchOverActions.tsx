// What a finished Live match offers next: Party up with the partner, Find a game, and Rematch. The
// game screen stacks them; the summary sheet lays them in two rows beside its Lobby link. Rematch
// and Lobby come in as nodes because each screen already has its own (vote count, link to the
// rematch once it exists); the state of the party button comes from endChoices.
import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { EndChoices } from '@fortytwo/client';

interface MatchOverActionsProps {
  choices: EndChoices;
  partnerName: string;
  layout: 'stack' | 'rows';
  rematch: ReactNode;
  lobby?: ReactNode;
  // Offline: the choices can't be made, and look it.
  busy: boolean;
  // A choice is on its way: further presses are ignored until it lands, but nothing changes look,
  // so the buttons don't flicker for the moment it takes.
  pending: boolean;
  onPartyUp: () => void;
  onCancelParty: () => void;
  onFindGame: () => void;
}

export function MatchOverActions({
  choices,
  partnerName,
  layout,
  rematch,
  lobby,
  busy,
  pending,
  onPartyUp,
  onCancelParty,
  onFindGame,
}: MatchOverActionsProps): JSX.Element {
  const party = partyControl();
  // Once partied, these could only lead back to the new game, so it stands alone.
  const findGame = choices.showFindGame && (
    <button
      type="button"
      className="action-button"
      disabled={busy}
      aria-disabled={pending || undefined}
      onClick={pending ? undefined : onFindGame}
    >
      Find a game
    </button>
  );
  const rematchControl = choices.showRematch && rematch;

  if (layout === 'rows') {
    return (
      <div className="match-over-actions match-over-actions-rows">
        <div className="match-over-actions-row">
          {lobby}
          {rematchControl}
        </div>
        <div className="match-over-actions-row">
          {findGame}
          {party}
        </div>
      </div>
    );
  }
  return (
    <div className="match-over-actions match-over-actions-stack">
      {party}
      {findGame}
      {rematchControl}
    </div>
  );

  function partyControl(): ReactNode {
    const button = (label: string, onClick: (() => void) | null) => (
      <button
        type="button"
        className="action-button action-button-team"
        disabled={onClick === null || busy}
        aria-disabled={pending || undefined}
        onClick={pending ? undefined : (onClick ?? undefined)}
      >
        {label}
      </button>
    );
    const { party } = choices;
    switch (party.kind) {
      case 'hidden':
        return null;
      case 'offer':
        return button(party.partnerOffered ? `${partnerName} wants to party up ✓` : `Party up with ${partnerName}`, onPartyUp);
      case 'waiting':
        return button(`Waiting for ${partnerName}…`, onCancelParty);
      case 'partnerLeft':
        return button(`${partnerName} left`, null);
      case 'partnerBusy':
        return button(`${partnerName} is in another game`, null);
      case 'partied':
        return (
          <Link to={`/match/${party.matchId}`} className="action-button action-button-team">
            Go to your new game
          </Link>
        );
    }
  }
}
