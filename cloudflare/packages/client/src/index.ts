// @fortytwo/client: the parts of a Forty-Two client that don't depend on how it draws - the REST
// wrapper, the match socket's connect-and-reconnect loop, and the table-geometry and match-summary
// helpers. Shared by apps/web and a future React Native app, so nothing here may use browser-only
// APIs (window, document, localStorage) or React; each app passes in whatever differs by platform,
// such as the API origin and what counts as a wake-up for the socket.
export * from './api';
export * from './matchSocket';
export * from './summary';
export * from './table';
