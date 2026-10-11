// The Profile page's Stats card: the player's own record from completed games (GET
// /api/users/stats), filtered to All, Humans only or With bots. Its own query, so a failure here
// leaves the rest of the Profile working. The figures and their wording come from
// @fortytwo/client's statTiles, shared with the mobile app.
import { useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StatsFilter } from '@fortytwo/api-types';
import { bestPartnerRecord, STATS_FILTERS, statTiles } from '@fortytwo/client';
import { useGetToken } from '../auth/useGetToken';
import { apiClient } from '../api/client';

export function PlayerStats(): JSX.Element {
  const client = apiClient(useGetToken());
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => client.getStats() });
  const [filter, setFilter] = useState<StatsFilter>('all');

  const summary = stats.data?.[filter];

  return (
    <section className="profile-card mat-panel" aria-labelledby="stats-title">
      <h2 id="stats-title" className="profile-section-title">
        Stats
      </h2>

      {stats.isLoading && <div className="spinner" role="status" aria-label="Loading stats" />}

      {stats.error != null && (
        <p role="alert" className="page-error">
          {stats.error instanceof Error ? stats.error.message : 'Something went wrong.'}
        </p>
      )}

      {stats.data && stats.data.all.played === 0 && <p className="profile-hint">Finish a game to see your stats here.</p>}

      {stats.data && stats.data.all.played > 0 && summary && (
        <>
          <fieldset className="form-group">
            <legend className="visually-hidden">Which games</legend>
            <div className="profile-choices">
              {STATS_FILTERS.map(({ filter: value, label }) => (
                <label key={value} className="profile-choice">
                  <input
                    type="radio"
                    name="statsFilter"
                    value={value}
                    checked={filter === value}
                    onChange={() => setFilter(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <dl className="stat-grid">
            {statTiles(summary).map(({ label, value }) => (
              <div key={label} className="stat-tile">
                <dt className="stat-label">{label}</dt>
                <dd className="stat-value">{value}</dd>
              </div>
            ))}
          </dl>

          {summary.bestPartner && (
            <p className="stat-partner">
              Best partner: <strong>{summary.bestPartner.user.displayName}</strong>{' '}
              <span className="stat-partner-record">{bestPartnerRecord(summary.bestPartner)}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
