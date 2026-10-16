// Seat takeover in a Live Play game, against the real MatchDO: newcomers claim bot seats,
// a player who leaves mid-game hands their seat to a bot, and a table with nobody left present is
// dropped rather than played on by bots alone. Deadlines are reached by winding the stored match's
// times back, as matchDOLive.test.ts does, then firing the alarm.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { Bid, LIVE_ABANDON_MS, LIVE_TURN_MS, Suit, Teams, createDomino, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { syncLobbyIndex } from '../src/lobby';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}
type Stub = ReturnType<typeof stubFor>;

async function stored(stub: Stub): Promise<MatchState> {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.get<MatchState>('match'))!);
}

async function windBack(stub: Stub, change: (match: MatchState) => Partial<MatchState>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    await state.storage.put('match', { ...match, ...change(match) });
  });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// p1 alone with three bots in a dealt Live Play game.
async function soloWithBots(name: string) {
  const stub = stubFor(name);
  await stub.create('p1', name, 'live');
  await stub.addBots('p1');
  return stub;
}

describe('seat takeover', () => {
  it('takes a claim and refuses one too many', async () => {
    const stub = await soloWithBots('to-claim');
    for (const id of ['n1', 'n2', 'n3']) expect((await stub.claimSeat(id)).ok).toBe(true);
    const fourth = await stub.claimSeat('n4');
    expect(fourth.ok).toBe(false);
  });

  it('lets a claimant cancel', async () => {
    const stub = await soloWithBots('to-cancel');
    await stub.claimSeat('n1');
    const left = await stub.leave('n1');
    expect(left.ok && !left.value.deleted && left.value.match.claims).toEqual([]);
  });

  it("gives a leaver's seat to a bot straight away, mid-hand", async () => {
    const stub = stubFor('to-leave');
    await stub.create('p1', 'to-leave', 'live');
    await stub.takeSeat('p2', 1);
    await stub.addBots('p1');
    const left = await stub.leave('p2');
    expect(left.ok && !left.value.deleted).toBe(true);
    const match = await stored(stub);
    expect(match.players.find((p) => p.position === 1)!.playerId).toMatch(/_bot-\d$/);
    expect(match.replaced).toEqual(['p2']);
  });

  it('drops the match when the last present player leaves', async () => {
    const stub = await soloWithBots('to-last-leave');
    const left = await stub.leave('p1');
    expect(left.ok && left.value.deleted).toBe(true);
    expect((await stub.getMatch()).ok).toBe(false);
  });

  it('waits on the last present player instead of autopiloting them, then drops the match', async () => {
    const stub = await soloWithBots('to-drop');
    // Make it p1's turn: let the bots act until the table waits on p1.
    for (let i = 0; i < 10 && (await stored(stub)).currentGame.currentPlayerId !== 'p1'; i++) await runDurableObjectAlarm(stub);
    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + 1000) }));
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot ?? []).toEqual([]);

    // The solo setup never synced the lobby, so seed the row: the null check below then shows the
    // drop removed it rather than it never having been there.
    await syncLobbyIndex(testEnv.DB, await stored(stub));
    expect(await testEnv.DB.prepare('SELECT id FROM matches WHERE id = ?').bind('to-drop').first()).not.toBeNull();

    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + LIVE_ABANDON_MS + 1000) }));
    await runDurableObjectAlarm(stub);
    expect((await stub.getMatch()).ok).toBe(false);
    const row = await testEnv.DB.prepare('SELECT id FROM matches WHERE id = ?').bind('to-drop').first();
    expect(row).toBeNull();
  });

  it('tells claimants they were let go before a dropped match closes', async () => {
    const stub = await soloWithBots('to-bump');
    await stub.claimSeat('n1');
    const broadcasts = await runInDurableObject(stub, async (instance) => {
      const sent: MatchState[] = [];
      // Capture what the DO broadcasts by spying on its private broadcast.
      const original = (instance as unknown as { broadcast(m: MatchState): void }).broadcast.bind(instance);
      (instance as unknown as { broadcast(m: MatchState): void }).broadcast = (m) => {
        sent.push(m);
        original(m);
      };
      await instance.leave('p1');
      return sent;
    });
    expect(broadcasts.at(-1)!.bumped).toEqual(['n1']);
  });
});

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// Winds the stored hand to decided, as live.test.ts's atBreak does: seat 0 bid 30, and seat 1's
// team took one trick of 31 points, which sets it. Only the players in `ready` have readied up.
// The alarm is set to now, so a bot due to ready up does so on the next firing.
async function decideHand(stub: Stub, ready: (playerId: string) => boolean, extra: Partial<MatchState> = {}) {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    const bidder = match.players.find((p) => p.position === 0)!.playerId;
    const setter = match.players.find((p) => p.position === 1)!.playerId;
    const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
    const decided: MatchState = {
      ...match,
      ...extra,
      currentGame: {
        ...match.currentGame,
        biddingPlayerId: bidder,
        bid: Bid.Thirty,
        trump: Suit.Sixes,
        currentPlayerId: null,
        tricks: [{ playerId: setter, team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
        ...extra.currentGame,
      },
      players: match.players.map((p) => ({ ...p, ready: ready(p.playerId) })),
    };
    await state.storage.put('match', decided);
    await state.storage.setAlarm(Date.now());
  });
}

