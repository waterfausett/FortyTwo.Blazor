import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Bid, Suit, createDomino, createMatch, matchViewFor, placeBid, setTrump, takeSeat, type Domino, type MatchState,
} from '@fortytwo/rules';
import type { Hint, HintResponse } from '@fortytwo/api-types';
import {
  HINT_GIVE_UP_MS, HINT_RETRY_MS, HINT_UNAVAILABLE, canAskForHint, fetchHint, hintHeadline, hintRows, hintTurnKey,
  isAbort, suggestedBid, suggestedDominoIds, suggestedTrump,
} from './hints';

afterEach(() => vi.useRealTimers());

const ready = (hint: Hint): HintResponse => ({ status: 'ready', hint });
const bidHint: Hint = {
  kind: 'bid',
  suggestion: { bid: 34, trump: Suit.Sixes, pMake: 0.68 },
  options: [
    { bid: 33, trump: Suit.Sixes, pMake: 0.75 },
    { bid: 34, trump: Suit.Sixes, pMake: 0.68 },
    { bid: 35, trump: Suit.Sixes, pMake: 0.52 },
  ],
};

describe('fetchHint', () => {
  it('asks again every 400 ms while the model warms up, then resolves with the hint', async () => {
    vi.useFakeTimers();
    const getHint = vi.fn<() => Promise<HintResponse>>()
      .mockResolvedValueOnce({ status: 'warming' })
      .mockResolvedValueOnce({ status: 'warming' })
      .mockResolvedValueOnce(ready(bidHint));

    const result = fetchHint(getHint);
    await vi.advanceTimersByTimeAsync(HINT_RETRY_MS - 1);
    expect(getHint).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getHint).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HINT_RETRY_MS);

    await expect(result).resolves.toEqual(bidHint);
    expect(getHint).toHaveBeenCalledTimes(3);
  });

  it('gives up after 10 s of warming', async () => {
    vi.useFakeTimers();
    const getHint = vi.fn(async (): Promise<HintResponse> => ({ status: 'warming' }));
    const result = fetchHint(getHint).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HINT_GIVE_UP_MS + HINT_RETRY_MS);
    expect(((await result) as Error).message).toBe(HINT_UNAVAILABLE);
  });

  it("rejects at once when the model is unavailable", async () => {
    await expect(fetchHint(async () => ({ status: 'unavailable' }))).rejects.toThrow(HINT_UNAVAILABLE);
  });

  it('leaves no abort listener behind once a wait is over', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const added = vi.spyOn(abort.signal, 'addEventListener');
    const removed = vi.spyOn(abort.signal, 'removeEventListener');
    const getHint = vi.fn<() => Promise<HintResponse>>()
      .mockResolvedValueOnce({ status: 'warming' })
      .mockResolvedValueOnce({ status: 'warming' })
      .mockResolvedValueOnce(ready(bidHint));

    const result = fetchHint(getHint, abort.signal);
    await vi.advanceTimersByTimeAsync(HINT_RETRY_MS * 2);
    await result;

    expect(added).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it('stops asking once aborted', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const getHint = vi.fn(async (): Promise<HintResponse> => ({ status: 'warming' }));
    const result = fetchHint(getHint, abort.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(HINT_RETRY_MS * 3);
    expect(isAbort(await result)).toBe(true);
    expect(getHint).toHaveBeenCalledTimes(1);
  });
});

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}
function practice(mode: 'bots' | 'custom' = 'bots'): MatchState {
  let m = createMatch('me', mode);
  m = takeSeat(m, 'm_bot-1', 1);
  m = takeSeat(m, 'm_bot-2', 2);
  m = takeSeat(m, 'm_bot-3', 3, deck());
  return { ...m, currentGame: { ...m.currentGame, firstActionBy: 'me', currentPlayerId: 'me' } };
}

describe('canAskForHint', () => {
  it('is true on my turn to bid, name trump or play in a practice match with bots on', () => {
    let m = practice();
    expect(canAskForHint(matchViewFor(m, 'me'), 'me', true)).toBe(true);
    m = placeBid(m, 'me', Bid.Thirty);
    for (const id of ['m_bot-1', 'm_bot-2', 'm_bot-3']) m = placeBid(m, id, Bid.Pass);
    expect(canAskForHint(matchViewFor(m, 'me'), 'me', true)).toBe(true);
    m = setTrump(m, 'me', Suit.Sixes);
    expect(canAskForHint(matchViewFor(m, 'me'), 'me', true)).toBe(true);
  });

  it('is false in any other mode, with bots off, off my turn, or before the match loads', () => {
    expect(canAskForHint(matchViewFor(practice('custom'), 'me'), 'me', true)).toBe(false);
    expect(canAskForHint(matchViewFor(practice(), 'me'), 'me', false)).toBe(false);
    const theirs = placeBid(practice(), 'me', Bid.Pass);
    expect(canAskForHint(matchViewFor(theirs, 'me'), 'me', true)).toBe(false);
    expect(canAskForHint(null, 'me', true)).toBe(false);
    expect(canAskForHint(matchViewFor(practice(), 'me'), undefined, true)).toBe(false);
  });

  it('is false once the hand is decided, though play carries on', () => {
    const m = practice();
    const decided: MatchState = {
      ...m,
      currentGame: {
        ...m.currentGame,
        bid: Bid.Thirty,
        biddingPlayerId: 'me',
        trump: Suit.Sixes,
        hands: m.currentGame.hands.map((h) => ({ ...h, bid: h.playerId === 'me' ? Bid.Thirty : Bid.Pass })),
        // Their side has taken 28 points (16 + 11 + 1): 30 is out of reach for us.
        tricks: [
          { playerId: 'm_bot-1', team: m.currentGame.hands[1].team, suit: Suit.Fives, dominoes: [createDomino(5, 5), createDomino(5, 0), createDomino(5, 1), createDomino(5, 2)] },
          { playerId: 'm_bot-1', team: m.currentGame.hands[1].team, suit: Suit.Fours, dominoes: [createDomino(4, 6), createDomino(4, 0), createDomino(4, 1), createDomino(4, 2)] },
          { playerId: 'm_bot-1', team: m.currentGame.hands[1].team, suit: Suit.Threes, dominoes: [createDomino(3, 3), createDomino(3, 0), createDomino(3, 1), createDomino(3, 2)] },
        ],
      },
    };
    expect(canAskForHint(matchViewFor(decided, 'me'), 'me', true)).toBe(false);
  });
});

