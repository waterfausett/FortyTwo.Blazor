// React Native has no window focus or online events, so react-query never learns the app came back
// or the network returned, and refetches nothing. This feeds it AppState and NetInfo instead: on
// coming back to the app, or the network returning, every query on screen that's gone stale
// refetches - the web app gets the same from the browser. Queries kept fresh some other way (the
// match screen's socket, `staleTime: Infinity`) opt out.
import { focusManager, onlineManager, type Query } from '@tanstack/react-query';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

// The lobby stays mounted under whatever is opened from it, so its queries count as on screen even
// when they're not. Those wait until the lobby is really showing: going back to it has its own
// refresh (app/index.tsx), and a fetch now would only be repeated then.
const LOBBY_QUERIES: unknown[] = ['matches', 'invites', 'people'];
let lobbyShowing = true;

export function setLobbyShowing(showing: boolean): void {
  lobbyShowing = showing;
}

// For the QueryClient's refetchOnWindowFocus and refetchOnReconnect.
export function refetchIfShowing(query: Query<any, any, any, any>): boolean {
  return lobbyShowing || !LOBBY_QUERIES.includes(query.queryKey[0]);
}

export function connectQueryFocus(): void {
  // Only the background counts as away, as for the match socket (useMatchSocket's
  // useAppInForeground): iOS goes 'inactive' for a pulled-down notification centre too.
  focusManager.setEventListener((setFocused) => {
    // Starting from where the app is now, so the first 'change' only counts if it really is one.
    setFocused(AppState.currentState !== 'background');
    const subscription = AppState.addEventListener('change', (state) => setFocused(state !== 'background'));
    return () => subscription.remove();
  });
  // NetInfo reads null while it doesn't know yet: only a definite "not connected" is offline.
  onlineManager.setEventListener((setOnline) => NetInfo.addEventListener((state) => setOnline(state.isConnected !== false)));
}
