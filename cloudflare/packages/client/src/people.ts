// What the People list says under a name: how many games together and how recently, or that
// they're a friend. Shared by the web and mobile lists.
import type { Person } from '@fortytwo/api-types';

function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

export function personDetail(person: Person, now: number = Date.now()): string {
  const games = person.games === 1 ? '1 game' : `${person.games} games`;
  if (person.isFriend) return person.games > 0 ? `Friend · ${games}` : 'Friend';
  if (person.games === 0 || person.lastPlayedOn === null) return '';
  return `${games} · ${ago(person.lastPlayedOn, now)}`;
}
