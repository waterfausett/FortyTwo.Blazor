import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/cursor';
import { BadRequestError } from '../src/requestBody';

describe('lobby cursor', () => {
  it('round-trips', () => {
    const cursor = { updatedOn: '2026-09-24T01:00:00.000Z', id: '0b7c1f2e-aaaa-bbbb-cccc-123456789abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is URL-safe', () => {
    expect(encodeCursor({ updatedOn: '2026-09-24T01:00:00.000Z', id: '???>>>' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('treats a missing or empty cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it.each(['%%%', btoa('no-separator'), btoa('not-a-date|id'), btoa('2026-09-24T01:00:00.000Z|')])(
    'rejects %s',
    (raw) => {
      expect(() => decodeCursor(raw)).toThrow(BadRequestError);
    }
  );
});
