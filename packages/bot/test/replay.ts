import {
  createDomino, createMatch, placeBid, playDomino, setTrump, takeSeat, type Domino, type MatchState,
} from '@fortytwo/rules';
import type { FixtureHand, FixtureStep } from './fixtures';

export const PLAYERS = ['p0', 'p1', 'p2', 'p3'];

export function dominoFromId(id: string): Domino {
  const [a, b] = id.split('/').map(Number);
  return createDomino(a, b);
}

export function startHand(h: FixtureHand): MatchState {
  const deal = h.deal.map(dominoFromId);
  let match = createMatch(PLAYERS[0]);
  for (let seat = 1; seat < 4; seat++) match = takeSeat(match, PLAYERS[seat], seat, seat === 3 ? deal : undefined);
  return {
    ...match,
    currentGame: { ...match.currentGame, firstActionBy: PLAYERS[h.opener], currentPlayerId: PLAYERS[h.opener] },
  };
}

export function applyStep(match: MatchState, s: FixtureStep): MatchState {
  const id = PLAYERS[s.seat];
  if (s.phase === 'bid') return placeBid(match, id, s.action as number);
  if (s.phase === 'trump') return setTrump(match, id, s.action as number);
  return playDomino(match, id, dominoFromId(s.action as string));
}
