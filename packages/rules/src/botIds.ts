// The reserved ids the Worker's bots sit under (apps/worker/src/bots.ts: the ML bot, or its
// simple-rules fallback). Lives here, not in the Worker, because the rules and the web client need
// to know who's a bot too: bots count as agreeing to a rematch without voting.
export const BOT_IDS = ['bot-1', 'bot-2', 'bot-3'] as const;

export function isBot(playerId: string): boolean {
  return (BOT_IDS as readonly string[]).includes(playerId);
}

// What a bot is called at the table: bot-1 is "Bot 1". Bots have no account to take a name from.
export function botDisplayName(playerId: string): string {
  return `Bot ${playerId.slice('bot-'.length)}`;
}
