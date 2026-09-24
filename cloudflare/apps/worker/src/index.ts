import { Hono } from 'hono';
import { requireAuth, type AuthedUser } from './auth/verifyJwt';

export interface Env {
  MATCH_DO: DurableObjectNamespace;
  DB: D1Database;
  AUTH0_DOMAIN: string;
  AUTH0_AUDIENCE: string;
  AUTH0_API_CLIENT_ID: string;
  AUTH0_API_CLIENT_SECRET: string;
  AUTH0_API_AUDIENCE: string;
}

const app = new Hono<{ Bindings: Env; Variables: { user: AuthedUser } }>();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/api/*', requireAuth());

export default app;
// Task 11 adds ./matchDO and restores this export.
// export { MatchDO } from './matchDO';
