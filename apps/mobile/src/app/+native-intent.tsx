// Expo Router hands every link that opens the app through here first. Links pass through
// unchanged; a match link that arrives while signed out is also kept, to open after sign-in
// (src/linking/incomingLink.ts).
import { noteIncomingLink } from '@/linking/incomingLink';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    noteIncomingLink(path);
  } catch {
    // Never fail to open the app over a link we couldn't read.
  }
  return path;
}
