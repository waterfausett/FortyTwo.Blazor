// Checks request bodies at the route boundary, so MatchDO and the rules engine only ever see values
// of the types they're declared with. Everything here throws `BadRequestError`, which index.ts's
// `onError` turns into a 400 in the same { title, detail } shape as a rule violation.
import type { Context } from 'hono';
import { Bid, Suit, Teams, createDomino, type Domino } from '@fortytwo/rules';

export class BadRequestError extends Error {
  readonly title = 'Invalid request';

  constructor(public detail: string) {
    super(detail);
    this.name = 'BadRequestError';
  }
}

type Body = Record<string, unknown>;

// The body as a JSON object - a missing body, broken JSON, or an array/primitive is a 400.
export async function readBody(c: Context): Promise<Body> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequestError('The request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('The request body must be a JSON object.');
  }
  return body as Body;
}

// A numeric enum's values, leaving out the reverse-mapped names TypeScript also puts on it.
function enumValues(e: Record<string, string | number>): number[] {
  return Object.values(e).filter((v): v is number => typeof v === 'number');
}

const BIDS = enumValues(Bid);
const SUITS = enumValues(Suit);
const TEAMS = enumValues(Teams);

function oneOf(body: Body, field: string, allowed: number[]): number {
  const value = body[field];
  if (typeof value !== 'number' || !allowed.includes(value)) {
    throw new BadRequestError(`\`${field}\` must be one of ${allowed.join(', ')}.`);
  }
  return value;
}

export function position(body: Body): number {
  return oneOf(body, 'position', [0, 1, 2, 3]);
}

export function team(body: Body): Teams {
  return oneOf(body, 'team', TEAMS);
}

export function bid(body: Body): Bid {
  return oneOf(body, 'bid', BIDS);
}

export function suit(body: Body): Suit {
  return oneOf(body, 'suit', SUITS);
}

export function ready(body: Body): boolean {
  if (typeof body.ready !== 'boolean') throw new BadRequestError('`ready` must be true or false.');
  return body.ready;
}

// Rebuilt from its two halves, so a client-supplied `id` never reaches the engine.
export function domino(body: Body): Domino {
  const value = body.domino as { top?: unknown; bottom?: unknown } | null;
  const isHalf = (half: unknown) => typeof half === 'number' && Number.isInteger(half) && half >= 0 && half <= 6;
  if (typeof value !== 'object' || value === null || !isHalf(value.top) || !isHalf(value.bottom)) {
    throw new BadRequestError('`domino` must have a `top` and `bottom` from 0 to 6.');
  }
  return createDomino(value.top as number, value.bottom as number);
}
