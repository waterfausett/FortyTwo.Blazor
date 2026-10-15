// A search box over the People list (usePeople), each person with a star to add or remove them as
// a friend, and an optional action - the Match page's Invite. Used by the Lobby's People tab and
// the Invite players dialog.
import { useState, type JSX, type ReactNode } from 'react';
import { personDetail } from '@fortytwo/client';
import type { Person } from '../api/client';
import { usePeople, type PeopleClient } from './usePeople';
import './People.css';

export function PeoplePanel({
  client,
  hiddenIds = [],
  action,
  emptyText,
}: {
  client: PeopleClient;
  hiddenIds?: string[];
  action?: (person: Person) => ReactNode;
  emptyText: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const { list, loading, error, searching, toggleFriend } = usePeople(client, query);
  const shown = (list ?? []).filter((p) => !hiddenIds.includes(p.user_id));

  return (
    <div className="people-panel">
      <input
        type="search"
        className="form-control people-search"
        aria-label="Find a player"
        placeholder="Find a player by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <p className="lobby-note">Loading…</p>}
      {error != null && (
        <p role="alert" className="page-error">
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </p>
      )}
      {!loading && error == null && shown.length === 0 && (
        <p className="lobby-note">{searching ? 'No players by that name.' : emptyText}</p>
      )}
      {shown.length > 0 && (
        <ul className="people-list">
          {shown.map((person) => (
            <li key={person.user_id} className="people-row">
              {person.picture ? (
                <img className="people-avatar" src={person.picture} alt="" />
              ) : (
                <span className="people-avatar people-initial" aria-hidden="true">
                  {person.displayName.trim()[0]?.toUpperCase()}
                </span>
              )}
              <span className="people-text">
                <span className="people-name">{person.displayName}</span>
                <span className="people-detail">{personDetail(person)}</span>
              </span>
              <button
                type="button"
                className={`people-star${person.isFriend ? ' is-friend' : ''}`}
                aria-label={person.isFriend ? `Remove ${person.displayName} from friends` : `Add ${person.displayName} as a friend`}
                aria-pressed={person.isFriend}
                onClick={() => toggleFriend(person)}
              >
                {person.isFriend ? '★' : '☆'}
              </button>
              {action?.(person)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
