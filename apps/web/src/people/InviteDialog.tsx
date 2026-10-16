// Invite players to a custom table from the Match page: the People list with an Invite button on
// each person not already seated. An invite goes as a push and to their Lobby (POST
// /api/matches/:id/invites); the button then reads Invited ✓.
import { useEffect, useRef, useState, type JSX } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { apiClient } from '../api/client';
import { PeoplePanel } from './PeoplePanel';
import type { PeopleClient } from './usePeople';
import '../components/NewMatchDialog.css';

type InviteClient = PeopleClient & Pick<ReturnType<typeof apiClient>, 'invitePlayers'>;

export function InviteDialog({
  open,
  matchId,
  seatedIds,
  client,
  onClose,
}: {
  open: boolean;
  matchId: string;
  seatedIds: string[];
  client: InviteClient;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [invited, setInvited] = useState<string[]>([]);
  const invite = useMutation({
    mutationFn: (userId: string) => client.invitePlayers(matchId, [userId]),
    // Skipped (already invited) counts as invited too: there's nothing more to send.
    onSuccess: (_result, userId) => setInvited((ids) => [...ids, userId]),
  });
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);
  if (!open) return null;

  return (
    <div className="new-match-scrim" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        tabIndex={-1}
        className="new-match-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="invite-title" className="new-match-title">Invite players</h2>
        {invite.error && (
          <p role="alert" className="new-match-error">
            {invite.error.message}
          </p>
        )}
        <PeoplePanel
          client={client}
          hiddenIds={seatedIds}
          emptyText="Nobody here yet. Search for a player by name, or share the invite link."
          action={(person) =>
            invited.includes(person.user_id) ? (
              <span className="people-invited">Invited ✓</span>
            ) : (
              <button
                type="button"
                className="action-button action-button-small"
                aria-label={`Invite ${person.displayName}`}
                disabled={invite.isPending && invite.variables === person.user_id}
                onClick={() => invite.mutate(person.user_id)}
              >
                Invite
              </button>
            )
          }
        />
      </div>
    </div>
  );
}
