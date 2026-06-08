import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'commands/deploy': resolve(__dirname, 'src/commands/deploy.ts'),
        'commands/upload': resolve(__dirname, 'src/commands/upload.ts'),
        'workflows/upload-workflow': resolve(__dirname, 'src/workflows/upload-workflow.ts'),
        'constants/flags': resolve(__dirname, 'src/constants/flags.ts'),
        'prompts/arns': resolve(__dirname, 'src/prompts/arns.ts'),
        'prompts/deployment': resolve(__dirname, 'src/prompts/deployment.ts'),
        'prompts/wallet': resolve(__dirname, 'src/prompts/wallet.ts'),
        'utils/config-resolver': resolve(__dirname, 'src/utils/config-resolver.ts'),
        'utils/constants': resolve(__dirname, 'src/utils/constants.ts'),
        'utils/path': resolve(__dirname, 'src/utils/path.ts'),
        'utils/validators': resolve(__dirname, 'src/utils/validators.ts'),
        'utils/signer': resolve(__dirname, 'src/utils/signer.ts'),
        'utils/uploader': resolve(__dirname, 'src/utils/uploader.ts'),
        'types/index': resolve(__dirname, 'src/types/index.ts'),
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
