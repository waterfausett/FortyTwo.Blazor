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
import { useGetToken } from '../auth/useGetToken';
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

// A table seen from above, indexed by seat position: the creator's seat (0) nearest you, then
// clockwise in turn order - the same layout the match screen uses (match/table.ts), so the seat
// you pick here is where you'll sit relative to the others there. Partners sit across.
const SEAT_SIDES = ['bottom', 'left', 'top', 'right'] as const;

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

// The Join flow for a Find a Game row: the table again, bigger, with each taken seat's name and a
// button in each open one. An open seat says who you'd partner with, since that's what picking a
// seat really decides (along with who plays before and after you).
function SeatPicker({
  seats,
  disabled,
  onPick,
}: {
  seats: (string | null)[];
  disabled: boolean;
  onPick: (position: number) => void;
}): JSX.Element {
  return (
    <div className="seat-picker" role="group" aria-label="Pick a seat">
      <span className="seat-picker-table" aria-hidden="true" />
      {SEAT_SIDES.map((side, position) => {
        const name = seats[position];
        if (name != null) {
          return (
            <span key={side} className={`seat-picker-seat seat-picker-${side} is-seated`}>
              {name}
            </span>
          );
        }
        const partner = seats[(position + 2) % 4];
        return (
          <button
            key={side}
            type="button"
            className={`seat-picker-seat seat-picker-${side}`}
            disabled={disabled}
            onClick={() => onPick(position)}
          >
            <span className="seat-picker-action">Sit here</span>
            <span className="seat-picker-hint">{partner != null ? `with ${partner}` : 'open seat'}</span>
          </button>
        );
      })}
    </div>
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
      </section>
    </div>
  );
}
