// The lobby: a tabbed match list (Find a Game / Active / Game History, defaulting to Active) plus
// create/join actions.
//
// Only the selected tab's list is ever fetched - one page (20) at a time, with Load more for the
// next - and the single `useInfiniteQuery` below is keyed on `activeTab`, so switching tabs just
// mounts a new query instance instead of eagerly fetching all three lists up front. There's no `refetchInterval` cadence either: Active games are expected to
// stay fairly static now that in-match play has its own WebSocket (useMatchSocket) carrying
// real-time updates once you're actually in a match - the lobby just needs a reasonably fresh
// snapshot, not a live feed. A manual refresh icon button (open-iconic's oi-loop-circular, loaded
// via app.css) refetches whichever tab is currently selected.
// Find a Game may want its own polling/push back later (matches can appear from other players at
// any time) - left as-is for now per explicit product direction.
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useGetToken } from '../auth/useGetToken';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { JSX } from 'react';
import { uniqueMatches } from '@fortytwo/client';
import { apiClient, type MatchPage, type MatchSummary } from '../api/client';
import { SEAT_SIDES, SeatPicker } from '../components/SeatPicker';
import './Lobby.css';

type MatchFilter = 'Active' | 'Joinable' | 'Completed';

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


function SeatGlyph({ seats }: { seats: (string | null)[] }): JSX.Element {
  return (
    <span className="seat-glyph" aria-hidden="true">
      <span className="seat-glyph-table" />
      {SEAT_SIDES.map((side, position) => (
        <span key={side} className={`seat-glyph-seat seat-glyph-${side}${seats[position] != null ? ' is-seated' : ''}`} />
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const client = apiClient(useGetToken());

  const [activeTab, setActiveTab] = useState<MatchFilter>('Active');
  const activeTabLabel = TABS.find((tab) => tab.filter === activeTab)?.label ?? activeTab;

  const matchesQuery = useInfiniteQuery({
    queryKey: ['matches', activeTab] as const,
    queryFn: ({ pageParam }) => client.listMatches(activeTab, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const matches = uniqueMatches(matchesQuery.data?.pages);
  // "Load more" fetches too, but only a refresh spins the refresh icon.
  const refreshing = matchesQuery.isFetching && !matchesQuery.isFetchingNextPage;

  // Back to the first page: drop the rest from the cache, then refetch what's left - one request,
  // with the list kept on screen meanwhile.
  function refresh() {
    queryClient.setQueryData<InfiniteData<MatchPage, string | undefined>>(['matches', activeTab], (data) =>
      data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    );
    void matchesQuery.refetch();
  }

  const createMatch = useMutation({
    mutationFn: () => client.createMatch(),
    onSuccess: (match) => {
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate(`/match/${match.id}`);
    },
  });

  // The Find a Game row whose seat picker is open, if any.
  const [pickingSeatIn, setPickingSeatIn] = useState<string | null>(null);

  const joinMatch = useMutation({
    mutationFn: ({ id, position }: { id: string; position: number }) => client.joinMatch(id, position),
    onSuccess: (match) => {
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate(`/match/${match.id}`);
    },
    // Most likely someone took the seat first - refetch so the picker shows who.
    onError: () => queryClient.invalidateQueries({ queryKey: ['matches'] }),
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
          disabled={refreshing}
          onClick={refresh}
        >
          <span
            className={`oi oi-loop-circular${refreshing ? ' spinner-reverse' : ''}`}
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
                  <SeatGlyph seats={match.seats} />
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
                    aria-expanded={pickingSeatIn === match.id}
                    onClick={() => setPickingSeatIn(pickingSeatIn === match.id ? null : match.id)}
                  >
                    {pickingSeatIn === match.id ? 'Cancel' : 'Join'}
                  </button>
                )}
                {activeTab === 'Joinable' && pickingSeatIn === match.id && (
                  <SeatPicker
                    seats={match.seats}
                    disabled={joinMatch.isPending}
                    onPick={(position) => joinMatch.mutate({ id: match.id, position })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {matchesQuery.hasNextPage && (
          <button
            type="button"
            className="action-button action-button-small lobby-load-more"
            disabled={matchesQuery.isFetchingNextPage}
            onClick={() => void matchesQuery.fetchNextPage()}
          >
            {matchesQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </section>
    </div>
  );
}
