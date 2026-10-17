// What a Live search shows in place of the table: who's online, the bar toward the bots taking the
// empty seats, who has sat down on each team, a card of tips and stats to read while waiting, and
// Start with bots / Cancel search. When a seat fills it says so to a screen reader ("Maria joined,
// 2 of 4") - never the timer, and never the card paging. Styles in SearchLobby.css.
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  LOBBY_CARD_MS,
  fillProgress,
  formatClock,
  joinAnnouncement,
  lobbyDots,
  rosterIds,
  type LobbyCard,
  type LobbyRoster,
} from '@fortytwo/client';
import { NameSkeleton } from './NameSkeleton';
import './SearchLobby.css';

export function SearchLobby({
  roster,
  viewerId,
  nameOf,
  online,
  elapsedMs,
  full,
  cards,
  onStartWithBots,
  startDisabled,
  onCancel,
  cancelDisabled,
  onHowToPlay,
}: {
  roster: LobbyRoster;
  viewerId: string;
  // null while the name loads.
  nameOf: (playerId: string) => string | null;
  online: number | null;
  // null without bots: there's no fill to count down to.
  elapsedMs: number | null;
  full: boolean;
  cards: LobbyCard[];
  onStartWithBots: (() => void) | null;
  startDisabled: boolean;
  onCancel: () => void;
  cancelDisabled: boolean;
  // The scoreboard's "?" is gone with the table, so the lobby offers the rules itself.
  onHowToPlay?: () => void;
}): JSX.Element {
  const ids = rosterIds(roster);
  const previous = useRef(ids);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    // A newcomer's name is looked up after they sit down: wait for it, so they're announced by name.
    if (ids.some((id) => id !== null && nameOf(id) === null)) return;
    const message = joinAnnouncement(previous.current, ids, nameOf);
    previous.current = ids;
    if (message) setAnnouncement(message);
  });

  const progress = elapsedMs === null ? null : fillProgress(elapsedMs);
  const row = (playerId: string | null, partnerSeat: boolean) => (
    <RosterRow
      playerId={playerId}
      you={playerId !== null && playerId === viewerId}
      name={playerId === null ? null : nameOf(playerId)}
      emptyText={partnerSeat && roster.seated ? 'Partner · searching…' : 'Searching…'}
    />
  );

  return (
    <section className="search-lobby" aria-labelledby="search-lobby-title">
      <div className="search-lobby-heading">
        <h2 id="search-lobby-title">Finding players</h2>
        <span className="search-lobby-heading-end">
          {online !== null && <span className="search-lobby-online">{online} online</span>}
          {onHowToPlay && (
            <button type="button" className="contract-rules" aria-label="How to play" onClick={onHowToPlay}>
              ?
            </button>
          )}
        </span>
      </div>

      {full ? (
        <p className="search-lobby-full">Table full</p>
      ) : (
        progress && (
          <div className="search-lobby-bar">
            <div className="search-lobby-track">
              <div className="search-lobby-fill" style={{ width: `${progress.fraction * 100}%` }} />
            </div>
            <span className="search-lobby-time">{`${formatClock(progress.remainingMs)} 🤖`}</span>
          </div>
        )
      )}

      <div className="search-lobby-roster">
        <h3 className="search-lobby-group search-lobby-us">Us</h3>
        <ul>
          <li>{row(roster.us[0], false)}</li>
          <li>{row(roster.us[1], true)}</li>
        </ul>
        <p className="search-lobby-vs" aria-hidden="true">
          vs
        </p>
        <h3 className="search-lobby-group search-lobby-them">Them</h3>
        <ul>
          <li>{row(roster.them[0], false)}</li>
          <li>{row(roster.them[1], false)}</li>
        </ul>
      </div>

      <LobbyCarousel cards={cards} />

      <div className="search-lobby-buttons">
        {onStartWithBots && (
          <button type="button" className="action-button" disabled={startDisabled} onClick={onStartWithBots}>
            Start with bots
          </button>
        )}
        <button type="button" className="search-lobby-cancel" disabled={cancelDisabled} onClick={onCancel}>
          Cancel search
        </button>
      </div>

      <p role="status" className="visually-hidden">
        {announcement}
      </p>
    </section>
  );
}

