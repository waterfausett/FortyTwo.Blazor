import { describe, it, expect } from 'vitest';
import { createMatch, takeSeat, createRematch, placeBid, setTrump, playDomino, patchPlayerReady, type MatchState } from './matchEngine';
import { Teams } from './teams';
import type { Game } from './game';
import { Bid } from './bid';
import { Suit } from './suit';
import { createDomino, type Domino } from './domino';
import { ValidationError } from './errors';
import {
  LIVE_FILL_MS,
  LIVE_TURN_MS,
  LIVE_ABANDON_MS,
  markAutoBid,
  TAKEOVER_MAX_MARKS,
  claimSeat,
  releaseClaim,
  letClaimsGo,
  isBotControlled,
  isPresent,
  liveDeadline,
  matchMode,
  replaceWithBot,
  resumeControl,
  setAutopilot,
  tableWait,
} from './live';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1-p4 seated in a match of `mode`; the fourth seat deals.
function dealt(mode: 'live' | 'daily' | 'custom' = 'live'): MatchState {
  let match = createMatch('p1', mode);
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck());
}

describe('matchMode', () => {
  it('reads a match from before modes as custom', () => {
    const { mode: _mode, ...old } = createMatch('p1');
    expect(matchMode(old)).toBe('custom');
  });

  it('is stored on a new match, live ones with the time the search began', () => {
    const live = createMatch('p1', 'live');
    expect(live.mode).toBe('live');
    expect(live.searchStartedOn).toBe(live.createdOn);
    const daily = createMatch('p1', 'daily');
    expect(daily.mode).toBe('daily');
    expect(daily.searchStartedOn).toBeUndefined();
    expect(createMatch('p1').mode).toBe('custom');
  });

  it('carries over to a rematch', () => {
    const rematch = createRematch('r1', dealt('daily'), deck());
    expect(rematch.mode).toBe('daily');
  });
});

describe('tableWait', () => {
  it('waits on nobody before the deal', () => {
    expect(tableWait(createMatch('p1', 'live'))).toBeNull();
  });

  it('waits on whoever is to act once dealt', () => {
    expect(tableWait(dealt())).toEqual({ kind: 'turn', playerIds: ['p1'] });
  });

  it('is null once the match is won', () => {
    expect(tableWait({ ...dealt(), winningTeam: 1 })).toBeNull();
  });
});

describe('liveDeadline', () => {
  it('fills the table LIVE_FILL_MS after the search began', () => {
    const match = createMatch('p1', 'live');
    expect(liveDeadline(match)).toEqual({ kind: 'fill', at: Date.parse(match.searchStartedOn!) + LIVE_FILL_MS, playerIds: [] });
  });

  it('times the human whose turn it is from when the turn began', () => {
    const match = dealt();
    expect(liveDeadline(match)).toEqual({ kind: 'turn', at: Date.parse(match.updatedOn) + LIVE_TURN_MS, playerIds: ['p1'] });
  });

  it('sets no clock for a bot or a player on autopilot', () => {
    expect(liveDeadline(setAutopilot(dealt(), ['p1'], true))).toBeNull();
  });

  it('sets no clock outside Live', () => {
    expect(liveDeadline(dealt('daily'))).toBeNull();
    expect(liveDeadline(dealt('custom'))).toBeNull();
    expect(liveDeadline(createMatch('p1', 'daily'))).toBeNull();
  });
});

