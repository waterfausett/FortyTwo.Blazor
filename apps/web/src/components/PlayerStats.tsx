// The Profile page's Stats card: the player's own record from completed matches (GET
// /api/users/stats), filtered to All, Humans only or With bots. Its own query, so a failure here
// leaves the rest of the Profile working. The figures and their wording come from
// @fortytwo/client's statSections, shared with the mobile app.
import { useState } from 'react';
import type { JSX } from 'react';
import type { StatsFilter } from '@fortytwo/api-types';
import { bestPartnerRecord, favoriteTrumpRecord, statSections, STATS_FILTERS, trumpLabel } from '@fortytwo/client';
import { useStats } from '../api/useStats';

export function PlayerStats(): JSX.Element {
  const stats = useStats();
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

      {stats.data && stats.data.all.played === 0 && <p className="profile-hint">Finish a match to see your stats here.</p>}

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

          {statSections(summary).map((section) => (
            <section key={section.key} className="stat-section" aria-labelledby={`stats-${section.key}`}>
              <h3 id={`stats-${section.key}`} className="stat-section-title">
                {section.title}
              </h3>
              <dl className="stat-grid">
                {section.tiles.map(({ label, value }) => (
                  <div key={label} className="stat-tile">
                    <dt className="stat-label">{label}</dt>
                    <dd className="stat-value">{value}</dd>
                  </div>
                ))}
              </dl>

              {section.key === 'matches' && summary.bestPartner && (
                <p className="stat-partner">
                  Best partner: <strong>{summary.bestPartner.user.displayName}</strong>{' '}
                  <span className="stat-partner-record">{bestPartnerRecord(summary.bestPartner)}</span>
                </p>
              )}

              {section.key === 'bidding' && summary.favoriteTrump && (
                <p className="stat-partner">
                  Favorite trump: <strong>{trumpLabel(summary.favoriteTrump.trump)}</strong>{' '}
                  <span className="stat-partner-record">{favoriteTrumpRecord(summary.favoriteTrump, summary.bidsWon)}</span>
                </p>
              )}
            </section>
          ))}
        </>
      )}
    </section>
  );
}
