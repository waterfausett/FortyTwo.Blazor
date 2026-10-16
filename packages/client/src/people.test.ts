import { describe, expect, it } from 'vitest';
import { inviteDetail, personDetail } from './people';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const person = (p: Partial<Parameters<typeof personDetail>[0]>) => ({
  user_id: 'u',
  displayName: 'Ann',
  isFriend: false,
  lastPlayedOn: null,
  games: 0,
  ...p,
});

describe('personDetail', () => {
  it('says how many games and how long ago', () => {
    expect(personDetail(person({ games: 3, lastPlayedOn: '2026-10-12T12:00:00.000Z' }), NOW)).toBe('3 games · 2d ago');
    expect(personDetail(person({ games: 1, lastPlayedOn: '2026-10-14T09:00:00.000Z' }), NOW)).toBe('1 game · 3h ago');
    expect(personDetail(person({ games: 1, lastPlayedOn: '2026-10-14T11:59:30.000Z' }), NOW)).toBe('1 game · just now');
  });

  it('says Friend for a friend', () => {
    expect(personDetail(person({ isFriend: true, games: 2, lastPlayedOn: '2026-10-12T12:00:00.000Z' }), NOW)).toBe('Friend · 2 games');
    expect(personDetail(person({ isFriend: true }), NOW)).toBe('Friend');
  });

  it('says nothing for a stranger from search', () => {
    expect(personDetail(person({}), NOW)).toBe('');
  });
});

describe('inviteDetail', () => {
  const invite = { matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-10-14T11:55:00.000Z', seatsOpen: 2 };

  it('says how long ago and how many seats are open', () => {
    expect(inviteDetail(invite, NOW)).toBe('5m ago · 2 seats open');
    expect(inviteDetail({ ...invite, seatsOpen: 1, createdOn: '2026-10-13T12:00:00.000Z' }, NOW)).toBe('1d ago · 1 seat open');
  });
});