describe('autopilot', () => {
  it('counts a player on autopilot as bot-controlled, and bots always', () => {
    const match = setAutopilot(dealt(), ['p2'], true);
    expect(isBotControlled(match, 'p2')).toBe(true);
    expect(isBotControlled(match, 'p3')).toBe(false);
    expect(isBotControlled(match, 'bot-1')).toBe(true);
  });

  it('turns off without touching anyone else', () => {
    const match = setAutopilot(setAutopilot(dealt(), ['p1', 'p2'], true), ['p1'], false);
    expect(match.autopilot).toEqual(['p2']);
  });

  it('restarts the turn clock when a player resumes, so the old deadline cannot fire again', () => {
    const stale = { ...setAutopilot(dealt(), ['p1'], true), updatedOn: new Date(Date.now() - LIVE_TURN_MS * 2).toISOString() };
    const resumed = resumeControl(stale, 'p1');
    expect(resumed.autopilot).toEqual([]);
    expect(liveDeadline(resumed)!.at).toBeGreaterThan(Date.now());
  });

  it('leaves a player who is not on autopilot untouched when they resume', () => {
    const match = dealt();
    const resumed = resumeControl(match, 'p2');
    expect(resumed).toBe(match);
    expect(resumed.updatedOn).toBe(match.updatedOn);
    expect(resumed.autopilot).toBeUndefined();
  });

  it("clears autopilot without restarting the clock of a player the table isn't waiting on", () => {
    const match = setAutopilot(dealt(), ['p2'], true);
    const resumed = resumeControl(match, 'p2');
    expect(resumed.autopilot).toEqual([]);
    expect(resumed.updatedOn).toBe(match.updatedOn);
  });

  it('refuses a resume from someone not at the table', () => {
    expect(() => resumeControl(dealt(), 'stranger')).toThrow(ValidationError);
  });
});

describe('seat bookkeeping', () => {
  it('stamps a hand with when it was dealt', () => {
    expect(dealt().currentGame.dealtOn).toEqual(expect.any(String));
  });

  it('records when a player went away, and forgets it when they come back', () => {
    const away = setAutopilot(dealt(), ['p2'], true);
    expect(away.awaySince?.p2).toEqual(expect.any(String));
    expect(setAutopilot(away, ['p2'], false).awaySince?.p2).toBeUndefined();
  });

  it('remembers that a bot ever sat down', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'bot-1', 1);
    expect(match.hadBots).toBe(true);
    expect(createMatch('p1', 'live').hadBots).toBeUndefined();
  });

  it('counts only seated humans not on autopilot as present', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'p2', 1);
    match = takeSeat(match, 'bot-1', 2);
    match = takeSeat(match, 'p4', 3, deck());
    match = setAutopilot(match, ['p4'], true);
    expect(isPresent(match, 'p1')).toBe(true);
    expect(isPresent(match, 'bot-1')).toBe(false);
    expect(isPresent(match, 'p4')).toBe(false);
    expect(isPresent(match, 'stranger')).toBe(false);
  });
});

describe('replaceWithBot', () => {
  it('hands the seat, its hand and its turn to a free bot', () => {
    const match = dealt();
    const next = replaceWithBot(match, 'p1');
    const bot = next.players.find((p) => p.position === 0)!;
    expect(bot.playerId).toBe('bot-1');
    expect(next.currentGame.hands.find((h) => h.playerId === 'bot-1')!.dominoes).toEqual(
      match.currentGame.hands.find((h) => h.playerId === 'p1')!.dominoes
    );
    expect(next.currentGame.currentPlayerId).toBe('bot-1');
    expect(next.currentGame.firstActionBy).toBe('bot-1');
    expect(next.replaced).toEqual(['p1']);
    expect(next.hadBots).toBe(true);
  });

  it('renames a high bidder and a trick winner mid-hand, so play can carry on', () => {
    let match = dealt();
    match = placeBid(match, 'p1', Bid.Thirty);
    for (const id of ['p2', 'p3', 'p4']) match = placeBid(match, id, Bid.Pass);
    match = setTrump(match, 'p1', Suit.Sixes);
    const next = replaceWithBot(match, 'p1');
    expect(next.currentGame.biddingPlayerId).toBe('bot-1');
    expect(next.currentGame.currentPlayerId).toBe('bot-1');
    const lead = next.currentGame.hands.find((h) => h.playerId === 'bot-1')!.dominoes[0];
    expect(() => playDomino(next, 'bot-1', lead)).not.toThrow();
  });

  it('takes the player off autopilot and picks the next free bot id', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'bot-1', 1);
    match = takeSeat(match, 'p3', 2);
    match = takeSeat(match, 'p4', 3, deck());
    match = setAutopilot(match, ['p3'], true);
    const next = replaceWithBot(match, 'p3');
    expect(next.players.find((p) => p.position === 2)!.playerId).toBe('bot-2');
    expect(next.autopilot).toEqual([]);
    expect(next.awaySince?.p3).toBeUndefined();
  });

  it('refuses someone not at the table', () => {
    expect(() => replaceWithBot(dealt(), 'stranger')).toThrow(ValidationError);
  });
});

