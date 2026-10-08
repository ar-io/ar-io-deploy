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

**Create a Solana wallet** (works for both) with `keygen`:

```bash
npx @ar.io/deploy keygen
```

It writes `./ario-deploy-wallet.json` (a `solana-keygen` `id.json`, readable by the user only, never overwritten, added to `.gitignore` inside a git repository) and prints the file path, the public address, the free upload allowance and the exact `deploy` command to run next. It never prints the secret key. Use `--out <path>` to choose another file. Do not read the wallet file or print its contents. Tell the user to back up the file: it cannot be recovered.

**For upload-only:** an Arweave wallet also works, if the user already has one:

- Base64-encode the JWK: `base64 -i wallet.json`

### Get an ArNS Name (optional, for human-readable URLs)

- Purchase a name at https://arns.ar.io (costs ARIO tokens)
- This gives you a permanent URL like `https://myapp.ar.io`
- Skip if you only need a raw Arweave transaction URL

### Fund Uploads

**Free tier facts** (tell the user before the first deploy):

- Turbo uploads are free up to **105 KiB per file**, and up to **10 MiB over the lifetime of a wallet and 10 MiB over the lifetime of an IP range**. Both are metered.
- The pre-upload check only knows the wallet. It can say "within this wallet's free tier" and the upload can still fail with HTTP 402 because the IP range's allowance is used up.
- On a 402, **stop and report it**. Never fall back to `--dev` to get past it: `--dev` uploads to the Turbo sandbox, which is not permanent and is not served by production gateways, so the URL it prints is not a real deployment. Offer these instead: add Turbo credits, `--on-demand` with `--max-token-amount`, or credits shared to the wallet.

- **Pre-fund**: Buy Turbo credits at https://turbo.ardrive.io
- **On-demand**: `--on-demand ario --max-token-amount 1.5` with a Solana upload key (`--sig-type solana`); EVM keys use `base-eth` or `base-usdc`

### Set Environment Variables

| Variable     | Purpose        | Format                                                   |
| ------------ | -------------- | -------------------------------------------------------- |
| `DEPLOY_KEY` | Upload key     | Base58 (Solana), base64 JWK (Arweave), or hex (Ethereum) |
| `ARNS_KEY`   | ArNS authority | Base58 Solana secret key                                 |

Or use `--wallet <path>` and `--arns-wallet <path>` to point to key files.

## How to Use

This skill uses `@ar.io/deploy` to upload your built app to Arweave permanently.

`--deploy-folder` uploads a folder and writes a manifest. `--deploy-file`
uploads a single file with **no manifest**, so manifest options such as
`--fallback-file` do not apply to it.

### Quick Deploy (Upload Only)

```bash
# Build first
npm run build

# Deploy (uses DEPLOY_KEY env var or prompts interactively)
npx @ar.io/deploy deploy --deploy-folder ./dist
```

### Single-page apps: set a fallback

**Check this before deploying any app with client-side routing** (React Router,
Vue Router, SvelteKit SPA mode, Next static export). It is the most common way
an ar.io deploy looks broken.

A path manifest 404s any path it does not list. An SPA's routes are not files —
`/settings` exists only in the router — so without a fallback the homepage loads
and every deep link 404s.

`ario-deploy` sets the fallback automatically **if the build emits `404.html`**.
Most do not. So either:

```bash
# Option A — give the build a 404.html (auto-detected)
npm run build && cp dist/index.html dist/404.html
npx @ar.io/deploy deploy --deploy-folder ./dist

# Option B — name the fallback explicitly
npx @ar.io/deploy deploy --deploy-folder ./dist --fallback-file index.html
```

Skip this only for a genuinely static site where every URL is a real file.

**After deploying, verify a deep link, not just the homepage** — the homepage
works either way, so it proves nothing:

```bash
curl -o /dev/null -w '%{http_code}\n' https://YOUR_NAME.ar.io/some/route
```

Expect `200`. If you get `404` within a minute of deploying, gateways may still
be serving cached 404s from the previous manifest — retry with a cache-busting
query string (`?x=1`) before concluding the deploy failed.

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
2. **Check for keys** — look for `DEPLOY_KEY` (and `ARNS_KEY` if ArNS) or wallet files. If there are none, run `npx @ar.io/deploy keygen`
3. **Detect build folder** — check for `./dist`, `./build`, `./out`, or ask the user
4. **Run deploy** — execute the appropriate `ario-deploy` command
5. **Report results** — show the transaction ID and URLs

## Signer Types

| Type                | Format            | ArNS Support                            |
| ------------------- | ----------------- | --------------------------------------- |
| `arweave` (default) | Base64 JWK        | Upload only (needs separate `ARNS_KEY`) |
| `ethereum`          | Hex key (0x...)   | Upload only (needs separate `ARNS_KEY`) |
| `solana`            | Base58 secret key | Upload + can be `ARNS_KEY` too          |

## Key Flags

- `--deploy-folder ./dist` — folder to upload (default: `./dist`)
- `--deploy-file ./file.html` — upload a single file instead
- `--arns-name myapp` — update ArNS record
- `--arns-wallet ./id.json` — Solana wallet for ArNS authority
- `--undername staging` — deploy to a subdomain (e.g., `staging_myapp.ar.io`)
- `--on-demand ario --max-token-amount 1.5` — top up once if credits run short (Solana upload key; EVM keys use `base-eth`)
- `--dev`: the Turbo development sandbox for upload and payment. Testing only: sandbox uploads are not permanent and production gateways do not serve them. Never use it to get past a 402
- `--no-dedupe` — force re-upload all files (identical files within one deploy are still uploaded once)
- `--compress gzip` — compress HTML/JS/CSS/JSON before upload (~5-8x cheaper); pair with `--compress-exclude "llms*.txt,*.md"` for files plain HTTP clients fetch
- `--incremental` — find files already uploaded by this wallet on chain, so a CI deploy with no local cache pays only for what changed (uploads take about 5-7 minutes to become findable)

Unchanged files are not re-uploaded while the local dedupe cache knows them, or at all with `--incremental`, and the credit check prices only what will actually be uploaded.

**With `--compress`, verify a page right after deploying.** Gateways must send
`Content-Encoding` even for items they have not indexed yet (ar-io-node
#964/#966; the ar.io and Turbo gateways have it). A gateway without the fix
serves the gzip bytes with no header, and the page renders as garbage. If that
happens, use a gateway with the fix or redeploy without `--compress`.

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
      - uses: ar-io/ar-io-deploy@v2.0.0
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-key: ${{ secrets.ARNS_KEY }}
          arns-name: YOUR_ARNS_NAME
          deploy-folder: ./dist
```

Required secrets:

- `DEPLOY_KEY` — upload wallet key (any signer type)
- `ARNS_KEY` — Solana base58 private key for ArNS authority (only if updating ArNS)
