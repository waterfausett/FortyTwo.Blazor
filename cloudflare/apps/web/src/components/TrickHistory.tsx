// Renders one team's pile of already-completed tricks off to the side of the gameboard, plus
// that team's running "Points" badge. Replaces the `player-team-tricks`/`opponent-tricks` halves
// of FortyTwo/Client/Pages/Match.razor's `gameboard` block (lines 121-154), which rendered every
// completed trick belonging to a team as a row of vertical Dominoes next to a Points chip - a
// history the React port had previously dropped in favor of showing only the points badge.
//
// `align="mine"` matches Match.razor's own-team panel: tricks listed most-recent-first
// (`teamTricks.Reverse()`), Points badge below the pile. `align="opponent"` matches its opponent
// panel: tricks in completion order, Points badge above the pile.
import type { JSX } from 'react';
import type { Trick } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface TrickHistoryProps {
  tricks: Trick[];
  points: number;
  align: 'mine' | 'opponent';
}

function trickKey(trick: Trick, index: number): string {
  return `${index}-${trick.dominoes.map((d) => d?.id ?? 'x').join(',')}`;
}

export function TrickHistory({ tricks, points, align }: TrickHistoryProps): JSX.Element {
  const ordered = align === 'mine' ? [...tricks].reverse() : tricks;

  const badge = (
    <span className="custom-chip custom-chip-info">
      Points
      <span className="badge badge-info">{points}</span>
    </span>
  );

  return (
    <div className={align === 'mine' ? 'player-team-tricks' : 'opponent-tricks'}>
      {align === 'opponent' && badge}
      <div className="trick-history">
        {ordered.map((trick, index) => (
          <div key={trickKey(trick, index)} className="trick-history-row">
            {trick.dominoes.map(
              (domino) => domino && <Domino key={domino.id} top={domino.top} bottom={domino.bottom} direction="vertical" />
            )}
          </div>
        ))}
      </div>
      {align === 'mine' && badge}
    </div>
  );
}
