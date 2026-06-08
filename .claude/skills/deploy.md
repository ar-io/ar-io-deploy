# Deploy to AR.IO

Deploy a web application to the permaweb (Arweave) and optionally update ArNS records.

## Skill Trigger

Use when the user says: "deploy to ar.io", "deploy to arweave", "deploy to permaweb", "publish to ar.io", "/deploy", or asks to deploy their app permanently.

## Prerequisites Check

Before deploying, verify:

1. **Build folder exists** — Look for `./dist`, `./build`, `./out`, or `.next/out`. Ask the user if unclear.
2. **@ar.io/deploy is available** — Check if it's in `package.json` (devDependencies) or installed globally. If not, install it:
   ```bash
   npm install -g @ar.io/deploy
   ```
3. **Wallet/key is available** — Check for:
   - `DEPLOY_KEY` environment variable
   - A wallet file (e.g., `wallet.json`, `id.json`, `~/.config/solana/id.json`)
   - Ask the user if neither is found

## Deployment Flow

### Step 1: Determine deployment type

Ask the user:

- **Upload only** (just put files on Arweave, get a tx ID)
- **Deploy with ArNS** (upload + update a human-readable name like `myapp.ar.io`)

### Step 2: Determine signer type

| Signer   | Key Format                   | Can update ArNS? |
| -------- | ---------------------------- | ---------------- |
| arweave  | Base64-encoded JWK JSON      | No (upload only) |
| ethereum | Hex private key (0x...)      | No (upload only) |
| solana   | Base58 secret key or id.json | Yes              |

**ArNS updates require `--sig-type solana`.**

### Step 3: Run the deploy

**Upload only (any signer):**

```bash
ario-deploy deploy --deploy-folder ./dist --sig-type arweave --wallet ./wallet.json
```

**With ArNS update (Solana signer required):**

```bash
ario-deploy deploy --deploy-folder ./dist --arns-name <NAME> --sig-type solana --wallet ./id.json
```

**With environment variable:**

```bash
DEPLOY_KEY=<key> ario-deploy deploy --deploy-folder ./dist --arns-name <NAME> --sig-type solana
```

**With on-demand payment (auto-fund if balance is low):**

```bash
ario-deploy deploy --deploy-folder ./dist --arns-name <NAME> --sig-type solana --wallet ./id.json --on-demand ario --max-token-amount 1.5
```

### Step 4: Report results

After successful deployment, report:

- **Transaction ID** — the Arweave tx ID
- **Direct URL** — `https://arweave.net/<TX_ID>`
- **ArNS URL** (if applicable) — `https://<name>.ar.io` or `https://<undername>_<name>.ar.io`

## Common Flags Reference

| Flag                  | Description              | Default   |
| --------------------- | ------------------------ | --------- |
| `--deploy-folder, -d` | Folder to deploy         | `./dist`  |
| `--deploy-file, -f`   | Single file to deploy    | —         |
| `--sig-type, -s`      | Signer type              | `arweave` |
| `--wallet, -w`        | Path to wallet file      | —         |
| `--private-key, -k`   | Private key string       | —         |
| `--arns-name, -n`     | ArNS name to update      | —         |
| `--undername, -u`     | Subdomain/undername      | `@`       |
| `--ttl-seconds, -t`   | TTL for ArNS record      | `60`      |
| `--cluster, -p`       | Solana cluster           | `mainnet` |
| `--on-demand`         | Auto-fund token type     | —         |
| `--max-token-amount`  | Max spend for on-demand  | —         |
| `--no-dedupe`         | Skip deduplication cache | `false`   |

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
        uses: ar-io/ar-io-deploy@v1
        with:
          deploy-key: ${{ secrets.DEPLOY_KEY }}
          arns-name: myapp
          sig-type: solana
          deploy-folder: ./dist
```

For PR previews:

```yaml
- name: Deploy Preview
  uses: ar-io/ar-io-deploy@v1
  with:
    deploy-key: ${{ secrets.DEPLOY_KEY }}
    arns-name: myapp
    sig-type: solana
    preview: 'true'
    github-token: ${{ secrets.GITHUB_TOKEN }}
    deploy-folder: ./dist
```

## Troubleshooting

| Error                                    | Solution                                                  |
| ---------------------------------------- | --------------------------------------------------------- |
| "DEPLOY_KEY not set"                     | Set env var or use `--wallet`/`--private-key`             |
| "deploy-folder does not exist"           | Build first (`npm run build`) or specify correct path     |
| "ArNS name does not exist"               | Verify the name exists on ar.io                           |
| "Insufficient Turbo Credits"             | Use `--on-demand ario` or fund wallet at turbo.ardrive.io |
| ArNS update fails with non-Solana signer | ArNS requires `--sig-type solana`                         |

## Important Notes

- **Arweave uploads are permanent** — verify your build has no secrets before deploying
- **Deduplication is on by default** — unchanged files are not re-uploaded (saves cost)
- **Cache location**: `.ario-deploy/transaction-cache.json` — commit it to share with team or gitignore it
