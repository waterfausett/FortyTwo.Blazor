// Small screens' trick piles, below the hand as in the mobile app: both teams' piles side by side,
// each headed by the team's running points (out of the target, for the bidding team), then its
// tricks, newest first, each with the points it was worth. Wider screens keep TrickHistory's piles
// either side of the table instead; match.css shows one or the other.
import type { JSX } from 'react';
import { trickValue, type Trick } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface TeamPile {
  tricks: Trick[];
  points: number;
  // The points this team needs to make its bid, when it's the bidding team.
  target: number | null;
}

export interface TrickPilesProps {
  us: TeamPile;
  them: TeamPile;
  // Only the hand's last two tricks are in view - say so, so it's clear why the rest are gone.
  stacked: boolean;
}

// Keyed by the trick's dominoes, as in TrickHistory: every domino is played once per hand.
function trickKey(trick: Trick): string {
  return trick.dominoes.map((d) => d?.id ?? 'x').join(',');
}

function Pile({ pile, label, side }: { pile: TeamPile; label: string; side: 'us' | 'them' }): JSX.Element {
  const newestFirst = [...pile.tricks].reverse();
  return (
    <div className={`trick-pile trick-pile-${side}`} aria-label={`${label} tricks: ${pile.points} points`}>
      <div className="trick-pile-header">
        <span className="trick-pile-label">{label}</span>
        <span className="trick-pile-points">
          {pile.points}
          <span className="trick-pile-target">{pile.target != null ? ` of ${pile.target}` : ' pts'}</span>
        </span>
      </div>
      {newestFirst.length === 0 ? (
        <p className="trick-pile-empty">No tricks yet</p>
      ) : (
        newestFirst.map((trick) => (
          <div key={trickKey(trick)} className="trick-pile-row">
            <div className="trick-pile-dominoes">
              {trick.dominoes.map(
                (d) => d && <Domino key={d.id} top={d.top} bottom={d.bottom} direction="vertical" />
              )}
            </div>
            <span className="trick-pile-value">+{trickValue(trick)}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function TrickPiles({ us, them, stacked }: TrickPilesProps): JSX.Element {
  return (
    <section className="trick-piles" aria-label="Tricks taken">
      <div className="trick-piles-row">
        <Pile pile={us} label="Us" side="us" />
        <Pile pile={them} label="Them" side="them" />
      </div>
      {stacked && <p className="trick-piles-note">Tricks are stacked: only the last two taken are shown</p>}
    </section>
  );
}
