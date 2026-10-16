// The Lobby's Invited to card: invites to custom tables waiting for the player (GET /api/invites),
// each with Join (the table's seat picker) and Dismiss. The newest few show, and the rest behind
// "Show N more", so a pile of invites doesn't push the match list down. Nothing at all when there
// are none.
import { useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { apiClient } from '../api/client';
import { inviteDetail } from '@fortytwo/client';
import { toastError } from '../ui/toast';
import './People.css';

export const VISIBLE_INVITES = 3;

type InvitesClient = Pick<ReturnType<typeof apiClient>, 'getInvites' | 'dismissInvite'>;

export function InvitesCard({ client }: { client: InvitesClient }): JSX.Element | null {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => client.getInvites() });
  const dismiss = useMutation({
    mutationFn: (matchId: string) => client.dismissInvite(matchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
    onError: toastError,
  });
  if (!invites.data || invites.data.length === 0) return null;
  const hidden = invites.data.length - VISIBLE_INVITES;
  const shown = expanded || hidden <= 0 ? invites.data : invites.data.slice(0, VISIBLE_INVITES);

  return (
    <section className="invites-card mat-panel" aria-label="Invited to">
      <h2 className="invites-title">Invited to</h2>
      <ul className="invites-list">
        {shown.map((invite) => (
          <li key={invite.matchId} className="invites-row">
            <span className="people-text">
              <span className="people-name">{invite.from.displayName} invited you</span>
              <span className="people-detail">{inviteDetail(invite)}</span>
            </span>
            <Link to={`/match/${invite.matchId}`} className="action-button action-button-small">
              Join
            </Link>
            <button
              type="button"
              className="invites-dismiss"
              aria-label={`Dismiss invite from ${invite.from.displayName}`}
              onClick={() => dismiss.mutate(invite.matchId)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="invites-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      )}
    </section>
  );
}