function RosterRow({ playerId, you, name, emptyText }: { playerId: string | null; you: boolean; name: string | null; emptyText: string }) {
  if (playerId === null) {
    return (
      <div className="search-lobby-row is-empty">
        <span className="search-lobby-avatar" aria-hidden="true">
          ?
        </span>
        <span className="search-lobby-name">{emptyText}</span>
      </div>
    );
  }
  return (
    <div className={`search-lobby-row${you ? ' is-you' : ''}`}>
      <span className="search-lobby-avatar" aria-hidden="true">
        {you ? 'Y' : (name?.trim()[0]?.toUpperCase() ?? '')}
      </span>
      {you ? (
        <span className="search-lobby-name">You</span>
      ) : name !== null ? (
        <span className="search-lobby-name">{name}</span>
      ) : (
        <NameSkeleton width="8em" />
      )}
    </div>
  );
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// Tips and the player's own stats, one card at a time: a scroll-snap strip the player can swipe,
// with a sliding row of dots (lobbyDots). It moves on by itself every LOBBY_CARD_MS, except under reduced motion,
// while the pointer is over it, or for LOBBY_CARD_MS after the player swiped or picked a dot.
function LobbyCarousel({ cards }: { cards: LobbyCard[] }): JSX.Element {
  const strip = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  const hovered = useRef(false);
  const touchedAt = useRef(0);
  const count = cards.length;

  function show(next: number) {
    const el = strip.current;
    el?.scrollTo?.({ left: next * el.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    setPage(next);
  }

  useEffect(() => {
    if (count < 2 || reducedMotion()) return;
    const timer = setInterval(() => {
      if (hovered.current || Date.now() - touchedAt.current < LOBBY_CARD_MS) return;
      show((pageRef.current + 1) % count);
    }, LOBBY_CARD_MS);
    return () => clearInterval(timer);
  }, [count]);

  const touched = () => (touchedAt.current = Date.now());

  return (
    <div className="search-lobby-card-wrap" onMouseEnter={() => (hovered.current = true)} onMouseLeave={() => (hovered.current = false)}>
      <div
        ref={strip}
        className="search-lobby-cards"
        onPointerDown={touched}
        onWheel={touched}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.clientWidth > 0) setPage(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {cards.map((card, i) => (
          <div key={i} className="search-lobby-card">
            <CardPage card={card} />
          </div>
        ))}
      </div>
      {count > 1 && (
        <div className="search-lobby-dots">
          {lobbyDots(count, page % count).map(({ index: i, size }) => (
            <button
              key={i}
              type="button"
              className="search-lobby-dot"
              data-size={size}
              aria-label={`Card ${i + 1} of ${count}`}
              aria-current={i === page % count ? 'true' : undefined}
              onClick={() => {
                touched();
                show(i);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CardPage({ card }: { card: LobbyCard }): JSX.Element {
  if (card.kind === 'tip') {
    return (
      <>
        <p className="search-lobby-card-label">Did you know</p>
        <p className="search-lobby-tip">{card.text}</p>
      </>
    );
  }
  return (
    <>
      <p className="search-lobby-card-label">Your stats</p>
      {card.kind === 'summary' ? (
        <dl className="search-lobby-summary">
          {card.items.map((item) => (
            <div key={item.label}>
              <dd>{item.value}</dd>
              <dt>{item.label}</dt>
            </div>
          ))}
        </dl>
      ) : (
        <div className="search-lobby-record">
          <span className="search-lobby-hint">{card.kind === 'favoriteTrump' ? 'Favorite trump' : 'Best partner'}</span>
          <span className="search-lobby-headline">{card.kind === 'favoriteTrump' ? card.trump : card.name}</span>
          <span className="search-lobby-hint">{card.record}</span>
        </div>
      )}
    </>
  );
}
