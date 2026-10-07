// One team's pile of already-completed tricks at the side of the table, headed by that team's
// running point total for the hand. Each trick is a row of vertical Dominoes.
//
// `align="mine"` lists the newest trick first; `align="opponent"` lists tricks in completion
// order. Both put the point total at the top.
import type { JSX } from 'react';
import type { Trick } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface TrickHistoryProps {
  tricks: Trick[];
  points: number;
  align: 'mine' | 'opponent';
  // The points this team needs to make its bid, when it's the bidding team.
  target?: number | null;
  label?: string;
}

// Keyed by the trick's dominoes alone - never its list position. Positions shift whenever a trick
// joins the newest-first "mine" pile (or the stacked view drops its oldest), and a position-based
// key would then remount every row, replaying each one's arrival animation. Every domino is played
// exactly once per hand, so the domino ids already identify a trick uniquely.
function trickKey(trick: Trick): string {
  return trick.dominoes.map((d) => d?.id ?? 'x').join(',');
}

// Disambiguates tricks with identical contents (impossible in a real hand, but test fixtures reuse
// the same dominoes) so React never sees duplicate keys.
function uniqueKeys(tricks: Trick[]): string[] {
  const seen = new Map<string, number>();
  return tricks.map((trick) => {
    const key = trickKey(trick);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}#${count}`;
  });
}

export function TrickHistory({ tricks, points, align, target = null, label }: TrickHistoryProps): JSX.Element {
  const ordered = align === 'mine' ? [...tricks].reverse() : tricks;
  const keys = uniqueKeys(ordered);

  return (
    <div className={align === 'mine' ? 'player-team-tricks' : 'opponent-tricks'} aria-label={label ? `${label} tricks` : undefined}>
      <div className="pile-total">
        {label && <span className="pile-label">{label}</span>}
        <span className="pile-points">
          <span className="badge">{points}</span>
          {target != null ? <span className="pile-target"> of {target}</span> : <span className="pile-target"> pts</span>}
        </span>
      </div>
      <div className="trick-history">
        {ordered.map((trick, index) => (
          <div key={keys[index]} className="trick-history-row">
            {trick.dominoes.map(
              (domino) => domino && <Domino key={domino.id} top={domino.top} bottom={domino.bottom} direction="vertical" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
