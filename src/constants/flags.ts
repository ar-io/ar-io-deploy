import { Flags } from '@oclif/core'

import { promptArnsName, promptCluster } from '../prompts/arns.js'
import { type DeployTarget, promptDeployTarget } from '../prompts/deployment.js'
import { promptSignerType } from '../prompts/wallet.js'
import { CONTENT_ENCODINGS } from '../utils/compression.js'
import {
  createFlagConfig,
  type PromptContext,
  type ResolvedConfig,
} from '../utils/config-resolver.js'
import { TTL_MAX, TTL_MIN } from '../utils/constants.js'
import { ALL_ON_DEMAND_TOKENS } from '../utils/turbo.js'
import {
  validateFileExists,
  validateFolderExists,
  validateTokenAmount,
  validateTtl,
  validateUndername,
} from '../utils/validators.js'
import { DEFAULT_CACHE_MAX_ENTRIES } from './cache.js'
import { DEFAULT_INCREMENTAL_GATEWAY } from './incremental.js'

/** Ask "file or folder?" once per run, whichever of the two flags asks first. */
function deployTarget(context: PromptContext): Promise<DeployTarget> {
  let target = context.memo.get('deploy-target') as Promise<DeployTarget> | undefined
  if (!target) {
    target = promptDeployTarget()
    context.memo.set('deploy-target', target)
  }

  return target
}

/**
 * Global flag definitions - single source of truth for all flags
 * Each flag includes its oclif definition and optional prompt function
 */
