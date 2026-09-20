import { defineConfig } from 'vitest/config'

/**
 * Tests exercise the built artifact in `lib/`, which is what a deployment
 * loads. `npm test` therefore builds before it runs; see the `test` script.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
})
