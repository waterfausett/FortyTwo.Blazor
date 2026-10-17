// Hints in a practice match (#76), the parts both apps share: when the Hint button shows, asking
// the Worker until its model has warmed up, and the words a hint is shown in.
import {
  Bid, bidToPrettyString, isLow, lowDoublesToPrettyString, matchMode, suitToPrettyString, type MatchState, type Suit,
} from '@fortytwo/rules';
import type { BidSuggestion, Hint, HintDomino, HintResponse } from '@fortytwo/api-types';
import { ApiError } from './api';
import { describeMatch } from './matchView';

// A cold Worker loads its model one piece per call (about 7 calls); spaced this far apart.
export const HINT_RETRY_MS = 400;
export const HINT_GIVE_UP_MS = 10_000;
export const HINT_UNAVAILABLE = "Hints aren't available right now.";

const aborted = () => Object.assign(new Error('Hint request aborted'), { name: 'AbortError' });
export const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

// Asks for a hint until the Worker stops answering 'warming'. Rejects with HINT_UNAVAILABLE when
// the model is unavailable or still warming after HINT_GIVE_UP_MS, with the Worker's own error for
// a refusal, and with an AbortError once `signal` aborts (callers drop that one silently).
export async function fetchHint(getHint: () => Promise<HintResponse>, signal?: AbortSignal): Promise<Hint> {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw aborted();
    const res = await getHint();
    if (signal?.aborted) throw aborted();
    if (res.status === 'ready') return res.hint;
    if (res.status === 'unavailable' || Date.now() - started >= HINT_GIVE_UP_MS) throw new Error(HINT_UNAVAILABLE);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, HINT_RETRY_MS);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(aborted());
      }, { once: true });
    });
  }
}

// The Hint button shows in a practice match with bots on, on my turn to bid, name trump or play,
// while the hand is still open (the Worker's hints.ts makes the final call).
export function canAskForHint(match: MatchState | null, myPlayerId: string | undefined, botsEnabled: boolean): boolean {
  if (!match || !myPlayerId || !botsEnabled || matchMode(match) !== 'bots') return false;
  if (!match.players.some((p) => p.playerId === myPlayerId)) return false;
  const view = describeMatch(match, myPlayerId);
  return !view.isHandOver && (view.canBid || view.canSelectTrump || view.isMyTurnToPlay);
}

// Names the decision a hint was asked for: any change to the match is a new one, so a hint never
// outlives the turn it was for.
export function hintTurnKey(match: MatchState): string {
  return `${match.currentGame.id}:${match.currentGame.currentPlayerId}:${match.updatedOn}`;
}

export function hintErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? error.title;
  return error instanceof Error ? error.message : HINT_UNAVAILABLE;
}

const percent = (p: number | null) => (p === null ? '' : `${Math.round(p * 100)}%`);
const marks = (gap: number) => `−${gap.toFixed(2)} marks`;

function trumpLabel(trump: number): string {
  return isLow(trump as Suit) ? `Low (doubles ${lowDoublesToPrettyString(trump as Suit).toLowerCase()})` : suitToPrettyString(trump as Suit);
}

function bidLabel(s: BidSuggestion): string {
  const bid = bidToPrettyString(s.bid as Bid);
  return s.trump === null ? bid : `${bid} · ${trumpLabel(s.trump)}`;
}

// High end first, as a domino is usually read: 6-4.
const dominoLabel = (d: HintDomino) => `${Math.max(d.top, d.bottom)}-${Math.min(d.top, d.bottom)}`;

export function hintHeadline(hint: Hint): string {
  switch (hint.kind) {
    case 'bid': {
      const s = hint.suggestion;
      if (s.bid === Bid.Pass) return 'Pass';
      return s.pMake === null ? `Bid ${bidLabel(s)}` : `Bid ${bidLabel(s)}, ${percent(s.pMake)} to make`;
    }
    case 'trump': {
      const s = hint.suggestion;
      return s.pMake === null ? trumpLabel(s.trump) : `${trumpLabel(s.trump)}, ${percent(s.pMake)} to make`;
    }
    case 'play':
      return `Play ${dominoLabel(hint.dominoes[0].domino)}`;
  }
}

export interface HintRow {
  key: string;
  label: string;
  detail: string;
  suggested: boolean;
}

export function hintRows(hint: Hint): HintRow[] {
  switch (hint.kind) {
    case 'bid':
      return hint.options.map((o) => ({
        key: String(o.bid), label: bidLabel(o), detail: percent(o.pMake), suggested: o.bid === hint.suggestion.bid,
      }));
    case 'trump':
      return hint.options.map((o, i) => ({
        key: String(o.trump), label: trumpLabel(o.trump), detail: percent(o.pMake), suggested: i === 0,
      }));
    case 'play':
      return hint.dominoes.map((r) => ({
        key: r.domino.id,
        label: dominoLabel(r.domino),
        detail: r.rating === 'best' ? 'best' : `${r.rating} (${marks(r.gap)})`,
        suggested: r.rating === 'best',
      }));
  }
}

export const suggestedBid = (hint: Hint | null): number | null => (hint?.kind === 'bid' ? hint.suggestion.bid : null);
export const suggestedTrump = (hint: Hint | null): number | null => (hint?.kind === 'trump' ? hint.suggestion.trump : null);
export const suggestedDominoIds = (hint: Hint | null): string[] =>
  hint?.kind === 'play' ? hint.dominoes.filter((r) => r.rating === 'best').map((r) => r.domino.id) : [];
