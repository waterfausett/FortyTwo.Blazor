import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth, type AuthedUser } from './auth/verifyJwt';
import matchesRoutes from './routes/matches';
import usersRoutes from './routes/users';
import { BadRequestError } from './requestBody';
import { expireIdleMatches } from './expiry';
import { assetLinks } from './appLinks';
import { botsEnabled } from './bots';
import type { MatchDO } from './matchDO';
import type { ClientConfig } from '@fortytwo/api-types';

export interface Env {
  MATCH_DO: DurableObjectNamespace<MatchDO>;
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_API_CLIENT_ID: string;
  AUTH0_API_CLIENT_SECRET: string;
  AUTH0_API_AUDIENCE: string;
  ALLOWED_ORIGIN?: string;
  // Bots (the ML bot, falling back to simple rules) can fill open seats unless this is exactly
  // 'false': a kill switch settable in the Cloudflare dashboard without a deploy.
  BOTS_ENABLED?: string;
  // The static-assets binding (wrangler.toml's [assets]); mlBot.ts reads the bot's weights from it.
  ASSETS?: Fetcher;
  // The Android app's signing-certificate SHA-256 fingerprints, comma-separated, for App Links
  // (appLinks.ts). Not secret: Android reads them from a public file.
  ANDROID_APP_FINGERPRINTS?: string;
  // An Expo access token, needed to send push notifications only once "enhanced push security"
  // is turned on for the Expo project (push/send.ts). A secret: `wrangler secret put`.
  EXPO_ACCESS_TOKEN?: string;
}

// The Hono environment every route runs in: the bindings above, plus the signed-in user that
// requireAuth() puts on the context.
export type AppEnv = { Bindings: Env; Variables: { user: AuthedUser } };

const app = new Hono<AppEnv>();

// A malformed request body gets the same { title, detail } shape as a rule violation, which the
// client already renders. Anything else is logged and hidden behind a generic 500, so no stack
// trace or internal message ever reaches a client.
app.onError((err, c) => {
  if (err instanceof BadRequestError) return c.json({ title: err.title, detail: err.detail }, 400);
  console.error('Unhandled error', err);
  return c.json({ title: 'Something went wrong' }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

// Android App Links (appLinks.ts). Public, like the web app's own files.
app.get('/.well-known/assetlinks.json', (c) => {
  const statements = assetLinks(c.env.ANDROID_APP_FINGERPRINTS);
  return statements ? c.json(statements) : c.notFound();
});

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
app.get('/api/config', (c) => c.json({ bots: botsEnabled(c.env) } satisfies ClientConfig));
app.route('/api/matches', matchesRoutes);
app.route('/api/users', usersRoutes);

export { app };

// The Worker's entry points: every request goes through the Hono app; the daily cron
// (wrangler.toml's [triggers]) runs the expiry sweep.
export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(expireIdleMatches(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
export { MatchDO } from './matchDO';
