import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    lib: {
      // The CLI's surface: oclif loads every file under dist/commands, and
      // `main` exports `run`. Everything else is bundled into chunks.
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'commands/deploy': resolve(__dirname, 'src/commands/deploy.ts'),
        'commands/upload': resolve(__dirname, 'src/commands/upload.ts'),
      },
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        '@ar.io/sdk',
        '@ardrive/turbo-sdk',
        '@inquirer/prompts',
        '@oclif/core',
        '@solana/kit',
        'bs58',
        'mime-types',
        'ora',
        'p-limit',
        /^node:.*/,
      ],
      output: {
        preserveModules: false,
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
    minify: false,
  },
  test: {
    globals: true,
    environment: 'node',
    // The e2e tests load the built CLI, which imports the heavy @ar.io/sdk
    // (Solana) and @solana/kit graphs. On a cold cache vitest pre-bundles these
    // with esbuild on first import, which can exceed the default 5s/30s timeouts
    // for whichever test triggers it first (warm runs are ~1.5s).
    testTimeout: 60000,
    hookTimeout: 60000,
    env: {
      // Enable MSW verbose logging by default (can be disabled with MSW_VERBOSE=false)
      MSW_VERBOSE: process.env.MSW_VERBOSE ?? 'true',
    },
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'dist/', '**/*.spec.ts', '**/*.test.ts'],
    },
  },
})
