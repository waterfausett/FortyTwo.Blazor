// What the Live search lobby shows, shared by the web and mobile match screens: the bar toward the
// bot fill, who has sat down on each team, the card's pages (tips and the player's own stats), and
// what to announce when someone joins.
import type { StatsSummary } from '@fortytwo/api-types';
import { LIVE_FILL_MS, type MatchPlayerRef } from '@fortytwo/rules';
import { bestPartnerRecord, favoriteTrumpRecord, statSections, trumpLabel } from './stats';

// How long each card stays up before the next, and how long a manual swipe holds it still.
export const LOBBY_CARD_MS = 9000;
// How long the full lobby stays up before the table appears.
export const LOBBY_FULL_HOLD_MS = 1200;
// How many tips one search shows: enough to last until the bots fill the table without repeating.
export const LOBBY_TIPS = Math.ceil(LIVE_FILL_MS / LOBBY_CARD_MS);
// How many of the card's dots show at once; the row slides along with the card.
export const LOBBY_DOTS = 7;

// Each restates a line of How to play (or the claim bar), so none says what the rules don't do.
export const SEARCH_TIPS: readonly string[] = [
  'Every hand has 42 points: 35 in the count dominoes, plus 1 for each of the seven tricks.',
  'The 5-5 and 6-4 are worth 10 points each. The 5-0, 4-1 and 3-2 are worth 5.',
  'A double is the highest domino of its suit: the 4-4 beats every other four.',
  'A trump belongs only to trump. With sixes trump, the 6-4 is a six, never a four.',
  'A domino that isn’t trump leads as its higher end: lead the 5-3 and fives are the suit led.',
  'Bid 84 and your team must take all 42 points - for 2 marks instead of 1!',
  'A Plunge needs four or more doubles. Your partner names trump, and your team must take every trick.',
  'If the first three players pass, the last player has to bid.',
  'Once the bid is 42 or more, the bidder can call Follow Me or Low instead of naming a trump.',
  'When playing Low, the bidder must lose every trick, and their partner sits the hand out.',
  'Can’t follow the suit led? Play anything - including a trump!',
  'A hand ends as soon as it’s decided, so you won’t always play all seven tricks.',
  'In a Live Match, start with bots and players can still join: each takes over a bot’s seat when a hand ends.',
  'In a Custom Match, you can play by your own rules!',
  'Live Matches have 60-second turns - and you get kicked if you’re on auto-pilot for a whole hand!',
  'Hop into Practice mode to test your skill against the 🤖s - take it easy, they’re still learning too!',
  'The first team to 7 marks wins the match.',
  'Set the bidders and your team scores the marks they bid.',
  'Whoever names trump leads the first trick.',
  'To bid 3 Marks, someone has to bid 84 first. Each rung after that goes up one at a time.',
  'A Plunge is worth 4 marks, and can only be bid while the high bid is under 4 Marks.',
  'On Follow Me there’s no trump: the highest domino of the suit led wins.',
  'Going Low? You also choose how doubles play: top of their suit, bottom of it, or a suit of their own.',
  'Low is lost the moment the bidder takes a trick.',
  'Whoever wins a trick leads the next one.',
  'Your turn ran out? A bot plays for you until you press Resume.',
  'Leave a Live game partway through and a bot takes your seat, so your team plays on.',
  'After a match, vote for a rematch. When all four agree, you go straight into the next one.',
  'Star players on the Friends tab, then invite them to a Custom Match.',
  'Async games let you take turns whenever, and we’ll notify you when the action is on you.',
  'If someone has kept an Async table waiting for 30 minutes, you can poke them.',
];

// A fresh handful of tips in a fresh order, so each search shows different ones.
export function shuffledTips(random: () => number = Math.random, count: number = LOBBY_TIPS): string[] {
  const tips = [...SEARCH_TIPS];
  for (let i = tips.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [tips[i], tips[j]] = [tips[j], tips[i]];
  }
  return tips.slice(0, count);
}

// The dots to show under the card: a window of LOBBY_DOTS around the current card, kept inside
// the row. An end dot with more cards past it is drawn small, and the one next to it a little
// smaller than full, so the row reads as going on.
export type LobbyDotSize = 'full' | 'small' | 'tiny';