export const globalFlags = {
  arnsName: createFlagConfig<string>({
    flag: Flags.string({
      char: 'n',
      description: 'The ArNS name to deploy to',
      required: false,
    }),
    prompt: promptArnsName,
  }),
  arnsPrivateKey: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description:
        'ArNS authority key: base58 Solana secret key that controls the ArNS name and signs the record update (alternative to --arns-wallet). Falls back to the ARNS_KEY env var. This is separate from the upload key.',
      exclusive: ['arns-wallet'],
      required: false,
    }),
  }),
  arnsWallet: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description:
        'ArNS authority key: path to the Solana wallet file (solana-keygen id.json) that controls the ArNS name and signs the record update. Falls back to the ARNS_KEY env var. This is separate from the upload key.',
      exclusive: ['arns-private-key'],
      async parse(input) {
        const validation = validateFileExists(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
  }),
  cluster: createFlagConfig<string>({
    flag: Flags.string({
      char: 'p',
      default: 'mainnet',
      description: 'Solana cluster for ArNS updates (mainnet or devnet)',
      options: ['mainnet', 'devnet'],
      required: false,
    }),
    prompt: promptCluster,
  }),
  compress: createFlagConfig<string>({
    flag: Flags.string({
      default: 'none',
      description:
        'Compress files before upload and tag them with Content-Encoding (gzip or br). Gateways serve the encoded bytes to every client, so prefer gzip unless you know your clients accept br. Already-compressed formats (JPEG, PNG, GIF, WebP, AVIF, WOFF/WOFF2, MP3, MP4, WebM, zip/gz and other archives) are uploaded as-is.',
      options: ['none', ...CONTENT_ENCODINGS],
      required: false,
    }),
  }),
  compressExclude: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description:
        'Comma-separated globs of files to upload uncompressed, relative to the deploy folder (e.g. "llms*.txt,*.md"). A pattern without "/" matches the file name in any directory.',
      required: false,
    }),
  }),
  dedupeCacheMaxEntries: createFlagConfig<number>({
    flag: Flags.integer({
      default: DEFAULT_CACHE_MAX_ENTRIES,
      description: 'Maximum number of entries to keep in the dedupe cache (LRU)',
      min: 0,
      required: false,
    }),
  }),
  deployFile: createFlagConfig<string | undefined>({
    flag: Flags.string({
      char: 'f',
      description: 'File to deploy (overrides deploy-folder)',
      async parse(input) {
        const validation = validateFileExists(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
    async prompt(context) {
      if (context.provided.has('deploy-folder')) return
      const target = await deployTarget(context)
      return target.type === 'file' ? target.path : undefined
    },
  }),
  deployFolder: createFlagConfig<string>({
    flag: Flags.string({
      char: 'd',
      default: './dist',
      description: 'Folder to deploy',
      async parse(input) {
        const validation = validateFolderExists(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
    async prompt(context) {
      if (context.provided.has('deploy-file')) return
      const target = await deployTarget(context)
      return target.type === 'folder' ? target.path : undefined
    },
  }),
  dev: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description:
        "Use Turbo's development sandbox: the sandbox upload and payment services together, and testnet RPCs for --on-demand funding. --uploader and --payment-url still override either service.",
      required: false,
    }),
  }),
  fallbackFile: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description:
        'Path (relative to the deploy folder) served for routes the manifest does not list. Defaults to 404.html when present.',
      required: false,
    }),
  }),
  ignoreApprovals: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description:
        "Ignore credits other wallets have shared with the upload key; pay only from the key's own balance.",
      exclusive: ['paid-by'],
      required: false,
    }),
  }),
  incremental: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description:
        'Reuse files already on Arweave: tag each file with its content hash, recover transaction ids the local cache is missing by querying your own past uploads, and record every id the moment it lands. Off by default.',
      exclusive: ['no-dedupe'],
      required: false,
    }),
  }),
  incrementalGateway: createFlagConfig<string>({
    flag: Flags.string({
      default: DEFAULT_INCREMENTAL_GATEWAY,
      description:
        'Gateway whose GraphQL endpoint is queried for past uploads when --incremental is set.',
      required: false,
    }),
  }),
  // Advanced payment settings
  maxTokenAmount: createFlagConfig<string | undefined>({
    flag: Flags.string({
      dependsOn: ['on-demand'],
      description:
        'Most the --on-demand top-up may spend, in whole tokens (e.g. 0.5). Caps the whole deploy, not each file.',
      async parse(input) {
        const validation = validateTokenAmount(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
  }),
  noDedupe: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description: 'Disable deduplication (do not cache or reuse previous uploads)',
      required: false,
    }),
  }),
  onDemand: createFlagConfig<string | undefined>({
    flag: Flags.string({
      dependsOn: ['max-token-amount'],
      description:
        'Top up Turbo credits with this token if the balance cannot cover the upload. Solana keys: ario, solana, solana-usdc. EVM keys: base-eth, base-usdc. Requires --max-token-amount.',
      options: [...ALL_ON_DEMAND_TOKENS],
      required: false,
    }),
  }),
  paidBy: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description:
        'Comma-separated addresses whose shared credits pay for the upload. Defaults to every wallet that has shared credits with the upload key.',
      exclusive: ['ignore-approvals'],
      required: false,
    }),
  }),
  paymentUrl: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description:
        'Custom Turbo payment service URL, used for balance checks, pricing and on-demand top-ups. Follows --uploader when that is the development sandbox.',
      required: false,
    }),
  }),
  privateKey: createFlagConfig<string | undefined>({
    flag: Flags.string({
      char: 'k',
      description:
        'Upload key (pays for the upload): private key string, alternative to --wallet. JWK JSON for Arweave, hex for EVM chains, base58 secret key for Solana.',
      exclusive: ['wallet'],
      required: false,
    }),
  }),
  rpcUrl: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description: 'Optional Solana RPC URL override for ArNS updates',
      required: false,
    }),
  }),
  sigType: createFlagConfig<string>({
    flag: Flags.string({
      char: 's',
      default: 'arweave',
      description: 'Signer type for the upload key (pays for the upload).',
      options: ['arweave', 'ethereum', 'polygon', 'solana'],
      required: false,
    }),
    prompt: promptSignerType,
  }),
  skipArnsCheck: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description:
        'Update the ArNS record even if the ArNS key does not appear to own or control the name (e.g. right after a transfer). Without it, such a deploy is refused before uploading.',
      required: false,
    }),
  }),
  ttlSeconds: createFlagConfig<string>({
    flag: Flags.string({
      char: 't',
      default: '60',
      description: `ArNS TTL in seconds (${TTL_MIN}-${TTL_MAX})`,
      async parse(input) {
        const validation = validateTtl(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
  }),
  undername: createFlagConfig<string>({
    flag: Flags.string({
      char: 'u',
      default: '@',
      description: 'ANT undername to update',
      async parse(input) {
        const validation = validateUndername(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
  }),
  uploader: createFlagConfig<string | undefined>({
    flag: Flags.string({
      aliases: ['upload-url'],
      description:
        'Custom Turbo upload service URL. Omit for production (https://upload.ardrive.io); see --dev for the sandbox.',
      required: false,
    }),
  }),
  useArns: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description: 'Update an ArNS/ANT record after upload.',
      required: false,
    }),
  }),
  useSignerBalanceFirst: createFlagConfig<boolean>({
    flag: Flags.boolean({
      default: false,
      description: "Spend the upload key's own balance before any shared credits.",
      required: false,
    }),
  }),
  wallet: createFlagConfig<string | undefined>({
    flag: Flags.string({
      char: 'w',
      description:
        'Upload key (pays for the upload): path to wallet file. JWK for Arweave, private key for EVM chains, solana-keygen id.json for Solana.',
      exclusive: ['private-key'],
      async parse(input) {
        const validation = validateFileExists(input)
        if (validation !== true) {
          throw new Error(validation)
        }

        return input
      },
      required: false,
    }),
  }),
}

/**
 * Deploy command configuration type
 */
export interface DeployConfig {
  'arns-name'?: string
  'arns-private-key'?: string
  'arns-wallet'?: string
  cluster: string
  compress?: string
  'compress-exclude'?: string
  'dedupe-cache-max-entries': number
  'deploy-file'?: string
  'deploy-folder': string
  dev: boolean
  'fallback-file'?: string
  'ignore-approvals': boolean
  incremental: boolean
  'incremental-gateway': string
  'max-token-amount'?: string
  'no-dedupe': boolean
  'on-demand'?: string
  'paid-by'?: string
  'payment-url'?: string
  'private-key'?: string
  'rpc-url'?: string
  'sig-type': string
  'ttl-seconds': string
  undername: string
  'skip-arns-check': boolean
  'use-arns': boolean
  uploader?: string
  'use-signer-balance-first': boolean
  wallet?: string
}

/**
 * Deploy command flag configurations
 * Maps kebab-case flag names to their camelCase globalFlags definitions
 */
export const deployFlagConfigs = {
  'arns-name': globalFlags.arnsName,
  'arns-private-key': globalFlags.arnsPrivateKey,
  'arns-wallet': globalFlags.arnsWallet,
  cluster: globalFlags.cluster,
  compress: globalFlags.compress,
  'compress-exclude': globalFlags.compressExclude,
  'dedupe-cache-max-entries': globalFlags.dedupeCacheMaxEntries,
  'deploy-file': globalFlags.deployFile,
  'deploy-folder': globalFlags.deployFolder,
  dev: globalFlags.dev,
  'fallback-file': globalFlags.fallbackFile,
  'ignore-approvals': globalFlags.ignoreApprovals,
  incremental: globalFlags.incremental,
  'incremental-gateway': globalFlags.incrementalGateway,
  'max-token-amount': globalFlags.maxTokenAmount,
  'no-dedupe': globalFlags.noDedupe,
  'on-demand': globalFlags.onDemand,
  'paid-by': globalFlags.paidBy,
  'payment-url': globalFlags.paymentUrl,
  'private-key': globalFlags.privateKey,
  'rpc-url': globalFlags.rpcUrl,
  'sig-type': globalFlags.sigType,
  'skip-arns-check': globalFlags.skipArnsCheck,
  'ttl-seconds': globalFlags.ttlSeconds,
  undername: globalFlags.undername,
  uploader: globalFlags.uploader,
  'use-arns': globalFlags.useArns,
  'use-signer-balance-first': globalFlags.useSignerBalanceFirst,
  wallet: globalFlags.wallet,
} as const

/**
 * Upload command — file/folder to Arweave via Turbo without updating ArNS
 */
export const uploadFlagConfigs = {
  compress: globalFlags.compress,
  'compress-exclude': globalFlags.compressExclude,
  'dedupe-cache-max-entries': globalFlags.dedupeCacheMaxEntries,
  'deploy-file': globalFlags.deployFile,
  'deploy-folder': globalFlags.deployFolder,
  dev: globalFlags.dev,
  'fallback-file': globalFlags.fallbackFile,
  'ignore-approvals': globalFlags.ignoreApprovals,
  incremental: globalFlags.incremental,
  'incremental-gateway': globalFlags.incrementalGateway,
  'max-token-amount': globalFlags.maxTokenAmount,
  'no-dedupe': globalFlags.noDedupe,
  'on-demand': globalFlags.onDemand,
  'paid-by': globalFlags.paidBy,
  'payment-url': globalFlags.paymentUrl,
  'private-key': globalFlags.privateKey,
  'sig-type': globalFlags.sigType,
  uploader: globalFlags.uploader,
  'use-signer-balance-first': globalFlags.useSignerBalanceFirst,
  wallet: globalFlags.wallet,
} as const

export type UploadConfig = ResolvedConfig<typeof uploadFlagConfigs>
