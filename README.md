# ARIO Deploy

Deploy any folder to Arweave and point an ArNS name at it. One command, permanent hosting.

`ario-deploy` uploads a build folder (or a single file), writes an Arweave path manifest, and optionally updates an ArNS (Ar.io Name System) record via its ANT (Ar.io Name Token) so the name resolves to the new upload. Available as a CLI and as a [GitHub Action](#github-action).

## Quick Start

Deploy your app to Arweave in under a minute:

```bash
# Install
npm install -g @ar.io/deploy

# Create a Solana wallet file (prints its path, its address and the next command)
ario-deploy keygen

# Deploy a folder with that wallet; the first files are free (see Free tier)
ario-deploy deploy --sig-type solana --wallet ~/.ario-deploy/wallets/<address>.json --deploy-folder ./dist

# Or deploy interactively (prompts for everything)
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
- [Free tier](#free-tier)
- [On-Demand Payment](#on-demand-payment)
- [Shared credits](#shared-credits)
- [Bundler service](#bundler-service)
- [Command Options](#command-options)
- [Deduplication](#deduplication)
- [Incremental uploads](#incremental-uploads)
- [Compression](#compression)
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
- **On-Demand Payment:** Top up Turbo credits with ARIO, SOL, USDC or Base ETH when a deploy needs them
- **Shared credits:** Spend credits other wallets have shared with your upload key
- **Arweave Manifest v0.2.0:** Creates manifests with fallback support for SPAs
- **Optional ArNS Updates:** Updates ArNS records via ANT with new transaction IDs
- **Automated Workflow:** Integrates with GitHub Actions for continuous deployment
- **Git Hash Tagging:** In CI (GitHub Actions), tags uploaded data items with the deploying commit SHA. Under `--incremental` the tag moves to the manifest only — see [Incremental uploads](#incremental-uploads) for why a per-deploy tag on a file cannot be allowed.
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

Node.js 20.18 or later.

A deployment uses up to **two independent keys**:

- **Upload key** — pays for the upload. Any supported chain (`--wallet` / `--private-key`, or the `DEPLOY_KEY` env var; chain selected with `--sig-type`).
- **ArNS authority key** — only needed when updating ArNS. Always a **Solana** key that controls the ArNS name and signs the ANT record update (`--arns-wallet` / `--arns-private-key`, or the `ARNS_KEY` env var).

They can be the same Solana wallet or two different wallets — provide each explicitly.

### Upload key (`DEPLOY_KEY`)

1. **Arweave signer (default):** Encode your Arweave wallet key in base64 and set it as `DEPLOY_KEY`:

   ```bash
   base64 -i wallet.json | pbcopy
   ```

2. **Ethereum/Polygon signers:** Use your raw private key (no encoding needed) as `DEPLOY_KEY`.
3. **Solana signer:** Use a base58-encoded secret key as `DEPLOY_KEY`, or a `solana-keygen` `id.json` byte-array wallet file via `--wallet`. To make a new one, run `ario-deploy keygen`.

#### Create a wallet with `keygen`

```bash
ario-deploy keygen                      # writes ~/.ario-deploy/wallets/<address>.json
ario-deploy keygen --out ~/wallets/my-wallet.json
```

`keygen` writes a new Solana key in `solana-keygen` `id.json` format. By default the file goes in `~/.ario-deploy/wallets/`, a folder in your home directory outside any project, named after the wallet's address. It prints the file path, the public address, the wallet's free upload allowance and the exact `deploy` command to run next. It never prints the secret key, and it never overwrites an existing file. Add `--dev` to look up the allowance on the Turbo sandbox.

Who can read the file:

- **Linux and macOS:** the file has mode `0600` and the wallets folder `0700`, so only your account can read them.
- **Windows:** `keygen` removes inherited permissions with `icacls` and grants access to your account only. When that fails it prints a warning, and other accounts on the computer might be able to read the file.

**Never put the wallet inside the folder you deploy.** An upload is permanent and public, and anyone who reads the file controls the wallet. `deploy` and `upload` refuse to publish a wallet you pass with `--wallet` or `--arns-wallet`, and any file that looks like a private key (see [Files that are never uploaded](#files-that-are-never-uploaded)). `--out` accepts any path, but `keygen` warns when the path is inside the current folder. When the file is inside a git repository, `keygen` adds it to the repository's `.gitignore` and then asks git to confirm that it is ignored and not tracked. If git does not confirm both, it prints a warning instead.

Back up the wallet file. It is the only copy, anyone who has it controls the wallet, and nobody can recover it for you. Never paste its contents anywhere.

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

## Free tier

Turbo uploads small files for free. The limits are:

- **105 KiB per file** (per data item). A larger file is billed.
- **10 MiB over the lifetime of a wallet**, and **10 MiB over the lifetime of an IP range**. Turbo meters both, and an upload is free only while both have allowance left.

`ario-deploy` can check the wallet's allowance before it uploads. It cannot check the IP range, so a deploy can pass the credit check ("within this wallet's free tier") and still be refused at upload time with HTTP 402 when other people on the same network have used the range's allowance. See [402 Payment Required](#troubleshooting).

To go past the free tier, add [Turbo credits](https://turbo.ardrive.io), use [`--on-demand`](#on-demand-payment), or have credits [shared](#shared-credits) to your wallet.

The sandbox (`--dev`) has its own, larger limit and is for testing only: see [Bundler service](#bundler-service).

## On-Demand Payment

With `--on-demand`, a deploy whose credits cannot cover the upload buys what it is short, once, before the first file uploads. `--max-token-amount` is required and caps that purchase for the whole deploy.

The token has to be one your upload key can pay with:

| Upload key (`--sig-type`) | `--on-demand` tokens                  |
| ------------------------- | ------------------------------------- |
| `solana`                  | `ario`, `solana`, `solana-usdc`       |
| `ethereum`, `polygon`     | `base-eth`, `base-usdc`               |
| `arweave`                 | none: top up Turbo credits in advance |

```bash
# ARIO is a Solana token, so it needs a Solana upload key
ario-deploy deploy --sig-type solana --wallet ./id.json --deploy-folder ./dist --on-demand ario --max-token-amount 1.5

# ETH on Base, with an Ethereum key
ario-deploy deploy --sig-type ethereum --private-key "0x..." --on-demand base-eth --max-token-amount 0.1
```

**How it works:**

1. Each file the deploy will actually upload is priced through Turbo. A file within the upload service's free size limit is free only while your wallet's free-tier allowance lasts, so once that is spent small files are priced too.
2. If the credits you can spend (see [Shared credits](#shared-credits)) cover it, nothing is bought.
3. Otherwise the shortfall plus a 10% buffer is converted at Turbo's quoted rate. If that exceeds `--max-token-amount`, the deploy stops before paying anything.
4. The top-up is paid once, and the deploy waits up to two minutes for Turbo to credit it before uploading anything.

If Turbo has not credited the top-up by then, the deploy stops without uploading and records the transfer in `.ario-deploy/`. Re-run once it confirms: the next run waits for that transfer instead of buying another. A transfer the payment service rejects is reported as such, and nothing is uploaded.

## Shared credits

Credits another wallet has shared with your upload key ([Turbo credit sharing](https://docs.ardrive.io/docs/turbo/)) are used automatically: the credit check counts them, and every data item names the sharing wallets as payers, which is what the bundler needs to charge them. Your own balance covers whatever they do not.

- `--paid-by <addresses>`: pay only from these wallets' shared credits (comma-separated).
- `--ignore-approvals`: ignore shared credits; pay only from the upload key's own balance.
- `--use-signer-balance-first`: spend the upload key's own balance before shared credits.

## Bundler service

Uploads go through Turbo: an upload service that accepts signed data items, and a payment service that answers balance, price and top-up questions. The two belong to the same network, and ario-deploy configures them together.

| When to use                        | Flags                                                              |
| ---------------------------------- | ------------------------------------------------------------------ |
| **Default** (production)           | none: `https://upload.ardrive.io` and `https://payment.ardrive.io` |
| **Development sandbox**            | `--dev`                                                            |
| **Custom or self-hosted services** | `--uploader <url>` and `--payment-url <url>`                       |

`--dev` selects both sandbox services (`https://upload.services.ar-io.dev` and `https://payment.services.ar-io.dev`) and testnet RPCs for `--on-demand`. Passing the sandbox URL to `--uploader` alone does the same. A custom `--uploader` without `--payment-url` keeps the production payment service and prints a warning, since balance checks and top-ups go there.

```bash
ario-deploy upload --wallet ./wallet.json --deploy-folder ./dist --dev
```

The free upload limit is read from the upload service, so it follows the network: 105 KiB per item in production, 5 MiB in the sandbox.

**A `--dev` upload is not permanent.** It goes to the Turbo sandbox for testing, production gateways do not serve it, and the result output says so. Never switch to `--dev` to get past an error on production: the URL it prints does not work as a permanent site.

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
- `--skip-arns-check`: Update the record even if the ArNS key does not appear to own or control the name. Without it, a deploy whose key cannot update the name is refused before anything is uploaded. Use it only right after the name changed hands, when the ANT's recorded owner can lag.

Upload key (pays for the upload):

- `--sig-type, -s`: Signer type for the upload key. Choices: `arweave`, `ethereum`, `polygon`, `solana`. Default: `arweave`
- `--wallet, -w`: Path to the upload wallet file (JWK for Arweave, private key for Ethereum/Polygon, `solana-keygen` `id.json` for Solana). Falls back to `DEPLOY_KEY`.
- `--private-key, -k`: Upload private-key string (alternative to `--wallet`). JWK JSON for Arweave, hex for EVM chains, base58 secret key for Solana.

ArNS authority key (controls the name, signs the update — always Solana):

- `--arns-wallet`: Path to the Solana `solana-keygen` `id.json` wallet that controls the ArNS name. Falls back to `ARNS_KEY`.
- `--arns-private-key`: Base58 Solana secret key for the ArNS authority (alternative to `--arns-wallet`). Falls back to `ARNS_KEY`.

Payment:

- `--on-demand`: Top up with this token if the credits cannot cover the upload. Choices: `ario`, `solana`, `solana-usdc` (Solana keys), `base-eth`, `base-usdc` (EVM keys). Requires `--max-token-amount`. See [On-Demand Payment](#on-demand-payment).
- `--max-token-amount`: Most the top-up may spend, in whole tokens (e.g. `0.5`). Caps the whole deploy.
- `--paid-by`, `--ignore-approvals`, `--use-signer-balance-first`: who pays. See [Shared credits](#shared-credits).
- `--dev`: Use Turbo's development sandbox for both upload and payment.
- `--uploader` (alias `--upload-url`), `--payment-url`: Custom Turbo services. See [Bundler service](#bundler-service).

Upload behaviour:

- `--no-dedupe`: Disable deduplication (do not cache or reuse previous uploads)
- `--dedupe-cache-max-entries`: Maximum number of entries to keep in the dedupe cache (LRU). Default: `10000`
- `--incremental`: Reuse files already on Arweave, including on a machine with no local cache. Off by default. Cannot be combined with `--no-dedupe` or `--dedupe-cache-max-entries 0`. See [Incremental uploads](#incremental-uploads).
- `--incremental-gateway`: Gateway whose GraphQL endpoint is queried for past uploads when `--incremental` is set. Default: `https://turbo-gateway.com`
- `--compress`: Compress files before upload and tag them with `Content-Encoding`. Choices: `gzip`, `br`, `none` (default). See [Compression](#compression).
- `--compress-exclude`: Comma-separated globs of files to upload uncompressed, e.g. `"llms*.txt,*.md"`

**`upload`** (explicit upload without ArNS): accepts `--deploy-folder`, `--deploy-file`, `--fallback-file`, wallet/signer flags, the payment flags, the dedupe and incremental flags, and `--compress` / `--compress-exclude` only.

## Deduplication

By default, ario-deploy caches your deployment log to prevent uploading duplicate (unchanged) files. This saves both time and upload costs by reusing existing data on Arweave.

**How it works:**

1. When you deploy, ario-deploy hashes each file in your build
2. It checks the local cache for matching hashes from previous uploads
3. Files that haven't changed are skipped - the existing transaction ID is reused
4. Files identical to another file in the same deploy are uploaded once and share its transaction (static exports often write the same payload under several names)
5. Only new or modified files are uploaded to Arweave, and each id is written to the cache the moment it lands, so a deploy that fails or is interrupted part-way does not pay for those files again
6. The cache is stored locally in `.ario-deploy/transaction-cache.json`, with a separate file per Turbo network (`--dev` uploads never stand in for production ones)

Entries are keyed on the file's content and content type (plus encoding when compressed), so byte-identical files served as different types are never confused. Caches written by 1.x, keyed on the hash alone, are still honoured, except for empty files, whose hash says nothing about their type.

Symlinks inside the deploy folder are followed only while they point inside it; a link to a file outside the folder stops the deploy, since uploading it would publish that file permanently.

#### Files that are never uploaded

Before any request is made, `deploy` and `upload` refuse to publish a private key:

- The run stops when the `--wallet` or `--arns-wallet` file is inside the deploy folder, or is the `--deploy-file`. Paths are compared after resolving symlinks.
- The run stops when any file in the upload, whatever its name, is a Solana `id.json` (a JSON array of 64 bytes) or an Arweave JWK private key. The error names the file. There is no flag to override this.
- `.git` folders are left out of folder uploads, with a one-line note.

The content check does not recognize keys stored in other forms, such as PEM, hex or base58 text. Check your build for those yourself.

The Turbo credit check runs after this planning step, so it prices only what will actually be uploaded, not the whole folder.

**Disable deduplication:**

If you need to force a fresh upload of all files (e.g., for debugging or to ensure a completely new deployment). Files that are identical within the same deploy are still uploaded once and share a transaction, since that reuses nothing from earlier deploys:

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

The cache files are stored in `.ario-deploy/` in your project root. You can:

- Add it to `.gitignore` if you don't want to share cache across team members
- Commit it to share cached transaction IDs with your team (reduces duplicate uploads)
- Delete it to start fresh: `rm -rf .ario-deploy/`

## Incremental uploads

`--incremental` makes a redeploy pay only for the files that actually changed.

Arweave storage is permanent, so re-uploading byte-identical files buys nothing. Build tools content-hash their output, so between two deploys of a real site only a couple of entry chunks change — everything else is already on chain and can be referenced by its existing transaction id in the path manifest.

```bash
ario-deploy deploy --wallet ./wallet.json --incremental
```

Measured on a 1,229-file static docs site, redeployed from a fresh CI runner with no local cache and `--compress gzip`: 1,228 files were found on chain and one was uploaded (2.5 MiB), where a cold deploy uploaded 33 MiB.

**How it works:**

1. Every file in the folder is hashed (SHA-256).
2. Each file is looked up in the local dedupe cache, and then — for anything the cache cannot answer — among your own past uploads on chain.
3. Only the remainder is uploaded, and each transaction id reaches the cache as it lands — on the leading edge, then coalesced onto a 500 ms trailing timer, and flushed on `SIGINT`/`SIGTERM` so Ctrl-C does not lose files you have already paid for. `SIGHUP` and `SIGBREAK` are not handled, so a closed terminal or a dropped SSH session can still lose the current batch; CI is covered, since GitHub Actions cancels with `SIGINT` then `SIGTERM`.
4. The manifest is assembled from the remembered ids plus the new ones.

**Why the on-chain lookup matters:** every uploaded file carries a `File-SHA256` tag, which makes it findable again from nothing but the bytes on disk. That is what a CI job needs. CI runs from a fresh checkout, so `.ario-deploy/transaction-cache.json` is often missing or stale even with `actions/cache` restoring it — and without the on-chain lookup every redeploy pays for the whole bundle again.

**The tag invariant:** a data item's id covers its tags, so a tag whose value changes between deploys — a commit SHA above all — moves every file's id on every deploy and defeats deduplication. The failure is silent: the upload succeeds, the manifest is correct, and the bill doubles. In incremental mode files therefore carry only deploy-invariant tags (`App-Name`, `Content-Type`, `File-SHA256`, plus `Content-Encoding` when compressed), and the `GIT-HASH` provenance tag rides on the manifest instead, which is rewritten every deploy anyway. The tag set is asserted in code, so a future addition fails loudly rather than quietly costing money.

**Reuse is keyed on content type as well as content.** Two files with identical bytes served under different types — `a.json` and `b.txt` — stay two uploads, because a gateway serves whatever `Content-Type` the data item carries and collapsing them would serve one of them as the other. Cache entries are therefore keyed `<sha256>|<mime-type>` (plus `|<encoding>` when compressed) in every mode. Incremental mode never falls back to a 1.x hash-only entry, so switching a project to `--incremental` may re-upload once and is cheap from then on.

**What it trusts:** only your own wallet's past transactions, matched on the 43-character address a gateway indexes an owner as — derived locally as `base64url(sha256(publicKey))`, which is correct for all four signer types. Every result is then re-checked against the owner and content type in the gateway's own response, which catches a buggy or misconfigured gateway. It cannot catch a malicious one, since the owner, tags and id all come from that same response: point `--incremental-gateway` only at a gateway you trust, because a wrong id would land in both the permanent manifest and the local cache.

**Limits and caveats:**

- **Lookups are batched.** Hashes are sent 100 per GraphQL request, because gateways cap the size of a query (an ar.io gateway refuses ~1,100 hashes with "Max query size exceeded"). A site of any size is covered; each batch is paged until its files are accounted for, up to 20 pages.
- **The credits pre-flight prices only what will be sent**: the files still to upload plus an estimate of the manifest, which is uploaded on every deploy. A fully reused redeploy is priced at the manifest alone.
- **Gateway GraphQL indexing lags an upload by a few minutes.** Two machines deploying the same _new_ file at the same moment can each pay for it. It costs a fraction of a cent and never produces a wrong manifest.
- **A gateway that is slow, unreachable or erroring costs reuse, not correctness.** Requests that fail transiently (HTTP 429 or 5xx, a timeout, a network error) are retried twice with a short backoff. A batch that still fails costs only its own files, which are uploaded again, and the run says how many batches it could not look up. If no batch can be looked up at all, the run warns and uploads everything the local cache does not already hold.
- **A doomed deploy takes longer to say so.** Every queued upload settles before a failure is reported, so a systemic failure (bad credentials, exhausted credits) on a very large folder surfaces at the end rather than immediately. The same uploads were always attempted, so the bill is unchanged; the alternative stranded ids that had been paid for and never written down.
- **Ignored for `--deploy-file`.** Reuse works through the manifest, and a single file has no manifest. The run warns rather than silently doing nothing.
- **Cache entries are keyed differently in each mode**, so a project that toggles `--incremental` on and off stores up to two entries per file against the shared `--dedupe-cache-max-entries` cap: `<sha256>` (or `gzip:<sha256>` when compressed) without it, and `<sha256>|<mime-type>` (or `<sha256>|<mime-type>|gzip`) with it.

**Notes:**

- Off by default. Nothing changes for an existing pipeline until you pass the flag.
- Refused alongside `--no-dedupe` or `--dedupe-cache-max-entries 0`, which ask for the opposite.
- Works with `--compress`: each file's `File-SHA256` is the hash of the file on disk, and a compressed upload also carries `Content-Encoding`, so a lookup only ever reuses an upload made with the same encoding. Turning compression on or off uploads each file once more, then reuse resumes.
- The lookup uses `https://turbo-gateway.com/graphql` by default, where uploads made through Turbo are indexed within minutes (about 5-7 in our measurements), before they are bundled into a block. Override it with `--incremental-gateway` — for example when uploading through another bundler with `--uploader`.

## Compression

Arweave storage is priced per byte, and HTML, JavaScript, CSS and JSON typically shrink 5-8x when compressed (a 169 MB static docs site uploads as 22 MiB). `--compress` compresses each file before upload and tags it with `Content-Encoding`; gateways return that header, and browsers decompress transparently.

```bash
ario-deploy deploy --wallet ./wallet.json --deploy-folder ./out --compress gzip
```

In the GitHub Action (`compress` needs v1.1.0 or later; pin the version, since the floating `v1` tag is moved by hand and may lag):

```yaml
- uses: ar-io/ar-io-deploy@v1.1.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    deploy-folder: ./dist
    compress: gzip
    compress-exclude: 'llms*.txt,*.md'
```

- **Prefer `gzip`.** Gateways send the encoded bytes to every client, whether or not it asked for compression. Every browser and HTTP library understands gzip; `br` was ~17% smaller than gzip on a static docs site, but some non-browser clients cannot decode it.
- **Formats that are already compressed** are uploaded as-is: already-compressed formats (JPEG, PNG, GIF, WebP, AVIF, HEIC, WOFF/WOFF2, MP3, M4A, Ogg/Opus, MP4, WebM, and zip/gz/br/bz2/xz/zst/7z/rar archives). Other images and fonts (`.svg`, `.ico`, `.ttf`, `.otf`) are compressed. Every other file is compressed, even a tiny one gzip makes a few bytes larger, so its tags always match how it was planned.
- **Exclude files meant for non-browser clients** with `--compress-exclude`, e.g. text files that tools fetch with `curl`: `--compress-exclude "llms*.txt,*.md"`. A pattern without `/` matches the file name in any directory.
- **Gateways must label items they have not indexed yet.** Right after a deploy, a gateway may serve a data item before it has indexed the item's tags. An ar-io-node without the fix for that (ar-io-node #964/#966) sends the gzip bytes with no `Content-Encoding` header, and browsers render garbage until the item is indexed -- or indefinitely, on a gateway that never indexes the bundle. The ar.io and Turbo gateways (`turbo-gateway.com`, `ardrive.net`, and those serving `*.ar.io`) have the fix; other operators get it by upgrading. Deploy to a test undername first and load it through each gateway that matters, including through Wayfinder, which may pick any gateway.
- **Deduplication still works**, including `--incremental`. Compressed uploads are cached (and found on chain) under their own key, so turning compression on re-uploads each file once, and later deploys skip unchanged files as usual.

## Package.json Scripts

Add deployment scripts to your `package.json`:

```json
{
  "scripts": {
    "build": "vite build",
    "deploy": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME>",
    "deploy:staging": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME> --undername staging",
    "deploy:devnet": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME> --cluster devnet",
    "deploy:on-demand": "pnpm build && ario-deploy deploy --arns-name <ARNS_NAME> --sig-type solana --on-demand ario --max-token-amount 1.5"
  }
}
```

These read the upload key from `DEPLOY_KEY` and the Solana ArNS authority key from `ARNS_KEY`. Deploy with:

```bash
DEPLOY_KEY=$(base64 -i wallet.json) ARNS_KEY=<base58-solana-secret-key> pnpm run deploy
```

Or with on-demand payment in ARIO, which needs a Solana upload key (here the same key does both jobs):

```bash
DEPLOY_KEY=<base58-solana-secret-key> ARNS_KEY=<base58-solana-secret-key> pnpm deploy:on-demand
```

## GitHub Action

The easiest way to integrate ario-deploy into your CI/CD pipeline is using our official GitHub Action.

### Basic Usage

```yaml
- uses: ar-io/ar-io-deploy@v2.0.0
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
        uses: ar-io/ar-io-deploy@v2.0.0
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: myapp
          preview: 'true'
          github-token: ${{ secrets.GITHUB_TOKEN }}
          deploy-folder: ./dist
```

When `preview` is enabled, the action will:

- Auto-generate an undername like `myapp-repo-pr-123` from the repository name and PR number
- Post a comment on the PR with the preview URL (the token needs `pull-requests: write`)
- Update the comment on subsequent pushes instead of creating new ones

Preview undernames are not removed when the PR closes; each costs one of the ArNS name's undername slots until you remove it. The action skips every step on a `closed` event, so subscribing to it costs nothing.

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
        uses: ar-io/ar-io-deploy@v2.0.0
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: myapp
          deploy-folder: ./dist
```

### With On-Demand Payment

```yaml
- name: Deploy with ARIO on-demand
  uses: ar-io/ar-io-deploy@v2.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    arns-key: ${{ secrets.ARNS_KEY }}
    arns-name: myapp
    deploy-folder: ./dist
    sig-type: solana # ARIO is a Solana token, so the upload key must be Solana
    on-demand: ario
    max-token-amount: '2.0'
```

### Updating ArNS (Solana)

ArNS updates run against the Solana ARIO programs. Provide the Solana ArNS authority key via `arns-key` (a base58 Solana secret key); the upload is still paid for by `deploy-key`. Use `cluster` to target `mainnet` (default) or `devnet`, and `rpc-url` for a custom RPC endpoint.

```yaml
- name: Deploy and update ArNS
  uses: ar-io/ar-io-deploy@v2.0.0
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
  uses: ar-io/ar-io-deploy@v2.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    deploy-folder: ./dist
    no-dedupe: 'true'
```

You can also limit the cache size:

```yaml
- name: Deploy with limited cache
  uses: ar-io/ar-io-deploy@v2.0.0
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    deploy-folder: ./dist
    dedupe-cache-max-entries: '1000'
```

### Incremental Uploads

A CI job runs from a fresh checkout, so the restored transaction cache is often missing or stale — and then every redeploy pays for the whole bundle again. `incremental: 'true'` recovers those transaction ids from your wallet's own past uploads on chain, so only the files that actually changed are paid for. See [Incremental uploads](#incremental-uploads). Requires v1.2.0 or later; pin the version, since the floating `v1` tag may lag.

```yaml
- name: Deploy only what changed
  uses: ar-io/ar-io-deploy@v1.2.0
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

      - run: pnpm run deploy
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
        run: ario-deploy deploy --arns-name my-app --sig-type solana --on-demand ario --max-token-amount 2.0
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

# Run tests (the e2e tests run the built CLI, so build first)
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
│   ├── commands/        # oclif commands: deploy, upload, keygen
│   ├── constants/       # flag definitions (single source of truth), cache constants
│   ├── prompts/         # interactive prompts
│   ├── utils/           # uploader, Turbo payments, cache, incremental index, signers
│   ├── workflows/       # the upload workflow both commands run
│   └── index.ts         # Main entry point
├── tests/               # unit and e2e tests (MSW mocks Turbo over HTTP)
├── bin/                 # run.js (built) and dev.js (tsx)
├── action.yml           # the GitHub Action
└── dist/                # Build output
```

## Security & Best Practices

- **Dedicated Wallet:** Always use a dedicated wallet for deployments to minimize security risks
- **Wallet Encoding:** Arweave wallets must be base64 encoded to be used in the deployment script
- **ArNS Name:** Required only when updating an ANT/ArNS target undername or root record
- **Turbo Credits:** Ensure your wallet has sufficient Turbo Credits, or use on-demand payment for automatic funding
- **On-Demand Limits:** Set reasonable `--max-token-amount` limits to prevent unexpected costs
- **Secret Management:** Keep your `DEPLOY_KEY` secret secure and never commit it to your repository
- **Wallet Location:** Never keep a wallet file inside the folder you deploy. `ario-deploy` refuses to upload one it recognizes (see [Files that are never uploaded](#files-that-are-never-uploaded)), but other tools that publish the folder do not
- **Build Security:** Always check your build for exposed environmental secrets before deployment, as data on Arweave is permanent

## Troubleshooting

- **Error: "DEPLOY_KEY environment variable not set":** Verify your base64 encoded wallet is set as the `DEPLOY_KEY` environment variable
- **Error: "deploy-folder does not exist":** Check that your build folder exists and the path is correct
- **Error: "deploy-file does not exist":** Check that your build file exists and the path is correct
- **Error: "ArNS name does not exist":** Verify the ArNS name is correct and exists in the specified network
- **Upload timeouts:** Files have a timeout for upload. Large files may fail and require optimization
- **"402 Payment Required" (or "Turbo refused the upload as unpaid"):** The upload service will not take the files for free and no credits cover them. Free uploads are up to 105 KiB per file and 10 MiB over the lifetime of a wallet and of an IP range, so a wallet with allowance left can still be refused when its IP range has used up its own. Add Turbo credits at https://turbo.ardrive.io, re-run with `--on-demand` and `--max-token-amount`, or have credits shared to the wallet. Do not use `--dev` to get around it: a sandbox upload is not permanent. Files that uploaded before the failure are cached, so a re-run does not pay for them again
- **Insufficient Turbo Credits:** Use `--on-demand` with `--max-token-amount` to automatically fund uploads when balance is low
- **On-demand payment fails:** Ensure the upload wallet holds the token, and that the token matches the key: `ario`, `solana` or `solana-usdc` with `--sig-type solana`; `base-eth` or `base-usdc` with an Ethereum or Polygon key
- **"Insufficient Turbo credits" on the sandbox with valid sandbox credits:** Use `--dev`, or pass `--payment-url https://payment.services.ar-io.dev` with a custom `--uploader`, so the balance is read from the sandbox
- **Credits shared with you are not used:** They are used automatically unless `--ignore-approvals` is set; with `--paid-by`, only the listed wallets count
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
