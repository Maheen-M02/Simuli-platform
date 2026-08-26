import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Browser integration tests launch a real Chromium; give them room but never
    // let a hung page stall the suite.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The fixture site binds a port and the browser is heavyweight; running
    // files in parallel makes failures non-deterministic.
    fileParallelism: false,
  },
});
