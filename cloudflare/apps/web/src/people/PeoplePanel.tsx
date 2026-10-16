// A search box over the People list (usePeople), each person with a star to add or remove them as
// a friend, and an optional action - the Match page's Invite. Used by the Lobby's People tab and
// the Invite players dialog. With `views` (the Lobby), a Friends / Recent players toggle shows
// one list at a time, friends first; without it, everyone is listed together.
import { useState, type JSX, type ReactNode } from 'react';
import { personDetail } from '@fortytwo/client';
import type { PeopleView, Person } from '../api/client';
import { usePeople, type PeopleClient } from './usePeople';
import './People.css';

const VIEWS: { view: PeopleView; label: string }[] = [
  { view: 'friends', label: 'Friends' },
  { view: 'recent', label: 'Recent players' },
];
const NO_FRIENDS = 'No friends yet. Star someone from Recent players to add them.';

export function PeoplePanel({
  client,
  hiddenIds = [],
  action,
  emptyText,
  views = false,
}: {
  client: PeopleClient;
  hiddenIds?: string[];
  action?: (person: Person) => ReactNode;
  emptyText: string;
  views?: boolean;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<PeopleView>('friends');
  const { list, loading, error, searching, toggleFriend } = usePeople(client, query, views ? view : undefined);
  const empty = views && view === 'friends' ? NO_FRIENDS : emptyText;
  const shown = (list ?? []).filter((p) => !hiddenIds.includes(p.user_id));

  return (
    <div className="people-panel">
      <input
        type="search"
        className="form-control people-search"
        aria-label="Find a player"
        maxLength={40}
        placeholder="Find a player by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {views && !searching && (
        <div className="people-views" role="group" aria-label="Show">
          {VIEWS.map(({ view: v, label }) => (
            <button
              key={v}
              type="button"
              className={`people-view${view === v ? ' is-active' : ''}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {loading && <p className="people-note">Loading…</p>}
      {error != null && (
        <p role="alert" className="page-error">
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </p>
      )}
      {!loading && error == null && shown.length === 0 && (
        <p className="people-note">{searching ? 'No players by that name.' : empty}</p>
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
