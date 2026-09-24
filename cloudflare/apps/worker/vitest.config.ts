import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        // Test-only Auth0 vars: production sets these via `wrangler secret`/dashboard, not
        // wrangler.toml. MatchDO's WebSocket upgrade handler calls `verifyToken(token, this.env)`
        // directly (no Hono Context to inject a JWKS resolver through, unlike requireAuth's
        // tests), so it needs real `env.AUTH0_DOMAIN`/`AUTH0_AUDIENCE` bindings here; the matching
        // JWKS endpoint is mocked in matchDOSocket.test.ts via `cloudflare:test`'s `fetchMock`.
        miniflare: {
          bindings: {
            AUTH0_DOMAIN: 'test-tenant.auth0.local',
            AUTH0_AUDIENCE: 'https://api.test.local',
          },
        },
      },
    },
  },
});
