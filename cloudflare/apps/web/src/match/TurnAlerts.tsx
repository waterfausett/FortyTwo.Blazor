// Tells a player the table is waiting on them (issue #2), for when they've looked away from it:
// their turn has come, or the hand is over and they've yet to ready up (or vote on a rematch, once
// the match is over). Match.tsx works out that call; this draws nothing, and is only rendered once
// the match has loaded, so whatever the page opens on (which the player is already looking at)
// never counts as a new call. The on-page cue for a turn is styles/match.css's one-shot flash on
// `.active`; this adds what reaches past the page:
//
//   - a chime, per the player's Sound setting (match/alertPrefs.ts): while away, always, or never;
//   - while away, a tab title that blinks the call ("● Your lead") and a favicon with a brass dot,
//     until they come back or the call is answered;
//   - while away, a system notification, if they switched those on and the browser allows it.
//
// "Away" is a hidden tab or an unfocused window.
//
// The mobile app gets push notifications instead (apps/worker/src/push/), but only when it has no
// socket open on the match - and a web tab keeps its socket in the background, so a player looking
// away from it hears nothing from the Worker. This covers that, saying what the push would
// (apps/worker/src/push/notices.ts).
import { useEffect, useRef } from 'react';
import { readAlertPrefs } from './alertPrefs';
import { playChime } from '../ui/chime';

const TURN_FAVICON = '/favicon-turn.svg';
const TITLE_BLINK_MS = 1000;

function isAway(): boolean {
  return document.hidden || !document.hasFocus();
}

// Starts the title blink and favicon dot; the returned function puts both back (safe to call twice).
function flashTab(callTitle: string): () => void {
  const title = document.title;
  const flashTitle = `● ${callTitle}`;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const iconHref = icon?.getAttribute('href') ?? null;

  document.title = flashTitle;
  icon?.setAttribute('href', TURN_FAVICON);
  const blink = setInterval(() => {
    document.title = document.title === flashTitle ? title : flashTitle;
  }, TITLE_BLINK_MS);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(blink);
    document.title = title;
    if (icon && iconHref != null) icon.setAttribute('href', iconHref);
  };
}

function notify(title: string, body: string, tag: string): Notification | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  try {
    // One tag per match, so a new call replaces the last notice instead of stacking.
    const notification = new Notification(title, { body, tag, icon: '/favicon.svg' });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return notification;
  } catch {
    // Some browsers (Android Chrome) only allow notifications from a service worker.
    return null;
  }
}

// What the table is waiting on the player for, in the push notices' words: their turn ("Your
// lead" / "Game 3 is waiting on you."), or a hand or the match over.
export interface TableCall {
  kind: 'turn' | 'handOver' | 'matchOver';
  title: string;
  body: string;
}

export interface TurnAlertsProps {
  // Null when the table isn't waiting on this player.
  call: TableCall | null;
  // Identifies the match, so its notifications replace one another.
  tag: string;
}

export function TurnAlerts({ call, tag }: TurnAlertsProps): null {
  // A new kind of call alerts; the same one with new words doesn't - winning a trick turns "Your
  // play" into "Your lead" without the turn ever leaving the player.
  const kind = call?.kind ?? null;
  const lastKindRef = useRef(kind);
  // Read when a call starts, without restarting the alert if its words change.
  const messageRef = useRef({ call, tag });
  // Declared first, so it has caught up before the effect below reads it.
  useEffect(() => {
    messageRef.current = { call, tag };
  });

  useEffect(() => {
    const started = kind != null && kind !== lastKindRef.current;
    lastKindRef.current = kind;
    const { call: current, tag: noticeTag } = messageRef.current;
    if (!started || !current) return;

    const prefs = readAlertPrefs();
    const away = isAway();
    if (prefs.sound === 'always' || (prefs.sound === 'away' && away)) playChime();
    if (!away) return;

    const stopFlash = flashTab(current.title);
    const notification = prefs.desktop ? notify(current.title, current.body, noticeTag) : null;
    function stop(): void {
      stopFlash();
      notification?.close();
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    }
    function onReturn(): void {
      if (!isAway()) stop();
    }
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    // The call was answered or moved on (or the page went away) - nothing left to point at.
    return stop;
  }, [kind]);

  return null;
}
