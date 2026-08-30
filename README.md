# ARIO Deploy

Deploy any folder to Arweave and point an ArNS name at it. One command, permanent hosting.

`ario-deploy` uploads a build folder (or a single file), writes an Arweave path manifest, and optionally updates an ArNS (Ar.io Name System) record via its ANT (Ar.io Name Token) so the name resolves to the new upload. Available as a CLI and as a [GitHub Action](#github-action).

## Quick Start

Deploy your app to Arweave in under a minute:

```bash
# Install
npm install -g @ar.io/deploy

# Deploy (interactive — prompts for everything)
ario-deploy deploy

# Or one-liner with a Solana wallet + ArNS name
DEPLOY_KEY=<solana-base58-key> ario-deploy deploy --deploy-folder ./dist --arns-name myapp --sig-type solana
```

Your app is now permanently live at `https://myapp.ar.io`.

## Table of Contents

<!-- toc -->

- [Quick Start](#quick-start)
- [Table of Contents](#table-of-contents)
- [Features](#features)
- [Installation](#installation)
- [Prerequisites](#prerequisites)
- [Commands](#commands)
- [On-Demand Payment](#on-demand-payment)
- [Bundler service](#bundler-service)
- [Command Options](#command-options)
- [Deduplication](#deduplication)
- [Incremental uploads](#incremental-uploads)
- [Package.json Scripts](#packagejson-scripts)
- [GitHub Action](#github-action)
- [CLI in GitHub Actions](#cli-in-github-actions)
- [Claude Code Integration](#claude-code-integration)
- [Development](#development)
- [Security & Best Practices](#security--best-practices)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Dependencies](#dependencies)
- [License](#license)
- [Resources](#resources)

<!-- tocstop -->

## Features

- **Turbo SDK Integration:** Uses Turbo SDK for fast, reliable file uploads to Arweave
- **On-Demand Payment:** Pay with ARIO or Base-ETH tokens on-demand during upload
- **Arweave Manifest v0.2.0:** Creates manifests with fallback support for SPAs
- **Optional ArNS Updates:** Updates ArNS records via ANT with new transaction IDs
- **Automated Workflow:** Integrates with GitHub Actions for continuous deployment
- **Git Hash Tagging:** In CI (GitHub Actions), tags uploaded data items with the deploying commit SHA
- **Incremental Uploads (opt-in):** `--incremental` pays only for the files that actually changed, recovering the rest from your own past uploads even on a machine with no local cache. See [Incremental uploads](#incremental-uploads).
- **404 Fallback Detection:** Automatically sets `404.html` as the manifest fallback when present, so deep links into a single-page app resolve instead of 404ing. Override with `--fallback-file <path>` — an SPA that only builds `index.html` can point at that instead.
- **Network Support:** ArNS updates run against the Solana ARIO programs on `mainnet` or `devnet`, with an optional custom RPC URL
- **Flexible Deployment:** Supports deploying a folder or a single file
- **Modern CLI:** Built with oclif for a robust command-line experience
- **TypeScript:** Fully typed for better developer experience

## Installation

Install the package using pnpm (recommended):

```bash
pnpm add -D @ar.io/deploy
```

Or with npm:

```bash
npm install --save-dev @ar.io/deploy
```

Or with yarn:

```bash
yarn add --dev @ar.io/deploy
```

## Prerequisites

A deployment uses up to **two independent keys**:

- **Upload key** — pays for the upload. Any supported chain (`--wallet` / `--private-key`, or the `DEPLOY_KEY` env var; chain selected with `--sig-type`).
- **ArNS authority key** — only needed when updating ArNS. Always a **Solana** key that controls the ArNS name and signs the ANT record update (`--arns-wallet` / `--arns-private-key`, or the `ARNS_KEY` env var).

They can be the same Solana wallet or two different wallets — provide each explicitly.

### Upload key (`DEPLOY_KEY`)

1. **Arweave signer (default):** Encode your Arweave wallet key in base64 and set it as `DEPLOY_KEY`:

   ```bash
   base64 -i wallet.json | pbcopy
   ```

2. **Ethereum/Polygon/KYVE signers:** Use your raw private key (no encoding needed) as `DEPLOY_KEY`.
3. **Solana signer:** Use a base58-encoded secret key as `DEPLOY_KEY`, or a `solana-keygen` `id.json` byte-array wallet file via `--wallet`.

### ArNS authority key (`ARNS_KEY`)

Set a base58-encoded **Solana** secret key as `ARNS_KEY`, or pass a `solana-keygen` `id.json` file via `--arns-wallet` (or a base58 string via `--arns-private-key`). This key must control the ArNS name being updated.

⚠️ **Important:** Use dedicated wallets for deployments to minimize security risks. Ensure your upload wallet has sufficient Turbo Credits for uploads.

## Commands

### Interactive Mode (Easiest)

Run the deploy command without arguments to be guided through all deployment options:

```bash
ario-deploy deploy
```

When ArNS details aren't supplied via flags, `deploy` asks whether you want to
update an ArNS name (defaulting to yes) and, if so, prompts for the details. It
will guide you through:

- Whether to update an ArNS name (and which one)
- Wallet method (file, string, or environment variable)
- What to deploy (folder or file)
- Advanced options (optional: undername, TTL, Solana cluster)

Pass `--arns-name` (or `--use-arns`) to skip the ArNS confirmation, or use the
`upload` command for an upload-only run. In a non-interactive environment (CI,
or no TTY) `deploy` does not prompt — supply everything via flags or
`DEPLOY_KEY`.

### Direct Commands

Use flags for faster, scriptable deployments:

```bash
# Basic deployment with wallet file
ario-deploy deploy --wallet ./wallet.json

# Deployment with ArNS update (separate upload key + Solana ArNS authority key)
ario-deploy deploy --use-arns --arns-name my-app --wallet ./wallet.json --arns-wallet ./arns-id.json
```

Deploy using private key directly:

```bash
ario-deploy deploy --private-key "$(cat wallet.json)"
```

Deploy using environment variable:

```bash
DEPLOY_KEY=$(base64 -i wallet.json) ario-deploy deploy --deploy-folder ./dist
```

Deploy a specific folder:

```bash
ario-deploy deploy --wallet ./wallet.json --deploy-folder ./build
```

Deploy a single file:

```bash
ario-deploy deploy --wallet ./wallet.json --deploy-file ./path/to/file.txt
```

`--deploy-file` overrides `--deploy-folder`, and the file is uploaded as one
transaction with **no manifest** — an ArNS name pointed at it resolves straight
to that file, served with its own content type. Useful for a PDF, a dataset, or
a single page. Manifest-only options such as `--fallback-file` do not apply.

### Single-page apps

An Arweave path manifest maps each path to a transaction, and a gateway returns
404 for any path the manifest does not list. That is correct for static files
but wrong for a single-page app, whose routes are not files — `/settings` is
invented by the router and exists nowhere on disk. Without a fallback the root
loads and every deep link 404s.

Manifests have a `fallback` for exactly this, and `ario-deploy` sets it
automatically when the build emits a `404.html`:

```bash
ario-deploy deploy --deploy-folder ./dist
```

Most SPA builds do not emit one. Either copy your entry point before deploying:

```bash
cp dist/index.html dist/404.html
```

…or name the fallback directly:

```bash
ario-deploy deploy --deploy-folder ./dist --fallback-file index.html
```

The file must exist in the deploy folder; a path that is not there fails before
anything is uploaded, so a typo costs nothing.

> Deep links can appear broken for up to a minute after a redeploy while
> gateways serve cached 404s from the previous manifest. Confirm with a
> cache-busting query string (`/settings?x=1`) before assuming the deploy failed.

### Upload/deploy without ArNS

`deploy` uploads without updating ArNS by default. You can also use the `upload` command explicitly for the same Turbo upload, dedupe cache, and payment options as deploy, minus ArNS flags:

```bash
ario-deploy deploy --wallet ./wallet.json --deploy-folder ./dist
ario-deploy upload --wallet ./wallet.json --deploy-folder ./dist
ario-deploy upload --wallet ./wallet.json --deploy-file ./dist/index.html
DEPLOY_KEY=$(base64 -i wallet.json) ario-deploy upload --deploy-folder ./dist
```

### Advanced Usage

Deploy to an undername (subdomain) — the ArNS authority key is a Solana wallet:

```bash
ario-deploy deploy --use-arns --arns-name my-app --wallet ./wallet.json --arns-wallet ./arns-id.json --undername staging
```

Deploy with a custom TTL:

```bash
ario-deploy deploy --use-arns --arns-name my-app --wallet ./wallet.json --arns-wallet ./arns-id.json --ttl-seconds 7200
```

Update ArNS on devnet (or against a custom RPC):

```bash
ario-deploy deploy --use-arns --arns-name my-app --wallet ./wallet.json --arns-wallet ./arns-id.json --cluster devnet
ario-deploy deploy --use-arns --arns-name my-app --wallet ./wallet.json --arns-wallet ./arns-id.json --rpc-url https://my-rpc.example.com
```

Upload using an Ethereum wallet (file):

```bash
ario-deploy deploy --sig-type ethereum --wallet ./private-key.txt
```

Upload using a Solana wallet (base58 private key):

```bash
ario-deploy deploy --sig-type solana --private-key "<base58-secret-key>"
```

## On-Demand Payment

Use on-demand payment to automatically fund uploads with ARIO or Base-ETH tokens when your Turbo balance is insufficient:

Deploy with ARIO on-demand payment:

```bash
ario-deploy deploy --wallet ./wallet.json --deploy-folder ./dist --on-demand ario --max-token-amount 1.5
```

Deploy with Base-ETH on-demand payment (using Ethereum signer):

```bash
ario-deploy deploy --sig-type ethereum --private-key "0x..." --on-demand base-eth --max-token-amount 0.1
```

**On-Demand Payment Options:**

- `--on-demand`: Token to use for on-demand payment (`ario` or `base-eth`)
- `--max-token-amount`: Maximum token amount to spend (in native token units, e.g., `1.5` for 1.5 ARIO or `0.1` for 0.1 ETH)

**How it works:**

1. Checks your Turbo balance before upload
2. If balance is insufficient, converts tokens to Turbo credits on-demand
3. Automatically adds a 10% buffer (`topUpBufferMultiplier: 1.1`) for reliability
4. Proceeds with upload once funded

**Token compatibility:**

- **ARIO**: Works with Arweave signer
- **Base-ETH**: Works with Ethereum signer (Base Network)

## Bundler service

Uploads go through a bundler service that accepts signed data items and posts them to Arweave. By default, ario-deploy uses the [Turbo](https://docs.ardrive.io/docs/turbo/) API and ArDrive’s production bundler (`https://upload.ardrive.io`). **`--uploader`** sets the **base URL** of the bundler service to use (scheme + host; typically no path).

| When to use               | Example value                                           |
| ------------------------- | ------------------------------------------------------- |
| **Default** (omit flag)   | ArDrive production bundler — same as Turbo CLI defaults |
| **Arweave bundler**       | `https://turbo.ardrive.io`                              |
| **Development / staging** | `https://upload.services.ar-io.dev`                     |
| **Custom or self-hosted** | Your own base URL if it implements the Turbo API        |

**Examples:**

```bash
# Deploy using Arweave’s bundler service
ario-deploy deploy --wallet ./wallet.json --deploy-folder ./dist --uploader https://turbo.ardrive.io

ario-deploy upload --wallet ./wallet.json --deploy-folder ./dist --uploader https://turbo.ardrive.io
```

**Notes:**

- Turbo billing and signer behavior follow Turbo.
- Use a **base URL only** (e.g. `https://turbo.ardrive.io`), not a path to a specific file or route.

## Command Options

**`deploy`** (upload by default, optional ArNS update):

- `--use-arns`: Update an ArNS/ANT record after upload. When ArNS details aren't supplied and you're in a TTY, `deploy` asks by default.
- `--arns-name, -n`: The ArNS name to update. Required when using `--use-arns`; also implies ArNS mode.
- `--cluster, -p`: Solana cluster for ArNS updates. Choices: `mainnet`, `devnet`. Default: `mainnet`
- `--rpc-url`: Optional Solana RPC URL override for ArNS updates
- `--deploy-folder, -d`: Folder to deploy. Default: `./dist`
- `--deploy-file, -f`: Deploy a single file instead of a folder (no manifest is created)
- `--fallback-file`: Path, relative to the deploy folder, served for routes the manifest does not list. Defaults to `404.html` when the build emits one. See [Single-page apps](#single-page-apps).
- `--undername, -u`: ANT undername to update. Default: `@`
- `--ttl-seconds, -t`: TTL in seconds for the ANT record (60-86400). Default: `60`

Upload key (pays for the upload):

- `--sig-type, -s`: Signer type for the upload key. Choices: `arweave`, `ethereum`, `polygon`, `kyve`, `solana`. Default: `arweave`
- `--wallet, -w`: Path to the upload wallet file (JWK for Arweave, private key for Ethereum/Polygon/KYVE, `solana-keygen` `id.json` for Solana). Falls back to `DEPLOY_KEY`.
- `--private-key, -k`: Upload private-key string (alternative to `--wallet`). JWK JSON for Arweave, hex for EVM chains, base58 secret key for Solana.

ArNS authority key (controls the name, signs the update — always Solana):

- `--arns-wallet`: Path to the Solana `solana-keygen` `id.json` wallet that controls the ArNS name. Falls back to `ARNS_KEY`.
- `--arns-private-key`: Base58 Solana secret key for the ArNS authority (alternative to `--arns-wallet`). Falls back to `ARNS_KEY`.
- `--on-demand`: Enable on-demand payment with specified token. Choices: `ario`, `base-eth`
- `--max-token-amount`: Maximum token amount for on-demand payment (used with `--on-demand`)
- `--no-dedupe`: Disable deduplication (do not cache or reuse previous uploads)
- `--dedupe-cache-max-entries`: Maximum number of entries to keep in the dedupe cache (LRU). Default: `10000`
- `--incremental`: Reuse files already on Arweave, including from a machine with no local cache. Off by default. Cannot be combined with `--no-dedupe`. See [Incremental uploads](#incremental-uploads).
- `--incremental-gateway`: Gateway whose GraphQL endpoint is queried for past uploads when `--incremental` is set. Default: `https://arweave.net`
- `--uploader`: Custom Turbo upload service base URL. See the **Bundler service** section.

**`upload`** (explicit upload without ArNS): accepts `--deploy-folder`, `--deploy-file`, wallet/signer flags, `--uploader`, `--on-demand` / `--max-token-amount`, and the dedupe and incremental flags only.

## Deduplication

By default, ario-deploy caches your deployment log to prevent uploading duplicate (unchanged) files. This saves both time and upload costs by reusing existing data on Arweave.

**How it works:**

1. When you deploy, ario-deploy hashes each file in your build
2. It checks the local cache for matching hashes from previous uploads
3. Files that haven't changed are skipped - the existing transaction ID is reused
4. Only new or modified files are uploaded to Arweave
5. The cache is stored locally in `.ario-deploy/transaction-cache.json`

**Disable deduplication:**

If you need to force a fresh upload of all files (e.g., for debugging or to ensure a completely new deployment):

```bash
ario-deploy deploy --wallet ./wallet.json --no-dedupe
```

**Limit cache size:**

The dedupe cache uses an LRU (Least Recently Used) eviction strategy. By default, it keeps up to 10,000 entries. You can adjust this limit:

```bash
# Keep only the last 1000 file entries
ario-deploy deploy --wallet ./wallet.json --dedupe-cache-max-entries 1000
```

**Cache location:**

The cache file is stored at `.ario-deploy/transaction-cache.json` in your project root. You can:

- Add it to `.gitignore` if you don't want to share cache across team members
- Commit it to share cached transaction IDs with your team (reduces duplicate uploads)
- Delete it to start fresh: `rm -rf .ario-deploy/`

## Incremental uploads

`--incremental` makes a redeploy pay only for the files that actually changed.

Arweave storage is permanent, so re-uploading byte-identical files buys nothing. Build tools content-hash their output, so between two deploys of a real site only a couple of entry chunks change — everything else is already on chain and can be referenced by its existing transaction id in the path manifest.

```bash
ario-deploy deploy --wallet ./wallet.json --incremental
```

**How it works:**

1. Every file in the folder is hashed (SHA-256).
2. Each hash is looked up in the local dedupe cache, and then — for anything the cache cannot answer — among your own past uploads on chain.
3. Only the remainder is uploaded, and each transaction id is written to the cache the moment it lands.
4. The manifest is assembled from the remembered ids plus the new ones.

**Why the on-chain lookup matters:** every uploaded file carries a `File-SHA256` tag, which makes it findable again from nothing but the bytes on disk. That is what a CI job needs. CI runs from a fresh checkout, so `.ario-deploy/transaction-cache.json` is often missing or stale even with `actions/cache` restoring it — and without the on-chain lookup every redeploy pays for the whole bundle again.

**The tag invariant:** a data item's id covers its tags, so a tag whose value changes between deploys — a commit SHA above all — moves every file's id on every deploy and defeats deduplication. The failure is silent: the upload succeeds, the manifest is correct, and the bill doubles. In incremental mode files therefore carry only deploy-invariant tags (`App-Name`, `Content-Type`, `File-SHA256`), and the `GIT-HASH` provenance tag rides on the manifest instead, which is rewritten every deploy anyway. The tag set is asserted in code, so a future addition fails loudly rather than quietly costing money.

**Known limitation:** gateway GraphQL indexing lags an upload by a few minutes. Two machines deploying the same _new_ file at the same moment can each pay for it. That is the accepted failure mode — it costs a fraction of a cent and never produces a wrong manifest. Equally, a gateway that is slow or unreachable costs reuse, not correctness: unresolved files are simply uploaded.

**Notes:**

- Off by default. Nothing changes for an existing pipeline until you pass the flag.
- Mutually exclusive with `--no-dedupe`, which asks for the opposite.
- Only your own wallet's past transactions are consulted. A `File-SHA256` tag is a claim anyone can stamp on any bytes; scoping the query to the uploading wallet is what makes the answer trustworthy.
- Two files with identical bytes in the same folder are paid for once and both listed in the manifest.
- The lookup uses `https://arweave.net/graphql` by default; override it with `--incremental-gateway`.

## Package.json Scripts

Add deployment scripts to your `package.json`:

```json
{
  "scripts": {
    "build": "vite build",
    "deploy": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME>",
    "deploy:staging": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME> --undername staging",
    "deploy:devnet": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME> --cluster devnet",
    "deploy:on-demand": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME> --on-demand ario --max-token-amount 1.5"
  }
}
```

These read the upload key from `DEPLOY_KEY` and the Solana ArNS authority key from `ARNS_KEY`. Deploy with:

```bash
DEPLOY_KEY=$(base64 -i wallet.json) ARNS_KEY=<base58-solana-secret-key> pnpm deploy
```

Or with on-demand payment:

```bash
DEPLOY_KEY=$(base64 -i wallet.json) ARNS_KEY=<base58-solana-secret-key> pnpm deploy:on-demand
```

## GitHub Action

The easiest way to integrate ario-deploy into your CI/CD pipeline is using our official GitHub Action.

### Basic Usage

```yaml
- uses: ar-io/ar-io-deploy@v1.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }} # upload key (pays for the upload)
    arns-key: ${{ secrets.ARNS_KEY }} # Solana ArNS authority key
    arns-name: myapp
    deploy-folder: ./dist
```

### PR Preview Deployments

Automatically deploy preview builds for each pull request. The `preview` mode auto-generates an undername from the PR number and posts a comment with the preview URL:

```yaml
name: Deploy PR Preview

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  deploy-preview:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Deploy Preview
        uses: ar-io/ar-io-deploy@v1.0.0
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: myapp
          preview: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
          deploy-folder: ./dist
```

When `preview` is enabled, the action will:

- Auto-generate an undername like `pr-123` from the PR number
- Post a comment on the PR with the preview URL
- Update the comment on subsequent pushes instead of creating new ones

### Production Deployment

Deploy to your base ArNS name when pushing to main:

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Deploy to Permaweb
        uses: ar-io/ar-io-deploy@v1.0.0
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: myapp
          deploy-folder: ./dist
```

### With On-Demand Payment

```yaml
- name: Deploy with ARIO on-demand
  uses: ar-io/ar-io-deploy@v1.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    arns-key: ${{ secrets.ARNS_KEY }}
    arns-name: myapp
    deploy-folder: ./dist
    on-demand: ario
    max-token-amount: '2.0'
```

### Updating ArNS (Solana)

ArNS updates run against the Solana ARIO programs. Provide the Solana ArNS authority key via `arns-key` (a base58 Solana secret key); the upload is still paid for by `deploy-key`. Use `cluster` to target `mainnet` (default) or `devnet`, and `rpc-url` for a custom RPC endpoint.

```yaml
- name: Deploy and update ArNS
  uses: ar-io/ar-io-deploy@v1.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }} # upload key
    arns-key: ${{ secrets.ARNS_KEY }} # Solana ArNS authority key
    arns-name: myapp
    deploy-folder: ./dist
    cluster: mainnet
```

### Disabling Deduplication

By default, the action caches transaction IDs to avoid re-uploading unchanged files. To disable this:

```yaml
- name: Deploy without dedupe
  uses: ar-io/ar-io-deploy@v1.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    deploy-folder: ./dist
    no-dedupe: 'true'
```

You can also limit the cache size:

```yaml
- name: Deploy with limited cache
  uses: ar-io/ar-io-deploy@v1.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    deploy-folder: ./dist
    dedupe-cache-max-entries: '1000'
```

### Incremental Uploads

A CI job runs from a fresh checkout, so the restored transaction cache is often missing or stale — and then every redeploy pays for the whole bundle again. `incremental: 'true'` recovers those transaction ids from your wallet's own past uploads on chain, so only the files that actually changed are paid for. See [Incremental uploads](#incremental-uploads).

```yaml
- name: Deploy only what changed
  uses: ar-io/ar-io-deploy@v1.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    deploy-folder: ./dist
    incremental: 'true'
```

---

## CLI in GitHub Actions

You can also use the CLI directly in your workflows:

**Basic Workflow:**

```yaml
name: Deploy to Permaweb

on:
  push:
    branches:
      - main

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - run: pnpm install

      - run: pnpm deploy
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}
```

**With On-Demand Payment:**

```yaml
name: Deploy to Permaweb with On-Demand Payment

on:
  push:
    branches:
      - main

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - run: pnpm install
      - run: pnpm build

      - name: Deploy with ARIO on-demand
        run: ario-deploy deploy --arns-name my-app --on-demand ario --max-token-amount 2.0
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }} # upload key (pays for the upload)
          ARNS_KEY: ${{ secrets.ARNS_KEY }} # Solana ArNS authority key


      # Or upload with Ethereum and Base-ETH on-demand payment (upload only; ArNS requires Solana):
      # - name: Upload with Base-ETH on-demand
      #   run: |
      #     ario-deploy upload \
      #       --sig-type ethereum \
      #       --on-demand base-eth \
      #       --max-token-amount 0.2
      #   env:
      #     DEPLOY_KEY: ${{ secrets.ETH_PRIVATE_KEY }}
```

## Claude Code Integration

Use [Claude Code](https://claude.ai/code) to deploy your app with natural language. Just say "deploy to ar.io" and Claude handles the rest.

### Add the Skill to Your Project

```bash
mkdir -p .claude/skills
curl -o .claude/skills/deploy.md https://raw.githubusercontent.com/ar-io/ar-io-deploy/main/examples/claude-skill/deploy.md
```

Then in Claude Code, say:

- "deploy to ar.io"
- "deploy my app to arweave"
- "set up CI/CD for ar.io deployment"

Claude will build your project, detect the output folder, and run the deploy with the right flags.

### What the Skill Does

1. **Detects your build folder** (`./dist`, `./build`, `./out`)
2. **Checks for credentials** (`DEPLOY_KEY` env var or wallet file)
3. **Installs `@ar.io/deploy`** if not already available
4. **Runs the deployment** with appropriate flags
5. **Reports results** — transaction ID, Arweave URL, ArNS URL

See [`examples/claude-skill/`](./examples/claude-skill/) for the full skill file and customization options.

---

## Development

### Setup

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build

# Run in development mode
pnpm dev

# Run tests
pnpm test

# Run linter
pnpm lint

# Format code
pnpm format
```

### Project Structure

```
ar-io-deploy/
├── src/
│   ├── commands/        # oclif commands
│   │   ├── deploy.ts
│   │   └── upload.ts
│   ├── types/           # TypeScript type definitions
│   │   └── index.ts
│   ├── utils/           # Utility functions
│   │   ├── constants.ts
│   │   ├── signer.ts
│   │   ├── uploader.ts
│   │   └── __tests__/   # Unit tests
│   └── index.ts         # Main entry point
├── bin/                 # Executable scripts
│   ├── run.js
│   └── dev.js
├── .husky/              # Git hooks
└── dist/                # Build output
```

## Security & Best Practices

- **Dedicated Wallet:** Always use a dedicated wallet for deployments to minimize security risks
- **Wallet Encoding:** Arweave wallets must be base64 encoded to be used in the deployment script
- **ArNS Name:** Required only when updating an ANT/ArNS target undername or root record
- **Turbo Credits:** Ensure your wallet has sufficient Turbo Credits, or use on-demand payment for automatic funding
- **On-Demand Limits:** Set reasonable `--max-token-amount` limits to prevent unexpected costs
- **Secret Management:** Keep your `DEPLOY_KEY` secret secure and never commit it to your repository
- **Build Security:** Always check your build for exposed environmental secrets before deployment, as data on Arweave is permanent

## Troubleshooting

- **Error: "DEPLOY_KEY environment variable not set":** Verify your base64 encoded wallet is set as the `DEPLOY_KEY` environment variable
- **Error: "deploy-folder does not exist":** Check that your build folder exists and the path is correct
- **Error: "deploy-file does not exist":** Check that your build file exists and the path is correct
- **Error: "ArNS name does not exist":** Verify the ArNS name is correct and exists in the specified network
- **Upload timeouts:** Files have a timeout for upload. Large files may fail and require optimization
- **Insufficient Turbo Credits:** Use `--on-demand` with `--max-token-amount` to automatically fund uploads when balance is low
- **On-demand payment fails:** Ensure your wallet has sufficient tokens (ARIO or Base-ETH) and the token type matches your signer (`ario` with Arweave, `base-eth` with Ethereum)
- **Deep links 404 but the homepage loads:** The manifest has no `fallback`. Emit a `404.html` or pass `--fallback-file index.html` — see [Single-page apps](#single-page-apps)
- **Deep links still 404 right after a redeploy:** Gateways cache the previous manifest's 404s for around a minute. Retry with a cache-busting query string before assuming the deploy failed
- **Error: "Fallback file not found in folder":** `--fallback-file` takes a path relative to the deploy folder, e.g. `index.html`, not `./dist/index.html`

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linter: `pnpm test && pnpm lint`
5. Commit your changes using conventional commits — the commit type determines the next release, so `fix:` for a bug and `feat:` for a feature
6. Push and create a pull request

### Conventional Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Commit messages should follow this format:

```
type(scope): subject

body (optional)
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

### Releases

Releases are automated. Merging to `main` runs
[semantic-release](https://semantic-release.gitbook.io/), which derives the next
version from the Conventional Commits since the last tag, publishes to npm, and
creates the GitHub Release whose notes serve as the changelog. `fix:` yields a
patch, `feat:` a minor, `BREAKING CHANGE:` a major; `chore:`, `docs:`, `ci:` and
`style:` release nothing.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
over GitHub OIDC, so no npm token is stored and every release carries a
provenance attestation. There are no credentials to rotate.

## Dependencies

- **@ar.io/sdk** - For ANT operations and ArNS management on Solana
- **@ardrive/turbo-sdk** - For fast file uploads to Arweave (and signer types)
- **@solana/kit** - Solana RPC clients and transaction signers for ArNS updates
- **bs58** - Base58 encoding/decoding for Solana keys
- **@oclif/core** - CLI framework
- **mime-types** - MIME type detection

## License

MIT — © Permanent Data Solutions, Inc.

## Resources

- [GitHub Repository](https://github.com/ar-io/ar-io-deploy)
- [Issues](https://github.com/ar-io/ar-io-deploy/issues)
- [Arweave Documentation](https://docs.arweave.org/)
- [AR.IO Documentation](https://docs.ar.io/)
