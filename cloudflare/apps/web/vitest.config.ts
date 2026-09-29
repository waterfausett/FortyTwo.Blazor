import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // @testing-library/react's automatic `afterEach(cleanup)` only self-registers when it finds a
    // *global* `afterEach` - without this, every test file needs its own explicit `cleanup()` call
    // or a previous test's rendered tree leaks into the next one. Some files still call it
    // themselves, which is harmless.
    globals: true,
    // Test-only origins for client.ts / useMatchSocket.ts's import.meta.env.VITE_API_ORIGIN /
    // VITE_WS_ORIGIN reads - production sets these via .env files per environment (see
    // .env.local), not here. Vitest merges `test.env` into process.env before running, which Vite's
    // loadEnv (the same mechanism that resolves import.meta.env.VITE_*) folds in alongside any
    // .env files, so these are visible to code exactly like a real VITE_-prefixed env var would be.
    env: {
      VITE_API_ORIGIN: 'https://api.test.local',
      VITE_WS_ORIGIN: 'wss://api.test.local',
    },
  },
});
