// Match links that arrive while the player is signed out: fortytwo://match/<id>, or the Worker's
// https://<host>/match/<id> (an Android App Link). The router would send a signed-out player to
// sign-in and drop the link, so it's kept here and opened once they've signed in (the root
// layout). A link that arrives while signed in is left to the router, which opens it directly.
//
// Plain module state rather than React state: +native-intent.tsx runs outside the React tree.

let signedIn = false;
// Typed as the route it is, so the root layout can hand it to the typed router as is.
type MatchRoute = `/match/${string}`;

let pending: MatchRoute | null = null;

// The app route a link points at, if it's a match link: `/match/<id>`.
export function matchRoute(link: string): MatchRoute | null {
  const found = /(?:^|\/)match\/([^/?#]+)/.exec(link);
  return found ? `/match/${found[1]}` : null;
}

// Kept current by the root layout as it renders, so links are judged by the latest state.
export function setSignedIn(value: boolean): void {
  signedIn = value;
}

// Called for each incoming link (+native-intent.tsx). Before the stored session has been
// restored at launch, the player counts as signed out; the layout then finds the link already
// open if they were signed in after all.
export function noteIncomingLink(link: string): void {
  const route = matchRoute(link);
  if (route && !signedIn) pending = route;
}

// The match link waiting for sign-in, if any, cleared as it's taken.
export function takePendingLink(): MatchRoute | null {
  const route = pending;
  pending = null;
  return route;
}
