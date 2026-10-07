// @fortytwo/client: the parts of a Forty-Two client that don't depend on how it draws - the REST
// wrapper, the match socket's connect-and-reconnect loop, what a seated player can see and do in a
// match, what to call each player, and the table-geometry and match-summary helpers. Shared by
// apps/web and apps/mobile, so nothing here may use browser-only APIs (window, document,
// localStorage) or React; each app passes in whatever differs by platform, such as the API origin
// and what counts as a wake-up for the socket.
export * from './api';
export * from './lobby';
export * from './matchSocket';
export * from './matchView';
export * from './optimistic';
export * from './playerNames';
export * from './poke';
export * from './summary';
export * from './table';
