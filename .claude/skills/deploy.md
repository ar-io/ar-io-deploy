# Deploy to AR.IO

Deploy a web application to the permaweb (Arweave) and optionally update ArNS records.

## Skill Trigger

Use when the user says: "deploy to ar.io", "deploy to arweave", "deploy to permaweb", "publish to ar.io", "/deploy", or asks to deploy their app permanently.

## First-Time Setup

If the user hasn't deployed before, walk them through these steps:

### 1. Create Wallet(s)

A deployment uses up to **two keys**:

- **Upload key** (`DEPLOY_KEY`) — pays for the upload. Can be any supported signer type.
- **ArNS authority key** (`ARNS_KEY`) — only needed for ArNS updates. Must be a **Solana** key that controls the ArNS name.

They can be the same Solana wallet or two different wallets.

**Create a Solana wallet** (works for both upload and ArNS) with `ario-deploy keygen`:

```bash
ario-deploy keygen
```

It writes `./ario-deploy-wallet.json` (a `solana-keygen` `id.json`, readable by the user only, never overwritten, added to `.gitignore` inside a git repository) and prints the file path, the public address, the free upload allowance and the exact `deploy` command to run next. It never prints the secret key. Use `--out <path>` to choose another file. Do not read the wallet file or print its contents.

Tell the user to back up the wallet file: anyone who has it controls the wallet, and it cannot be recovered.

**For upload-only (no ArNS):** an Arweave wallet also works, if the user already has one:

- Base64-encode the JWK: `base64 -i wallet.json`

### 2. Get an ArNS Name (for human-readable URLs)

ArNS names give you a permanent URL like `https://myapp.ar.io`.

