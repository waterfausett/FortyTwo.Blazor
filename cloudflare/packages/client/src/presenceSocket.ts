// The presence socket (the Worker's matchmaker.ts): how many players have the app open. One per
// signed-in app while it's in front; the server sends the count on connect and then at most once
// a minute, and the client sends nothing.
import type { PresenceMessage } from '@fortytwo/api-types';
import { connectSocket } from './socket';

function isPresenceMessage(value: unknown): value is PresenceMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'online' &&
    typeof (value as { online?: unknown }).online === 'number'
  );
}

export function connectPresenceSocket({
  origin,
  getToken,
  onOnline,
  subscribeWake,
}: {
  origin: string;
  getToken: () => Promise<string>;
  onOnline: (online: number) => void;
  subscribeWake?: (wake: () => void) => () => void;
}): () => void {
  return connectSocket({
    url: (token) => `${origin}/presence/ws?token=${token}`,
    getToken,
    onMessage: (data) => {
      if (isPresenceMessage(data)) onOnline(data.online);
    },
    subscribeWake,
  });
}
