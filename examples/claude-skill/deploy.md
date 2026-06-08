# Deploy to AR.IO

Deploy this project to the permaweb (Arweave) with optional ArNS name updates.

## Skill Trigger

Use when the user says: "deploy", "deploy to ar.io", "deploy to arweave", "publish to permaweb", "/deploy", or asks to ship/publish the app.

## First-Time Setup

If the user hasn't deployed to AR.IO before, guide them through setup:

### Create a Wallet

**For ArNS deployments (recommended)** — use a Solana wallet:

```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Generate a keypair
solana-keygen new

# Get your base58 private key for DEPLOY_KEY
solana-keygen export-private-key
```

**For upload-only** — an Arweave wallet works:

- Generate at https://arweave.app
- Base64-encode the JWK: `base64 -i wallet.json`

### Get an ArNS Name (optional, for human-readable URLs)

- Purchase a name at https://arns.app (costs ARIO tokens)
- This gives you a permanent URL like `https://myapp.ar.io`
- Skip if you only need a raw Arweave transaction URL

### Fund Uploads

- **Pre-fund**: Buy Turbo credits at https://turbo.ardrive.io
- **On-demand**: Use `--on-demand ario` to auto-convert ARIO tokens during deploy

### Set DEPLOY_KEY

| Signer   | DEPLOY_KEY Format                                       |
| -------- | ------------------------------------------------------- |
| solana   | Base58 private key (`solana-keygen export-private-key`) |
| arweave  | `base64 -i wallet.json`                                 |
| ethereum | Hex private key (`0xabc...`)                            |

Or use `--wallet <path>` to point to a key file instead.

## How to Use

This skill uses `@ar.io/deploy` to upload your built app to Arweave permanently.

### Quick Deploy (Upload Only)

```bash
# Build first
npm run build

# Deploy (uses DEPLOY_KEY env var or prompts interactively)
npx @ar.io/deploy deploy --deploy-folder ./dist
```

### Deploy with ArNS Name (Solana Signer Required)

```bash
DEPLOY_KEY=<solana-base58-key> npx @ar.io/deploy deploy \
  --deploy-folder ./dist \
  --arns-name YOUR_ARNS_NAME \
  --sig-type solana
```

### Interactive Mode

If unsure about options, run without flags for guided prompts:

```bash
npx @ar.io/deploy deploy
```

## Deployment Steps

1. **Build the project** — run the project's build command (e.g., `npm run build`, `pnpm build`)
2. **Check for DEPLOY_KEY** — look for the environment variable or a wallet file
3. **Detect build folder** — check for `./dist`, `./build`, `./out`, or ask the user
4. **Run deploy** — execute the appropriate `ario-deploy` command
5. **Report results** — show the transaction ID and URLs

## Signer Types

| Type       | Format            | ArNS Support  |
| ---------- | ----------------- | ------------- |
| `arweave`  | Base64 JWK        | Upload only   |
| `ethereum` | Hex key (0x...)   | Upload only   |
| `solana`   | Base58 secret key | Upload + ArNS |

## Key Flags

- `--deploy-folder ./dist` — folder to upload (default: `./dist`)
- `--deploy-file ./file.html` — upload a single file instead
- `--arns-name myapp` — update ArNS record (requires solana signer)
- `--sig-type solana` — signer type (required for ArNS)
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
    "deploy": "npm run build && ario-deploy deploy --arns-name YOUR_NAME --sig-type solana",
    "deploy:preview": "npm run build && ario-deploy deploy --arns-name YOUR_NAME --sig-type solana --undername preview"
  }
}
```

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
          arns-name: YOUR_ARNS_NAME
          sig-type: solana
          deploy-folder: ./dist
```

Required secret: `DEPLOY_KEY` — your Solana base58 private key (for ArNS) or base64 Arweave JWK (upload only).
