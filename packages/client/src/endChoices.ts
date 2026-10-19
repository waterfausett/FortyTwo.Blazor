// What a finished match offers its players to do next, worked out from MatchState alone. Only a Live
// game has the full set (Party up, Find a game, Rematch); every other mode keeps its plain Rematch,
// so `live` tells a screen whether to show the Live panel at all. Shared by the web and mobile apps.
import { isBot, matchMode, partnerOf, rematchBlocked, teamForPosition, type MatchState } from '@fortytwo/rules';

export type PartyButton =
  // Not Live, not won, viewer not seated, rematch made, bot partner, or viewer moved on.
  | { kind: 'hidden' }
  // "Party up with Sam", and whether Sam has already asked.
  | { kind: 'offer'; partnerOffered: boolean }
  // My offer stands; tapping cancels it.
  | { kind: 'waiting' }
  | { kind: 'partnerLeft' }
  | { kind: 'partnerBusy' }
  // My team has a new match to search in.
  | { kind: 'partied'; matchId: string };

export interface EndChoices {
  live: boolean;
  partnerId: string | null;
  party: PartyButton;
  // The table can't be four again, or my own offer stands, so a rematch vote is off the table.
  rematchDisabled: boolean;
  // I turned up in another Live game, so the client sends me back to it.
  iAmBusy: boolean;
  // Off once my team has partied up: both could only lead back to the same new game.
  showFindGame: boolean;
  showRematch: boolean;
}

export function endChoices(match: MatchState, myPlayerId: string): EndChoices {
  const live = matchMode(match) === 'live';
  const me = match.players.find((p) => p.playerId === myPlayerId);
  const partnerId = partnerOf(match, myPlayerId);
  const offers = match.partyOffers ?? [];
  const iOffered = offers.includes(myPlayerId);

  const party = partyButton();
  const partied = party.kind === 'partied';

  return {
    live,
    partnerId,
    party,
    rematchDisabled: rematchBlocked(match) || iOffered,
    iAmBusy: match.movedOn?.[myPlayerId] === 'busy',
    showFindGame: !partied,
    showRematch: !partied,
  };

  // The order matters: a finished party beats everything, then the cases with nothing to offer, then
  // what became of the partner, and only then where my own offer stands. A rematch already made
  // seats the partners together, so there's nothing left to party up for.
  function partyButton(): PartyButton {
    const partied = me && match.partyMatchIds?.[teamForPosition(me.position)];
    if (partied !== undefined) return { kind: 'partied', matchId: partied };
    if (
      !live ||
      match.winningTeam === null ||
      !me ||
      match.rematchId !== undefined ||
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
