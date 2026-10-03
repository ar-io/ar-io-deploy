import { defineConfig } from 'vitest/config'

/**
 * Live tests: the built CLI against Turbo's development sandbox, the sandbox
 * gateway and public Solana RPCs. No MSW, nothing mocked. Sandbox uploads
 * within the free limit cost nothing, but they are real, permanent uploads.
 */
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    globals: true,
    hookTimeout: 120_000,
    include: ['tests/live/**/*.test.ts'],
    // Indexing on the gateway can take minutes.
    testTimeout: 15 * 60_000,
  },
})
