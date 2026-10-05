// Types `cloudflare:test`'s `env` as the worker's own bindings plus the test-only ones
// vitest.config.ts adds through miniflare.
import type { Env } from '../src/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
    TINY_BOT_JSON: string;
    TINY_BOT_BIN_B64: string;
  }
}
