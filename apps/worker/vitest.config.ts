import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// wrangler.toml serves the web app's build as static assets and refuses to load if that directory
// is missing. The tests never request an asset, so an empty directory is enough when the web app
// hasn't been built.
fs.mkdirSync(path.join(__dirname, '../web/dist'), { recursive: true });

// The pool's ASSETS binding, though, serves an empty directory instead of ../web/dist: once the web
// app has been built that holds the real model (/models/bot.*), which the ML bot would load and
// play differently from the simple bots the flow tests assert on. Whatever the local build state,
// the tests get no model, so getMlBot resolves to null (mlBot.test.ts fakes the binding for the
// cases that need files).
// The tiny test model from the bot package, handed to mlBot.test.ts as text/base64 bindings (the
// pool has no fs).
const fixtures = path.join(__dirname, '../../packages/bot/test/fixtures');
const emptyAssets = path.join(os.tmpdir(), 'fortytwo-no-assets');
fs.mkdirSync(emptyAssets, { recursive: true });

// vitest-plugin's local D1 instance is isolated from `wrangler d1 migrations apply --local`
// (a separate CLI-driven sqlite store) - so migrations must be applied inside the test worker
// itself. We read them here and hand them to the worker as a TEST_MIGRATIONS binding; a setup
// file (test/applyMigrations.ts) then runs them against env.DB before any test executes.
const migrationsPath = path.join(__dirname, 'migrations');
const migrations = await readD1Migrations(migrationsPath);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Test-only Auth0 vars: production sets these via `wrangler secret`/dashboard, not
      // wrangler.toml. MatchDO's WebSocket upgrade handler calls `verifyToken(token, this.env)`
      // directly (no Hono Context to inject a JWKS resolver through, unlike requireAuth's
      // tests), so it needs real `env.AUTH0_DOMAIN`/`AUTH0_AUDIENCE` bindings here; the matching
      // JWKS endpoint is mocked in matchDOSocket.test.ts via test/fetchMock.ts.
      miniflare: {
        assets: { directory: emptyAssets },
        bindings: {
          AUTH0_DOMAIN: 'test-tenant.auth0.local',
          AUTH0_AUDIENCE: 'https://api.test.local',
          // auth0Management.ts keys the Management API token it keeps in D1 by this.
          AUTH0_API_AUDIENCE: 'https://api.test.local/mgmt',
          TEST_MIGRATIONS: migrations,
          TINY_BOT_JSON: fs.readFileSync(path.join(fixtures, 'tiny-bot.json'), 'utf8'),
          TINY_BOT_BIN_B64: fs.readFileSync(path.join(fixtures, 'tiny-bot.bin')).toString('base64'),
          // Pinned off regardless of a developer's local .dev.vars (which vitest-plugin
          // also loads into this pool), so the bot routes stay off unless a test asks for them.
          // routes.matches.test.ts turns BOTS_ENABLED on per call (app.request's env argument)
          // instead.
          BOTS_ENABLED: 'false',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/applyMigrations.ts'],
  },
});
