// The lobby's page cursor as clients see it: an opaque, URL-safe token for where the last page
// ended (lobby.ts's LobbyCursor), so clients never build or depend on its contents.
import type { LobbyCursor } from './lobby';
import { BadRequestError } from './requestBody';

export function encodeCursor({ updatedOn, id }: LobbyCursor): string {
  return btoa(`${updatedOn}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// No cursor means the first page. Anything that isn't one of ours is a 400.
export function decodeCursor(raw: string | undefined): LobbyCursor | null {
  if (raw === undefined || raw === '') return null;
  let text: string;
  try {
    text = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
  const separator = text.indexOf('|');
  const updatedOn = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (separator <= 0 || id === '' || Number.isNaN(Date.parse(updatedOn))) {
    throw new BadRequestError('Invalid cursor');
  }
  return { updatedOn, id };
}
