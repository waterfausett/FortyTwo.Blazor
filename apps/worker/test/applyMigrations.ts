import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';
import type { Env } from '../src/index';

// Runs once per test worker before any test file executes, applying migrations/*.sql to the
// isolated local D1 instance vitest-plugin provisions for env.DB. This is separate from
// (and does not touch) the sqlite store `wrangler d1 migrations apply --local` writes to.
const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
