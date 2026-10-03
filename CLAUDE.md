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
pnpm test:unit            # src/**/__tests__/ and tests/unit/
pnpm test:e2e             # E2E tests only (tests/e2e/); needs `pnpm build` first
pnpm test:live            # Real uploads to the Turbo sandbox; see Testing
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
- **No interactive command**: each command decides whether to prompt via `canPrompt()` (stdin and stdout are TTYs, `CI` unset). Without a terminal, `deploy` falls back to upload-only when no ArNS name is given, and a missing key is an error, never a prompt.
- **Shared command code**: `src/utils/command-helpers.ts` holds what both commands need: key resolution (`resolveKey`, which validates a Solana key as it reads it), `uploadWorkflowConfig`, the result rows, and `reportFailure`. Keep it there; the two hand-maintained copies it replaced had drifted into bugs. Commands are files in `src/commands/`, and oclif loads every file under `dist/commands`, so helpers must not live there.
- **Vite entries**: `vite.config.ts` builds `index` and one entry per command; everything else is bundled into chunks. A new command needs its own entry.

### Configuration Resolution Pattern

All CLI flags are defined in `src/constants/flags.ts` as a single source of truth: the oclif flag and an optional interactive prompt. `resolveConfig()` in `src/utils/config-resolver.ts` merges flags with prompts. oclif fills in defaults before a command sees its flags, so commands pass `defaultedFlags(metadata)`; without it every defaulted flag looks user-typed and its prompt never runs. Prompts share a `PromptContext` per resolution, which is how the file-or-folder question is asked once for both `--deploy-file` and `--deploy-folder`.

### Upload Flow

`src/workflows/upload-workflow.ts` orchestrates: validate everything that needs no network (funding token against the signer, the cap, service URLs) -> create signer -> init Turbo client -> plan (`planFolderUpload`, or `planFileUpload` for `--deploy-file`: hash, cache lookup, chain lookup with `--incremental`, in-run dedupe, compression) -> resume any pending top-up -> credit check and, with `--on-demand`, one top-up -> upload -> return tx ID and the service's gateway. The plan is computed once and reused for the upload, so the credit check prices exactly what will be sent; a cached file prices at nothing.

`io.error` throws, so it is never called inside a `try` (the catch would re-wrap the message). Steps return a problem string and the caller calls `io.error` once.

### Turbo Payments

`src/utils/turbo.ts` composes Turbo SDK primitives rather than reimplementing them. What is load-bearing:

