import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { MatchPage, MatchSummary } from '@fortytwo/client';
import { createDomino, createMatch, takeSeat, Teams, type Domino, type MatchState } from '@fortytwo/rules';
import { updateLobbyRow } from '../lobbyRow';

function dealt(): MatchState {
  const deck: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) deck.push(createDomino(i, j));
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck);
}
const names: Record<string, string> = { p1: 'Ann', p2: 'Bo', p3: 'Cy', p4: 'Di' };

const row = (overrides: Partial<MatchSummary>): MatchSummary => ({
  id: 'other',
  status: 'active',
  playerCount: 4,
  updatedOn: '2026-10-17T00:00:00.000Z',
  teams: [['Ann', 'Cy'], ['Bo', 'Di']],
  seats: ['Ann', 'Bo', 'Cy', 'Di'],
  mode: 'daily',
  turn: { kind: 'turn', yours: true, waitingOn: ['Ann'] },
  ...overrides,
});

function lobbyWith(...rows: MatchSummary[]) {
  const client = new QueryClient();
  const data: InfiniteData<MatchPage, string | undefined> = { pages: [{ matches: rows, nextCursor: null }], pageParams: [undefined] };
  client.setQueryData(['matches', 'Active'], data);
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const rowFor = (id: string) =>
    client.getQueryData<InfiniteData<MatchPage, string | undefined>>(['matches', 'Active'])!.pages[0].matches.find((m) => m.id === id);
  return { client, invalidate, rowFor };
}

describe('updateLobbyRow', () => {
  it("gives the match's row the turn as last seen, leaving the others and fetching nothing", () => {
    const match = dealt();
    const turn = match.currentGame.currentPlayerId!;
    const viewer = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== turn)!;
    const other = row({});
    const { client, invalidate, rowFor } = lobbyWith(other, row({ id: match.id }));

    updateLobbyRow(client, match.id, match, viewer);

    expect(rowFor(match.id)?.turn).toEqual({ kind: 'turn', yours: false, waitingOn: [names[turn]] });
    expect(rowFor('other')).toEqual(other);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('fetches the lists again for a match just finished, or one with a newcomer seated', () => {
    const match = dealt();
    const finished = lobbyWith(row({ id: match.id }));
    updateLobbyRow(finished.client, match.id, { ...match, winningTeam: Teams.TeamA }, 'p1');
    expect(finished.rowFor(match.id)?.status).toBe('completed');
    expect(finished.invalidate).toHaveBeenCalledWith({ queryKey: ['matches'] });

    const filled = lobbyWith(row({ id: match.id, playerCount: 3, seats: ['Ann', 'Bo', 'Cy', null] }));
    updateLobbyRow(filled.client, match.id, match, 'p1');
    expect(filled.rowFor(match.id)?.playerCount).toBe(3);
    expect(filled.invalidate).toHaveBeenCalledWith({ queryKey: ['matches'] });
  });
});
