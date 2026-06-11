# Deploy to AR.IO

Deploy this project to the permaweb (Arweave) with optional ArNS name updates.

## Skill Trigger

Use when the user says: "deploy", "deploy to ar.io", "deploy to arweave", "publish to permaweb", "/deploy", or asks to ship/publish the app.

## First-Time Setup

If the user hasn't deployed to AR.IO before, guide them through setup:

### Create Wallet(s)

A deployment uses up to **two keys**:

- **Upload key** (`DEPLOY_KEY`) — pays for the upload. Any supported signer.
- **ArNS authority key** (`ARNS_KEY`) — updates the ArNS name. Must be Solana. Only needed for ArNS.

They can be the same Solana wallet or two different wallets.

**Create a Solana wallet** (works for both):

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
solana-keygen new
solana-keygen export-private-key  # base58 key for DEPLOY_KEY / ARNS_KEY
```

**For upload-only** — an Arweave wallet also works:

- Generate at https://arweave.app
- Base64-encode the JWK: `base64 -i wallet.json`

### Get an ArNS Name (optional, for human-readable URLs)

- Purchase a name at https://arns.app (costs ARIO tokens)
- This gives you a permanent URL like `https://myapp.ar.io`
- Skip if you only need a raw Arweave transaction URL

### Fund Uploads

- **Pre-fund**: Buy Turbo credits at https://turbo.ardrive.io
- **On-demand**: Use `--on-demand ario` to auto-convert ARIO tokens during deploy

### Set Environment Variables

| Variable | Purpose | Format |
|----------|---------|--------|
| `DEPLOY_KEY` | Upload key | Base58 (Solana), base64 JWK (Arweave), or hex (Ethereum) |
| `ARNS_KEY` | ArNS authority | Base58 Solana secret key |

Or use `--wallet <path>` and `--arns-wallet <path>` to point to key files.

## How to Use

This skill uses `@ar.io/deploy` to upload your built app to Arweave permanently.

### Quick Deploy (Upload Only)

```bash
# Build first
npm run build

# Deploy (uses DEPLOY_KEY env var or prompts interactively)
npx @ar.io/deploy deploy --deploy-folder ./dist
```

### Deploy with ArNS Name

```bash
DEPLOY_KEY=<upload-key> ARNS_KEY=<solana-key> npx @ar.io/deploy deploy \
  --deploy-folder ./dist \
  --arns-name YOUR_ARNS_NAME
```

### Interactive Mode

If unsure about options, run without flags for guided prompts:

```bash
npx @ar.io/deploy deploy
```

## Deployment Steps

1. **Build the project** — run the project's build command (e.g., `npm run build`, `pnpm build`)
2. **Check for keys** — look for `DEPLOY_KEY` (and `ARNS_KEY` if ArNS) or wallet files
3. **Detect build folder** — check for `./dist`, `./build`, `./out`, or ask the user
4. **Run deploy** — execute the appropriate `ario-deploy` command
5. **Report results** — show the transaction ID and URLs

## Signer Types

| Type | Format | ArNS Support |
|------|--------|-------------|
| `arweave` (default) | Base64 JWK | Upload only (needs separate `ARNS_KEY`) |
| `ethereum` | Hex key (0x...) | Upload only (needs separate `ARNS_KEY`) |
| `solana` | Base58 secret key | Upload + can be `ARNS_KEY` too |

## Key Flags

- `--deploy-folder ./dist` — folder to upload (default: `./dist`)
- `--deploy-file ./file.html` — upload a single file instead
- `--arns-name myapp` — update ArNS record
- `--arns-wallet ./id.json` — Solana wallet for ArNS authority
- `--undername staging` — deploy to a subdomain (e.g., `staging_myapp.ar.io`)
- `--on-demand ario` — auto-fund upload if balance is low
- `--no-dedupe` — force re-upload all files

## After Deployment

- **Arweave URL**: `https://arweave.net/<TX_ID>`
- **ArNS URL**: `https://<arns-name>.ar.io`
- **Undername URL**: `https://<undername>_<arns-name>.ar.io`

## Setup for New Projects

If `@ar.io/deploy` is not installed:

```bash
npm install --save-dev @ar.io/deploy
```

Add to `package.json` scripts:

```json
{
  "scripts": {
    "deploy": "npm run build && ario-deploy deploy --arns-name YOUR_NAME",
    "deploy:preview": "npm run build && ario-deploy deploy --arns-name YOUR_NAME --undername preview"
  }
}
```

Then run with: `DEPLOY_KEY=<key> ARNS_KEY=<key> npm run deploy`

## CI/CD Setup

For GitHub Actions, add this workflow (`.github/workflows/deploy.yml`):

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
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - uses: ar-io/ar-io-deploy@v1
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: YOUR_ARNS_NAME
          deploy-folder: ./dist
```

Required secrets:

- `DEPLOY_KEY` — upload wallet key (any signer type)
- `ARNS_KEY` — Solana base58 private key for ArNS authority (only if updating ArNS)
