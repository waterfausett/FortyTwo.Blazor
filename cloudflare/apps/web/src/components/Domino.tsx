// One domino tile. Replaces FortyTwo/Client/Components/Domino.razor. Pip-layout structure
// (six-position die face per half, plus the divider `<span class="line">`) is ported directly
// from the real Domino.razor, reusing domino.css's existing class names as-is - no new CSS.
//
// Orientation-flip simplification (see Task 20's report for the full data-model gap writeup):
// the old Razor's `Instance.Orientation` (Left/Right) field let a player flip which half of the
// underlying C# Domino displayed "on top" without changing its identity. Our TS `Domino` type
// (packages/rules/src/domino.ts) has no such field - it only carries the canonical, normalized
// `top <= bottom` values - and Task 20's brief never asks for orientation-flipping. Rather than
// invent new component-local orientation state to replicate a UX affordance the shared type
// doesn't support, this component uses a fixed, direct mapping: the `top` prop always renders in
// the top half, `bottom` always in the bottom half.
import type { JSX } from 'react';

export interface DominoProps {
  top: number;
  bottom: number;
  onClick?: () => void;
  selectable?: boolean;
  direction?: 'horizontal' | 'vertical';
}

// Port of Domino.razor's conditional pip-span logic, applied identically to each half (`prefix`
// is "T" for the top half / "B" for the bottom half; the class names themselves - e.g. TL23456 -
// come straight from domino.css). Encodes a standard 6-position die face:
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

// Direction defaults to 'horizontal', matching Domino.razor's `Direction { get; set; } =
// DominoDirection.Horizontal` default - domino.css's `.horizontal` class rotates the tile 90deg
// from its natural tall/vertical shape, so the default rendering is the wide hand-tile look;
// TrickDisplay passes direction="vertical" (omitting the class) for the tall trick-pile look,
// matching Match.razor's explicit `Direction="DominoDirection.Vertical"` there.
export function Domino({ top, bottom, onClick, selectable = false, direction = 'horizontal' }: DominoProps): JSX.Element {
  const classNames = ['domino', direction === 'horizontal' ? 'horizontal' : null, selectable ? 'clickable' : null]
    .filter((c): c is string => Boolean(c))
    .join(' ');

  return (
    <div className={classNames} data-testid="domino" onClick={onClick} role={onClick ? 'button' : undefined}>
      <DominoHalf prefix="T" value={top} />
      <span className="line" />
      <DominoHalf prefix="B" value={bottom} />
    </div>
  );
}
