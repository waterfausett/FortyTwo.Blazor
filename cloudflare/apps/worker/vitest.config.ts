import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import fs from 'node:fs';
import path from 'node:path';

// wrangler.toml serves the web app's build as static assets and refuses to load if that directory
// is missing. The tests never request an asset, so an empty directory is enough when the web app
// hasn't been built.
fs.mkdirSync(path.join(__dirname, '../web/dist'), { recursive: true });

// vitest-pool-workers' local D1 instance is isolated from `wrangler d1 migrations apply --local`
// (a separate CLI-driven sqlite store) - so migrations must be applied inside the test worker
// itself. We read them here and hand them to the worker as a TEST_MIGRATIONS binding; a setup
// file (test/applyMigrations.ts) then runs them against env.DB before any test executes.
const migrationsPath = path.join(__dirname, 'migrations');
const migrations = await readD1Migrations(migrationsPath);

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/applyMigrations.ts'],
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
            TEST_MIGRATIONS: migrations,
            // Pinned off regardless of a developer's local .dev.vars (which vitest-pool-workers
            // also loads into this pool), so the bot routes stay off unless a test asks for them.
            // matchDOBots.test.ts and routes.matches.test.ts turn AUTO_PLAY_BOTS on per call
            // (runInDurableObject's env override / app.request's env argument) instead.
            AUTO_PLAY_BOTS: 'false',
          },
        },
      },
    },
  },
});
