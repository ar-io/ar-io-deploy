# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ARIO Deploy (`@ar.io/deploy`) is a TypeScript CLI tool for deploying web apps to the permaweb (Arweave) with optional ArNS (Arweave Name Service) record updates via Solana. Built on oclif, it uses Turbo SDK for uploads and supports five signer types (Arweave, Ethereum, Polygon, KYVE, Solana).

## Build & Development Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Vite build + TypeScript declarations
pnpm dev                  # Run CLI in dev mode (tsx, no build needed)
pnpm test                 # Vitest in watch mode
pnpm test:run             # Single test run
pnpm test:unit            # Unit tests only (src/**/__tests__/)
pnpm test:e2e             # E2E tests only (tests/e2e/)
pnpm test:coverage        # Coverage report (v8 provider)
pnpm lint                 # ESLint check
pnpm lint:fix             # ESLint auto-fix
pnpm format               # Prettier format all
pnpm format:check         # Prettier check
```

Run a single test file: `pnpm vitest run path/to/file.test.ts`

## Architecture

### CLI Framework (oclif)

- **Entry points**: `bin/run.js` (production, uses `dist/`), `bin/dev.js` (development, uses tsx)
- **Commands**: `src/commands/deploy.ts` (upload + optional ArNS update), `src/commands/upload.ts` (upload only)
- **Default command**: `interactive` — prompts user to choose a command

### Configuration Resolution Pattern

All CLI flags are defined in `src/constants/flags.ts` as a single source of truth. Each flag definition includes the oclif flag config, an optional interactive prompt function, an optional transform, and a `triggersInteractive` boolean. The `resolveConfig()` utility in `src/utils/config-resolver.ts` merges CLI flags with interactive prompts for missing values.

### Upload Flow

`src/workflows/upload-workflow.ts` orchestrates: create signer -> init Turbo client -> handle on-demand funding (with 10% buffer) -> upload file/folder with dedup cache -> return tx ID.

### Deduplication Cache

Located at `.ario-deploy/transaction-cache.json` (relative to cwd). Maps SHA-256 file hashes to `{transactionId, createdAtTimestamp, lastUsedTimestamp}`. LRU eviction at configurable max entries (default 10,000). Disable with `--no-dedupe`.

### Signer Types

`src/utils/signer.ts` creates signers: Arweave (base64 JWK -> ArweaveSigner), Ethereum/Polygon/KYVE (hex key -> EthereumSigner), Solana (base58 key -> HexSolanaSigner). Only Solana signers can update ArNS records.

### Solana Integration

`src/utils/solana.ts` handles Solana key conversion (base58 or id.json array -> KeyPairSigner) and RPC client creation. ArNS updates use `@ar.io/sdk` ANT write operations on Solana mainnet/devnet.

## Testing

- **Unit tests**: Co-located in `src/utils/__tests__/`, use Vitest globals
- **E2E tests**: `tests/e2e/`, use `@oclif/test` runCommand() with MSW mocking Turbo API
- **Fixtures**: `tests/fixtures/` contains test wallet and test-app directory
- **Mock setup**: `tests/global-setup.ts` (MSW server init), `tests/setup.ts` (handler registration)
- **Type generation**: `pnpm generate:types` creates types from OpenAPI specs in `tests/fixtures/`

## Code Style

- **No semicolons**, single quotes, trailing commas, 100 char width (Prettier)
- **Import sorting**: enforced by `eslint-plugin-simple-import-sort`
- **ESM**: All imports use `.js` extensions; `"type": "module"` in package.json
- **Conventional Commits**: enforced by commitlint via husky commit-msg hook
- **Pre-commit hook**: lint-staged runs ESLint --fix + Prettier on staged .ts/.tsx files

## Deploy Skill

This repo includes a Claude Code skill at `.claude/skills/deploy.md` that enables natural-language deployment. Users say "deploy to ar.io" and the skill guides through build detection, wallet setup, and deployment.

A copy-paste version for external projects lives at `examples/claude-skill/deploy.md` with its own README.

## Publishing

Package is published as `@ar.io/deploy` on npm under the `@ar.io` org.

- **CI workflow** (`.github/workflows/ci.yml`): Runs lint, format, build, test on PRs to main. PRs must have exactly one version checkbox (major/minor/patch) in the body.
- **Release workflow** (`.github/workflows/release.yml`): On merge to main, reads the version checkbox from the PR body, bumps `package.json`, commits, tags, and publishes to npm with the `latest` tag. Requires `NPM_TOKEN` and optional `DEPLOY_PAT` secrets.
- **Manual release**: Trigger the release workflow via `workflow_dispatch` with a version type.

## GitHub Action

The repo ships a composite GitHub Action (`action.yml`) that external projects use:

```yaml
- uses: ar-io/ar-io-deploy@v1
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    arns-name: myapp
    sig-type: solana
```

Key features: auto-dedup cache via `actions/cache`, PR preview mode with auto-generated undernames and PR comments, undername cleanup on PR close.

## Key Constraints

- ArNS updates require Solana signer — other signer types can only upload
- Arweave uploads are permanent — verify builds before deploying
- Build output goes to `dist/` with ESM format, no minification, source maps enabled
- Node >= 18 required
- Package version is bumped automatically by CI — don't manually edit `version` in package.json on feature branches
