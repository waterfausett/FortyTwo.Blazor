// Checks request bodies at the route boundary, so MatchDO and the rules engine only ever see values
// of the types they're declared with. Everything here throws `BadRequestError`, which index.ts's
// `onError` turns into a 400 in the same { title, detail } shape as a rule violation.
import type { Context } from 'hono';
import { BOT_MARK, Bid, Suit, Teams, ValidationError, assertValidHouseRules, createDomino, type Domino, type HouseRules } from '@fortytwo/rules';
import { MAX_USER_IDS } from './auth0Management';
import type { PeopleView, ProfilePatch } from '@fortytwo/api-types';

export class BadRequestError extends Error {
  readonly title = 'Invalid request';

  constructor(public detail: string) {
    super(detail);
    this.name = 'BadRequestError';
  }
}

type Body = Record<string, unknown>;

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BadRequestError('The request body must be JSON.');
  }
}

// The body as a JSON object - a missing body, broken JSON, or an array/primitive is a 400.
export async function readBody(c: Context): Promise<Body> {
  const body = await readJson(c);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('The request body must be a JSON object.');
  }
  return body as Body;
}

// A body that may be left out altogether: no body is an empty object. Anything sent must still be
// a JSON object. (POST /api/matches: installed mobile builds send no body.)
export async function readOptionalBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequestError('The request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('The request body must be a JSON object.');
  }
  return body as Body;
}

// A custom table's house rules, or undefined when none were sent (the defaults).
export function houseRules(body: Body): HouseRules | undefined {
  if (body.rules === undefined) return undefined;
  try {
    return assertValidHouseRules(body.rules);
  } catch (error) {
    if (error instanceof ValidationError) throw new BadRequestError(error.detail ?? error.title);
    throw error;
  }
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

// Which matchmaking queue: Live or Async. (Custom tables come from POST /api/matches.)
export function mode(body: Body): 'live' | 'daily' {
  if (body.mode !== 'live' && body.mode !== 'daily') throw new BadRequestError('`mode` must be "live" or "daily".');
  return body.mode;
}

// Only ever false: a player takes their seat back from the bot. A bot takes it over on its own,
// when a Live turn runs out.
export function autopilotOff(body: Body): false {
  if (body.autopilot !== false) throw new BadRequestError('`autopilot` can only be set to false.');
  return false;
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

// Auth0 ids are `connection|id` (e.g. `auth0|64f...`, `google-oauth2|1234`, `samlp|acme|a@b.com`);
// bots are `bot-N` or `<matchId>_bot-N`. Anything with quotes, brackets or whitespace isn't an id.
const USER_ID = /^[A-Za-z0-9|._:@+=/-]{1,256}$/;

// The body of a user search: a JSON array of up to MAX_USER_IDS user ids, de-duplicated.
export async function readUserIds(c: Context): Promise<string[]> {
  const body = await readJson(c);
  if (!Array.isArray(body) || !body.every((id) => typeof id === 'string' && USER_ID.test(id))) {
    throw new BadRequestError('The request body must be an array of user ids.');
  }
  const ids = [...new Set(body as string[])];
  if (ids.length > MAX_USER_IDS) {
    throw new BadRequestError(`Look up at most ${MAX_USER_IDS} users at a time.`);
  }
  return ids;
}

export const MAX_DISPLAY_NAME_LENGTH = 50;
export const MAX_PICTURE_URL_LENGTH = 2048;

// A profile update, keeping only the fields a player may set; anything else in the body is dropped
// rather than stored in their Auth0 user_metadata.
export function profilePatch(body: Body): ProfilePatch {
  const patch: ProfilePatch = {};
  if (body.displayName !== undefined) patch.displayName = displayName(body.displayName);
  if (body.picture !== undefined) patch.picture = picture(body.picture);
  if (body.highlightPlayable !== undefined) patch.highlightPlayable = setting(body, 'highlightPlayable');
  if (body.pushNotifications !== undefined) patch.pushNotifications = setting(body, 'pushNotifications');
  if (body.seenHowToPlay !== undefined) patch.seenHowToPlay = setting(body, 'seenHowToPlay');
  return patch;
}

// An on/off setting.
function setting(body: Body, field: string): boolean {
  const value = body[field];
  if (typeof value !== 'boolean') throw new BadRequestError(`\`${field}\` must be true or false.`);
  return value;
}

// Trimmed, 1 to MAX_DISPLAY_NAME_LENGTH characters, no control characters, and not the bot mark -
// that is how the table tells a bot from a person.
function displayName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '' || [...name].length > MAX_DISPLAY_NAME_LENGTH || /\p{Cc}/u.test(name)) {
    throw new BadRequestError(
      `\`displayName\` must be 1 to ${MAX_DISPLAY_NAME_LENGTH} characters, with no control characters.`
    );
  }
  if (name.includes(BOT_MARK)) {
    throw new BadRequestError(`\`displayName\` can't contain ${BOT_MARK}; that marks the bots.`);
  }
  return name;
}

// An https: URL, since everyone at the table loads it as an <img src>. Blank clears it, which puts
// the account's own picture back.
function picture(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestError('`picture` must be a URL.');
  const url = value.trim();
  if (url === '') return '';
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'https:' || url.length > MAX_PICTURE_URL_LENGTH) {
    throw new BadRequestError(`\`picture\` must be an https: URL of at most ${MAX_PICTURE_URL_LENGTH} characters.`);
  }
  return url;
}

// A user id from a route parameter (Hono has already URL-decoded it).
export function userIdParam(value: string | undefined): string {
  if (value === undefined || !USER_ID.test(value)) throw new BadRequestError('That is not a user id.');
  return value;
}

// A People search: trimmed, SEARCH_MIN to SEARCH_MAX characters.
export function peopleView(value: string | undefined): PeopleView | undefined {
  if (value === undefined) return undefined;
  if (value === 'friends' || value === 'recent') return value;
  throw new BadRequestError('show must be friends or recent.');
}

export function searchQuery(value: string | undefined, min: number, max: number): string {
  const q = (value ?? '').trim();
  if ([...q].length < min || [...q].length > max) {
    throw new BadRequestError(`Search with ${min} to ${max} characters.`);
  }
  return q;
}

// POST /api/matches/:id/invites: `{ userIds }`, 1 to `max` user ids, de-duplicated.
export function invitees(body: Body, max: number): string[] {
  const ids = body.userIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && USER_ID.test(id))) {
    throw new BadRequestError('`userIds` must be a list of user ids.');
  }
  const unique = [...new Set(ids as string[])];
  if (unique.length > max) throw new BadRequestError(`Invite at most ${max} players at a time.`);
  return unique;
}
