// The catch-all route: any path the router doesn't know. Sits behind AuthGate like every page.
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import './NotFound.css';

export function NotFound(): JSX.Element {
  return (
    <div className="not-found">
      <div className="not-found-tile" aria-hidden="true" />
      <h1 className="page-title">Nothing here</h1>
      <p className="not-found-text">There's no page at this address.</p>
      <Link to="/" className="action-button">
        Back to the Lobby
      </Link>
    </div>
  );
}