- **Upload and payment services are a pair.** `resolveTurboServices` picks both: `--dev` (named after Turbo's CLI flag) selects the sandbox, and a sandbox `--uploader` or `--payment-url` pulls in the other half. Configuring only the uploader sends balance checks and top-ups to production.
- **Pricing is per data item.** `quoteUploadWinc` prices each item the plan will send (payload + `DATA_ITEM_HEADER_BYTES`, sized above the largest measured header). An item within the free size limit (read from the upload service by `fetchUploadServiceInfo`: 105 KiB in production, 5 MiB in the sandbox) is free only while the wallet's metered free tier lasts (`turbo.getFreeStatus()`). Turbo's price endpoint does not apply the free tier itself.
- **Who pays mirrors Turbo's CLI.** By default every wallet in `receivedApprovals` goes into `paidBy` on every data item (files and manifest; it travels as the `x-paid-by` header, not a tag, so ids are unaffected). The payment service tries `[...paidBy, signer]`, so `spendableWinc` is `effectiveBalance` by default, own `winc` with `--ignore-approvals`, and own `winc` plus the named payers' unexpired approvals with `--paid-by`.
- **On-demand funding happens once, before uploads.** Never pass Turbo's `OnDemandFunding` to per-file `uploadFile` calls: each concurrent worker sees the same shortfall and buys its own top-up, and the cap applies per purchase. `fundShortfall` tops up the plan's shortfall in one transfer. The Turbo client is created with the funding token (not the signer's), since Turbo pays a top-up in the client's token; `ON_DEMAND_TOKENS` maps each signer type to the tokens it can pay with.
- **A sent top-up is never bought twice.** The transfer id is saved to `.ario-deploy/pending-topup*.json` the moment tokens move (`onSent`, including when Turbo's own submit step fails and only its error message carries the id). Nothing uploads until the top-up is credited, and the next run waits for a pending one before pricing. `submitFundTransaction` answers 400 both for a failed transfer and for one not mined yet, and 404 for one not seen yet; `classifyFundError` reads the body to tell them apart.
- **Tests fake only the chain.** `UploadWorkflowIo.tokenTools` replaces Turbo's on-chain transfer and `fundingPoll` shortens the wait; everything else runs through the real SDK against MSW (`tests/unit/payments-workflow.test.ts`). The fake transfer is deliberately slow, because an instant one hides the concurrency race.

### Compression

`--compress gzip|br` (`src/utils/compression.ts`) compresses each file before upload and adds a `Content-Encoding` tag; already-compressed formats and `--compress-exclude` globs are uploaded as-is. Every other file is compressed, even one gzip makes a few bytes larger: the encoding is part of the file's cache key (and, with `--incremental`, of what the chain index matches), so uploading a planned-as-gzip file uncompressed would make it unfindable. It only works if gateways send that header for items they have not indexed yet (ar-io-node #964/#966); without it, pages render as garbage right after a deploy.

### Deduplication Cache

Located at `.ario-deploy/transaction-cache.json` (relative to cwd) for production, and `transaction-cache.<upload-host>.json` for any other Turbo network (`TurboServices.cacheScope`): a sandbox id must never stand in for a production upload. Keys are `<sha256>|<mime-type>[|<encoding>]` in every mode (`fileCacheKey`). Outside incremental mode, 1.x hash-only keys (`<sha256>`, `gzip:<sha256>`) are still honoured and migrated on a hit, except for the empty file, whose hash is shared by every type. `loadCache` drops entries whose id is not a 43-character Arweave id. LRU eviction at configurable max entries (default 10,000). Disable with `--no-dedupe`. Files identical to another file in the same run share one upload, keyed on MIME type + content; this applies even with `--no-dedupe`.

Ids reach disk as each upload lands, in every mode, through `createCacheWriter` (see below), so a run that fails or is interrupted part-way keeps what it paid for. Cache writes are best-effort: a read-only or full disk warns and never fails a deploy that has already paid. After the first failed upload no new uploads start; in-flight ones settle and are recorded.

### Incremental Uploads (`--incremental`, opt-in)

`src/utils/incremental.ts` adds the two things the local cache cannot do: a `File-SHA256` tag on every uploaded file, and a chain-backed index (`createChainIndex`) that rebuilds the hash -> transaction id map by querying the uploader's own past items over GraphQL. That index is what makes a fresh CI checkout cheap. Ids reach disk during the run (in every mode, not just this one): `createCacheWriter` writes on the leading edge, then coalesces onto a 500 ms **trailing** timer (unref'd) and flushes on `SIGINT`/`SIGTERM`, because a leading edge alone is a throttle that strands a whole concurrent batch, and Ctrl-C runs no `finally`. Call `dispose()` on every path out — including the ones where `io.error` throws — or the handlers leak one per run.

Four things are load-bearing and easy to break:

- **Deploy-invariant file tags.** A data item's id covers its tags, so any per-deploy tag on a file (the commit SHA above all) moves every id and silently doubles the bill. `incrementalFileTags()` stamps only `App-Name`, `Content-Type`, `File-SHA256` (hash of the file on disk) and, when compressed, `Content-Encoding` (set by configuration, so still invariant), guarded by `assertDeployInvariantTags`; `GIT-HASH` goes on the manifest instead.
- **The owner address.** GraphQL `owners` matches `base64url(sha256(publicKey))`, never `signer.getNativeAddress()` — that returns base58 for Solana and `0x…` for Ethereum/Polygon, and a gateway answers those with HTTP 200 and zero edges. Use `ownerAddressFromPublicKey()`; `assertOwnerAddress()` refuses anything else rather than querying with a value that can only ever match nothing.
- **Content type and encoding in the key.** Reuse is keyed `<sha256>|<mime-type>`, plus `|<encoding>` when compressed (`incrementalCacheKey`). Hash alone would serve byte-identical `a.json` and `b.txt` under one `Content-Type`, and would hand a gzip deploy an uncompressed upload; the chain index reads `Content-Encoding` off each result for the same reason. Incremental mode never falls back to a 1.x hash-only entry.
- **Pricing follows the plan, not the folder.** `planFolderUpload` is split out of `uploadFolder` so `runUploadWorkflow` can quote `plan.uploadBytes + plan.manifestBytes`. Quoting the whole folder would refuse the two-chunk redeploy this flag exists to make cheap.

### Signer Types

`src/utils/signer.ts` creates signers: Arweave (base64 JWK -> ArweaveSigner), Ethereum/Polygon (hex key -> EthereumSigner), Solana (base58 key -> HexSolanaSigner). Only Solana signers can update ArNS records.

### Solana Integration

`src/utils/solana.ts` handles Solana key conversion (base58 or id.json array, validated as 64 bytes) and RPC client creation. ArNS updates use `@ar.io/sdk` ANT write operations on Solana mainnet/devnet.

`deploy` checks everything about the ArNS update it can **before** paying for the upload (`prepareArns`): the key decodes, the undername matches the ANT program's rule (`validateUndername`), and the name exists ("record not found" is told apart from an RPC failure). Whether the key controls the name is only a warning: the ANT's recorded owner can lag a transfer. The tx id is printed before the update, and a failed update names it.

## Testing

- **Unit tests**: Most live in `tests/unit/`; a few are in `src/utils/__tests__/`. Both use Vitest globals. Workflow-level tests drive the real Turbo SDK against MSW rather than hand-rolled fakes, and each regression test should fail when its bug is put back.
- **E2E tests** run the built CLI from `dist/`, so rebuild before running them. CI runs `pnpm build` and then `pnpm test:run`. Test timeouts are 60s because the first import of `@ar.io/sdk` on a cold cache is slow. `vi.mock` does not reach the built CLI; to mock a dependency of a command, run the command class from `src` (see `tests/unit/deploy-arns.test.ts`).
- **No live network**: `tests/setup.ts` fails any request no MSW handler answers. Mocks must match routes Turbo SDK 2.x actually calls (`tests/mocks/README.md`).
- **Live tests** (`pnpm test:live`, `tests/live/`, own config `vitest.live.config.ts`) run the built CLI against the real Turbo sandbox, its gateway and public Solana RPCs, and check results through the gateway. Excluded from the default run. Uploads stay under the sandbox's free limit, but they are real and permanent. Run them before a release; mocks cannot tell you the services still behave as the code assumes. The token-spending tests (`tests/live/funded.test.ts`: real top-ups, shared credits, ArNS updates verified on chain) need `ARIO_DEPLOY_LIVE_SOLANA_WALLET` (a funded devnet wallet) and `ARIO_DEPLOY_LIVE_ARNS_NAME` (a devnet name it controls) and are skipped without them. Top-up tests fund a fresh key from that wallet, because a wallet with leftover credits would pass without topping up.
- **The Action's deploy script** is tested as shipped: `tests/unit/action-script.test.ts` extracts it from `action.yml` and runs it against a stub CLI.
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
- **Release workflow** (`.github/workflows/release.yml`): Uses `semantic-release` on pushes to `main` (stable `@latest`) and `alpha` (prerelease `@alpha`). Versioning is automatic from conventional commit messages (`feat:` = minor, `fix:` = patch, `feat!:` = major). Publishes to npm via OIDC and creates GitHub releases. CHANGELOG.md is not updated (`.releaserc.json` has no changelog plugin); release notes live on GitHub.
- **Manual release**: Trigger the release workflow via `workflow_dispatch`.
- **Branch channels**: `main` → `@latest` tag, `alpha` → `@alpha` tag (configured in `.releaserc.json`).
- Package version is bumped automatically by CI — don't manually edit `version` in package.json on feature branches.

## GitHub Action

The repo ships a composite GitHub Action (`action.yml`) that external projects use:

```yaml
- uses: ar-io/ar-io-deploy@v2.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    arns-key: ${{ secrets.ARNS_KEY }}
    arns-name: myapp
```

Key features: dedupe cache via `actions/cache` (the whole `.ario-deploy/` directory, one entry per run, restored by prefix, so nothing is ever deleted), PR preview mode with auto-generated undernames and PR comments. Preview undernames are not removed on PR close, and every step skips `closed` events. Inputs reach the shell only through `env:` and a quoted argument array, never `${{ }}` pasted into the script, because a branch name is attacker-chosen and the step holds both keys. It installs `@ar.io/deploy@^2`; bump that with the major. The CLI honours `NO_COLOR` (the step sets it) and prints `Tx ID: <id>` before any ArNS update, which is the line the step reads.

## Key Constraints

- ArNS updates require a Solana key (`ARNS_KEY` / `--arns-wallet`) — upload key can be any supported signer
- The upload key (`DEPLOY_KEY`) and ArNS authority key (`ARNS_KEY`) can be the same Solana wallet or separate wallets
- Arweave uploads are permanent — verify builds before deploying
- Build output goes to `dist/` with ESM format, no minification, source maps enabled
- Node >= 20.18 required (Turbo SDK uploads crash on Node 18, and `@solana/kit` requires 20.18)
- Package version is bumped automatically by semantic-release — don't manually edit `version` in package.json
