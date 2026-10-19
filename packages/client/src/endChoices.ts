// What a finished match offers its players to do next, worked out from MatchState alone. Only a Live
// game has the full set (Party up, Find a game, Rematch); every other mode keeps its plain Rematch,
// so `live` tells a screen whether to show the Live panel at all. Shared by the web and mobile apps.
//
// The Live choices belong to the moment the game ends. Opened later (from history, say), a finished
// Live game offers nothing: by then the partner, the table and any game they led to have moved on.
// Nor does it ever link to the game a party or rematch went to, which may since have finished or
// been dropped: Find a game takes a player back to a Live game they're still in, so it does instead.
import { isBot, matchMode, partnerOf, rematchBlocked, teamForPosition, type MatchState } from '@fortytwo/rules';

export type PartyButton =
  // Not Live, not won, too long ago, viewer not seated, partied or rematch made, bot partner, or
  // viewer moved on.
  | { kind: 'hidden' }
  // "Party up with Sam", and whether Sam has already asked.
  | { kind: 'offer'; partnerOffered: boolean }
  // My offer stands; tapping cancels it.
  | { kind: 'waiting' }
  | { kind: 'partnerLeft' }
  | { kind: 'partnerBusy' };

// How long after a Live game ends someone opening it is still offered its choices.
export const LIVE_END_CHOICES_MS = 5 * 60_000;

export interface EndChoices {
  live: boolean;
  // A Live game that ended more than LIVE_END_CHOICES_MS before the screen opened: no choices at all.
  expired: boolean;
  partnerId: string | null;
  party: PartyButton;
  // The table can't be four again, or my own offer stands, so a rematch vote is off the table.
  rematchDisabled: boolean;
  // I turned up in another Live game, so the client sends me back to it.
  iAmBusy: boolean;
  // Find a game stands alone once my team has partied up or the rematch is made: it leads back to
  // that game while it's still going.
  showFindGame: boolean;
  showRematch: boolean;
}

// `openedAt` is when the screen showing the match opened (ms, server time): the Live choices are
// offered if the game ended less than LIVE_END_CHOICES_MS before that, or after it.
export function endChoices(match: MatchState, myPlayerId: string, openedAt: number): EndChoices {
  const live = matchMode(match) === 'live';
  const me = match.players.find((p) => p.playerId === myPlayerId);
  const partnerId = partnerOf(match, myPlayerId);
  const offers = match.partyOffers ?? [];
  const iOffered = offers.includes(myPlayerId);
  const expired =
    live && (match.wonOn === undefined || openedAt - Date.parse(match.wonOn) >= LIVE_END_CHOICES_MS);
  // My team went on to another game: partied up, or all four agreed to a rematch.
  const goneOn =
    (me !== undefined && match.partyMatchIds?.[teamForPosition(me.position)] !== undefined) ||
    match.rematchId !== undefined;

  return {
    live,
    expired,
    partnerId,
    party: partyButton(),
    rematchDisabled: rematchBlocked(match) || iOffered,
    iAmBusy: match.movedOn?.[myPlayerId] === 'busy',
    showFindGame: !expired,
    showRematch: !expired && !(live && goneOn),
  };

  // The order matters: first the cases with nothing to offer, then what became of the partner, and
  // only then where my own offer stands. A rematch already made seats the partners together, so
  // there's nothing left to party up for.
  function partyButton(): PartyButton {
    if (
      !live ||
      expired ||
      goneOn ||
      match.winningTeam === null ||
      !me ||
      partnerId === null ||
      isBot(partnerId) ||
      match.movedOn?.[myPlayerId] !== undefined
    ) {
      return { kind: 'hidden' };
    }
    if (match.movedOn?.[partnerId] === 'busy') return { kind: 'partnerBusy' };
    if (match.movedOn?.[partnerId] === 'left' || match.away?.includes(partnerId)) return { kind: 'partnerLeft' };
    if (iOffered) return { kind: 'waiting' };
    return { kind: 'offer', partnerOffered: offers.includes(partnerId) };
  }
}
