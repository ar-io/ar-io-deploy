import { Flags } from '@oclif/core'

import { promptArnsName, promptCluster } from '../prompts/arns.js'
import { promptDeployTarget } from '../prompts/deployment.js'
import { promptSignerType } from '../prompts/wallet.js'
import { createFlagConfig, type ResolvedConfig } from '../utils/config-resolver.js'
import { TTL_MAX, TTL_MIN } from '../utils/constants.js'
import {
  validateFileExists,
  validateFolderExists,
  validateTtl,
  validateUndername,
} from '../utils/validators.js'
import { DEFAULT_CACHE_MAX_ENTRIES } from './cache.js'

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
    triggersInteractive: true,
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
    async prompt() {
      const target = await promptDeployTarget()
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
    async prompt() {
      const target = await promptDeployTarget()
      return target.type === 'folder' ? target.path : './dist'
    },
  }),
  // Advanced payment settings
  maxTokenAmount: createFlagConfig<string | undefined>({
    flag: Flags.string({
      description: 'Maximum token amount for on-demand payment',
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
      description: 'Enable on-demand payment with specified token (ario or base-eth)',
      options: ['ario', 'base-eth'],
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
      options: ['arweave', 'ethereum', 'polygon', 'kyve', 'solana'],
      required: false,
    }),
    prompt: promptSignerType,
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
      description:
        'Custom Turbo upload service base URL. Omit for ArDrive production: https://upload.ardrive.io.',
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
 * Complete set of flags for the deploy command
 */
export const deployFlags = {
  'arns-name': globalFlags.arnsName.flag,
  'arns-private-key': globalFlags.arnsPrivateKey.flag,
  'arns-wallet': globalFlags.arnsWallet.flag,
  cluster: globalFlags.cluster.flag,
  'dedupe-cache-max-entries': globalFlags.dedupeCacheMaxEntries.flag,
  'deploy-file': globalFlags.deployFile.flag,
  'deploy-folder': globalFlags.deployFolder.flag,
  'max-token-amount': globalFlags.maxTokenAmount.flag,
  'no-dedupe': globalFlags.noDedupe.flag,
  'on-demand': globalFlags.onDemand.flag,
  'private-key': globalFlags.privateKey.flag,
  'rpc-url': globalFlags.rpcUrl.flag,
  'sig-type': globalFlags.sigType.flag,
  'ttl-seconds': globalFlags.ttlSeconds.flag,
  undername: globalFlags.undername.flag,
  uploader: globalFlags.uploader.flag,
  'use-arns': globalFlags.useArns.flag,
  wallet: globalFlags.wallet.flag,
}

/**
 * ArNS-specific flags (subset of deploy flags)
 */
export const arnsFlags = {
  'arns-name': globalFlags.arnsName.flag,
  'arns-private-key': globalFlags.arnsPrivateKey.flag,
  'arns-wallet': globalFlags.arnsWallet.flag,
  cluster: globalFlags.cluster.flag,
  'rpc-url': globalFlags.rpcUrl.flag,
  'ttl-seconds': globalFlags.ttlSeconds.flag,
  undername: globalFlags.undername.flag,
}

/**
 * Wallet/authentication flags (subset of deploy flags)
 */
export const walletFlags = {
  'private-key': globalFlags.privateKey.flag,
  'sig-type': globalFlags.sigType.flag,
  wallet: globalFlags.wallet.flag,
}

/**
 * Deploy command configuration type
 */
export interface DeployConfig {
  'arns-name'?: string
  'arns-private-key'?: string
  'arns-wallet'?: string
  cluster: string
  'dedupe-cache-max-entries': number
  'deploy-file'?: string
  'deploy-folder': string
  'max-token-amount'?: string
  'no-dedupe': boolean
  'on-demand'?: string
  'private-key'?: string
  'rpc-url'?: string
  'sig-type': string
  'ttl-seconds': string
  undername: string
  'use-arns': boolean
  uploader?: string
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
  'dedupe-cache-max-entries': globalFlags.dedupeCacheMaxEntries,
  'deploy-file': globalFlags.deployFile,
  'deploy-folder': globalFlags.deployFolder,
  'max-token-amount': globalFlags.maxTokenAmount,
  'no-dedupe': globalFlags.noDedupe,
  'on-demand': globalFlags.onDemand,
  'private-key': globalFlags.privateKey,
  'rpc-url': globalFlags.rpcUrl,
  'sig-type': globalFlags.sigType,
  'ttl-seconds': globalFlags.ttlSeconds,
  undername: globalFlags.undername,
  uploader: globalFlags.uploader,
  'use-arns': globalFlags.useArns,
  wallet: globalFlags.wallet,
} as const

/**
 * Upload command — file/folder to Arweave via Turbo without updating ArNS
 */
export const uploadFlagConfigs = {
  'dedupe-cache-max-entries': globalFlags.dedupeCacheMaxEntries,
  'deploy-file': globalFlags.deployFile,
  'deploy-folder': globalFlags.deployFolder,
  'max-token-amount': globalFlags.maxTokenAmount,
  'no-dedupe': globalFlags.noDedupe,
  'on-demand': globalFlags.onDemand,
  'private-key': globalFlags.privateKey,
  'sig-type': globalFlags.sigType,
  uploader: globalFlags.uploader,
  wallet: globalFlags.wallet,
} as const

export type UploadConfig = ResolvedConfig<typeof uploadFlagConfigs>