// p1 and p3 against bot-1 and bot-2, dealt.
function withBots(): MatchState {
  let match = createMatch('p1', 'live');
  match = takeSeat(match, 'bot-1', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'bot-2', 3, deck());
}

// A filed hand worth one mark: p1 bid 30.
function markHand(match: MatchState): Game {
  return {
    ...match.currentGame,
    biddingPlayerId: 'p1',
    bid: Bid.Thirty,
    hands: match.currentGame.hands.map((h) => (h.playerId === 'p1' ? { ...h, bid: Bid.Thirty } : h)),
  };
}

// The current hand decided and everyone but `last` ready, so `last` readying deals the next one.
// Seat 0 bid 30; seat 1's team took one trick of 31 points, more than the 12 that sets the bid.
function atBreak(match: MatchState, last: string): MatchState {
  const bidder = match.players.find((p) => p.position === 0)!.playerId;
  const setter = match.players.find((p) => p.position === 1)!.playerId;
  const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
  const decided = {
    ...match,
    currentGame: {
      ...match.currentGame,
      biddingPlayerId: bidder,
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      tricks: [{ playerId: setter, team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
    },
  };
  return { ...decided, players: decided.players.map((p) => ({ ...p, ready: p.playerId !== last })) };
}

describe('claimSeat', () => {
  it('queues a newcomer for a bot seat', () => {
    expect(claimSeat(withBots(), 'n1').claims).toEqual(['n1']);
  });

  it('allows no more claims than bot seats', () => {
    const two = claimSeat(claimSeat(withBots(), 'n1'), 'n2');
    expect(() => claimSeat(two, 'n3')).toThrow(ValidationError);
  });

  it('refuses outside Over the table, before the deal, once finished, near the end, and twice', () => {
    expect(() => claimSeat({ ...withBots(), mode: 'daily' }, 'n1')).toThrow(ValidationError);
    expect(() => claimSeat(createMatch('p1', 'live'), 'n1')).toThrow(ValidationError);
    expect(() => claimSeat({ ...withBots(), winningTeam: Teams.TeamA }, 'n1')).toThrow(ValidationError);
    const nearEnd = { ...withBots(), games: { [Teams.TeamA]: Array.from({ length: TAKEOVER_MAX_MARKS }, () => markHand(withBots())) } };
    expect(() => claimSeat(nearEnd, 'n1')).toThrow(ValidationError);
    expect(() => claimSeat(claimSeat(withBots(), 'n1'), 'n1')).toThrow(ValidationError);
    expect(() => claimSeat(withBots(), 'p1')).toThrow(ValidationError);
  });

  it('lets a claim go', () => {
    expect(releaseClaim(claimSeat(withBots(), 'n1'), 'n1').claims).toEqual([]);
  });
});

describe('the hand break', () => {
  it('seats claims in bot seats, lowest position first, ready for the deal', () => {
    const match = atBreak(claimSeat(withBots(), 'n1'), 'p1');
    const next = patchPlayerReady(match, 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('n1');
    expect(next.players.find((p) => p.position === 3)!.playerId).toBe('bot-2');
    expect(next.claims).toEqual([]);
    expect(next.currentGame.hands.find((h) => h.playerId === 'n1')!.dominoes).toHaveLength(7);
  });

  it('opens with the seat after the last opener even when that seat changed hands', () => {
    let match = withBots();
    match = { ...match, currentGame: { ...match.currentGame, firstActionBy: 'bot-1' } };
    const next = patchPlayerReady(atBreak(claimSeat(match, 'n1'), 'p1'), 'p1', true, deck());
    expect(next.currentGame.firstActionBy).toBe('p3');
  });

  it('replaces a player away for the whole hand with a bot', () => {
    let match = setAutopilot(dealt(), ['p2'], true);
    match = { ...match, awaySince: { p2: match.currentGame.dealtOn! } };
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.replaced).toEqual(['p2']);
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('bot-1');
    expect(next.autopilot).toEqual([]);
  });

  it('lets a claim take the seat of a player replaced at the same break, lowest position first', () => {
    // Bots at 1 and 3; p3 at 2 has been away all hand. Two claims: they take seats 1 and 2.
    let match = setAutopilot(withBots(), ['p3'], true);
    match = { ...match, awaySince: { p3: match.currentGame.dealtOn! } };
    match = claimSeat(claimSeat(match, 'n1'), 'n2');
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('n1');
    expect(next.players.find((p) => p.position === 2)!.playerId).toBe('n2');
    expect(next.players.find((p) => p.position === 3)!.playerId).toBe('bot-2');
    expect(next.replaced).toEqual(['p3']);
  });

  it('keeps a player who went away partway through the hand', () => {
    let match = setAutopilot(dealt(), ['p2'], true);
    match = { ...match, awaySince: { p2: new Date(Date.parse(match.currentGame.dealtOn!) + 1000).toISOString() } };
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('p2');
  });

  it('replaces nobody in a match stored before deal times were kept', () => {
    let match = setAutopilot(dealt(), ['p2'], true);
    // Away since the deal, so only the missing deal time keeps the seat from being replaced.
    match = { ...match, awaySince: { p2: match.currentGame.dealtOn! } };
    const { dealtOn: _d, ...oldGame } = match.currentGame;
    match = { ...match, currentGame: oldGame };
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('p2');
  });

  it('does none of this outside Over the table', () => {
    let daily = setAutopilot({ ...dealt(), mode: 'daily' as const }, ['p2'], true);
    // Away since the deal, so only the mode keeps the seat from being replaced.
    daily = { ...daily, awaySince: { p2: daily.currentGame.dealtOn! } };
    const next = patchPlayerReady(atBreak(daily, 'p1'), 'p1', true, deck());
    expect(next.replaced).toBeUndefined();
  });

  it('lets claimants go when the match ends before a seat comes up', () => {
    const next = letClaimsGo(claimSeat(withBots(), 'n1'));
    expect(next.claims).toEqual([]);
    expect(next.bumped).toEqual(['n1']);
    const quiet = withBots();
    expect(letClaimsGo(quiet)).toBe(quiet);
  });
});

describe('pause and drop', () => {
  it('drops instead of autopiloting the last present player', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'bot-1', 1);
    match = takeSeat(match, 'bot-2', 2);
    match = takeSeat(match, 'bot-3', 3, deck());
    expect(liveDeadline(match)).toEqual({ kind: 'drop', at: Date.parse(match.updatedOn) + LIVE_TURN_MS + LIVE_ABANDON_MS, playerIds: ['p1'] });
  });

  it('still times a player out while someone else is present', () => {
    expect(liveDeadline(dealt())!.kind).toBe('turn');
  });

  it('drops when the only other human is already away', () => {
    const match = setAutopilot(dealt(), ['p2', 'p3', 'p4'], true);
    expect(liveDeadline(match)!.kind).toBe('drop');
  });
});

describe('markAutoBid', () => {
  it('marks the hand the bot bid for', () => {
    const next = markAutoBid(dealt(), 'p1');
    expect(next.currentGame.hands.find((h) => h.playerId === 'p1')!.autoBid).toBe(true);
    expect(next.currentGame.hands.find((h) => h.playerId === 'p2')!.autoBid).toBeUndefined();
  });
});
