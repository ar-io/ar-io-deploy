# Quick Start Guide

Get up and running with ARIO Deploy in minutes!

## Installation

Using pnpm (recommended):

```bash
pnpm add -D @ar.io/deploy
```

## Setup

1. **Prepare your wallet**

   For plain uploads you can use any supported signer:
   - **Arweave (default):** base64-encode your JWK

     ```bash
     base64 -i wallet.json | pbcopy
     ```

   - **Ethereum/Polygon/KYVE:** use your raw hex private key directly
   - **Solana:** use a base58 secret key, or a `solana-keygen` `id.json` wallet file

   > **Updating ArNS requires a Solana signer** (`--sig-type solana`), because ArNS/ANT records live on Solana programs. Use a base58 Solana secret key as your `DEPLOY_KEY` (or pass `--wallet ./id.json`).

2. **Set environment variable**

   ```bash
   export DEPLOY_KEY="<your-wallet-or-private-key>"
   ```

3. **Add deployment script to package.json**

   ```json
   {
     "scripts": {
       "build": "vite build",
       "deploy": "pnpm build && ario-deploy deploy --arns-name <YOUR_ARNS_NAME> --sig-type solana"
     }
   }
   ```

## Basic Usage

Deploy to production (updates ArNS — requires a Solana key):

```bash
DEPLOY_KEY=<solana-base58-secret-key> pnpm deploy
```

Deploy to staging (undername):

```bash
DEPLOY_KEY=<solana-base58-secret-key> ario-deploy deploy \
  --arns-name my-app \
  --sig-type solana \
  --undername staging
```

Upload without updating ArNS (any signer, no Solana required):

```bash
DEPLOY_KEY=$(base64 -i wallet.json) ario-deploy upload --deploy-folder ./dist
```

## Common Scenarios

### Deploy a React/Vite App

```json
{
  "scripts": {
    "build": "vite build",
    "deploy": "pnpm build && ario-deploy deploy --arns-name my-app --sig-type solana"
  }
}
```

### Deploy with Custom Build Folder

```bash
ario-deploy deploy --arns-name my-app --sig-type solana --deploy-folder ./build
```

### Deploy Single File

```bash
ario-deploy deploy --arns-name my-app --sig-type solana --deploy-file ./dist/index.html
```

### Update ArNS on Devnet

```bash
ario-deploy deploy --arns-name my-app --sig-type solana --cluster devnet
```

### Upload with an Ethereum Wallet

Non-Solana signers can upload but cannot update ArNS:

```bash
DEPLOY_KEY=<eth-private-key> ario-deploy upload \
  --deploy-folder ./dist \
  --sig-type ethereum
```

## GitHub Actions Setup

Create `.github/workflows/deploy.yml`:

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

## Troubleshooting

**Issue:** "DEPLOY_KEY environment variable not set"

**Solution:** Make sure you've exported the DEPLOY_KEY variable or passed it inline:

```bash
DEPLOY_KEY=<solana-base58-secret-key> ario-deploy deploy --arns-name my-app --sig-type solana
```

---

**Issue:** "ArNS updates require --sig-type solana"

**Solution:** ArNS records live on Solana — pass `--sig-type solana` and use a Solana wallet/key for any deploy that updates ArNS.

---

**Issue:** "deploy-folder does not exist"

**Solution:** Make sure your build step runs before deployment and outputs to the correct folder:

```bash
pnpm build && ario-deploy deploy --arns-name my-app --sig-type solana --deploy-folder ./dist
```

---

**Issue:** "ArNS name does not exist"

**Solution:** Verify your ArNS name is registered and you're targeting the correct Solana cluster (`--cluster mainnet` or `--cluster devnet`).

## Next Steps

- Read the full [README.md](./README.md) for detailed documentation
- Check [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute
- See all available options: `ario-deploy deploy --help`

## Need Help?

- [Open an issue](https://github.com/ar-io/ar-io-deploy/issues)
- [Read the docs](https://docs.ar.io/)
- [Join the community](https://discord.gg/arweave)
