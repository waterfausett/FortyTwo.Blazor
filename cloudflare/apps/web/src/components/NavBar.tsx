// A minimal top-level nav bar (Lobby + Profile links), reachable from every page. Addresses
// CRITICAL finding #4 from the final whole-branch review: before this, there was no way to reach
// ANY page in the app except by typing a URL directly - no link back to the lobby existed anywhere
// once a player navigated away from it. Deliberately simple (two links, no elaborate layout) per
// this plan's established "port as-is, no redesign" approach elsewhere in the app.
import type { JSX } from 'react';
import { Link } from 'react-router-dom';

export function NavBar(): JSX.Element {
  return (
    <nav className="app-navbar" aria-label="Main navigation">
      <Link to="/">Lobby</Link>
      <Link to="/profile">Profile</Link>
    </nav>
  );
}
