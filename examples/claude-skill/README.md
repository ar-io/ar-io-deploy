# Claude Code Skill: Deploy to AR.IO

This is a ready-to-use Claude Code skill for deploying your app to the permaweb via AR.IO.

## Installation

Copy the `deploy.md` file into your project's `.claude/skills/` directory:

```bash
mkdir -p .claude/skills
curl -o .claude/skills/deploy.md https://raw.githubusercontent.com/ar-io/ar-io-deploy/alpha/examples/claude-skill/deploy.md
```

## Usage

Once installed, simply tell Claude Code:

- "deploy to ar.io"
- "deploy my app"
- "publish to arweave"
- "/deploy"

Claude will:

1. Build your project
2. Detect your deploy folder
3. Check for wallet/credentials
4. Deploy using `@ar.io/deploy`
5. Report back the transaction ID and live URL

## Prerequisites

- Node.js >= 18
- A wallet:
  - **Upload key** (`DEPLOY_KEY`): Any supported type — Solana (base58), Arweave (base64 JWK), or Ethereum (hex)
  - **ArNS key** (`ARNS_KEY`): Solana base58 private key (only needed if updating ArNS names)
- `@ar.io/deploy` installed (`npm install -g @ar.io/deploy` or as a devDependency)

## Customization

Edit `.claude/skills/deploy.md` in your project to:

- Set your default ArNS name
- Set your default build folder
- Add project-specific deployment notes
- Configure signer type defaults
