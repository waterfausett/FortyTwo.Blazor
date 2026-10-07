import { configDefaults, defineConfig } from 'vitest/config';
// dist/ holds tsc -b's compiled copies of the tests, which Vitest 4 no longer skips by default.
export default defineConfig({ test: { environment: 'node', exclude: [...configDefaults.exclude, 'dist/**'] } });
