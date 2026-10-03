// Tells a player their turn has come (issue #2), for when they've looked away from the table. Draws
// nothing - Match.tsx renders it once the match has loaded, so the turn the page opens on (which
// the player is already looking at) never counts as one starting. The on-page cue is styles/
// match.css's one-shot flash on `.active`; this adds what reaches past the page:
//
//   - a chime, per the player's Sound setting (match/alertPrefs.ts): while away, always, or never;
//   - while away, a tab title that blinks "Your turn" and a favicon with a brass dot, until they
//     come back or the turn ends;
//   - while away, a system notification, if they switched those on and the browser allows it.
//
// "Away" is a hidden tab or an unfocused window.
//
// The mobile app gets push notifications instead (apps/worker/src/push/), but only when it has no
// socket open on the match - and a web tab keeps its socket in the background, so a player looking
// away from it hears nothing from the Worker. This covers that, saying what the push would.
import { useEffect, useRef } from 'react';
import { readAlertPrefs } from './alertPrefs';
import { playChime } from '../ui/chime';

const TURN_TITLE = '● Your turn';
const TURN_FAVICON = '/favicon-turn.svg';
const TITLE_BLINK_MS = 1000;

function isAway(): boolean {
  return document.hidden || !document.hasFocus();
}

// Starts the title blink and favicon dot; the returned function puts both back (safe to call twice).
function flashTab(): () => void {
  const title = document.title;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const iconHref = icon?.getAttribute('href') ?? null;

  document.title = TURN_TITLE;
  icon?.setAttribute('href', TURN_FAVICON);
  const blink = setInterval(() => {
    document.title = document.title === TURN_TITLE ? title : TURN_TITLE;
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
    // One tag per match, so a new turn replaces the last notice instead of stacking.
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

export interface TurnAlertsProps {
  isMyTurn: boolean;
  // The notification's words, as the mobile app's push notices put them (apps/worker/src/push/
  // notices.ts): what the turn asks for ("Your lead") and which game is waiting.
  title: string;
  body: string;
  // Identifies the match, so its notifications replace one another.
  tag: string;
}

export function TurnAlerts({ isMyTurn, title, body, tag }: TurnAlertsProps): null {
  const wasMyTurnRef = useRef(isMyTurn);
  // Read when a turn starts, without restarting the alert if the text changes mid-turn.
  const messageRef = useRef({ title, body, tag });
  // Declared first, so it has caught up before the effect below reads it.
  useEffect(() => {
    messageRef.current = { title, body, tag };
  });

  useEffect(() => {
    const started = isMyTurn && !wasMyTurnRef.current;
    wasMyTurnRef.current = isMyTurn;
    if (!started) return;

    const prefs = readAlertPrefs();
    const away = isAway();
    if (prefs.sound === 'always' || (prefs.sound === 'away' && away)) playChime();
    if (!away) return;

    const stopFlash = flashTab();
    const { title: noticeTitle, body: noticeBody, tag: noticeTag } = messageRef.current;
    const notification = prefs.desktop ? notify(noticeTitle, noticeBody, noticeTag) : null;
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
    // The turn ended (or the page went away) - nothing left to point at.
    return stop;
  }, [isMyTurn]);

  return null;
}
