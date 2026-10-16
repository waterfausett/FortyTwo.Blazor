// Who's a bot (apps/worker/src/bots.ts: the ML bot, or its simple-rules fallback). Lives here, not
// in the Worker, because the rules and the web client need to know too: bots count as agreeing to a
// rematch without voting.
//
// A bot id is `bot-N` (N 1 to 3), optionally behind a `<seed>_` prefix: `<matchId>_bot-2`. The
// prefix is what names the bot - see botDisplayName - so each table gets its own cast and the name
// travels with the id to every client. Bare `bot-N` ids are what matches before names were stored;
// they still work, and keep a fixed set of names.
const BOT_ID = /^(?:(.+)_)?bot-([1-3])$/;
const BOT_COUNT = 3;

// Every bot's name ends with this, and no player's can (see withoutBotMark), so a bot is never
// mistaken for a person - or the other way round.
export const BOT_MARK = '🤖';

const NAMES = [
  'Ada', 'Arlo', 'Bea', 'Beck', 'Cleo', 'Cyrus', 'Dani', 'Dex', 'Edie', 'Elio',
  'Fern', 'Finn', 'Gus', 'Hana', 'Hugo', 'Iris', 'Ivo', 'Jade', 'Juno', 'Kai',
  'Kit', 'Lena', 'Leo', 'Luz', 'Milo', 'Mina', 'Nico', 'Nova', 'Odie', 'Otto',
  'Pia', 'Quinn', 'Remy', 'Rhea', 'Sage', 'Theo', 'Uma', 'Vera', 'Wren', 'Zed', 'Zoe',
];

export function isBot(playerId: string): boolean {
  return BOT_ID.test(playerId);
}

// The id for a bot joining a table, or undefined when all three are seated. `seated` is every
// playerId at the table. A new bot takes the prefix of the bots already there, so a table keeps one
// seed for good - through a rematch, a human taking a bot's seat and a bot coming back - and its
// names stay distinct. Only a table with no bot yet is seeded with `matchId`.
export function mintBotId(matchId: string, seated: readonly string[]): string | undefined {
  const bots = seated.map((id) => BOT_ID.exec(id)).filter((m): m is RegExpExecArray => m !== null);
  const taken = new Set(bots.map((m) => Number(m[2])));
  const number = [1, 2, 3].find((n) => !taken.has(n));
  if (number === undefined) return undefined;
  const prefix = bots.length > 0 ? (bots[0][1] ?? '') : matchId;
  return prefix === '' ? `bot-${number}` : `${prefix}_bot-${number}`;
}

// What a bot is called at the table: "Ada 🤖". The seed picks an order for NAMES and bot N takes
// the Nth, so the three bots at a table can't share a name. Pure in the id, so every place that
// shows a bot (the table, pushes, the lobby) agrees without asking the match.
export function botDisplayName(playerId: string): string {
  const m = BOT_ID.exec(playerId);
  if (m === null) return playerId;
  return `${seededOrder(m[1] ?? '')[Number(m[2]) - 1]} ${BOT_MARK}`;
}

// A name with the bot mark taken out, for names players choose or bring from their accounts. What
// is left is trimmed and may be empty.
export function withoutBotMark(name: string): string {
  return name.replaceAll(BOT_MARK, '').replace(/\s+/g, ' ').trim();
}

function seededOrder(seed: string): string[] {
  // FNV-1a over the seed, then mulberry32 for a Fisher-Yates shuffle of the first BOT_COUNT places.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  const random = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const names = [...NAMES];
  for (let i = 0; i < BOT_COUNT; i++) {
    const j = i + Math.floor(random() * (names.length - i));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, BOT_COUNT);
}
