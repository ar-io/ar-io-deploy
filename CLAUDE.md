# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ARIO Deploy (`@ar.io/deploy`) is a TypeScript CLI tool for deploying web apps to the permaweb (Arweave) with optional ArNS (Arweave Name Service) record updates via Solana. Built on oclif, it uses Turbo SDK for uploads and supports four signer types (Arweave, Ethereum, Polygon, Solana). KYVE was dropped in 2.0 because Turbo SDK 2.x removed the token.

## Build & Development Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Vite build + TypeScript declarations
pnpm dev                  # Run CLI in dev mode (tsx, no build needed)
pnpm test                 # Vitest in watch mode
pnpm test:run             # Single test run
pnpm test:unit            # Only src/**/__tests__/ — misses tests/unit/
pnpm test:e2e             # E2E tests only (tests/e2e/); needs `pnpm build` first
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
- **No interactive command**: `deploy` decides itself whether to prompt. It prompts only in a TTY with `CI` unset, and otherwise falls back to upload-only when no ArNS name is given.
- **Vite entries**: `vite.config.ts` lists every command and public module as a library entry, and oclif loads commands from `dist/commands`. A new command needs its own entry there.

### Configuration Resolution Pattern

All CLI flags are defined in `src/constants/flags.ts` as a single source of truth. Each flag definition includes the oclif flag config, an optional interactive prompt function, an optional transform, and a `triggersInteractive` boolean. The `resolveConfig()` utility in `src/utils/config-resolver.ts` merges CLI flags with interactive prompts for missing values.

### Upload Flow

`src/workflows/upload-workflow.ts` orchestrates: validate `--on-demand` against the signer -> create signer -> resolve Turbo services -> init Turbo client -> plan the folder upload (`planFolderUpload`: hash, cache lookup, chain lookup with `--incremental`, in-run dedupe, compression) -> credit check and, with `--on-demand`, one top-up -> upload -> return tx ID. The plan is computed once and reused by `uploadFolder`, so the credit check prices exactly what will be sent, not the whole folder. `--deploy-file` has no plan and prices the file's raw size.

### Turbo Payments

`src/utils/turbo.ts` composes Turbo SDK primitives rather than reimplementing them. What is load-bearing:

