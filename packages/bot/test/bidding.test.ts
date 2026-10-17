import { describe, expect, it } from 'vitest';
import { chooseBid, optionsFromTable, type BidTable } from '../src/bidding';

// A hand that can only make a Low: every high and points probability is near zero, Low is near certain.
const lowOnly: BidTable = {
  points: Array.from({ length: 7 }, () => new Array(12).fill(0.01)),
  high: new Array(8).fill(0.01),
  low: [0.95, 0.9, 0.9],
  plunge: null,
};
const legal = [0, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 84];
const cfg = { makeThreshold: 0.6, overbidPartnerThreshold: 0.9 };
const ctx = { legal, partnerHolds: false, lastToBid: false };

describe('optionsFromTable', () => {
  it('values 42+ bids by Low when Low is allowed', () => {
    const options = optionsFromTable(lowOnly, legal);
    expect(options.some((o) => o.trump < -1)).toBe(true);
    expect(chooseBid(options, ctx, cfg).bid).toBeGreaterThanOrEqual(42);
  });

  it('leaves Low out when it is not allowed, so the bot passes a Low-only hand', () => {
    const options = optionsFromTable(lowOnly, legal, false);
    expect(options.some((o) => o.trump < -1)).toBe(false);
    expect(chooseBid(options, ctx, cfg).bid).toBe(0);
  });
});
