import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth, type AuthedUser } from './auth/verifyJwt';
import matchesRoutes from './routes/matches';
import usersRoutes from './routes/users';

export interface Env {
  MATCH_DO: DurableObjectNamespace;
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_API_CLIENT_ID: string;
  AUTH0_API_CLIENT_SECRET: string;
  AUTH0_API_AUDIENCE: string;
  ALLOWED_ORIGIN?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { user: AuthedUser } }>();

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
app.route('/api/matches', matchesRoutes);
app.route('/api/users', usersRoutes);

export default app;
export { MatchDO } from './matchDO';
