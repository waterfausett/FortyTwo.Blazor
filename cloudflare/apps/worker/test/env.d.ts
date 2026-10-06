// Types `cloudflare:test`'s `env` (a Cloudflare.Env) as the worker's own bindings plus the
// test-only ones vitest.config.ts adds through miniflare.
import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
      TINY_BOT_JSON: string;
      TINY_BOT_BIN_B64: string;
    }
  }
}
