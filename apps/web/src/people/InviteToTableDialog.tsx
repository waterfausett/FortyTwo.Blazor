// Invite a person from the Lobby's People tab to one of your tables: your open Custom tables (the
// first page of Active games, filtered by invitableTables), each with an Invite button. Invites go
// through the same POST /api/matches/:id/invites as the Match page's Invite players, so the same
// limits hold - one invite per person per table, six per table; the button then reads Invited ✓.
import { useEffect, useRef, useState, type JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { invitableTables, tableDetail, tableTitle } from '@fortytwo/client';
import type { apiClient, Person } from '../api/client';
import '../components/NewMatchDialog.css';
import './People.css';

type TablesClient = Pick<ReturnType<typeof apiClient>, 'listMatches' | 'invitePlayers'>;

export function InviteToTableDialog({
  person,
  client,
  onClose,
}: {
  person: Person;
  client: TablesClient;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [invited, setInvited] = useState<string[]>([]);
  const tables = useQuery({
    queryKey: ['matches', 'Active', 'first-page'],
    queryFn: () => client.listMatches('Active'),
  });
  const invite = useMutation({
    mutationFn: (matchId: string) => client.invitePlayers(matchId, [person.user_id]),
    // Skipped (already invited) counts as invited too: there's nothing more to send.
    onSuccess: (_result, matchId) => setInvited((ids) => [...ids, matchId]),
  });
  useEffect(() => dialogRef.current?.focus(), []);
  const open = tables.data && invitableTables(tables.data.matches, person.displayName);

  return (
    <div className="new-match-scrim" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-table-title"
        tabIndex={-1}
        className="new-match-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="invite-table-title" className="new-match-title">
          Invite {person.displayName}
        </h2>
        {(invite.error ?? tables.error) && (
          <p role="alert" className="new-match-error">
            {(invite.error ?? tables.error)?.message}
          </p>
        )}
        {tables.isPending && <p className="people-note">Loading…</p>}
        {open?.length === 0 && <p className="people-note">No open Custom tables. Start one from New match.</p>}
        {open && open.length > 0 && (
          <ul className="people-list">
            {open.map((match) => (
              <li key={match.id} className="people-row">
                <span className="people-text">
                  <span className="people-name">{tableTitle(match)}</span>
                  <span className="people-detail">{tableDetail(match)}</span>
                </span>
                {invited.includes(match.id) ? (
                  <span className="people-invited">Invited ✓</span>
                ) : (
                  <button
                    type="button"
                    className="action-button action-button-small"
                    aria-label={`Invite ${person.displayName} to ${tableTitle(match)}`}
                    disabled={invite.isPending && invite.variables === match.id}
                    onClick={() => invite.mutate(match.id)}
                  >
                    Invite
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
