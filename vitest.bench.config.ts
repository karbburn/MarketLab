import { defineConfig } from 'vitest/config';

/**
 * Benchmark configuration, deliberately separate from `vitest.config.ts`:
 * benchmarks report timings but never gate the build. `npm run test` must keep
 * running only the correctness suites.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
    // The report is the product of this suite; never suppress it for passing runs.
    silent: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
