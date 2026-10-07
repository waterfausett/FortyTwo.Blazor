// Stands in for a player's name while it loads (match/usePlayerNames.ts), so the raw player id
// never shows. Styles in NameSkeleton.css.
import type { JSX } from 'react';
import './NameSkeleton.css';

export function NameSkeleton({ width = '5em' }: { width?: string }): JSX.Element {
  return (
    <span className="name-skeleton" style={{ width }}>
      <span className="visually-hidden">Loading name</span>
    </span>
  );
}