export function lobbyDots(count: number, current: number, shown: number = LOBBY_DOTS): { index: number; size: LobbyDotSize }[] {
  const width = Math.min(count, shown);
  const start = Math.min(Math.max(0, current - Math.floor(width / 2)), count - width);
  const end = start + width;
  return Array.from({ length: width }, (_, k) => {
    const index = start + k;
    const fromEdge = Math.min(start > 0 ? k : Infinity, end < count ? width - 1 - k : Infinity);
    const size: LobbyDotSize = fromEdge === 0 ? 'tiny' : fromEdge === 1 ? 'small' : 'full';
    return { index, size };
  });
}

// How far the search is toward the bot fill, clamped for a late server or a skewed clock.
export function fillProgress(elapsedMs: number): { fraction: number; remainingMs: number } {
  const elapsed = Math.min(LIVE_FILL_MS, Math.max(0, elapsedMs));
  return { fraction: elapsed / LIVE_FILL_MS, remainingMs: LIVE_FILL_MS - elapsed };
}

// Who sits on each team, as playerIds (null for an empty seat). Us is the viewer and the seat
// across - partners sit across from each other - and Them the two seats beside. A viewer without a
// seat sees seats 0 and 2 as Us.
export interface LobbyRoster {
  us: [string | null, string | null];
  them: [string | null, string | null];
  seated: boolean;
}

export function lobbyRoster(players: MatchPlayerRef[], viewerId: string): LobbyRoster {
  const mine = players.find((p) => p.playerId === viewerId);
  const p = mine?.position ?? 0;
  const at = (offset: number) => players.find((q) => q.position === (p + offset) % 4)?.playerId ?? null;
  return { us: [at(0), at(2)], them: [at(1), at(3)], seated: mine !== undefined };
}

export function rosterIds(roster: LobbyRoster): (string | null)[] {
  return [...roster.us, ...roster.them];
}

export type LobbyCard =
  | { kind: 'tip'; text: string }
  | { kind: 'summary'; items: { label: string; value: string }[] }
  | { kind: 'favoriteTrump'; trump: string; record: string }
  | { kind: 'bestPartner'; name: string; record: string };

const SUMMARY_LABELS = ['Played', 'Won', 'Made rate'];

// The card's pages: a tip first, then the stats pages each between tips, then the rest of the
// tips. Tips only until there are stats to show.
export function lobbyCards(stats: StatsSummary | null | undefined, tips: readonly string[] = SEARCH_TIPS): LobbyCard[] {
  const tipCards = tips.map((text): LobbyCard => ({ kind: 'tip', text }));
  if (!stats || stats.played === 0) return tipCards;
  const tiles = statSections(stats).flatMap((s) => s.tiles);
  const statCards: LobbyCard[] = [
    { kind: 'summary', items: SUMMARY_LABELS.map((label) => tiles.find((t) => t.label === label)!) },
  ];
  if (stats.favoriteTrump) {
    statCards.push({
      kind: 'favoriteTrump',
      trump: trumpLabel(stats.favoriteTrump.trump),
      record: favoriteTrumpRecord(stats.favoriteTrump, stats.bidsWon),
    });
  }
  if (stats.bestPartner) {
    statCards.push({ kind: 'bestPartner', name: stats.bestPartner.user.displayName, record: bestPartnerRecord(stats.bestPartner) });
  }
  const cards: LobbyCard[] = [];
  statCards.forEach((card, i) => {
    if (tipCards[i]) cards.push(tipCards[i]);
    cards.push(card);
  });
  return [...cards, ...tipCards.slice(statCards.length)];
}

// "Maria joined, 2 of 4" when a seat fills; nothing when one empties or nothing changed.
export function joinAnnouncement(
  previous: (string | null)[],
  next: (string | null)[],
  nameOf: (id: string) => string | null
): string | null {
  const seated = next.filter((id) => id !== null).length;
  if (seated <= previous.filter((id) => id !== null).length) return null;
  const joined = next.find((id) => id !== null && !previous.includes(id));
  if (!joined) return null;
  return `${nameOf(joined) ?? 'A player'} joined, ${seated} of 4`;
}
