// The lobby: three polling match lists (Active/Joinable/Completed) plus create/join actions.
// Replaces the old FortyTwo/Client/Pages/Index.razor + Index.razor.cs, which drove its lists via a
// SignalR push (`OnMatchCreated`) into a client-side store. Per the design spec's polling decision
// (no live lobby push in v1 - only in-match state gets a WebSocket, via useMatchSocket), each list
// here is a TanStack Query `useQuery` with `refetchInterval: 8000` and `refetchOnWindowFocus: true`
// instead: a new/updated match becomes visible to other players within one 8s poll (or immediately
// on window focus), which is an accepted tradeoff for the lobby (unlike in-match play, where a
// missed update would be a real problem).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { Link, useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { apiClient, type MatchSummary } from '../api/client';

const POLL_INTERVAL_MS = 8000;

// The lobby's list rows come from the lightweight D1 "MatchSummary" shape (`{ id, status,
// playerCount, updatedOn }`) - it carries no team composition, unlike the full MatchState a match
// page would have. Without per-team occupancy to drive a team picker, a single "Join" button with
// a fixed default team is the simplest reasonable UX for this task; the server
// (`validation.ts`'s `assertTeamNotFull`, called from `matchEngine.ts`'s `addPlayer`) validates
// team capacity and rejects a full team, which surfaces here as a mutation error rather than a
// client-side team-select flow.
const DEFAULT_JOIN_TEAM = 1; // Teams.TeamA in @fortytwo/rules

function matchListQuery(client: ReturnType<typeof apiClient>, filter: 'Active' | 'Completed' | 'Joinable') {
  return {
    queryKey: ['matches', filter] as const,
    queryFn: () => client.listMatches(filter),
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function MatchListSection({
  title,
  matches,
  isLoading,
  error,
  emptyLabel,
  renderRowActions,
}: {
  title: string;
  matches: MatchSummary[] | undefined;
  isLoading: boolean;
  error: unknown;
  emptyLabel: string;
  renderRowActions?: (match: MatchSummary) => JSX.Element | null;
}): JSX.Element {
  return (
    <section className="lobby-section" aria-label={title}>
      <h2>{title}</h2>
      {isLoading && <p>Loading…</p>}
      {error != null && (
        <p role="alert" className="lobby-error">
          {errorMessage(error)}
        </p>
      )}
      {!isLoading && error == null && (matches == null || matches.length === 0) && <p>{emptyLabel}</p>}
      {matches != null && matches.length > 0 && (
        <ul className="lobby-match-list">
          {matches.map((match) => (
            <li key={match.id} className="lobby-match-row">
              <Link to={`/match/${match.id}`} className="lobby-match-id">
                {match.id}
              </Link>
              <span className="lobby-match-players">{match.playerCount} players</span>
              {renderRowActions?.(match)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Lobby(): JSX.Element {
  const { getAccessTokenSilently } = useAuth0();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Auth0's getAccessTokenSilently is typed to return `Promise<string | undefined>` (it's
  // overloaded, and the plain-string overload can still resolve `undefined`) while apiClient's
  // getToken param is a plain `() => Promise<string>` - wrap it and fail loudly rather than
  // silently sending a request with an `Authorization: Bearer undefined` header.
  const client = apiClient(async () => {
    const token = await getAccessTokenSilently();
    if (!token) throw new Error('Failed to obtain an access token.');
    return token;
  });

  const activeQuery = useQuery(matchListQuery(client, 'Active'));
  const joinableQuery = useQuery(matchListQuery(client, 'Joinable'));
  const completedQuery = useQuery(matchListQuery(client, 'Completed'));

  const createMatch = useMutation({
    mutationFn: () => client.createMatch(),
    onSuccess: (match) => {
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate(`/match/${match.id}`);
    },
  });

  const joinMatch = useMutation({
    mutationFn: ({ id, team }: { id: string; team: number }) => client.joinMatch(id, team),
    onSuccess: (match) => {
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate(`/match/${match.id}`);
    },
  });

  return (
    <div className="lobby">
      <h1>
        Matches
        <button type="button" onClick={() => createMatch.mutate()} disabled={createMatch.isPending}>
          Create Match
        </button>
      </h1>
      {createMatch.isError && (
        <p role="alert" className="lobby-error">
          {errorMessage(createMatch.error)}
        </p>
      )}
      {joinMatch.isError && (
        <p role="alert" className="lobby-error">
          {errorMessage(joinMatch.error)}
        </p>
      )}

      <MatchListSection
        title="Active"
        matches={activeQuery.data}
        isLoading={activeQuery.isLoading}
        error={activeQuery.error}
        emptyLabel="No active games."
      />

      <MatchListSection
        title="Find a Game"
        matches={joinableQuery.data}
        isLoading={joinableQuery.isLoading}
        error={joinableQuery.error}
        emptyLabel="No games to join right now."
        renderRowActions={(match) => (
          <button
            type="button"
            onClick={() => joinMatch.mutate({ id: match.id, team: DEFAULT_JOIN_TEAM })}
            disabled={joinMatch.isPending}
          >
            Join
          </button>
        )}
      />

      <MatchListSection
        title="Game History"
        matches={completedQuery.data}
        isLoading={completedQuery.isLoading}
        error={completedQuery.error}
        emptyLabel="No completed games yet."
      />
    </div>
  );
}