describe('hintTurnKey', () => {
  it('changes with every move', () => {
    const m = practice();
    const next = placeBid(m, 'me', Bid.Thirty);
    expect(hintTurnKey(next)).not.toBe(hintTurnKey(m));
    expect(hintTurnKey(m)).toBe(hintTurnKey({ ...m }));
  });
});

describe('hint text', () => {
  it('reads a bid hint', () => {
    expect(hintHeadline(bidHint)).toBe('Bid 34 · Sixes, 68% to make');
    expect(hintRows(bidHint)).toEqual([
      { key: '33', label: '33 · Sixes', detail: '75%', suggested: false },
      { key: '34', label: '34 · Sixes', detail: '68%', suggested: true },
      { key: '35', label: '35 · Sixes', detail: '52%', suggested: false },
    ]);
    expect(suggestedBid(bidHint)).toBe(34);
  });

  it('reads Pass, Plunge, Follow Me and a forced bid without numbers', () => {
    expect(hintHeadline({ ...bidHint, suggestion: { bid: Bid.Pass, trump: null, pMake: null } })).toBe('Pass');
    expect(hintHeadline({ ...bidHint, suggestion: { bid: Bid.Plunge, trump: null, pMake: 0.8 } })).toBe('Bid Plunge, 80% to make');
    expect(hintHeadline({ ...bidHint, suggestion: { bid: 84, trump: Suit.None, pMake: 0.61 } })).toBe('Bid 84 · Follow Me, 61% to make');
    expect(hintRows({ kind: 'bid', suggestion: { bid: 30, trump: null, pMake: null }, options: [{ bid: 30, trump: null, pMake: null }] }))
      .toEqual([{ key: '30', label: '30', detail: '', suggested: true }]);
  });

  it('reads a trump hint, Low with its doubles rule', () => {
    const hint: Hint = {
      kind: 'trump',
      suggestion: { trump: Suit.LowDoublesLow, pMake: 0.71 },
      options: [{ trump: Suit.LowDoublesLow, pMake: 0.71 }, { trump: Suit.Sixes, pMake: 0.4 }],
    };
    expect(hintHeadline(hint)).toBe('Low (doubles low), 71% to make');
    expect(hintRows(hint).map((r) => [r.label, r.detail, r.suggested])).toEqual([
      ['Low (doubles low)', '71%', true],
      ['Sixes', '40%', false],
    ]);
    expect(suggestedTrump(hint)).toBe(Suit.LowDoublesLow);
  });

  it('lists at most three dominoes, best first', () => {
    const d = (a: number, b: number) => createDomino(a, b);
    const hint: Hint = {
      kind: 'play',
      dominoes: [
        { domino: d(4, 6), marks: 0.62, gap: 0, rating: 'best' },
        { domino: d(6, 6), marks: 0.57, gap: 0.05, rating: 'close' },
        { domino: d(1, 3), marks: 0.22, gap: 0.4, rating: 'weaker' },
        { domino: d(0, 2), marks: 0.12, gap: 0.5, rating: 'weaker' },
        { domino: d(0, 5), marks: 0.02, gap: 0.6, rating: 'weaker' },
      ],
    };
    expect(hintRows(hint).map((r) => r.label)).toEqual(['6-4', '6-6', '3-1']);
  });

  it('reads a play hint, every best domino marked', () => {
    const d = (a: number, b: number) => createDomino(a, b);
    const hint: Hint = {
      kind: 'play',
      dominoes: [
        { domino: d(4, 6), marks: 0.62, gap: 0, rating: 'best' },
        { domino: d(6, 6), marks: 0.57, gap: 0.05, rating: 'close' },
        { domino: d(1, 3), marks: 0.22, gap: 0.4, rating: 'weaker' },
      ],
    };
    expect(hintHeadline(hint)).toBe('Play 6-4');
    expect(hintRows(hint).map((r) => [r.label, r.detail])).toEqual([
      ['6-4', 'best'],
      ['6-6', 'close (−0.05 marks)'],
      ['3-1', 'weaker (−0.40 marks)'],
    ]);
    expect(suggestedDominoIds(hint)).toEqual(['4/6']);
    expect(suggestedDominoIds(null)).toEqual([]);
  });
});