async function lobbySeats(matchId: string) {
  const { results } = await testEnv.DB.prepare('SELECT player_id AS playerId, position FROM match_players WHERE match_id = ? ORDER BY position')
    .bind(matchId)
    .all<{ playerId: string; position: number }>();
  return results;
}

const seatsOf = (match: MatchState) =>
  [...match.players].sort((a, b) => a.position - b.position).map(({ playerId, position }) => ({ playerId, position }));

function globalMatchmaker() {
  return testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('global'));
}

async function openLive(): Promise<string[]> {
  return runInDurableObject(globalMatchmaker(), async (_i, state) => (await state.storage.get<string[]>('open:live')) ?? []);
}

// Polls for something a waitUntil does after the call that started it has returned.
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('the hand break in MatchDO', () => {
  it('seats a claimant in a bot seat when the last human readies up, and lists the new seats', async () => {
    const stub = await soloWithBots('break-human');
    expect((await stub.claimSeat('n1')).ok).toBe(true);
    await decideHand(stub, (id) => id !== 'p1');
    // List the old seats first, so the rows below must have been rewritten by the break.
    await syncLobbyIndex(testEnv.DB, await stored(stub));

    const result = await stub.readyUp('p1', true, deck());
    expect(result.ok).toBe(true);
    const match = await stored(stub);
    expect(match.players.find((p) => p.position === 1)!.playerId).toBe('n1');
    expect(match.claims).toEqual([]);
    expect(match.currentGame.hands.some((h) => h.playerId === 'n1')).toBe(true);
    expect(await lobbySeats('break-human')).toEqual(seatsOf(match));
  });

  it("seats a claimant when a bot's ready-up in the alarm deals the next hand, and lists the new seats", async () => {
    const stub = await soloWithBots('break-bot');
    expect((await stub.claimSeat('n1')).ok).toBe(true);
    const before = await stored(stub);
    const lastBot = before.players.find((p) => p.position === 3)!.playerId;
    await decideHand(stub, (id) => id !== lastBot);
    await syncLobbyIndex(testEnv.DB, await stored(stub));

    for (let i = 0; i < 10 && !(await stored(stub)).players.some((p) => p.playerId === 'n1'); i++) {
      await runDurableObjectAlarm(stub);
    }
    const match = await stored(stub);
    expect(match.players.find((p) => p.position === 1)!.playerId).toBe('n1');
    expect(await lobbySeats('break-bot')).toEqual(seatsOf(match));
  });

  it('gives the seat of a player away the whole hand to a bot, and offers the game to the Matchmaker', async () => {
    const stub = stubFor('break-away');
    await stub.create('p1', 'break-away', 'live');
    await stub.takeSeat('p2', 1);
    await stub.addBots('p1');
    // Seating the bots offered the game already; take it off the list to see the break offer it.
    expect(await eventually(async () => (await openLive()).includes('break-away'))).toBe(true);
    await runInDurableObject(globalMatchmaker(), async (_i, state) => {
      const open = (await state.storage.get<string[]>('open:live')) ?? [];
      await state.storage.put('open:live', open.filter((id) => id !== 'break-away'));
    });

    const dealtOn = ago(60_000);
    await decideHand(stub, (id) => id !== 'p1', {
      autopilot: ['p2'],
      awaySince: { p2: ago(120_000) },
    });
    await windBack(stub, (m) => ({ currentGame: { ...m.currentGame, dealtOn } }));
    await syncLobbyIndex(testEnv.DB, await stored(stub));

    expect((await stub.readyUp('p1', true, deck())).ok).toBe(true);
    const match = await stored(stub);
    expect(match.players.find((p) => p.position === 1)!.playerId).toMatch(/_bot-\d$/);
    expect(match.replaced).toEqual(['p2']);
    expect(await lobbySeats('break-away')).toEqual(seatsOf(match));
    expect(await eventually(async () => (await openLive()).includes('break-away'))).toBe(true);
  });
});
