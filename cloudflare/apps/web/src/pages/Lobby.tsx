// The lobby: the player's matches (Active, the default, and Game History) plus the New match
// chooser - Live and Async matchmaking, or a custom table to share with friends.
//
// Only the selected tab's list is ever fetched - one page (20) at a time, with Load more for the
// next - and the single `useInfiniteQuery` below is keyed on `activeTab`, so switching tabs just
// mounts a new query instance instead of eagerly fetching both lists up front. There's no
// `refetchInterval` cadence either: Active games are expected to stay fairly static now that
// in-match play has its own WebSocket (useMatchSocket) carrying real-time updates once you're
// actually in a match - the lobby just needs a reasonably fresh snapshot, not a live feed. A manual
// refresh icon button (open-iconic's oi-loop-circular, loaded via app.css) refetches whichever tab
// is currently selected.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useGetToken } from '../auth/useGetToken';
import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { HouseRules } from '@fortytwo/rules';
import type { JSX } from 'react';
import { rowLabel, rowStatus, uniqueMatches, yourTurnFirst } from '@fortytwo/client';
import { apiClient, type MatchPage, type MatchSummary } from '../api/client';
import { useOnline } from '../api/presence';
import { NewMatchDialog, type NewMatchChoice } from '../components/NewMatchDialog';
import { SEAT_SIDES } from '../components/SeatPicker';
import { useHowToPlay } from '../match/useHowToPlay';
import '../components/HowToPlay.css';
import './Lobby.css';

type MatchFilter = 'Active' | 'Completed';

const TABS: { filter: MatchFilter; label: string }[] = [
  { filter: 'Active', label: 'Active' },
  { filter: 'Completed', label: 'Game History' },
];

const EMPTY_LABELS: Record<MatchFilter, string> = {
  Active: "You're not in any games. Start a new match.",
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

  // A first-time player is offered the rules until they dismiss the card or open them.
  const howToPlay = useHowToPlay(client);

  const [activeTab, setActiveTab] = useState<MatchFilter>('Active');
  const activeTabLabel = TABS.find((tab) => tab.filter === activeTab)?.label ?? activeTab;

  const matchesQuery = useInfiniteQuery({
    queryKey: ['matches', activeTab] as const,
    queryFn: ({ pageParam }) => client.listMatches(activeTab, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const matches = uniqueMatches(matchesQuery.data?.pages);
  const rows = matches && yourTurnFirst(matches);
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

  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig() });
  const online = useOnline();
  const [choosing, setChoosing] = useState(false);

  // Live and Async seat the player through matchmaking; Custom Match starts a custom table; Play
  // vs bots starts a game against three bots.
  const startMatch = useMutation({
    mutationFn: ({ choice, rules }: { choice: NewMatchChoice; rules?: HouseRules }) =>
      choice === 'challenge' ? client.createMatch(rules) : choice === 'bots' ? client.playBots() : client.play(choice),
    onSuccess: (match) => {
      setChoosing(false);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate(`/match/${match.id}`);
    },
    // The dialog shows the error. A timeout may still have seated the player, so refetch the list.
    onError: () => queryClient.invalidateQueries({ queryKey: ['matches'] }),
  });
  function choose() {
    startMatch.reset();
    setChoosing(true);
  }

  return (
    <div className="lobby">
      <header className="lobby-header">
        <h1 className="page-title">Matches</h1>
        <button
          type="button"
          className="action-button"
          onClick={choose}
        >
          New match
        </button>
      </header>
      {howToPlay.offer && (
        <aside className="how-to-play-card" aria-label="New to Forty-Two">
          <Link to="/how-to-play">New to 42? Learn how to play</Link>
          <button type="button" aria-label="Dismiss" onClick={howToPlay.markSeen}>
            ×
          </button>
        </aside>
      )}
      <NewMatchDialog
        open={choosing}
        liveEnabled={config.data?.bots ?? false}
        online={online}
        pending={startMatch.isPending ? startMatch.variables.choice : null}
        error={startMatch.error ? errorMessage(startMatch.error) : null}
        onChoose={(choice, rules) => startMatch.mutate({ choice, rules })}
        onClose={() => setChoosing(false)}
      />

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
        {!matchesQuery.isLoading && matchesQuery.error == null && (rows == null || rows.length === 0) && (
          <p className="lobby-note">{EMPTY_LABELS[activeTab]}</p>
        )}
        {rows != null && rows.length > 0 && (
          <ul className="lobby-match-list">
            {rows.map((match) => {
              const status = rowStatus(match);
              return (
                <li key={match.id} className="lobby-match-row">
                  <Link to={`/match/${match.id}`} className="lobby-match-link">
                    <SeatGlyph seats={match.seats} />
                    <span className="lobby-match-text">
                      <span className="lobby-match-players">{formatMatchup(match)}</span>
                      <span className="lobby-match-meta">
                        {status.yours ? rowLabel(match) : `${rowLabel(match)} · ${status.text}`} · {formatUpdated(match.updatedOn)}
                      </span>
                    </span>
                  </Link>
                  {status.yours && <span className="lobby-badge">{status.text}</span>}
                </li>
              );
            })}
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