- **Upload and payment services are a pair.** `resolveTurboServices` picks both: `--dev` (named after Turbo's CLI flag) selects the sandbox, and a sandbox `--uploader` or `--payment-url` pulls in the other half. Configuring only the uploader sends balance checks and top-ups to production.
- **Pricing is per data item.** `quoteUploadWinc` prices each item the plan will send (payload + `DATA_ITEM_HEADER_BYTES`), skipping items within the free limit, which `fetchFreeUploadLimit` reads from the upload service (105 KiB in production, 5 MiB in the sandbox). Turbo's price endpoint does not apply the free tier itself.
- **Who pays mirrors Turbo's CLI.** By default every wallet in `receivedApprovals` goes into `paidBy` on every data item (files and manifest; it travels as the `x-paid-by` header, not a tag, so ids are unaffected). The payment service tries `[...paidBy, signer]`, so `spendableWinc` is `effectiveBalance` by default, own `winc` with `--ignore-approvals`, and own `winc` plus the named payers' unexpired approvals with `--paid-by`.
- **On-demand funding happens once, before uploads.** Never pass Turbo's `OnDemandFunding` to per-file `uploadFile` calls: each concurrent worker sees the same shortfall and buys its own top-up, and the cap applies per purchase. `fundShortfall` tops up the plan's shortfall in one transfer. The Turbo client is created with the funding token (not the signer's), since Turbo pays a top-up in the client's token; `ON_DEMAND_TOKENS` maps each signer type to the tokens it can pay with.
- **Tests fake only the chain.** `UploadWorkflowIo.tokenTools` replaces Turbo's on-chain transfer; everything else runs through the real SDK against MSW (`tests/unit/payments-workflow.test.ts`). The fake transfer is deliberately slow, because an instant one hides the concurrency race.

### Compression

`--compress gzip|br` (`src/utils/compression.ts`) compresses each file before upload and adds a `Content-Encoding` tag; already-compressed formats and `--compress-exclude` globs are uploaded as-is. Every other file is compressed, even one gzip makes a few bytes larger: the encoding is part of the file's cache key (and, with `--incremental`, of what the chain index matches), so uploading a planned-as-gzip file uncompressed would make it unfindable. It only works if gateways send that header for items they have not indexed yet (ar-io-node #964/#966); without it, pages render as garbage right after a deploy.

### Deduplication Cache

Located at `.ario-deploy/transaction-cache.json` (relative to cwd). Maps SHA-256 file hashes to `{transactionId, createdAtTimestamp, lastUsedTimestamp}`; compressed uploads use `<encoding>:<hash>` keys so they never reuse uncompressed transactions. LRU eviction at configurable max entries (default 10,000). Disable with `--no-dedupe`. Separately, files identical to another file in the same run share one upload, keyed on MIME type + content so the `Content-Type` tag stays correct; this applies even with `--no-dedupe`, since it reuses nothing from earlier deploys.

### Incremental Uploads (`--incremental`, opt-in)

`src/utils/incremental.ts` adds the two things the local cache cannot do: a `File-SHA256` tag on every uploaded file, and a chain-backed index (`createChainIndex`) that rebuilds the hash -> transaction id map by querying the uploader's own past items over GraphQL. That index is what makes a fresh CI checkout cheap. Ids reach disk during the run — `createCacheWriter` writes on the leading edge, then coalesces onto a 500 ms **trailing** timer (unref'd) and flushes on `SIGINT`/`SIGTERM`, because a leading edge alone is a throttle that strands a whole concurrent batch, and Ctrl-C runs no `finally`. Call `dispose()` on every path out — including the ones where `io.error` throws — or the handlers leak one per run.

Four things are load-bearing and easy to break:

- **Deploy-invariant file tags.** A data item's id covers its tags, so any per-deploy tag on a file (the commit SHA above all) moves every id and silently doubles the bill. `incrementalFileTags()` stamps only `App-Name`, `Content-Type`, `File-SHA256` (hash of the file on disk) and, when compressed, `Content-Encoding` (set by configuration, so still invariant), guarded by `assertDeployInvariantTags`; `GIT-HASH` goes on the manifest instead.
- **The owner address.** GraphQL `owners` matches `base64url(sha256(publicKey))`, never `signer.getNativeAddress()` — that returns base58 for Solana, `0x…` for Ethereum/Polygon and `kyve1…` for KYVE, and a gateway answers those with HTTP 200 and zero edges. Use `ownerAddressFromPublicKey()`; `assertOwnerAddress()` refuses anything else rather than querying with a value that can only ever match nothing.
- **Content type and encoding in the key.** Reuse is keyed `<sha256>|<mime-type>`, plus `|<encoding>` when compressed (`incrementalCacheKey`). Hash alone would serve byte-identical `a.json` and `b.txt` under one `Content-Type`, and would hand a gzip deploy an uncompressed upload; the chain index reads `Content-Encoding` off each result for the same reason. Non-incremental runs keep the historic keys (`<sha256>`, `gzip:<sha256>`), so a project that toggles the flag stores both against the same LRU cap.
- **Pricing follows the plan, not the folder.** `planFolderUpload` is split out of `uploadFolder` so `runUploadWorkflow` can quote `plan.uploadBytes + plan.manifestBytes`. Quoting the whole folder would refuse the two-chunk redeploy this flag exists to make cheap.

### Signer Types

`src/utils/signer.ts` creates signers: Arweave (base64 JWK -> ArweaveSigner), Ethereum/Polygon (hex key -> EthereumSigner), Solana (base58 key -> HexSolanaSigner). Only Solana signers can update ArNS records.

### Solana Integration

`src/utils/solana.ts` handles Solana key conversion (base58 or id.json array -> KeyPairSigner) and RPC client creation. ArNS updates use `@ar.io/sdk` ANT write operations on Solana mainnet/devnet.

## Testing

- **Unit tests**: Most live in `tests/unit/` (uploader, incremental, compression, signer, cache writer); a few are in `src/utils/__tests__/`. Both use Vitest globals. `pnpm test:unit` runs only the `src` set; use `pnpm vitest run tests/unit` or `pnpm test:run` for the rest
- **E2E tests** run the built CLI from `dist/`, so rebuild before running them. CI runs `pnpm build` and then `pnpm test:run`. Test timeouts are 60s because the first import of `@ar.io/sdk` on a cold cache is slow
- **E2E layout**: `tests/e2e/`, use `@oclif/test` runCommand() with MSW mocking Turbo API
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

Package is published as `@ar.io/deploy` on npm under the `@ar.io` org. Uses npm OIDC trusted publishers — no `NPM_TOKEN` needed.

- **Build workflow** (`.github/workflows/build.yml`): Runs lint, format, build, test on pushes to non-main/alpha branches and via `workflow_call`.
- **Release workflow** (`.github/workflows/release.yml`): Uses `semantic-release` on pushes to `main` (stable `@latest`) and `alpha` (prerelease `@alpha`). Versioning is automatic from conventional commit messages (`feat:` = minor, `fix:` = patch, `feat!:` = major). Publishes to npm via OIDC, creates GitHub releases, updates CHANGELOG.md.
- **Manual release**: Trigger the release workflow via `workflow_dispatch`.
- **Branch channels**: `main` → `@latest` tag, `alpha` → `@alpha` tag (configured in `.releaserc.json`).
- Package version is bumped automatically by CI — don't manually edit `version` in package.json on feature branches.

## GitHub Action

The repo ships a composite GitHub Action (`action.yml`) that external projects use:

```yaml
- uses: ar-io/ar-io-deploy@v2.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    arns-name: myapp
    sig-type: solana
```

Key features: auto-dedup cache via `actions/cache`, PR preview mode with auto-generated undernames and PR comments, undername cleanup on PR close.

## Key Constraints

- ArNS updates require a Solana key (`ARNS_KEY` / `--arns-wallet`) — upload key can be any supported signer
- The upload key (`DEPLOY_KEY`) and ArNS authority key (`ARNS_KEY`) can be the same Solana wallet or separate wallets
- Arweave uploads are permanent — verify builds before deploying
- Build output goes to `dist/` with ESM format, no minification, source maps enabled
- Node >= 18 required
- Package version is bumped automatically by semantic-release — don't manually edit `version` in package.json
