import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth, type AuthedUser } from './auth/verifyJwt';
import matchesRoutes from './routes/matches';
import usersRoutes from './routes/users';
import { BadRequestError } from './requestBody';

export interface Env {
  MATCH_DO: DurableObjectNamespace;
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_API_CLIENT_ID: string;
  AUTH0_API_CLIENT_SECRET: string;
  AUTH0_API_AUDIENCE: string;
  ALLOWED_ORIGIN?: string;
  // Dev-only testing aid (set via .dev.vars, gitignored - never present in a deployed environment):
  // when === 'true', players can seat bots in a match's open seats (POST /api/matches/:id/bots) and
  // MatchDO (matchDO.ts) drives their bids/trump/plays automatically, so one account - or a few
  // people testing together - can play a full match. Read as a
  // string, not boolean: .dev.vars is dotenv-style, so there's no real boolean type to declare here
  // - see bots.ts.
  AUTO_PLAY_BOTS?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { user: AuthedUser } }>();

// A malformed request body gets the same { title, detail } shape as a rule violation, which the
// client already renders. Anything else is logged and hidden behind a generic 500, so no stack
// trace or internal message ever reaches a client.
app.onError((err, c) => {
  if (err instanceof BadRequestError) return c.json({ title: err.title, detail: err.detail }, 400);
  console.error('Unhandled error', err);
  return c.json({ title: 'Something went wrong' }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

// WebSocket upgrade route for a match's live-state socket (matchDO.ts's `handleWebSocketUpgrade`).
// Deliberately mounted OUTSIDE the `/api/*` `requireAuth()` middleware below: a WebSocket upgrade
// request can't carry a standard `Authorization` header, so the DO's own upgrade handler validates
// the `?token=` query param itself instead.
//
// `MatchDO.fetch` dispatches on `url.pathname === '/ws'` exactly (it's already scoped to one match
// by its own DO identity, so it expects no `/matches/:id` prefix) - forwarding `c.req.raw` as-is
// would carry this route's full `/matches/:id/ws` pathname straight through and never match, so the
// request is rebuilt with its URL rewritten to `/ws` (preserving the `?token=` query string) before
// being handed to the DO. Passing the original request as the `Request` constructor's second
// argument copies its method/headers/body along with the new URL.
app.get('/matches/:id/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }
  const stub = c.env.MATCH_DO.get(c.env.MATCH_DO.idFromName(c.req.param('id')));
  const target = new URL(c.req.raw.url);
  target.pathname = '/ws';
  return stub.fetch(new Request(target.toString(), c.req.raw));
});

// Must run before requireAuth() so the preflight OPTIONS request - which carries no Authorization
// header - gets a CORS response instead of a 401. Falls back to the local Vite dev origin when
// ALLOWED_ORIGIN isn't set (e.g. `wrangler dev` without a .dev.vars entry); set ALLOWED_ORIGIN to
// the real Pages domain for staging/production.
app.use(
  '/api/*',
  cors({
    origin: (origin, c) => c.env.ALLOWED_ORIGIN ?? 'http://localhost:5173',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }),
);
app.use('/api/*', requireAuth());
// Feature switches the web app needs to know about - one worker flag drives both sides.
app.get('/api/config', (c) => c.json({ bots: c.env.AUTO_PLAY_BOTS === 'true' }));
app.route('/api/matches', matchesRoutes);
app.route('/api/users', usersRoutes);

export default app;
export { MatchDO } from './matchDO';
