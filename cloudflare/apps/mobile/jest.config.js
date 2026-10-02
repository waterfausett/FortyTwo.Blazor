module.exports = {
  preset: 'jest-expo',
  // React Native requires much of itself lazily, so the first test in a file to render a Modal or
  // the safe-area provider also waits for Jest to compile those modules. Without a transform cache
  // (a fresh CI runner) that alone can pass Jest's default 5 s; warm, the same tests take
  // milliseconds.
  testTimeout: 30000,
  moduleNameMapper: {
    // This app needs React 19.2.3, the exact version React Native's renderer was built against,
    // and npm keeps that copy in apps/mobile/node_modules because apps/web's newer React is the
    // one hoisted to the repo root. Packages hoisted to the root (react-native, the test renderer,
    // @tanstack/react-query, ...) would otherwise load that root copy in tests. Expo's Metro
    // config already does this for the app bundle.
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
