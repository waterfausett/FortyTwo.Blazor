// The top-level nav bar (Lobby + Profile links), reachable from every page. Styled as the hall's
// dark rail, with a 4|2 bone tile as the brand mark (NavBar.css).
import type { JSX } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Suit } from '@fortytwo/rules';
import { PipFace } from './PipFace';
import './NavBar.css';

export function NavBar(): JSX.Element {
  return (
    <nav className="app-navbar" aria-label="Main navigation">
      <Link to="/" className="app-brand" aria-label="Forty-Two home">
        <span className="brand-tile" aria-hidden="true">
          <PipFace suit={Suit.Fours} size="xs" />
          <PipFace suit={Suit.Deuces} size="xs" />
        </span>
        <span className="brand-name">Forty-Two</span>
      </Link>
      <div className="app-nav-links">
        <NavLink to="/" end>
          Lobby
        </NavLink>
        <NavLink to="/profile">Profile</NavLink>
      </div>
    </nav>
  );
}
