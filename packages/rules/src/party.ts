import { isBot } from './botIds';
import { ValidationError } from './errors';
import { matchMode } from './live';
import type { MatchState } from './matchEngine';
import { teamForPosition, type Teams } from './teams';
import { assertIsMatchPlayer } from './validation';

// How long a partner can be away at the end of a Live game before the party offer stops waiting.
export const PARTY_GRACE_MS = 30_000;

function now(): string {
  return new Date().toISOString();
}

// The other seat on a player's team, or null when it is empty.
export function partnerOf(match: MatchState, playerId: string): string | null {
  const me = match.players.find((p) => p.playerId === playerId);
  if (!me) return null;
  const team = teamForPosition(me.position);
  return match.players.find((p) => p.playerId !== playerId && teamForPosition(p.position) === team)?.playerId ?? null;
}

// Offers to search together as a pair instead of voting for a rematch, so the offer replaces the
// player's vote. Only a Live match that is over, between two people who both still want to be here.
export function offerParty(match: MatchState, playerId: string): MatchState {
  if (matchMode(match) !== 'live') throw new ValidationError('Only a Live game can party up');
  if (match.winningTeam === null) throw new ValidationError('This match is still being played');
  assertIsMatchPlayer(match, playerId);

  const me = match.players.find((p) => p.playerId === playerId)!;
  const partner = partnerOf(match, playerId);
  if (partner === null || isBot(partner)) throw new ValidationError('You have no partner to party up with');
  if (match.partyMatchIds?.[teamForPosition(me.position)] !== undefined) {
    throw new ValidationError('You have already partied up');
  }
  if (match.movedOn?.[playerId] !== undefined) throw new ValidationError('You have moved on');
  if (match.movedOn?.[partner] !== undefined || match.away?.includes(partner)) {
    throw new ValidationError('Your partner has gone');
  }

  const offers = match.partyOffers ?? [];
  return {
    ...match,
    partyOffers: offers.includes(playerId) ? offers : [...offers, playerId],
    rematchVotes: (match.rematchVotes ?? []).filter((id) => id !== playerId),
    updatedOn: now(),
  };
}

export function cancelParty(match: MatchState, playerId: string): MatchState {
  return { ...match, partyOffers: (match.partyOffers ?? []).filter((id) => id !== playerId), updatedOn: now() };
}

// Both partners have offered, so the pair can go and search together.
export function partyAgreed(match: MatchState, playerId: string): boolean {
  const partner = partnerOf(match, playerId);
  const offers = match.partyOffers ?? [];
  return partner !== null && offers.includes(playerId) && offers.includes(partner);
}

// The player went on to something else (pressed Find a game, or turned up in another Live game).
// That is final for this match, and the first reason stands. Their offer and vote go with them.
export function moveOn(match: MatchState, playerId: string, why: 'left' | 'busy'): MatchState {
  return {
    ...withoutIntent(match, playerId),
    movedOn: { ...match.movedOn, [playerId]: match.movedOn?.[playerId] ?? why },
    updatedOn: now(),
  };
}

// Marks a player who lapsed, or back again. Unlike moving on it is undone when they return. Returns
// the same match when nothing changes, so a caller can skip a save.
export function setAway(match: MatchState, playerId: string, away: boolean): MatchState {
  const isAway = match.away?.includes(playerId) ?? false;
  if (away === isAway) return match;
  if (!away) return { ...match, away: (match.away ?? []).filter((id) => id !== playerId), updatedOn: now() };
  return { ...withoutIntent(match, playerId), away: [...(match.away ?? []), playerId], updatedOn: now() };
}

// A team's party has a match to search in; the offers that got it there are spent. Any rematch
// vote of theirs goes too, so the other team isn't shown a rematch count that can't come true.
export function recordParty(match: MatchState, team: Teams, matchId: string): MatchState {
  const members = match.players.filter((p) => teamForPosition(p.position) === team).map((p) => p.playerId);
  return {
    ...match,
    partyMatchIds: { ...match.partyMatchIds, [team]: matchId },
    partyOffers: (match.partyOffers ?? []).filter((id) => !members.includes(id)),
    rematchVotes: (match.rematchVotes ?? []).filter((id) => !members.includes(id)),
    updatedOn: now(),
  };
}

// A Live table can't rematch once the four are no longer all there to play it: someone has gone,
// or a pair has left to search together. Other modes never block, so a Daily vote always counts.
export function rematchBlocked(match: MatchState): boolean {
  if (matchMode(match) !== 'live') return false;
  const gone = [...Object.keys(match.movedOn ?? {}), ...(match.away ?? [])];
  return gone.some((id) => !isBot(id)) || Object.keys(match.partyMatchIds ?? {}).length > 0;
}

// The match without the player's party offer or rematch vote.
function withoutIntent(match: MatchState, playerId: string): MatchState {
  return {
    ...match,
    partyOffers: (match.partyOffers ?? []).filter((id) => id !== playerId),
    rematchVotes: (match.rematchVotes ?? []).filter((id) => id !== playerId),
  };
}
