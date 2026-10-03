// One domino tile: a six-position die face per half, plus the divider `<span class="line">`,
// styled by domino.css.
//
// The `top` prop always renders in the top half and `bottom` in the bottom half. A `Domino`
// (packages/rules/src/domino.ts) only carries its canonical `top <= bottom` values, with no
// orientation, so a tile can't be flipped.
import type { JSX } from 'react';

export interface DominoProps {
  top: number;
  bottom: number;
  onClick?: () => void;
  onDoubleClick?: () => void;
  selectable?: boolean;
  // Adds domino.css's `.preselected` class (a glow, see theme.css's `--domino-preselected-color`)
  // directly to this element. Deliberately NOT a wrapper class: `.horizontal`'s rotate+negative-
  // margin hack means a wrapper div's own layout box doesn't line up with where the domino
  // actually renders, so styling has to live on the domino element itself to be visible at all.
  preselected?: boolean;
  // With the "highlight playable dominoes" setting on, whether this tile may be played right now.
  hint?: 'playable' | 'unplayable';
  direction?: 'horizontal' | 'vertical';
}

// The pip spans for one half, applied identically to each (`prefix` is "T" for the top half / "B"
// for the bottom half; the class names themselves - e.g. TL23456 - come from domino.css). Encodes
// a standard 6-position die face:
//   - value >= 2: left + right corner dots
//   - value == 6: an additional middle-row pair (the "6" position)
//   - value >= 4: another middle-row pair (the "456" position)
//   - value is odd (1, 3, 5): a center dot
function pipClasses(prefix: 'T' | 'B', value: number): string[] {
  const classes: string[] = [];
  if (value >= 2) classes.push(`${prefix}L23456`);
  if (value === 6) classes.push(`${prefix}L6`);
  if (value >= 4) classes.push(`${prefix}L456`);
  if (value % 2 !== 0) classes.push(`${prefix}C135`);
  if (value >= 2) classes.push(`${prefix}R23456`);
  if (value === 6) classes.push(`${prefix}R6`);
  if (value >= 4) classes.push(`${prefix}R456`);
  return classes;
}

function DominoHalf({ prefix, value }: { prefix: 'T' | 'B'; value: number }): JSX.Element {
  return (
    <div data-value={value}>
      {pipClasses(prefix, value).map((cls) => (
        <span key={cls} className={cls} />
      ))}
    </div>
  );
}

// Direction defaults to 'horizontal': domino.css's `.horizontal` class rotates the tile 90deg from
// its natural tall/vertical shape, so the default rendering is the wide hand-tile look;
// TrickDisplay passes direction="vertical" (omitting the class) for the tall trick-pile look.
export function Domino({
  top,
  bottom,
  onClick,
  onDoubleClick,
  selectable = false,
  preselected = false,
  hint,
  direction = 'horizontal',
}: DominoProps): JSX.Element {
  const classNames = [
    'domino',
    direction === 'horizontal' ? 'horizontal' : null,
    selectable ? 'clickable' : null,
    preselected ? 'preselected' : null,
    hint ?? null,
  ]
    .filter((c): c is string => Boolean(c))
    .join(' ');

  return (
    <div
      className={classNames}
      data-testid="domino"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      role={onClick ? 'button' : undefined}
    >
      <DominoHalf prefix="T" value={top} />
      <span className="line" />
      <DominoHalf prefix="B" value={bottom} />
    </div>
  );
}