- **Purchase a name**: Go to https://arns.ar.io and search for an available name
- Names are purchased with ARIO tokens on Solana
- Once purchased, the name is tied to an ANT (Ar.io Name Token) that your wallet controls
- **Skip this step** if you only need upload-only (you'll get a raw Arweave tx URL instead)

### 3. Fund Uploads

**Free tier facts** (tell the user before the first deploy):

- Turbo uploads are free up to **105 KiB per file**, and up to **10 MiB over the lifetime of a wallet and 10 MiB over the lifetime of an IP range**. Both are metered.
- The pre-upload check only knows the wallet. It can say "within this wallet's free tier" and the upload can still fail with HTTP 402 because the IP range's allowance is used up.
- On a 402, **stop and report it**. Never fall back to `--dev` to get past it: `--dev` uploads to the Turbo sandbox, which is not permanent and is not served by production gateways, so the URL it prints is not a real deployment. Offer these instead: add Turbo credits, `--on-demand` with `--max-token-amount`, or credits shared to the wallet.

Beyond the free tier, uploads cost Turbo credits. Options:

- **Pre-fund**: Buy Turbo credits at https://turbo.ardrive.io with crypto or credit card
- **On-demand**: `--on-demand <token> --max-token-amount <n>` tops up once during deploy if credits run short. The token must match the upload key: `ario`, `solana`, `solana-usdc` with `--sig-type solana`; `base-eth`, `base-usdc` with an Ethereum/Polygon key. Arweave keys cannot top up on demand.
- **Shared credits**: credits other wallets shared with the upload key are used automatically (`--paid-by`, `--ignore-approvals` to control)

### 4. Set Up Environment Variables

| Variable     | Purpose                           | Format                                                   |
| ------------ | --------------------------------- | -------------------------------------------------------- |
| `DEPLOY_KEY` | Upload key (pays for upload)      | Base58 (Solana), base64 JWK (Arweave), or hex (Ethereum) |
| `ARNS_KEY`   | ArNS authority key (updates name) | Base58 Solana secret key                                 |

**Alternatively**, use file paths:

- `--wallet <path>` — upload key file
- `--arns-wallet <path>` — ArNS authority key file (Solana id.json)

## Prerequisites Check

Before deploying, verify:

1. **Build folder exists** — Look for `./dist`, `./build`, `./out`, or `.next/out`. Ask the user if unclear.
2. **@ar.io/deploy is available** — Check if it's in `package.json` (devDependencies) or installed globally. If not, install it:
   ```bash
   npm install -g @ar.io/deploy
   ```
3. **Wallet/key is available** — Check for:
   - `DEPLOY_KEY` environment variable (and `ARNS_KEY` if updating ArNS)
   - Wallet files (e.g., `wallet.json`, `id.json`, `~/.config/solana/id.json`)
   - If neither is found, run `ario-deploy keygen` to create a wallet; do not ask the user to generate one elsewhere
4. **ArNS name exists** (if deploying with ArNS) — The user must have already purchased a name at https://arns.ar.io

## Deployment Flow

### Step 1: Determine deployment type

Ask the user:

- **Upload only** (just put files on Arweave, get a tx ID)
- **Deploy with ArNS** (upload + update a human-readable name like `myapp.ar.io`)

### Step 2: Determine signer type(s)

| Upload Signer     | Key Format                   | ArNS Support              |
| ----------------- | ---------------------------- | ------------------------- |
| arweave (default) | Base64-encoded JWK           | Needs separate `ARNS_KEY` |
| ethereum          | Hex private key (0x...)      | Needs separate `ARNS_KEY` |
| solana            | Base58 secret key or id.json | Can also be `ARNS_KEY`    |

**ArNS updates always need a Solana key** in `ARNS_KEY` (or `--arns-wallet` / `--arns-private-key`). It is never taken from `DEPLOY_KEY`: to use one Solana wallet for both, set both.

Requires Node.js 20.18 or later.

### Step 3: Run the deploy

**Upload only (any signer):**

```bash
ario-deploy deploy --deploy-folder ./dist --wallet ./wallet.json
```

**With ArNS update (separate keys):**

```bash
ario-deploy deploy --deploy-folder ./dist --arns-name <NAME> --wallet ./wallet.json --arns-wallet ./arns-id.json
```

**With ArNS update (same Solana key for both):**

```bash
DEPLOY_KEY=<solana-key> ARNS_KEY=<solana-key> ario-deploy deploy --deploy-folder ./dist --arns-name <NAME> --sig-type solana
```

**With on-demand payment (auto-fund if balance is low):**

```bash
ario-deploy deploy --deploy-folder ./dist --arns-name <NAME> --sig-type solana --wallet ./id.json --arns-wallet ./arns-id.json --on-demand ario --max-token-amount 1.5
```

### Step 4: Report results

After successful deployment, report:

- **Transaction ID** — the Arweave tx ID
- **Direct URL** — `https://arweave.net/<TX_ID>`
- **ArNS URL** (if applicable) — `https://<name>.ar.io` or `https://<undername>_<name>.ar.io`

## Common Flags Reference

| Flag                    | Description                                                  | Default                     |
| ----------------------- | ------------------------------------------------------------ | --------------------------- |
| `--deploy-folder, -d`   | Folder to deploy                                             | `./dist`                    |
| `--deploy-file, -f`     | Single file to deploy                                        | —                           |
| `--sig-type, -s`        | Upload signer type                                           | `arweave`                   |
| `--wallet, -w`          | Upload wallet file path                                      | —                           |
| `--private-key, -k`     | Upload private key string                                    | —                           |
| `--arns-wallet`         | ArNS authority wallet file (Solana id.json)                  | —                           |
| `--arns-private-key`    | ArNS authority key string (base58)                           | —                           |
| `--arns-name, -n`       | ArNS name to update                                          | —                           |
| `--undername, -u`       | Subdomain/undername                                          | `@`                         |
| `--ttl-seconds, -t`     | TTL for ArNS record                                          | `60`                        |
| `--cluster, -p`         | Solana cluster                                               | `mainnet`                   |
| `--skip-arns-check`     | Update ArNS even if the key does not appear to control it    | `false`                     |
| `--on-demand`           | Top-up token (must match the upload key)                     | —                           |
| `--max-token-amount`    | Max spend for the whole deploy (required with on-demand)     | —                           |
| `--paid-by`             | Wallets whose shared credits pay                             | all that shared             |
| `--dev`                 | Turbo sandbox, testing only, not permanent                   | `false`                     |
| `--no-dedupe`           | Skip deduplication cache                                     | `false`                     |
| `--compress`            | Compress uploads: `gzip`, `br` or `none`                     | `none`                      |
| `--compress-exclude`    | Globs to upload uncompressed                                 | —                           |
| `--fallback-file`       | Path served for unlisted routes (SPAs)                       | `404.html` if present       |
| `--incremental`         | Reuse files already on Arweave (finds past uploads on chain) | `false`                     |
| `--incremental-gateway` | Gateway queried for past uploads                             | `https://turbo-gateway.com` |

## Interactive Mode

If the user is unsure about options, suggest running interactively:

```bash
ario-deploy deploy
```

This launches a guided wizard that prompts for all options.

## CI/CD Setup (GitHub Actions)

If the user wants to set up automated deployments, provide this workflow:

```yaml
name: Deploy to Permaweb

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

      - name: Install and build
        run: |
          npm ci
          npm run build

      - name: Deploy to AR.IO
        uses: ar-io/ar-io-deploy@v2.0.0
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: myapp
          deploy-folder: ./dist
```

For PR previews:

```yaml
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

## Troubleshooting

| Error                                           | Solution                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "DEPLOY_KEY not set"                            | Set `DEPLOY_KEY` env var or use `--wallet`/`--private-key`                                                                                                                                                                               |
| "deploy-folder does not exist"                  | Build first (`npm run build`) or specify correct path                                                                                                                                                                                    |
| "ArNS name does not exist"                      | Verify the name exists at https://arns.ar.io                                                                                                                                                                                             |
| HTTP 402 / "Turbo refused the upload as unpaid" | The free tier is used up (per wallet or per IP range), or a file is over 105 KiB. Add Turbo credits at https://turbo.ardrive.io, use `--on-demand`, or have credits shared to the wallet. Report it to the user; never switch to `--dev` |
| "Insufficient Turbo Credits"                    | Fund the upload wallet at https://turbo.ardrive.io, or use `--on-demand` with a token the key can pay in. On the sandbox, pass `--dev`                                                                                                   |
| Pages show garbage after a `--compress` deploy  | The gateway served an unindexed item without `Content-Encoding` (needs ar-io-node #964/#966). Use a gateway with the fix, or redeploy without `--compress`                                                                               |
| ArNS update fails                               | Ensure `ARNS_KEY` or `--arns-wallet` is set with a Solana key that controls the ArNS name                                                                                                                                                |

## Important Notes

- **`--dev` is not permanent.** It is the Turbo sandbox, for testing the tool only. A sandbox upload is not served by production gateways. Never use it to get past a 402, and if it was used, say so plainly in the report
- **Arweave uploads are permanent** — verify your build has no secrets before deploying
- **Deduplication is on by default** — unchanged files are not re-uploaded, and identical files within one deploy are uploaded once (saves cost). The credit check prices only what will actually be uploaded
- **Compression (`--compress gzip`) cuts upload cost ~5-8x for HTML/JS/CSS/JSON** — suggest it for static sites, with `--compress-exclude "llms*.txt,*.md"` for files plain HTTP clients fetch. Recommend deploying to a test undername first: gateways must send `Content-Encoding` for items they have not indexed yet (ar.io/Turbo gateways do; others need ar-io-node #964/#966)
- **Incremental uploads (`--incremental`) make CI redeploys cheap** — suggest it whenever deploys run in CI or on more than one machine. Each file is tagged with its content hash and later deploys find those uploads on chain, so a fresh checkout with no cache pays only for changed files. Uploads take about 5-7 minutes to become findable, so a redeploy seconds later may re-upload. Not combinable with `--no-dedupe` or `--dedupe-cache-max-entries 0`; ignored for `--deploy-file`
- **Cache location**: `.ario-deploy/transaction-cache.json` — commit it to share with team or gitignore it
