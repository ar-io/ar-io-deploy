# Quick Start Guide

Get up and running with ARIO Deploy in minutes. Requires Node.js 20.18 or later.

## Installation

Using pnpm (recommended):

```bash
pnpm add -D @ar.io/deploy
```

## Setup

A deploy uses up to two keys:

- **Upload key (`DEPLOY_KEY`)** pays for the upload, on any supported chain:
  - **Arweave (default):** base64-encode your JWK: `base64 -i wallet.json`
  - **Ethereum/Polygon:** your raw hex private key, with `--sig-type ethereum` or `--sig-type polygon`
  - **Solana:** a base58 secret key or a `solana-keygen` `id.json` file, with `--sig-type solana`
- **ArNS authority key (`ARNS_KEY`)** is needed only to update an ArNS name. It is always a Solana key that controls the name: a base58 secret key, or `--arns-wallet ./id.json`.

The two can be the same Solana wallet; provide each explicitly.

1. **Set the keys**

   ```bash
   export DEPLOY_KEY="<upload-key>"
   export ARNS_KEY="<solana-base58-secret-key>"
   ```

2. **Add a deployment script to package.json**

   ```json
   {
     "scripts": {
       "build": "vite build",
       "deploy": "pnpm build && ario-deploy deploy --arns-name <YOUR_ARNS_NAME>"
     }
   }
   ```

## Basic Usage

Deploy and update ArNS (run the script with `pnpm run deploy`: `pnpm deploy` is a built-in pnpm command):

```bash
pnpm run deploy
```

Deploy to a staging undername:

```bash
ario-deploy deploy --arns-name my-app --undername staging
```

Upload without updating ArNS (no ArNS key needed):

```bash
DEPLOY_KEY=$(base64 -i wallet.json) ario-deploy upload --deploy-folder ./dist
```

## Common Scenarios

### Deploy with a Custom Build Folder

```bash
ario-deploy deploy --arns-name my-app --deploy-folder ./build
```

### Deploy a Single File

```bash
ario-deploy deploy --arns-name my-app --deploy-file ./dist/index.html
```

### Use One Solana Wallet for Both Keys

```bash
ario-deploy deploy --arns-name my-app --sig-type solana --wallet ./id.json --arns-wallet ./id.json
```

### Update ArNS on Devnet

```bash
ario-deploy deploy --arns-name my-app --cluster devnet
```

`--cluster` only selects the Solana cluster for the ArNS update. The upload still goes to production Turbo; add `--dev` to upload and pay through Turbo's development sandbox instead.

### Upload with an Ethereum Wallet

```bash
DEPLOY_KEY=<eth-private-key> ario-deploy upload --deploy-folder ./dist --sig-type ethereum
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
          node-version: 22
          cache: 'pnpm'

      - run: pnpm install
      - run: pnpm run deploy
        env:
          DEPLOY_KEY: ${{ secrets.DEPLOY_KEY }}
          ARNS_KEY: ${{ secrets.ARNS_KEY }}
```

Or use the bundled GitHub Action; see the [README](../README.md#github-action).

## Troubleshooting

**"No upload key provided"**: set `DEPLOY_KEY`, or pass `--wallet` or `--private-key`.

**"No ArNS authority key provided"**: set `ARNS_KEY`, or pass `--arns-wallet` or `--arns-private-key`. It must be a Solana key that controls the name.

**"Invalid Solana key"**: the key must be a base58 64-byte secret key (not a public address) or an `id.json` byte array.

**"deploy-folder does not exist"**: run the build first, and point `--deploy-folder` at its output.

**"ArNS name [x] does not exist on mainnet"**: check the name, and the cluster (`--cluster mainnet` or `--cluster devnet`). "Could not fetch the ArNS record" instead means the Solana RPC failed; retry, or pass `--rpc-url`.

**"Insufficient Turbo credits"**: top up the upload wallet's Turbo credits, or pass `--on-demand` with a token the upload key can pay in (see the README's On-Demand Payment section).

## Next Steps

- Read the full [README](../README.md)
- Check [CONTRIBUTING.md](../CONTRIBUTING.md) to contribute
- See all options: `ario-deploy deploy --help`

## Need Help?

- [Open an issue](https://github.com/ar-io/ar-io-deploy/issues)
- [Read the docs](https://docs.ar.io/)
- [Join the community](https://discord.gg/csYueXqZ3W)
