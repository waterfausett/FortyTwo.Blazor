// The lobby: a tabbed match list (Find a Game / Active / Game History, defaulting to Active,
// mirroring the old FortyTwo/Client/Pages/Index.razor's nav-tabs layout) plus create/join
// actions. Replaces Index.razor + Index.razor.cs, which drove its lists via a SignalR push
// (`OnMatchCreated`) into a client-side store.
//
// Only the selected tab's list is ever fetched - the single `useQuery` below is keyed on
// `activeTab`, so switching tabs just mounts a new query instance instead of eagerly fetching all
// three lists up front. There's no `refetchInterval` cadence either: Active games are expected to
// stay fairly static now that in-match play has its own WebSocket (useMatchSocket) carrying
// real-time updates once you're actually in a match - the lobby just needs a reasonably fresh
// snapshot, not a live feed. A manual refresh icon button (the old app's oi-loop-circular, from
// the open-iconic set already loaded via app.css) refetches whichever tab is currently selected.
// Find a Game may want its own polling/push back later (matches can appear from other players at
// any time) - left as-is for now per explicit product direction.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { JSX } from 'react';
import { apiClient, type MatchSummary } from '../api/client';
import './Lobby.css';

type MatchFilter = 'Active' | 'Joinable' | 'Completed';

// Order and labels match the old app's tab bar (Index.razor's nav-tabs: Find a Game, Active
// Games, Game History).
const TABS: { filter: MatchFilter; label: string }[] = [
  { filter: 'Joinable', label: 'Find a Game' },
  { filter: 'Active', label: 'Active Games' },
  { filter: 'Completed', label: 'Game History' },
];

const EMPTY_LABELS: Record<MatchFilter, string> = {
  Active: "You're not in any games. Create a match, or find one to join.",
  Joinable: 'No open seats right now. Create a match and others can join it.',
  Completed: 'Finished games will show up here.',
};

// The lobby's list rows come from the lightweight D1 "MatchSummary" shape (`{ id, status,
// playerCount, updatedOn }`) - it carries no team composition, unlike the full MatchState a match
// page would have. Without per-team occupancy to drive a team picker, a single "Join" button is
// the simplest reasonable UX for this task; the server (`validation.ts`'s `assertTeamNotFull`,
// called from `matchEngine.ts`'s `addPlayer`) validates team capacity and rejects a full team,
// which surfaces here as a mutation error rather than a client-side team-select flow.
//
// Which team the button requests, though, can't be a fixed constant: `createMatch` always seats
// the creator on TeamA (position First - matchEngine.ts's `createMatch`), and every join since has
// gone through this same alternating pattern, so a match's `playerCount` alone tells us which team
// still has room - 1 seated (TeamA) -> join TeamB; 2 seated (1 per team) -> join TeamA; 3 seated (2
// TeamA, 1 TeamB) -> join TeamB. A fixed TeamA here was the scoped re-review's CRITICAL 3 finding:
// once the server's team-capacity guard is real, every 3rd join permanently fails "Team is full",
// so no match could ever reach 4 players through the UI.
const TEAM_A = 1; // Teams.TeamA in @fortytwo/rules
const TEAM_B = 2; // Teams.TeamB in @fortytwo/rules

function joinTeamFor(playerCount: number): number {
  return playerCount % 2 === 1 ? TEAM_B : TEAM_A;
}

// A table seen from above: four seats around a square of mat, filled in the order players sit
// down (the creator nearest you, then around the table). Says "how full is this game" at a glance.
const SEAT_ORDER = ['bottom', 'left', 'top', 'right'] as const;

function SeatGlyph({ seated }: { seated: number }): JSX.Element {
  return (
    <span className="seat-glyph" aria-hidden="true">
      <span className="seat-glyph-table" />
      {SEAT_ORDER.map((seat, i) => (
        <span key={seat} className={`seat-glyph-seat seat-glyph-${seat}${i < seated ? ' is-seated' : ''}`} />
      ))}
    </span>
  );
}

// "Alice & Cara vs Bob & bot-3". A team nobody has joined yet reads as "?"; a row with no players
// at all falls back to the match id so it still has a label.
function formatMatchup({ id, teams }: MatchSummary): string {
  if (teams.every((team) => team.length === 0)) return id;
  return teams.map((team) => (team.length > 0 ? team.join(' & ') : '?')).join(' vs ');
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
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

  const [activeTab, setActiveTab] = useState<MatchFilter>('Active');
  const activeTabLabel = TABS.find((tab) => tab.filter === activeTab)?.label ?? activeTab;

  const matchesQuery = useQuery({
    queryKey: ['matches', activeTab] as const,
    queryFn: () => client.listMatches(activeTab),
  });
  const matches = matchesQuery.data;

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
      <header className="lobby-header">
        <h1 className="page-title">Matches</h1>
        <button
          type="button"
          className="action-button"
          onClick={() => createMatch.mutate()}
          disabled={createMatch.isPending}
        >
          {createMatch.isPending ? 'Creating…' : 'Create match'}
        </button>
      </header>
      {createMatch.isError && (
        <p role="alert" className="page-error">
          {errorMessage(createMatch.error)}
        </p>
      )}
      {joinMatch.isError && (
        <p role="alert" className="page-error">
          {errorMessage(joinMatch.error)}
        </p>
      )}

      <div className="lobby-tabs" role="tablist" aria-label="Match lists">
        {TABS.map((tab) => (
          <button
            key={tab.filter}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.filter}
            className={`lobby-tab${activeTab === tab.filter ? ' lobby-tab-active' : ''}`}
            onClick={() => setActiveTab(tab.filter)}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          className="lobby-refresh"
          title="Refresh list"
          aria-label={`Refresh ${activeTabLabel}`}
          disabled={matchesQuery.isFetching}
          onClick={() => matchesQuery.refetch()}
        >
          <span
            className={`oi oi-loop-circular${matchesQuery.isFetching ? ' spinner-reverse' : ''}`}
            aria-hidden="true"
          ></span>
        </button>
      </div>

      <section className="lobby-section mat-panel" aria-label={activeTabLabel}>
        {matchesQuery.isLoading && <p className="lobby-note">Loading…</p>}
        {matchesQuery.error != null && (
          <p role="alert" className="page-error">
            {errorMessage(matchesQuery.error)}
          </p>
        )}
        {!matchesQuery.isLoading && matchesQuery.error == null && (matches == null || matches.length === 0) && (
          <p className="lobby-note">{EMPTY_LABELS[activeTab]}</p>
        )}
        {matches != null && matches.length > 0 && (
          <ul className="lobby-match-list">
            {matches.map((match) => (
              <li key={match.id} className="lobby-match-row">
                <Link to={`/match/${match.id}`} className="lobby-match-link">
                  <SeatGlyph seated={match.playerCount} />
                  <span className="lobby-match-text">
                    <span className="lobby-match-players">{formatMatchup(match)}</span>
                    <span className="lobby-match-meta">
                      {match.playerCount} of 4 seated, updated {formatUpdated(match.updatedOn)}
                    </span>
                  </span>
                </Link>
                {activeTab === 'Joinable' && (
                  <button
                    type="button"
                    className="action-button action-button-small"
                    onClick={() => joinMatch.mutate({ id: match.id, team: joinTeamFor(match.playerCount) })}
                    disabled={joinMatch.isPending}
                  >
                    Join
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
